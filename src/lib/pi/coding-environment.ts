import "server-only";

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { appStateDir } from "@/lib/runtime/app-paths";

export type CodingToolName = "node" | "npm" | "pnpm" | "git" | "python";

export interface CodingToolStatus {
  name: CodingToolName;
  required: boolean;
  available: boolean;
  executable?: string;
  version?: string;
  minimum?: string;
  error?: string;
}

export interface CodingEnvironmentStatus {
  platform: NodeJS.Platform;
  root: string;
  managedRoot: string;
  ready: boolean;
  tools: CodingToolStatus[];
  project?: {
    packageManager?: "pnpm" | "npm";
    dependenciesInstalled: boolean;
    pythonEnvironment?: string;
  };
  checkedAt: string;
}

export interface CodingEnvironmentInstallResult {
  status: CodingEnvironmentStatus;
  attempted: string[];
  output: string[];
  requiresUserAction: string[];
}

const WINDOWS_INSTALLERS: Record<Exclude<CodingToolName, "npm" | "pnpm">, string> = {
  node: "OpenJS.NodeJS.LTS",
  git: "Git.Git",
  python: "Python.Python.3.12",
};

function executableName(name: CodingToolName): string {
  if (name === "node") return process.execPath;
  if (process.platform === "win32" && (name === "npm" || name === "pnpm")) return `${name}.cmd`;
  return name;
}

function runVersion(executable: string): { version?: string; error?: string } {
  try {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) return { error: result.error.message };
    if (result.status !== 0) return { error: `${result.stderr || "退出码 " + result.status}`.trim() };
    const version = `${result.stdout || ""}`.trim().split(/\r?\n/)[0];
    return version ? { version } : { error: "版本信息为空" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "探测失败" };
  }
}

function findExecutable(name: CodingToolName): string | undefined {
  if (name === "node") return process.execPath;
  const candidate = executableName(name);
  if (process.platform !== "win32") return candidate;
  const result = spawnSync("where.exe", [candidate], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (result.status !== 0) return undefined;
  // Return the command name instead of the localized `where.exe` path. This
  // avoids OEM-codepage corruption for usernames containing CJK characters and
  // lets Windows resolve .cmd shims through the shell.
  return candidate;
}

function toolStatus(name: CodingToolName): CodingToolStatus {
  const minimum = name === "node" ? ">=22" : name === "python" ? ">=3.11" : undefined;
  const executable = findExecutable(name);
  if (!executable) return { name, required: name === "node" || name === "git", available: false, minimum };
  const result = runVersion(executable);
  const versionMatch = result.version?.match(/(?:v|python )?(\d+)(?:\.(\d+))?/i);
  const major = versionMatch ? Number(versionMatch[1]) : 0;
  const minor = versionMatch ? Number(versionMatch[2] ?? 0) : 0;
  const minimumSatisfied = name === "node" ? major >= 22 : name === "python" ? major > 3 || (major === 3 && minor >= 11) : true;
  return {
    name,
    required: name === "node" || name === "git",
    available: Boolean(result.version) && minimumSatisfied,
    executable,
    version: result.version,
    minimum,
    error: result.error || (result.version && !minimumSatisfied ? `版本过低，需要 ${minimum}` : undefined),
  };
}

function packageManager(root: string): "pnpm" | "npm" | undefined {
  if (!fs.existsSync(path.join(root, "package.json"))) return undefined;
  return fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : "npm";
}

function projectStatus(root: string): CodingEnvironmentStatus["project"] {
  const manager = packageManager(root);
  const dependenciesInstalled = manager
    ? fs.existsSync(path.join(root, "node_modules"))
    : false;
  const requirements = path.join(root, "requirements.txt");
  const pythonEnvironment = fs.existsSync(requirements) ? path.join(root, ".withyou-python") : undefined;
  return manager || pythonEnvironment
    ? { packageManager: manager, dependenciesInstalled, pythonEnvironment }
    : undefined;
}

export function codingEnvironmentRoot(): string {
  return path.join(appStateDir(), "coding-environment");
}

export function getCodingEnvironmentStatus(root = process.cwd()): CodingEnvironmentStatus {
  const tools = (["node", "npm", "pnpm", "git", "python"] as CodingToolName[]).map(toolStatus);
  const requiredReady = tools.filter((tool) => tool.required).every((tool) => tool.available);
  const pnpmReady = tools.find((tool) => tool.name === "pnpm")?.available;
  const npmReady = tools.find((tool) => tool.name === "npm")?.available;
  const project = projectStatus(root);
  return {
    platform: process.platform,
    root: path.resolve(root),
    managedRoot: codingEnvironmentRoot(),
    ready: requiredReady && Boolean(npmReady || pnpmReady),
    tools,
    project,
    checkedAt: new Date().toISOString(),
  };
}

function runInstaller(executable: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 15 * 60_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim().slice(-20_000);
  return { ok: result.status === 0, output: output || (result.status === 0 ? "完成" : "失败") };
}

export function installCodingEnvironment(root = process.cwd()): CodingEnvironmentInstallResult {
  const attempted: string[] = [];
  const output: string[] = [];
  const requiresUserAction: string[] = [];
  let status = getCodingEnvironmentStatus(root);

  if (process.platform === "win32") {
    const winget = spawnSync("where.exe", ["winget.exe"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    if (winget.status === 0) {
      for (const tool of status.tools) {
        if (tool.available || !(tool.name in WINDOWS_INSTALLERS)) continue;
        const id = WINDOWS_INSTALLERS[tool.name as keyof typeof WINDOWS_INSTALLERS];
        attempted.push(`winget install ${id}`);
        const result = runInstaller("winget.exe", [
          "install",
          "--id",
          id,
          "--exact",
          "--scope",
          "user",
          "--accept-source-agreements",
          "--accept-package-agreements",
        ]);
        output.push(`${id}: ${result.output}`);
      }
    } else {
      requiresUserAction.push("未找到 winget，请安装 Node.js 22、Git 和 Python 3.11+ 后重新检查环境。");
    }
  } else {
    requiresUserAction.push("当前平台不提供自动系统依赖安装，请手动安装 Node.js 22、Git 和 Python 3.11+。");
  }

  status = getCodingEnvironmentStatus(root);
  const manager = status.project?.packageManager;
  if (manager && !status.project?.dependenciesInstalled) {
    const executable = manager === "pnpm" ? executableName("pnpm") : executableName("npm");
    const args = manager === "pnpm" ? ["install", "--frozen-lockfile"] : ["install"];
    attempted.push(`${executable} ${args.join(" ")}`);
    const result = runInstaller(executable, args);
    output.push(`项目依赖: ${result.output}`);
    if (!result.ok) requiresUserAction.push(`项目依赖安装失败，请在 ${path.resolve(root)} 中运行 ${executable} ${args.join(" ")}`);
  }

  const requirements = path.join(root, "requirements.txt");
  if (status.tools.find((tool) => tool.name === "python")?.available && fs.existsSync(requirements)) {
    const venv = path.join(root, ".withyou-python");
    if (!fs.existsSync(venv)) {
      attempted.push("python -m venv .withyou-python");
      const created = runInstaller(executableName("python"), ["-m", "venv", ".withyou-python"]);
      output.push(`Python venv: ${created.output}`);
    }
  }

  return { status: getCodingEnvironmentStatus(root), attempted, output, requiresUserAction };
}
