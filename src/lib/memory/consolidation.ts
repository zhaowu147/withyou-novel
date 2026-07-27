/**
 * 小说版 Dream：将章节级记忆增量归并为 5 章剧情块和 10 章阶段摘要。
 *
 * 任务状态单独落盘；失败不影响正文，后续章节保存会自动重试。
 */
import "server-only";

import { gatewayCall } from "@/lib/ai/gateway";
import { wrapUntrustedData } from "@/lib/ai/prompt-boundary";
import { newId, nowIso, readCollection, updateCollection } from "@/lib/local/json-db";
import { listChapterFiles } from "@/lib/local/store";
import { listNovelMemories, type NovelMemory, upsertDerivedMemory } from "@/lib/memory/novel-memory";
import {
  canFeed,
  DERIVED_ARTIFACT_ROOT,
  depthForMemoryKind,
  depthOfMemory,
  derivedArtifactBanner,
} from "@/lib/memory/provenance";
import { novelFS } from "@/lib/novel-fs";

import { createHash } from "node:crypto";

export type ConsolidationKind = "block" | "stage";
export type ConsolidationStatus = "queued" | "running" | "succeeded" | "failed";

export interface MemoryConsolidationJob {
  id: string;
  novel_id: string;
  kind: ConsolidationKind;
  chapter_start: number;
  chapter_end: number;
  input_hash: string;
  status: ConsolidationStatus;
  attempts: number;
  max_attempts: number;
  locked_at?: string;
  next_retry_at?: string;
  last_error?: string;
  output_memory_id?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface ConsolidationOutput {
  title?: string;
  summary?: string;
  causalChain?: string[];
  keyEvents?: string[];
  stateChanges?: string[];
  relationshipChanges?: string[];
  factionChanges?: string[];
  abilityItemChanges?: string[];
  foreshadows?: string[];
  unresolvedConflicts?: string[];
  nextBridge?: string[];
  entities?: string[];
  keywords?: string[];
}

const JOB_COLLECTION = "memory_consolidation_jobs";
const STALE_LOCK_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function readConsolidationJobs(novelId: string): MemoryConsolidationJob[] {
  return readCollection<MemoryConsolidationJob>(novelId, JOB_COLLECTION).filter((job) => job?.novel_id === novelId);
}

const CONSOLIDATION_PROMPT = `你是长篇小说的增量记忆整理器。输入仅包含一个有限章节区间的章节记忆、必要的章节兜底摘录，以及可选的上一阶段承接。

你的任务是整理事实，不续写、不猜测、不评价文笔。严格输出 JSON：
{
  "title": "本区间简短标题",
  "summary": "本区间剧情总述",
  "causalChain": ["原因→行动→结果"],
  "keyEvents": ["关键事件"],
  "stateChanges": ["人物状态变化"],
  "relationshipChanges": ["关系变化"],
  "factionChanges": ["势力变化"],
  "abilityItemChanges": ["能力或物品变化"],
  "foreshadows": ["新增、激活或回收的伏笔"],
  "unresolvedConflicts": ["仍未解决的冲突"],
  "nextBridge": ["下一阶段必须承接的状态或问题"],
  "entities": ["核心人物、势力、地点、物品"],
  "keywords": ["检索关键词"]
}

要求：
- 每条事实必须能由输入追溯，不得补写输入中没有的设定。
- 合并重复表述，但保留因果、状态转折和未解决问题。
- 人物误解、谎言和传闻要保留其信息来源，不能当成客观事实。
- 若输入不足，相应数组返回空数组，不得编造。`;

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function rangePath(kind: ConsolidationKind, start: number, end: number): string {
  const left = String(start).padStart(3, "0");
  const right = String(end).padStart(3, "0");
  const sub = kind === "block" ? "剧情块" : "阶段";
  return `${DERIVED_ARTIFACT_ROOT}${sub}/第${left}-${right}章.md`;
}

function jobInputHash(novelId: string, start: number, end: number): string {
  const chapters = listChapterFiles(novelId)
    .filter((chapter) => chapter.number >= start && chapter.number <= end)
    .sort((a, b) => a.number - b.number)
    .map((chapter) => ({
      number: chapter.number,
      title: chapter.title,
      contentHash: hashText(chapter.content),
    }));
  return hashText(JSON.stringify(chapters));
}

async function enqueueRange(
  novelId: string,
  kind: ConsolidationKind,
  start: number,
  end: number,
): Promise<MemoryConsolidationJob> {
  // 输入指纹要读章节文件，放锁外算好。
  const inputHash = jobInputHash(novelId, start, end);
  const now = nowIso();
  let result: MemoryConsolidationJob | null = null;
  await updateCollection<MemoryConsolidationJob>(novelId, JOB_COLLECTION, (allRows) => {
    const rows = allRows.filter((job) => job?.novel_id === novelId);
    const existingIndex = rows.findIndex(
      (job) => job.kind === kind && job.chapter_start === start && job.chapter_end === end,
    );
    if (existingIndex >= 0) {
      const existing = rows[existingIndex];
      if (existing.input_hash === inputHash && existing.status === "succeeded") {
        result = existing;
        return null;
      }
      if (existing.input_hash === inputHash && (existing.status === "queued" || existing.status === "running")) {
        result = existing;
        return null;
      }
      const refreshed: MemoryConsolidationJob = {
        ...existing,
        input_hash: inputHash,
        status: "queued",
        attempts: existing.input_hash === inputHash ? existing.attempts : 0,
        locked_at: undefined,
        next_retry_at: undefined,
        last_error: undefined,
        output_memory_id: undefined,
        completed_at: undefined,
        updated_at: now,
      };
      rows[existingIndex] = refreshed;
      result = refreshed;
      return rows;
    }

    const created: MemoryConsolidationJob = {
      id: newId(),
      novel_id: novelId,
      kind,
      chapter_start: start,
      chapter_end: end,
      input_hash: inputHash,
      status: "queued",
      attempts: 0,
      max_attempts: MAX_ATTEMPTS,
      created_at: now,
      updated_at: now,
    };
    rows.push(created);
    result = created;
    return rows;
  });
  if (!result) throw new Error("[consolidation] enqueueRange updater 未执行");
  return result;
}

/**
 * 新章或旧章重写后，只让受影响的 5/10 章区间失效并重新排队。
 */
export async function queueAffectedConsolidations(
  novelId: string,
  changedChapter: number,
): Promise<MemoryConsolidationJob[]> {
  const latest = listChapterFiles(novelId).reduce((max, chapter) => Math.max(max, chapter.number), 0);
  const queued: MemoryConsolidationJob[] = [];
  const blockStart = Math.floor((changedChapter - 1) / 5) * 5 + 1;
  const blockEnd = blockStart + 4;
  if (latest >= blockEnd) queued.push(await enqueueRange(novelId, "block", blockStart, blockEnd));

  const stageStart = Math.floor((changedChapter - 1) / 10) * 10 + 1;
  const stageEnd = stageStart + 9;
  if (latest >= stageEnd) queued.push(await enqueueRange(novelId, "stage", stageStart, stageEnd));
  return queued;
}

/**
 * 回收过期锁 + 认领下一个任务，整体在一次锁内完成：
 * 两个进程同时 claim 时只有一个能拿到同一个 job（旧实现 recover 与 claim
 * 分两次写，之间有竞态窗口）。
 */
async function claimNextJob(novelId: string): Promise<MemoryConsolidationJob | null> {
  const nowMs = Date.now();
  let claimed: MemoryConsolidationJob | null = null;
  await updateCollection<MemoryConsolidationJob>(novelId, JOB_COLLECTION, (allRows) => {
    const rows = allRows.filter((job) => job?.novel_id === novelId);
    let changed = false;
    for (const job of rows) {
      if (job.status === "running" && job.locked_at && nowMs - Date.parse(job.locked_at) > STALE_LOCK_MS) {
        job.status = "queued";
        job.locked_at = undefined;
        job.last_error = "检测到上次处理中断，已回收过期任务锁";
        job.updated_at = nowIso();
        changed = true;
      } else if (
        job.status === "failed" &&
        job.attempts < job.max_attempts &&
        (!job.next_retry_at || Date.parse(job.next_retry_at) <= nowMs)
      ) {
        job.status = "queued";
        job.updated_at = nowIso();
        changed = true;
      }
    }

    const runnable = rows
      .filter((job) => job.status === "queued" && job.attempts < job.max_attempts)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "block" ? -1 : 1;
        return a.chapter_start - b.chapter_start;
      })[0];
    if (!runnable) return changed ? rows : null;
    const index = rows.findIndex((job) => job.id === runnable.id);
    const next: MemoryConsolidationJob = {
      ...runnable,
      status: "running",
      attempts: runnable.attempts + 1,
      locked_at: nowIso(),
      updated_at: nowIso(),
    };
    rows[index] = next;
    claimed = next;
    return rows;
  });
  return claimed;
}

function chapterMemories(memories: NovelMemory[], start: number, end: number, outputDepth: number): NovelMemory[] {
  return memories
    .filter(
      (memory) =>
        memory.status === "active" &&
        memory.source.type === "chapter" &&
        (memory.source.chapter ?? 0) >= start &&
        (memory.source.chapter ?? 0) <= end &&
        canFeed(depthOfMemory(memory), outputDepth),
    )
    .sort((a, b) => (a.source.chapter ?? 0) - (b.source.chapter ?? 0));
}

function chapterMemoryLine(memory: NovelMemory): string {
  return `- 第${memory.source.chapter}章 [${memory.tier}/${memory.kind}] ${memory.content}`;
}

function fallbackChapterLines(novelId: string, start: number, end: number, existingLines: string[]): string[] {
  const represented = new Set(
    existingLines.map((line) => Number(line.match(/第(\d+)章/)?.[1])).filter((value) => Number.isFinite(value)),
  );
  return listChapterFiles(novelId)
    .filter((chapter) => chapter.number >= start && chapter.number <= end && !represented.has(chapter.number))
    .map((chapter) => {
      const normalized = chapter.content.replace(/\s+/g, " ").trim();
      const excerpt =
        normalized.length <= 1_000 ? normalized : `${normalized.slice(0, 600)} … ${normalized.slice(-400)}`;
      return `- 第${chapter.number}章「${chapter.title}」兜底摘录：${excerpt}`;
    });
}

/**
 * 上一阶段承接。
 *
 * 旧实现读的是上一个 stage_summary —— 那是 depth 2，与本次产出同深，等于
 * 「阶段摘要接着阶段摘要写」，一路传下去就是摘要的摘要的摘要，是本项目唯一
 * 会自我放大的污染路径。改为读上一阶段末尾的 block_summary（depth 1）：
 * 承接信息量相当，但层级严格低于产出，链条到此为止。
 */
function previousStageContext(memories: NovelMemory[], start: number, outputDepth: number): NovelMemory | null {
  return (
    memories
      .filter(
        (memory) =>
          memory.status === "active" &&
          memory.kind === "block_summary" &&
          (memory.chapter_end ?? 0) < start &&
          canFeed(depthOfMemory(memory), outputDepth),
      )
      .sort((a, b) => (b.chapter_end ?? 0) - (a.chapter_end ?? 0))[0] ?? null
  );
}

/** 一次归并要用哪些记忆。层级约束全部在这里执行，不掺 IO，便于单测直接打。 */
export interface ConsolidationInputSelection {
  /** 本次归并产出的层级 */
  outputDepth: number;
  /** 区间内的章节级事实 */
  chapterRows: NovelMemory[];
  /** 阶段汇总才有：区间内已生成的剧情块 */
  blockRows: NovelMemory[];
  /** 阶段汇总才有：上一阶段的承接来源 */
  previous: NovelMemory | null;
}

export type ConsolidationRange = Pick<MemoryConsolidationJob, "kind" | "chapter_start" | "chapter_end">;

/**
 * 挑选归并输入。纯函数：给定记忆全集与区间，产出可用的输入。
 * 唯一的硬规矩是 `canFeed(输入层级, 产出层级)` —— 等深或更深的一律不采纳。
 */
export function selectConsolidationInputs(
  memories: NovelMemory[],
  job: ConsolidationRange,
): ConsolidationInputSelection {
  const outputDepth = depthForMemoryKind(job.kind === "block" ? "block_summary" : "stage_summary");
  const chapterRows = chapterMemories(memories, job.chapter_start, job.chapter_end, outputDepth);
  const blockRows =
    job.kind === "stage"
      ? memories
          .filter(
            (memory) =>
              memory.status === "active" &&
              memory.kind === "block_summary" &&
              (memory.chapter_start ?? 0) >= job.chapter_start &&
              (memory.chapter_end ?? 0) <= job.chapter_end &&
              canFeed(depthOfMemory(memory), outputDepth),
          )
          .sort((a, b) => (a.chapter_start ?? 0) - (b.chapter_start ?? 0))
      : [];
  const previous = job.kind === "stage" ? previousStageContext(memories, job.chapter_start, outputDepth) : null;
  return { outputDepth, chapterRows, blockRows, previous };
}

/** 归并输入 + 实际用到的记忆 id（写进产出的 provenance.derived_from 供追溯）。 */
interface JobInput {
  text: string;
  derivedFrom: string[];
}

function buildJobInput(novelId: string, job: MemoryConsolidationJob): JobInput {
  const memories = listNovelMemories(novelId);
  const { chapterRows, blockRows, previous } = selectConsolidationInputs(memories, job);
  const chapterLines = chapterRows.map(chapterMemoryLine);
  const fallbackLines = fallbackChapterLines(novelId, job.chapter_start, job.chapter_end, chapterLines);
  const blockLines = blockRows.map(
    (memory) => `## 剧情块 ${memory.chapter_start}-${memory.chapter_end}\n${memory.content}`,
  );
  const text = [
    `任务类型：${job.kind === "block" ? "5章剧情块" : "10章阶段汇总"}`,
    `章节范围：第${job.chapter_start}章至第${job.chapter_end}章`,
    previous
      ? `上一阶段承接（第${previous.chapter_start}-${previous.chapter_end}章剧情块）：\n${previous.content.slice(-3_000)}`
      : "",
    blockLines.length ? `已生成剧情块：\n${blockLines.join("\n\n")}` : "",
    `章节级事实：\n${[...chapterLines, ...fallbackLines].join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const derivedFrom = [...chapterRows, ...blockRows, ...(previous ? [previous] : [])].map((memory) => memory.id);
  return { text, derivedFrom };
}

function parseOutput(raw: string): ConsolidationOutput {
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as ConsolidationOutput;
  if (!parsed.summary?.trim()) throw new Error("阶段整理结果缺少 summary");
  return parsed;
}

function stringList(value: unknown, max = 40): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function renderOutput(job: MemoryConsolidationJob, output: ConsolidationOutput, depth: number): string {
  const sections: Array<[string, string[]]> = [
    ["章节因果链", stringList(output.causalChain)],
    ["关键事件", stringList(output.keyEvents)],
    ["人物状态变化", stringList(output.stateChanges)],
    ["关系变化", stringList(output.relationshipChanges)],
    ["势力变化", stringList(output.factionChanges)],
    ["能力与物品变化", stringList(output.abilityItemChanges)],
    ["伏笔变化", stringList(output.foreshadows)],
    ["未解决冲突", stringList(output.unresolvedConflicts)],
    ["下一阶段承接", stringList(output.nextBridge)],
  ];
  const body = [
    `# ${output.title?.trim() || `第${job.chapter_start}-${job.chapter_end}章派生记忆`}`,
    "",
    derivedArtifactBanner(depth),
    `> 来源章节：第${job.chapter_start}章—第${job.chapter_end}章`,
    `> 输入版本：${job.input_hash}`,
    `> 生成时间：${nowIso()}`,
    "",
    "## 剧情总述",
    output.summary?.trim() ?? "",
  ];
  for (const [title, items] of sections) {
    body.push("", `## ${title}`, ...(items.length ? items.map((item) => `- ${item}`) : ["- 无"]));
  }
  return body.join("\n");
}

async function completeJob(novelId: string, jobId: string, outputMemoryId: string): Promise<void> {
  await updateCollection<MemoryConsolidationJob>(novelId, JOB_COLLECTION, (allRows) => {
    const rows = allRows.filter((job) => job?.novel_id === novelId);
    const index = rows.findIndex((job) => job.id === jobId);
    if (index < 0) return null;
    rows[index] = {
      ...rows[index],
      status: "succeeded",
      output_memory_id: outputMemoryId,
      locked_at: undefined,
      next_retry_at: undefined,
      last_error: undefined,
      completed_at: nowIso(),
      updated_at: nowIso(),
    };
    return rows;
  });
}

async function failJob(novelId: string, jobId: string, error: unknown): Promise<void> {
  await updateCollection<MemoryConsolidationJob>(novelId, JOB_COLLECTION, (allRows) => {
    const rows = allRows.filter((job) => job?.novel_id === novelId);
    const index = rows.findIndex((job) => job.id === jobId);
    if (index < 0) return null;
    const job = rows[index];
    const delayMinutes = Math.min(60, 5 * 2 ** Math.max(0, job.attempts - 1));
    rows[index] = {
      ...job,
      status: "failed",
      locked_at: undefined,
      next_retry_at:
        job.attempts < job.max_attempts ? new Date(Date.now() + delayMinutes * 60 * 1000).toISOString() : undefined,
      last_error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      updated_at: nowIso(),
    };
    return rows;
  });
}

async function executeJob(novelId: string, job: MemoryConsolidationJob): Promise<string> {
  const kind = job.kind === "block" ? "block_summary" : "stage_summary";
  const depth = depthForMemoryKind(kind);
  const input = buildJobInput(novelId, job);
  const raw = await gatewayCall({
    channel: "tool",
    systemPrompt: CONSOLIDATION_PROMPT,
    messages: [
      {
        role: "user",
        content: wrapUntrustedData("novel_memory_range", input.text),
      },
    ],
    maxTokens: 4_096,
    temperature: 0.1,
  });
  const output = parseOutput(raw);
  const markdown = renderOutput(job, output, depth);
  const path = rangePath(job.kind, job.chapter_start, job.chapter_end);
  novelFS.writeFileAtomic(novelId, path, markdown);
  const latestChapter = listChapterFiles(novelId).reduce((max, chapter) => Math.max(max, chapter.number), 0);
  if (job.kind === "block" && job.chapter_end === latestChapter) {
    novelFS.writeFileAtomic(novelId, `${DERIVED_ARTIFACT_ROOT}当前状态.md`, markdown);
  }
  const memory = await upsertDerivedMemory({
    novelId,
    kind,
    content: markdown,
    path,
    inputHash: job.input_hash,
    chapterStart: job.chapter_start,
    chapterEnd: job.chapter_end,
    entities: stringList(output.entities),
    keywords: stringList(output.keywords),
    derivedFrom: input.derivedFrom,
  });
  return memory.id;
}

export async function runPendingConsolidations(
  novelId: string,
  maxJobs = 2,
): Promise<Array<{ jobId: string; status: "succeeded" | "failed"; error?: string }>> {
  const results: Array<{ jobId: string; status: "succeeded" | "failed"; error?: string }> = [];
  for (let index = 0; index < maxJobs; index++) {
    const job = await claimNextJob(novelId);
    if (!job) break;
    try {
      const memoryId = await executeJob(novelId, job);
      await completeJob(novelId, job.id, memoryId);
      results.push({ jobId: job.id, status: "succeeded" });
    } catch (error) {
      await failJob(novelId, job.id, error);
      results.push({
        jobId: job.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function listConsolidationJobs(novelId: string): MemoryConsolidationJob[] {
  return readConsolidationJobs(novelId).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function retryConsolidationJob(novelId: string, jobId: string): Promise<MemoryConsolidationJob | null> {
  let result: MemoryConsolidationJob | null = null;
  await updateCollection<MemoryConsolidationJob>(novelId, JOB_COLLECTION, (allRows) => {
    const rows = allRows.filter((job) => job?.novel_id === novelId);
    const index = rows.findIndex((job) => job.id === jobId);
    if (index < 0) return null;
    const retried: MemoryConsolidationJob = {
      ...rows[index],
      status: "queued",
      attempts: 0,
      locked_at: undefined,
      next_retry_at: undefined,
      last_error: undefined,
      completed_at: undefined,
      updated_at: nowIso(),
    };
    rows[index] = retried;
    result = retried;
    return rows;
  });
  return result;
}
