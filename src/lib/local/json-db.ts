/**
 * 本地 JSON 文件读写（服务端 only）
 * 每个集合一个文件: vault/entities.json 等
 *
 * 数据安全约定（勿退回静默 catch）：
 * - 文件不存在 → 返回空集合 / fallback（新项目的正常态）。
 * - 文件存在但解析失败 → 绝不静默返回空，否则下一次写入会用空集合覆盖，
 *   造成永久丢数据。改为：先尝试 .bak 自愈；无可用备份则保留损坏现场并抛错，
 *   让调用方失败（500 好过静默清零）。
 * - 每次写入前把旧主文件备份为 .bak，使上面的自愈路径有东西可回退。
 *
 * 该策略照搬同项目 settings-file.ts 已验证的做法（损坏另存 .corrupt + 备份回退）。
 */
import "server-only";

import { lock as acquireCrossProcessLock } from "proper-lockfile";

import { vaultDir } from "./paths";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** 集合文件损坏且无可用备份时抛出，供调用方与测试区分。 */
export class CollectionCorruptError extends Error {
  readonly filePath: string;
  constructor(filePath: string, cause?: unknown) {
    super(`数据文件损坏且无可用备份，已停止读取以避免覆盖：${filePath}。原始文件保持原样，请人工检查或从备份恢复。`);
    this.name = "CollectionCorruptError";
    this.filePath = filePath;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** 保留的 .corrupt 历史份数 */
const CORRUPT_KEEP = 3;

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Per-file 互斥锁（双层）───
// 层1：进程内 promise 队列，让同进程对同一文件的 read-modify-write 串行；
// 层2：proper-lockfile 跨进程锁（dev server + 测试进程 / 多开 exe 同时写时防丢写）。
const fileLocks = new Map<string, Promise<void>>();

async function withFileLock(filePath: string, fn: () => void): Promise<void> {
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  const current = prev.then(async () => {
    // 锁文件是 `${filePath}.lock` 目录，建在父目录下；目标文件本身可以尚不存在。
    ensureDir(path.dirname(filePath));
    // 重试窗口 ~12s，覆盖 10s stale 期：崩溃进程残留的锁能被等到并接管。
    // 拿不到锁则抛错让本次操作失败 —— 与本文件「500 好过丢数据」的约定一致。
    const release = await acquireCrossProcessLock(filePath, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 12, factor: 1.6, minTimeout: 100, maxTimeout: 2_000 },
    });
    try {
      fn();
    } finally {
      await release().catch((e) => {
        // 释放失败只会让别的进程多等一个 stale 期，主流程数据已安全落盘。
        console.warn(`[json-db] 释放跨进程锁失败（可忽略）: ${filePath}`, e);
      });
    }
  });
  // 存储当前 promise，失败也要推进队列
  fileLocks.set(
    filePath,
    current.catch(() => {
      /* 吞掉拒绝，让锁队列继续推进 */
    }),
  );
  await current;
}

function collectionPath(novelId: string, name: string): string {
  return path.join(vaultDir(novelId), `${name}.json`);
}

function backupPath(p: string): string {
  return `${p}.bak`;
}

/** 把损坏主文件重命名另存为 .corrupt.<ts>，并只保留最近 CORRUPT_KEEP 份。 */
function archiveCorrupt(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    const corruptPath = `${p}.corrupt.${Date.now()}`;
    fs.renameSync(p, corruptPath);
    const base = path.basename(p);
    const dir = path.dirname(p);
    const stale = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.corrupt.`))
      .sort()
      .reverse()
      .slice(CORRUPT_KEEP);
    for (const name of stale) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        /* 清理旧损坏副本失败可忽略 */
      }
    }
    return corruptPath;
  } catch (e) {
    console.error(`[json-db] 归档损坏文件失败: ${p}`, e);
    return null;
  }
}

/** 原子写：tmp 完整写入后 rename 替换；替换前把旧主文件备份为 .bak。 */
function atomicWriteWithBackup(p: string, serialized: string): void {
  const dir = path.dirname(p);
  ensureDir(dir);
  // 备份上一版（最后一次已知可用内容），供读取侧自愈。
  try {
    if (fs.existsSync(p)) fs.copyFileSync(p, backupPath(p));
  } catch (e) {
    console.error(`[json-db] 备份 .bak 失败（继续写入）: ${p}`, e);
  }
  const tmp = path.join(dir, `.${path.basename(p)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, serialized, "utf8");
  fs.renameSync(tmp, p);
}

function parseArray<T>(raw: string): T[] | null {
  const value = JSON.parse(raw);
  return Array.isArray(value) ? (value as T[]) : null;
}

export function readCollection<T>(novelId: string, name: string): T[] {
  const p = collectionPath(novelId, name);
  if (!fs.existsSync(p)) return []; // 新项目正常态

  let parseError: unknown;
  try {
    const rows = parseArray<T>(fs.readFileSync(p, "utf8"));
    if (rows) return rows;
    parseError = new Error("集合文件内容不是数组");
  } catch (e) {
    parseError = e;
  }

  // 主文件损坏 —— 尝试从 .bak 自愈
  const bak = backupPath(p);
  if (fs.existsSync(bak)) {
    try {
      const rows = parseArray<T>(fs.readFileSync(bak, "utf8"));
      if (rows) {
        const archived = archiveCorrupt(p); // 主文件已被移走
        try {
          fs.copyFileSync(bak, p); // 用备份还原主文件，保持后续读写一致
        } catch (e) {
          console.error(`[json-db] 从 .bak 还原主文件失败: ${p}`, e);
        }
        console.warn(`[json-db] 主文件损坏，已从备份恢复: ${p}${archived ? `（损坏副本存于 ${archived}）` : ""}`);
        return rows;
      }
    } catch (e) {
      console.error(`[json-db] .bak 同样无法解析: ${bak}`, e);
    }
  }

  // 无可用备份：不动主文件、不返回空，抛错让调用方失败（避免二次覆盖清零）。
  console.error(`[json-db] 数据文件损坏且无可用备份，拒绝返回空集合: ${p}`, parseError);
  throw new CollectionCorruptError(p, parseError);
}

/**
 * 整体覆盖写（不加锁）。仅供 updateCollection 内部与测试构造现场使用；
 * 业务代码不要直连 —— read→改→writeCollection 的窗口会互相覆盖丢写，
 * 一律改走 updateCollection。
 */
export function writeCollection<T>(novelId: string, name: string, rows: T[]): void {
  const dir = vaultDir(novelId);
  ensureDir(dir);
  atomicWriteWithBackup(collectionPath(novelId, name), JSON.stringify(rows, null, 2));
}

/**
 * 安全的 read-modify-write：加锁后读取→修改→写入，防止并发覆盖。
 * 业务代码的集合写入一律走这里；updater 返回 null 表示无变化、跳过写入。
 * 注意：updater 在锁内同步执行，外部 IO（读文件树、调模型）应在锁外准备好。
 */
export async function updateCollection<T>(
  novelId: string,
  name: string,
  updater: (rows: T[]) => T[] | null,
): Promise<void> {
  const p = collectionPath(novelId, name);
  await withFileLock(p, () => {
    const current = readCollection<T>(novelId, name);
    const updated = updater(current);
    if (updated !== null) writeCollection(novelId, name, updated);
  });
}

/**
 * 带兜底的单文件 JSON 读取（用于 meta 等）。
 * 契约：读不到返回 fallback，不抛错。但文件存在却损坏时，先把损坏现场另存
 * （或从 .bak 恢复），再返回 —— 原始数据不丢，下一次写入不会静默覆盖损坏内容。
 */
export function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (e) {
    // 尝试 .bak
    const bak = backupPath(filePath);
    if (fs.existsSync(bak)) {
      try {
        const recovered = JSON.parse(fs.readFileSync(bak, "utf8")) as T;
        const archived = archiveCorrupt(filePath);
        try {
          fs.copyFileSync(bak, filePath);
        } catch {
          /* 还原失败可忽略，已有 recovered */
        }
        console.warn(
          `[json-db] JSON 文件损坏，已从备份恢复: ${filePath}${archived ? `（损坏副本存于 ${archived}）` : ""}`,
        );
        return recovered;
      } catch {
        /* .bak 也坏，走下面的归档 + fallback */
      }
    }
    const archived = archiveCorrupt(filePath);
    console.error(
      `[json-db] JSON 文件损坏，已另存损坏现场并返回兜底值: ${filePath}${archived ? `（损坏副本存于 ${archived}）` : ""}`,
      e,
    );
    return fallback;
  }
}

export function writeJsonFile(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  atomicWriteWithBackup(filePath, JSON.stringify(data, null, 2));
}

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
