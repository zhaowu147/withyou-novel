/**
 * 导入/历史章节的可暂停、可续跑记忆建库。
 *
 * 每个任务只保存在目标 novelId 的 Vault 中；章节内容哈希是不可变输入快照。
 * 若处理期间正文变化，旧结果不会写入，而是让新快照重新排队。
 */
import "server-only";

import { newId, nowIso, updateCollection } from "@/lib/local/json-db";
import { sanitizeNovelId } from "@/lib/local/paths";
import { extractChapterMemory } from "@/lib/memory/chapter-memory-extractor";
import { queueAffectedConsolidations, runPendingConsolidations } from "@/lib/memory/consolidation";
import { ingestChapterMemories, listNovelMemories } from "@/lib/memory/novel-memory";
import { novelFS } from "@/lib/novel-fs";

import { createHash } from "node:crypto";

export type MemoryBackfillStatus = "queued" | "running" | "paused" | "completed" | "failed" | "superseded";

export type MemoryBackfillChapterStatus = "queued" | "running" | "succeeded" | "failed" | "stale";

export interface MemoryBackfillChapter {
  number: number;
  title: string;
  source_hash: string;
  status: MemoryBackfillChapterStatus;
  attempts: number;
  max_attempts: number;
  locked_at?: string;
  next_retry_at?: string;
  last_error?: string;
  memories_written?: number;
  updated_at: string;
  completed_at?: string;
}

export interface MemoryBackfillJob {
  id: string;
  novel_id: string;
  project_fingerprint: string;
  status: MemoryBackfillStatus;
  chapters: MemoryBackfillChapter[];
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface SourceChapter {
  number: number;
  title: string;
  content: string;
  sourceHash: string;
}

const JOB_COLLECTION = "memory_backfill_jobs";
const MAX_ATTEMPTS = 5;
const STALE_LOCK_MS = 15 * 60 * 1000;
const MAX_JOB_HISTORY = 10;
const activeRuns = new Set<string>();

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceChapters(novelId: string): SourceChapter[] {
  return novelFS
    .listChapters(novelId)
    .map((chapter) => {
      const content = novelFS.readChapter(novelId, chapter.number) ?? "";
      return {
        number: chapter.number,
        title: chapter.title,
        content,
        sourceHash: hashText(content),
      };
    })
    .filter((chapter) => chapter.content.trim())
    .sort((a, b) => a.number - b.number);
}

function projectFingerprint(novelId: string, chapters: SourceChapter[]): string {
  return hashText(
    JSON.stringify({
      novelId,
      chapters: chapters.map((chapter) => [chapter.number, chapter.title, chapter.sourceHash]),
    }),
  );
}

function isolateJobs(novelId: string, rows: MemoryBackfillJob[]): MemoryBackfillJob[] {
  return rows.filter(
    (job) => job && job.novel_id === novelId && typeof job.id === "string" && Array.isArray(job.chapters),
  );
}

/**
 * 加锁的 read-modify-write：mutator 就地修改 jobs，返回 false 表示无变化跳过写入。
 * 历史裁剪（MAX_JOB_HISTORY）在写入前统一做。
 */
async function mutateIsolatedJobs(novelId: string, mutator: (jobs: MemoryBackfillJob[]) => boolean): Promise<void> {
  await updateCollection<MemoryBackfillJob>(novelId, JOB_COLLECTION, (allRows) => {
    const jobs = isolateJobs(novelId, allRows);
    if (!mutator(jobs)) return null;
    return jobs.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, MAX_JOB_HISTORY);
  });
}

function alreadyIngestedHashes(novelId: string): Set<string> {
  return new Set(
    listNovelMemories(novelId)
      .filter(
        (memory) =>
          memory.status === "active" &&
          memory.source.type === "chapter" &&
          memory.kind === "chapter_summary" &&
          typeof memory.source.content_hash === "string",
      )
      .map((memory) => `${memory.source.chapter}:${memory.source.content_hash as string}`),
  );
}

function deriveStatus(job: MemoryBackfillJob): MemoryBackfillStatus {
  if (job.status === "paused" || job.status === "superseded") return job.status;
  if (job.chapters.some((chapter) => chapter.status === "running")) return "running";
  if (job.chapters.some((chapter) => chapter.status === "queued")) return "queued";
  if (job.chapters.some((chapter) => chapter.status === "failed" || chapter.status === "stale")) {
    return "failed";
  }
  return "completed";
}

/**
 * 为当前作品正文创建不可变章节快照。相同快照不会重复创建任务。
 */
export async function queueMemoryBackfill(novelIdInput: string): Promise<MemoryBackfillJob> {
  const novelId = sanitizeNovelId(novelIdInput);
  // 正文快照与已入库指纹都在锁外读取（各自有独立文件），锁内只做任务合并。
  const chapters = sourceChapters(novelId);
  const fingerprint = projectFingerprint(novelId, chapters);
  const ingested = alreadyIngestedHashes(novelId);
  let result: MemoryBackfillJob | null = null;
  await mutateIsolatedJobs(novelId, (jobs) => {
    const sameSnapshot = jobs.find((job) => job.project_fingerprint === fingerprint && job.status !== "superseded");
    if (sameSnapshot) {
      let repaired = false;
      for (const chapter of sameSnapshot.chapters) {
        if (chapter.status === "succeeded" && !ingested.has(`${chapter.number}:${chapter.source_hash}`)) {
          chapter.status = "queued";
          chapter.attempts = 0;
          chapter.completed_at = undefined;
          chapter.memories_written = undefined;
          chapter.updated_at = nowIso();
          repaired = true;
        }
      }
      if (repaired) {
        sameSnapshot.status = deriveStatus(sameSnapshot);
        sameSnapshot.completed_at = undefined;
        sameSnapshot.updated_at = nowIso();
      }
      result = sameSnapshot;
      return repaired;
    }

    const now = nowIso();
    for (const job of jobs) {
      if (job.status === "queued" || job.status === "running" || job.status === "paused" || job.status === "failed") {
        job.status = "superseded";
        job.updated_at = now;
      }
    }

    const created: MemoryBackfillJob = {
      id: newId(),
      novel_id: novelId,
      project_fingerprint: fingerprint,
      status: "queued",
      chapters: chapters.map((chapter) => {
        const succeeded = ingested.has(`${chapter.number}:${chapter.sourceHash}`);
        return {
          number: chapter.number,
          title: chapter.title,
          source_hash: chapter.sourceHash,
          status: succeeded ? "succeeded" : "queued",
          attempts: succeeded ? 1 : 0,
          max_attempts: MAX_ATTEMPTS,
          updated_at: now,
          completed_at: succeeded ? now : undefined,
        };
      }),
      created_at: now,
      updated_at: now,
    };
    created.status = deriveStatus(created);
    if (created.status === "completed") created.completed_at = now;
    jobs.unshift(created);
    result = created;
    return true;
  });
  if (!result) throw new Error("[backfill] queueMemoryBackfill updater 未执行");
  return result;
}

/** 就地回收过期章节锁与到期重试；返回是否有修改。供锁内复用。 */
function recoverInPlace(jobs: MemoryBackfillJob[]): boolean {
  const currentTime = Date.now();
  let changed = false;
  for (const job of jobs) {
    if (job.status === "paused" || job.status === "superseded" || job.status === "completed") {
      continue;
    }
    for (const chapter of job.chapters) {
      if (
        chapter.status === "running" &&
        chapter.locked_at &&
        currentTime - Date.parse(chapter.locked_at) > STALE_LOCK_MS
      ) {
        chapter.status = "queued";
        chapter.locked_at = undefined;
        chapter.last_error = "检测到上次处理中断，已回收过期章节锁";
        chapter.updated_at = nowIso();
        changed = true;
      } else if (
        chapter.status === "failed" &&
        chapter.attempts < chapter.max_attempts &&
        (!chapter.next_retry_at || Date.parse(chapter.next_retry_at) <= currentTime)
      ) {
        chapter.status = "queued";
        chapter.next_retry_at = undefined;
        chapter.updated_at = nowIso();
        changed = true;
      }
    }
    const nextStatus = deriveStatus(job);
    if (job.status !== nextStatus) {
      job.status = nextStatus;
      job.updated_at = nowIso();
      changed = true;
    }
  }
  return changed;
}

async function recoverStaleWork(novelId: string): Promise<MemoryBackfillJob[]> {
  let snapshot: MemoryBackfillJob[] = [];
  await mutateIsolatedJobs(novelId, (jobs) => {
    const changed = recoverInPlace(jobs);
    snapshot = jobs.map((job) => ({ ...job, chapters: job.chapters.map((item) => ({ ...item })) }));
    return changed;
  });
  return snapshot;
}

/** 回收 + 认领在同一次锁内完成，两个进程不会认领到同一章。 */
async function claimNextChapter(
  novelId: string,
): Promise<{ job: MemoryBackfillJob; chapter: MemoryBackfillChapter } | null> {
  let claim: { job: MemoryBackfillJob; chapter: MemoryBackfillChapter } | null = null;
  await mutateIsolatedJobs(novelId, (jobs) => {
    const changed = recoverInPlace(jobs);
    const job = jobs.find(
      (candidate) =>
        candidate.status !== "paused" &&
        candidate.status !== "superseded" &&
        candidate.status !== "completed" &&
        candidate.chapters.some((chapter) => chapter.status === "queued" && chapter.attempts < chapter.max_attempts),
    );
    if (!job) return changed;
    const chapter = job.chapters.find(
      (candidate) => candidate.status === "queued" && candidate.attempts < candidate.max_attempts,
    );
    if (!chapter) return changed;
    const now = nowIso();
    chapter.status = "running";
    chapter.attempts += 1;
    chapter.locked_at = now;
    chapter.updated_at = now;
    job.status = "running";
    job.updated_at = now;
    claim = {
      job: { ...job, chapters: job.chapters.map((item) => ({ ...item })) },
      chapter: { ...chapter },
    };
    return true;
  });
  return claim;
}

async function updateClaimedChapter(
  novelId: string,
  jobId: string,
  chapterNumber: number,
  updater: (chapter: MemoryBackfillChapter) => void,
): Promise<void> {
  await mutateIsolatedJobs(novelId, (jobs) => {
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job || job.novel_id !== novelId || job.status === "superseded") return false;
    const chapter = job.chapters.find((candidate) => candidate.number === chapterNumber);
    if (!chapter) return false;
    updater(chapter);
    const now = nowIso();
    job.status = deriveStatus(job);
    job.updated_at = now;
    if (job.status === "completed") {
      job.completed_at = now;
    }
    return true;
  });
}

async function completeChapter(
  novelId: string,
  jobId: string,
  chapterNumber: number,
  memoriesWritten: number,
): Promise<void> {
  await updateClaimedChapter(novelId, jobId, chapterNumber, (chapter) => {
    chapter.status = "succeeded";
    chapter.locked_at = undefined;
    chapter.next_retry_at = undefined;
    chapter.last_error = undefined;
    chapter.memories_written = memoriesWritten;
    chapter.completed_at = nowIso();
    chapter.updated_at = nowIso();
  });
}

async function staleChapter(novelId: string, jobId: string, chapterNumber: number): Promise<void> {
  await updateClaimedChapter(novelId, jobId, chapterNumber, (chapter) => {
    chapter.status = "stale";
    chapter.locked_at = undefined;
    chapter.last_error = "章节在提取期间发生变化，旧结果已丢弃";
    chapter.updated_at = nowIso();
  });
}

async function failChapter(novelId: string, jobId: string, chapterNumber: number, error: unknown): Promise<void> {
  await updateClaimedChapter(novelId, jobId, chapterNumber, (chapter) => {
    const delayMinutes = Math.min(60, 5 * 2 ** Math.max(0, chapter.attempts - 1));
    chapter.status = "failed";
    chapter.locked_at = undefined;
    chapter.next_retry_at =
      chapter.attempts < chapter.max_attempts
        ? new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()
        : undefined;
    chapter.last_error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    chapter.updated_at = nowIso();
  });
}

function currentSourceChapter(novelId: string, chapterNumber: number, title: string): SourceChapter | null {
  const content = novelFS.readChapter(novelId, chapterNumber);
  if (content == null || !content.trim()) return null;
  return {
    number: chapterNumber,
    title,
    content,
    sourceHash: hashText(content),
  };
}

export async function runMemoryBackfill(
  novelIdInput: string,
  maxChapters = 2,
): Promise<{
  busy: boolean;
  processed: Array<{ chapter: number; status: "succeeded" | "failed" | "stale"; error?: string }>;
  consolidation: Awaited<ReturnType<typeof runPendingConsolidations>>;
}> {
  const novelId = sanitizeNovelId(novelIdInput);
  if (activeRuns.has(novelId)) return { busy: true, processed: [], consolidation: [] };
  activeRuns.add(novelId);
  const processed: Array<{
    chapter: number;
    status: "succeeded" | "failed" | "stale";
    error?: string;
  }> = [];
  try {
    for (let index = 0; index < Math.max(1, Math.min(5, maxChapters)); index++) {
      const claim = await claimNextChapter(novelId);
      if (!claim) break;
      const source = currentSourceChapter(novelId, claim.chapter.number, claim.chapter.title);
      if (!source || source.sourceHash !== claim.chapter.source_hash) {
        await staleChapter(novelId, claim.job.id, claim.chapter.number);
        await queueMemoryBackfill(novelId);
        processed.push({ chapter: claim.chapter.number, status: "stale" });
        continue;
      }
      try {
        const extraction = await extractChapterMemory(source.number, source.content);
        const current = currentSourceChapter(novelId, source.number, source.title);
        if (!current || current.sourceHash !== claim.chapter.source_hash) {
          await staleChapter(novelId, claim.job.id, source.number);
          await queueMemoryBackfill(novelId);
          processed.push({ chapter: source.number, status: "stale" });
          continue;
        }
        const memory = await ingestChapterMemories(novelId, source.number, source.content, extraction);
        if (!memory.unchanged) await queueAffectedConsolidations(novelId, source.number);
        await completeChapter(novelId, claim.job.id, source.number, memory.inserted);
        processed.push({ chapter: source.number, status: "succeeded" });
      } catch (error) {
        await failChapter(novelId, claim.job.id, source.number, error);
        processed.push({
          chapter: source.number,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const consolidation = processed.some((item) => item.status === "succeeded")
      ? await runPendingConsolidations(novelId, 1)
      : [];
    return { busy: false, processed, consolidation };
  } finally {
    activeRuns.delete(novelId);
  }
}

export async function listMemoryBackfillJobs(novelIdInput: string): Promise<MemoryBackfillJob[]> {
  const novelId = sanitizeNovelId(novelIdInput);
  return (await recoverStaleWork(novelId)).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function pauseMemoryBackfill(novelIdInput: string, jobId?: string): Promise<MemoryBackfillJob | null> {
  const novelId = sanitizeNovelId(novelIdInput);
  let result: MemoryBackfillJob | null = null;
  await mutateIsolatedJobs(novelId, (jobs) => {
    const job = jobId
      ? jobs.find((candidate) => candidate.id === jobId)
      : jobs.find((candidate) => candidate.status === "queued" || candidate.status === "running");
    if (!job || job.status === "completed" || job.status === "superseded") return false;
    job.status = "paused";
    job.updated_at = nowIso();
    result = job;
    return true;
  });
  return result;
}

export async function resumeMemoryBackfill(novelIdInput: string, jobId?: string): Promise<MemoryBackfillJob | null> {
  const novelId = sanitizeNovelId(novelIdInput);
  let result: MemoryBackfillJob | null = null;
  await mutateIsolatedJobs(novelId, (jobs) => {
    const job = jobId
      ? jobs.find((candidate) => candidate.id === jobId)
      : jobs.find((candidate) => candidate.status === "paused" || candidate.status === "failed");
    if (!job || job.status === "completed" || job.status === "superseded") return false;
    for (const chapter of job.chapters) {
      if (chapter.status === "failed" && chapter.attempts < chapter.max_attempts) {
        chapter.status = "queued";
        chapter.next_retry_at = undefined;
        chapter.updated_at = nowIso();
      }
    }
    job.status = deriveStatus({ ...job, status: "queued" });
    job.updated_at = nowIso();
    result = job;
    return true;
  });
  return result;
}

export async function retryMemoryBackfillFailures(
  novelIdInput: string,
  jobId?: string,
): Promise<MemoryBackfillJob | null> {
  const novelId = sanitizeNovelId(novelIdInput);
  let result: MemoryBackfillJob | null = null;
  await mutateIsolatedJobs(novelId, (jobs) => {
    const job = jobId
      ? jobs.find((candidate) => candidate.id === jobId)
      : jobs.find((candidate) => candidate.status === "failed");
    if (!job || job.status === "superseded") return false;
    for (const chapter of job.chapters) {
      if (chapter.status !== "failed") continue;
      chapter.status = "queued";
      chapter.attempts = 0;
      chapter.next_retry_at = undefined;
      chapter.last_error = undefined;
      chapter.updated_at = nowIso();
    }
    job.status = deriveStatus({ ...job, status: "queued" });
    job.completed_at = undefined;
    job.updated_at = nowIso();
    result = job;
    return true;
  });
  return result;
}
