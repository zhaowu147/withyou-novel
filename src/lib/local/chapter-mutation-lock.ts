/**
 * 章节写入互斥锁。
 *
 * 章节正文文件和 vault/chapter_files.json 是同一个逻辑写入，不能只锁其中一边。
 * 进程内队列覆盖同一个 Node 进程中的多请求；proper-lockfile 覆盖开发服务器、
 * Electron 多开和独立脚本同时写入的情况。读取哈希与实际写入必须放在调用方的
 * 同一个锁回调里，才能让乐观并发保护真正生效。
 */
import "server-only";

import { lock as acquireCrossProcessLock } from "proper-lockfile";

import { sanitizeNovelId, vaultDir } from "./paths";
import * as fs from "node:fs";
import * as path from "node:path";

const novelMutationQueues = new Map<string, Promise<void>>();

function lockTarget(novelId: string, chapterNumber: number): string {
  const safeNovelId = sanitizeNovelId(novelId);
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1 || chapterNumber > 100_000) {
    throw new Error("章节编号必须是 1 到 100000 的整数");
  }
  // 按小说而不是只按章节加锁：saveChapterFile 还会更新同一本小说的
  // total_chapters 元数据，避免第 1 章和第 2 章并行写时互相覆盖 meta.json。
  return path.join(vaultDir(safeNovelId), ".novel-mutation.lock");
}

/** 在同一小说/章节上串行执行一个包含“读哈希 + 写入”的完整事务。 */
export async function withChapterMutationLock<T>(
  novelId: string,
  chapterNumber: number,
  operation: () => Promise<T> | T,
): Promise<T> {
  const target = lockTarget(novelId, chapterNumber);
  const previous = novelMutationQueues.get(target) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const tail = previous.then(() => turn);
  novelMutationQueues.set(target, tail);

  await previous;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let releaseCrossProcess: (() => Promise<void>) | undefined;
  try {
    releaseCrossProcess = await acquireCrossProcessLock(target, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 12, factor: 1.6, minTimeout: 100, maxTimeout: 2_000 },
    });
    return await operation();
  } finally {
    if (releaseCrossProcess) {
      await releaseCrossProcess().catch((error) => {
        console.warn(`[chapter-lock] 释放章节锁失败（可忽略）: ${target}`, error);
      });
    }
    releaseTurn();
    if (novelMutationQueues.get(target) === tail) novelMutationQueues.delete(target);
  }
}
