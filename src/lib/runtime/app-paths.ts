/**
 * 应用路径解析 —— 全项目唯一的数据根出口。
 *
 * 为什么需要它：打包成 exe 由用户双击启动时，process.cwd() 不可预测（可能是
 * C:\Windows\System32、桌面，或快捷方式里配置的"起始位置"）。任何直接用
 * process.cwd() 拼出来的数据路径都会随启动方式漂移，用户看到的现象是"我的小说
 * 全没了"，而旧数据其实还躺在另一个目录里。所以数据根必须显式解析一次、缓存、
 * 并且在可疑时报警，而不是在 12 个文件里各自 join 一遍 cwd。
 *
 * 解析顺序（先命中者胜）：
 *   1. WITHYOU_DATA_DIR              显式指定，打包启动器应当设置它
 *   2. 从 process.cwd() 向上找仓库锚点  保持现有开发行为逐字节不变
 *   3. 从 argv[1] / __dirname 向上找   cwd 不对时仍能定位到仓库
 *   4. 操作系统用户数据目录             打包运行且未设 env 时的兜底
 *
 * 仓库锚点 = 同时具备 package.json（name 为 withyou-novel）与 src/ 目录。
 * standalone 产物里没有 src/，因此不会被误判成仓库、把用户数据写进程序目录。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const APP_DIR_NAME = "withyou-novel";
const PACKAGE_NAME = "withyou-novel";
/** 向上回溯的层数上限，避免在异常路径上一直走到根 */
const MAX_WALK_UP = 8;

export type DataRootSource = "env:WITHYOU_DATA_DIR" | "repo:cwd" | "repo:module" | "os-app-data";

export interface DataRootInfo {
  /** 最终选定的数据根（绝对路径） */
  root: string;
  /** 命中的是哪一级候选，便于排查"数据去哪了" */
  source: DataRootSource;
  /** 未被选中但看起来已有数据的候选根 —— 提示用户数据可能在别处 */
  strandedCandidates: string[];
}

function isRepoRoot(dir: string): boolean {
  try {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) return false;
    if (!fs.existsSync(path.join(dir, "src"))) return false;
    if (!fs.statSync(path.join(dir, "src")).isDirectory()) return false;
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
    return parsed.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

function walkUpForRepoRoot(start: string | null | undefined): string | null {
  if (!start) return null;
  let current: string;
  try {
    current = path.resolve(start);
  } catch {
    return null;
  }
  for (let depth = 0; depth <= MAX_WALK_UP; depth += 1) {
    if (isRepoRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** 入口脚本所在目录。`next dev` / `next start` 下它位于 node_modules/next/dist/bin。 */
function entryScriptDir(): string | null {
  const entry = process.argv[1];
  if (!entry) return null;
  try {
    return path.dirname(path.resolve(entry));
  } catch {
    return null;
  }
}

/** 本模块所在目录。ESM 下 __dirname 不存在，typeof 守卫不会抛错。 */
function moduleDir(): string | null {
  return typeof __dirname === "string" ? __dirname : null;
}

function osAppDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, APP_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, APP_DIR_NAME);
}

/** 该目录下是否已存在本应用的数据 */
function looksPopulated(root: string): boolean {
  try {
    return (
      fs.existsSync(path.join(root, "novels")) ||
      fs.existsSync(path.join(root, ".data")) ||
      fs.existsSync(path.join(root, "settings.json"))
    );
  } catch {
    return false;
  }
}

/**
 * 解析时的探测点。生产代码全部走默认值；测试通过显式传入来覆盖各分支，
 * 免得靠 process.chdir() 这种全局副作用。
 */
export interface DataRootProbe {
  explicit?: string | null;
  cwd?: string;
  entryDir?: string | null;
  moduleDir?: string | null;
  appDataDir?: string;
}

function withDefaults(probe: DataRootProbe): Required<DataRootProbe> {
  return {
    // biome-ignore lint/nursery/useNullishCoalescing: explicit null (from tests) must not fall through to the env default
    explicit: probe.explicit !== undefined ? probe.explicit : (process.env.WITHYOU_DATA_DIR ?? null),
    cwd: probe.cwd ?? /* turbopackIgnore: true */ process.cwd(),
    // biome-ignore lint/nursery/useNullishCoalescing: explicit null (from tests) must not fall through to the probe default
    entryDir: probe.entryDir !== undefined ? probe.entryDir : entryScriptDir(),
    // biome-ignore lint/nursery/useNullishCoalescing: explicit null (from tests) must not fall through to the probe default
    moduleDir: probe.moduleDir !== undefined ? probe.moduleDir : moduleDir(),
    appDataDir: probe.appDataDir ?? osAppDataDir(),
  };
}

/** 仓库根候选；供 Pi 源码维护模式复用，避免它也去猜 cwd。 */
export function repoRootCandidate(probe: DataRootProbe = {}): string | null {
  const p = withDefaults(probe);
  return walkUpForRepoRoot(p.cwd) ?? walkUpForRepoRoot(p.entryDir) ?? walkUpForRepoRoot(p.moduleDir);
}

function collectCandidates(probe: DataRootProbe): Array<{ root: string; source: DataRootSource }> {
  const p = withDefaults(probe);
  const candidates: Array<{ root: string; source: DataRootSource }> = [];

  const explicit = p.explicit?.trim();
  if (explicit) {
    candidates.push({ root: path.resolve(explicit), source: "env:WITHYOU_DATA_DIR" });
  }

  const fromCwd = walkUpForRepoRoot(p.cwd);
  if (fromCwd) candidates.push({ root: fromCwd, source: "repo:cwd" });

  const fromModule = walkUpForRepoRoot(p.entryDir) ?? walkUpForRepoRoot(p.moduleDir);
  if (fromModule && fromModule !== fromCwd) {
    candidates.push({ root: fromModule, source: "repo:module" });
  }

  candidates.push({ root: p.appDataDir, source: "os-app-data" });
  return candidates;
}

export function resolveDataRootInfo(probe: DataRootProbe = {}): DataRootInfo {
  const candidates = collectCandidates(probe);
  const chosen = candidates[0];
  const stranded = candidates
    .slice(1)
    .map((candidate) => candidate.root)
    .filter((root) => root !== chosen.root && looksPopulated(root));
  return { root: chosen.root, source: chosen.source, strandedCandidates: [...new Set(stranded)] };
}

let cached: DataRootInfo | null = null;
let warned = false;

/**
 * 选定的数据根。首次解析后缓存；若选中的根还没有数据、而另一个候选里有，
 * 会告警一次 —— 这正是"小说不见了"最常见的成因。
 */
export function dataRootInfo(): DataRootInfo {
  if (!cached) {
    cached = resolveDataRootInfo();
    if (!warned && cached.strandedCandidates.length > 0 && !looksPopulated(cached.root)) {
      warned = true;
      console.warn(
        `[app-paths] 数据根解析为 ${cached.root}（来源 ${cached.source}），但该目录还没有数据；` +
          `以下目录里已存在数据，可能是你要找的：${cached.strandedCandidates.join(" , ")}。` +
          `如需指定，请设置 WITHYOU_DATA_DIR。`,
      );
    }
  }
  return cached;
}

/** 仅供测试：清掉缓存，让下一次解析重新读取环境变量 */
export function resetDataRootCache(): void {
  cached = null;
  warned = false;
}

/** 用户数据根：novels/ 、.data/ 、settings.json 都挂在它下面 */
export function dataRoot(): string {
  return dataRootInfo().root;
}

/** 运行时状态目录（工作区绑定、恢复点、Pi 会话） */
export function appStateDir(): string {
  return path.join(dataRoot(), ".data");
}

/** 小说数据根。NOVELS_BASE_DIR 仍然可以单独覆盖它。 */
export function novelsRoot(): string {
  const override = process.env.NOVELS_BASE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(dataRoot(), "novels");
}

/** settings.json 的绝对路径 */
export function settingsFilePath(): string {
  return path.join(dataRoot(), "settings.json");
}
