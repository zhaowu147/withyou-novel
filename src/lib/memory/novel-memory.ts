/**
 * 每部小说独立的分层记忆库。
 *
 * 正文章节与用户手写设定始终是事实源；本文件只保存可回溯的派生记忆。
 * 当前使用项目内 JSON 持久化，数据结构与检索接口保持独立，后续可平滑迁移到 SQLite。
 */
import "server-only";

import { newId, nowIso, readCollection, updateCollection } from "@/lib/local/json-db";
import { getNovel } from "@/lib/local/store";
import { searchMemoryIndex } from "@/lib/memory/memory-index";
import {
  AUTHOR_FACT_DEPTH,
  depthForMemoryKind,
  depthOfMemory,
  isDerivedArtifactPath,
  type MemoryProvenance,
} from "@/lib/memory/provenance";
import { novelFS } from "@/lib/novel-fs";

import { createHash } from "node:crypto";

export type NovelMemoryTier = "canonical" | "long" | "short";
export type NovelMemoryStatus = "active" | "candidate" | "superseded" | "expired" | "rejected";
export type NovelMemoryKind =
  | "outline"
  | "setting"
  | "style"
  | "event"
  | "character_state"
  | "relationship"
  | "location"
  | "faction"
  | "item"
  | "ability"
  | "foreshadow"
  | "conflict"
  | "chapter_summary"
  | "block_summary"
  | "stage_summary"
  | "other";

export interface NovelMemorySource {
  type: "chapter" | "project_file" | "metadata" | "derived";
  chapter?: number;
  path?: string;
  content_hash: string;
  excerpt?: string;
}

export interface NovelMemory {
  id: string;
  novel_id: string;
  tier: NovelMemoryTier;
  kind: NovelMemoryKind;
  content: string;
  entities: string[];
  keywords: string[];
  importance: "high" | "mid" | "low";
  confidence: number;
  status: NovelMemoryStatus;
  source: NovelMemorySource;
  /**
   * 来源层级。0 = 作者事实，≥1 = AI 派生（详见 @/lib/memory/provenance）。
   * 可选：升级前写入的旧记录没有这个字段，读取一律走 depthOfMemory 兜底。
   */
  provenance?: MemoryProvenance;
  chapter_start?: number;
  chapter_end?: number;
  expires_after_chapter?: number;
  created_at: string;
  updated_at: string;
}

export interface ExtractedNovelMemory {
  tier?: NovelMemoryTier;
  kind?: NovelMemoryKind;
  content?: string;
  entities?: string[];
  keywords?: string[];
  importance?: "high" | "mid" | "low";
  confidence?: number;
  ttlChapters?: number;
  evidence?: string;
}

export interface ChapterMemoryExtraction {
  summary?: string;
  memories?: ExtractedNovelMemory[];
}

export interface AgentMemoryCandidateInput extends ExtractedNovelMemory {
  sourcePath?: string;
}

export interface MemoryRecallResult {
  canonical: NovelMemory[];
  long: NovelMemory[];
  short: NovelMemory[];
  expandedEntities: string[];
}

const MEMORY_COLLECTION = "memories";
const CANONICAL_FILES: Array<{
  path: string;
  kind: NovelMemoryKind;
}> = [
  { path: "设定/核心设定.md", kind: "setting" },
  { path: "设定/世界观/世界设定.md", kind: "setting" },
  { path: "设定/角色/角色设定.md", kind: "setting" },
  { path: "设定/金手指.md", kind: "setting" },
  { path: "大纲/总纲.md", kind: "outline" },
  { path: "大纲/细纲.md", kind: "outline" },
];

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function compactText(text: string, max = 4_000): string {
  return text.replace(/\r\n/g, "\n").trim().slice(0, max);
}

function normalizeList(values: unknown, max = 12): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).slice(0, max);
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function isTier(value: unknown): value is NovelMemoryTier {
  return value === "canonical" || value === "long" || value === "short";
}

function isKind(value: unknown): value is NovelMemoryKind {
  return [
    "outline",
    "setting",
    "style",
    "event",
    "character_state",
    "relationship",
    "location",
    "faction",
    "item",
    "ability",
    "foreshadow",
    "conflict",
    "chapter_summary",
    "block_summary",
    "stage_summary",
    "other",
  ].includes(String(value));
}

export async function initializeNovelMemory(novelId: string): Promise<void> {
  await updateCollection<NovelMemory>(novelId, MEMORY_COLLECTION, (rows) => (rows.length === 0 ? rows : null));
  await syncCanonicalMemories(novelId);
}

export function listNovelMemories(novelId: string): NovelMemory[] {
  // 即便导入文件中夹带了其他作品的记忆记录，也绝不让其进入当前作品召回。
  return readCollection<NovelMemory>(novelId, MEMORY_COLLECTION).filter((memory) => memory?.novel_id === novelId);
}

export async function upsertDerivedMemory(input: {
  novelId: string;
  kind: "block_summary" | "stage_summary";
  content: string;
  path: string;
  inputHash: string;
  chapterStart: number;
  chapterEnd: number;
  entities?: string[];
  keywords?: string[];
  /** 归并时实际用到的记忆 id，写进 provenance 供人工追溯 */
  derivedFrom?: string[];
}): Promise<NovelMemory> {
  const now = nowIso();
  const provenance: MemoryProvenance = {
    depth: depthForMemoryKind(input.kind),
    derived_from: input.derivedFrom?.length ? input.derivedFrom.slice(0, 200) : undefined,
  };
  const content = compactText(input.content, 12_000);
  let result: NovelMemory | null = null;
  await updateCollection<NovelMemory>(input.novelId, MEMORY_COLLECTION, (allRows) => {
    const rows = allRows.filter((memory) => memory?.novel_id === input.novelId);
    const existing = rows.filter(
      (row) => row.source.type === "derived" && row.source.path === input.path && row.kind === input.kind,
    );
    const unchanged = existing.find((row) => row.source.content_hash === input.inputHash && row.status === "active");
    if (unchanged) {
      result = unchanged;
      return null;
    }
    for (const row of existing) {
      if (row.status === "active") {
        row.status = "superseded";
        row.updated_at = now;
      }
    }
    const created: NovelMemory = {
      id: newId(),
      novel_id: input.novelId,
      tier: "long",
      kind: input.kind,
      content,
      entities: normalizeList(input.entities, 40),
      keywords: normalizeList(input.keywords, 40),
      importance: "high",
      confidence: 1,
      status: "active",
      source: {
        type: "derived",
        path: input.path,
        content_hash: input.inputHash,
        excerpt: content.slice(0, 240),
      },
      provenance,
      chapter_start: input.chapterStart,
      chapter_end: input.chapterEnd,
      created_at: now,
      updated_at: now,
    };
    rows.push(created);
    result = created;
    return rows;
  });
  if (!result) throw new Error("[novel-memory] upsertDerivedMemory updater 未执行");
  return result;
}

export async function updateNovelMemory(
  novelId: string,
  memoryId: string,
  patch: Partial<Pick<NovelMemory, "tier" | "kind" | "content" | "entities" | "keywords" | "importance" | "status">>,
): Promise<NovelMemory | null> {
  let result: NovelMemory | null = null;
  await updateCollection<NovelMemory>(novelId, MEMORY_COLLECTION, (allRows) => {
    const rows = allRows.filter((memory) => memory?.novel_id === novelId);
    const index = rows.findIndex((row) => row.id === memoryId);
    if (index < 0) return null;
    const current = rows[index];
    const content = typeof patch.content === "string" ? compactText(patch.content, 4_000) : current.content;
    if (!content) return null;
    const next: NovelMemory = {
      ...current,
      tier: isTier(patch.tier) ? patch.tier : current.tier,
      kind: isKind(patch.kind) ? patch.kind : current.kind,
      content,
      entities: patch.entities ? normalizeList(patch.entities) : current.entities,
      keywords: patch.keywords ? normalizeList(patch.keywords) : current.keywords,
      importance:
        patch.importance === "high" || patch.importance === "mid" || patch.importance === "low"
          ? patch.importance
          : current.importance,
      status:
        patch.status === "active" ||
        patch.status === "candidate" ||
        patch.status === "superseded" ||
        patch.status === "expired" ||
        patch.status === "rejected"
          ? patch.status
          : current.status,
      updated_at: nowIso(),
    };
    rows[index] = next;
    result = next;
    return rows;
  });
  return result;
}

/**
 * 将文件树中稳定设定同步为规范记忆。相同来源内容不重复写入，修改后保留旧版本。
 * 文件树/元数据读取在锁外完成，锁内只做集合合并。
 */
export async function syncCanonicalMemories(novelId: string): Promise<number> {
  const now = nowIso();

  const sources: Array<{
    key: string;
    content: string;
    kind: NovelMemoryKind;
    source: NovelMemorySource;
  }> = [];

  for (const item of CANONICAL_FILES) {
    // 护栏：规范记忆＝作者事实，派生产物（派生记忆/*.md）绝不能从这条路径回流成
    // depth 0。CANONICAL_FILES 目前是白名单，这里挡的是未来有人往里加派生路径。
    if (isDerivedArtifactPath(item.path)) {
      console.error(`[novel-memory] 拒绝把派生产物当作规范记忆同步：${item.path}`);
      continue;
    }
    try {
      const content = compactText(novelFS.readFile(novelId, item.path) ?? "");
      if (!content || content.replace(/^#.*$/gm, "").trim().length < 4) continue;
      sources.push({
        key: `project_file:${item.path}`,
        content,
        kind: item.kind,
        source: {
          type: "project_file",
          path: item.path,
          content_hash: hashText(content),
          excerpt: content.slice(0, 240),
        },
      });
    } catch {
      // 文件不存在时跳过，项目仍可继续使用其他来源。
    }
  }

  const meta = getNovel(novelId)?.metadata ?? {};
  const metadataFields: Array<[string, NovelMemoryKind]> = [
    ["outline", "outline"],
    ["detailedOutline", "outline"],
    ["characters", "setting"],
    ["worldview", "setting"],
    ["goldfinger", "setting"],
  ];
  for (const [field, kind] of metadataFields) {
    const content = compactText(typeof meta[field] === "string" ? meta[field] : "");
    if (!content) continue;
    sources.push({
      key: `metadata:${field}`,
      content,
      kind,
      source: {
        type: "metadata",
        path: field,
        content_hash: hashText(content),
        excerpt: content.slice(0, 240),
      },
    });
  }

  let changed = 0;
  await updateCollection<NovelMemory>(novelId, MEMORY_COLLECTION, (allRows) => {
    const rows = allRows.filter((memory) => memory?.novel_id === novelId);
    changed = 0;
    for (const item of sources) {
      const sameSource = rows.filter((row) => {
        const key = `${row.source.type}:${row.source.path ?? ""}`;
        return key === item.key && row.tier === "canonical";
      });
      if (sameSource.some((row) => row.source.content_hash === item.source.content_hash && row.status === "active")) {
        continue;
      }
      for (const old of sameSource) {
        if (old.status === "active") {
          old.status = "superseded";
          old.updated_at = now;
        }
      }
      rows.push({
        id: newId(),
        novel_id: novelId,
        tier: "canonical",
        kind: item.kind,
        content: item.content,
        entities: [],
        keywords: [],
        importance: "high",
        confidence: 1,
        status: "active",
        source: item.source,
        // 直接来自手写设定文件 / 项目元数据，是作者事实本身。
        provenance: { depth: AUTHOR_FACT_DEPTH },
        created_at: now,
        updated_at: now,
      });
      changed++;
    }
    return changed > 0 ? rows : null;
  });
  return changed;
}

/**
 * 保存章节后，将模型提取结果落入短期/长期记忆。
 * 从正文推断出的 canonical 只进入候选区，避免模型静默改写用户设定。
 */
export async function ingestChapterMemories(
  novelId: string,
  chapter: number,
  chapterText: string,
  extraction: ChapterMemoryExtraction,
): Promise<{ inserted: number; candidates: number; unchanged: boolean }> {
  const sourceHash = hashText(chapterText);
  const now = nowIso();

  // 候选列表在锁外构建（纯计算），锁内只做去重、失效标记与合并。
  const input: ExtractedNovelMemory[] = [];
  const summary = compactText(extraction.summary ?? "", 240);
  if (summary) {
    input.push({
      tier: "short",
      kind: "chapter_summary",
      content: summary,
      importance: "high",
      confidence: 1,
      ttlChapters: 5,
      evidence: chapterText.slice(0, 160),
    });
  }
  input.push(...(Array.isArray(extraction.memories) ? extraction.memories : []).slice(0, 16));

  let outcome = { inserted: 0, candidates: 0, unchanged: false };
  await updateCollection<NovelMemory>(novelId, MEMORY_COLLECTION, (allRows) => {
    const rows = allRows.filter((memory) => memory?.novel_id === novelId);
    const sameVersion = rows.some(
      (row) =>
        row.source.type === "chapter" &&
        row.source.chapter === chapter &&
        row.source.content_hash === sourceHash &&
        (row.status === "active" || row.status === "candidate"),
    );
    if (sameVersion) {
      outcome = { inserted: 0, candidates: 0, unchanged: true };
      return null;
    }

    for (const row of rows) {
      if (
        row.source.type === "chapter" &&
        row.source.chapter === chapter &&
        (row.status === "active" || row.status === "candidate")
      ) {
        row.status = "superseded";
        row.updated_at = now;
      } else if (
        row.tier === "short" &&
        row.status === "active" &&
        row.expires_after_chapter != null &&
        row.expires_after_chapter < chapter
      ) {
        row.status = "expired";
        row.updated_at = now;
      }
    }

    let inserted = 0;
    let candidates = 0;
    for (const candidate of input) {
      const content = compactText(candidate.content ?? "", 320);
      if (!content) continue;
      const tier = isTier(candidate.tier) ? candidate.tier : "short";
      const ttl = tier === "short" ? Math.max(1, Math.min(12, Math.round(candidate.ttlChapters ?? 5))) : undefined;
      const status: NovelMemoryStatus = tier === "canonical" ? "candidate" : "active";
      rows.push({
        id: newId(),
        novel_id: novelId,
        tier,
        kind: isKind(candidate.kind) ? candidate.kind : "other",
        content,
        entities: normalizeList(candidate.entities),
        keywords: normalizeList(candidate.keywords),
        importance: candidate.importance === "high" || candidate.importance === "low" ? candidate.importance : "mid",
        confidence: clampConfidence(candidate.confidence),
        status,
        source: {
          type: "chapter",
          chapter,
          content_hash: sourceHash,
          excerpt: compactText(candidate.evidence ?? "", 180) || content,
        },
        // depth 0：虽由模型抽取，但只离作者正文一跳，且章节内容一变就整批作废重抽
        // （见上面的 sourceHash 判重），不会跨轮累积，因此不构成自我放大。
        provenance: { depth: AUTHOR_FACT_DEPTH },
        chapter_start: chapter,
        chapter_end: chapter,
        expires_after_chapter: ttl == null ? undefined : chapter + ttl,
        created_at: now,
        updated_at: now,
      });
      inserted++;
      if (status === "candidate") candidates++;
    }

    outcome = { inserted, candidates, unchanged: false };
    return rows;
  });
  return outcome;
}

/**
 * Memory Agent 的结构化候选暂存。
 *
 * 与章节自动追踪不同：Agent 可能综合多个文件和记忆做判断，因此所有条目一律
 * 先以 candidate + derived depth=1 保存。只有用户通过记忆接口明确批准后才会
 * 变为 active；在此之前 retrieveNovelMemories 不会召回它们。
 */
export async function stageAgentMemoryCandidates(input: {
  novelId: string;
  runId: string;
  currentChapter?: number;
  candidates: AgentMemoryCandidateInput[];
}): Promise<NovelMemory[]> {
  const now = nowIso();
  const prepared = input.candidates.slice(0, 24);
  const created: NovelMemory[] = [];
  await updateCollection<NovelMemory>(input.novelId, MEMORY_COLLECTION, (allRows) => {
    const rows = allRows.filter((memory) => memory?.novel_id === input.novelId);
    for (const candidate of prepared) {
      const content = compactText(candidate.content ?? "", 500);
      if (!content) continue;
      const tier = isTier(candidate.tier) ? candidate.tier : "long";
      const kind = isKind(candidate.kind) ? candidate.kind : "other";
      const duplicate = rows.some(
        (row) =>
          (row.status === "active" || row.status === "candidate") &&
          row.tier === tier &&
          row.kind === kind &&
          row.content === content,
      );
      if (duplicate) continue;

      const ttl = tier === "short" ? Math.max(1, Math.min(12, Math.round(candidate.ttlChapters ?? 5))) : undefined;
      const sourcePath = compactText(candidate.sourcePath ?? "", 300);
      const evidence = compactText(candidate.evidence ?? "", 180);
      const memory: NovelMemory = {
        id: newId(),
        novel_id: input.novelId,
        tier,
        kind,
        content,
        entities: normalizeList(candidate.entities),
        keywords: normalizeList(candidate.keywords),
        importance: candidate.importance === "high" || candidate.importance === "low" ? candidate.importance : "mid",
        confidence: clampConfidence(candidate.confidence),
        status: "candidate",
        source: {
          type: "derived",
          path: `agent-run/${input.runId}${sourcePath ? `#${sourcePath}` : ""}`,
          content_hash: hashText(JSON.stringify({ runId: input.runId, tier, kind, content, sourcePath })),
          excerpt: evidence || content,
        },
        provenance: { depth: 1 },
        expires_after_chapter: ttl == null ? undefined : Math.max(0, input.currentChapter ?? 0) + ttl,
        created_at: now,
        updated_at: now,
      };
      rows.push(memory);
      created.push(memory);
    }
    return created.length ? rows : null;
  });
  return created;
}

export async function decideMemoryCandidates(input: {
  novelId: string;
  memoryIds: string[];
  decision: "approve" | "reject";
  runId?: string;
}): Promise<{ updated: NovelMemory[]; skipped: string[] }> {
  const requested = Array.from(new Set(input.memoryIds.filter(Boolean))).slice(0, 100);
  const requestedSet = new Set(requested);
  const updated: NovelMemory[] = [];
  const seen = new Set<string>();
  await updateCollection<NovelMemory>(input.novelId, MEMORY_COLLECTION, (allRows) => {
    const rows = allRows.filter((memory) => memory?.novel_id === input.novelId);
    let changed = false;
    for (let index = 0; index < rows.length; index += 1) {
      const memory = rows[index];
      if (!requestedSet.has(memory.id)) continue;
      seen.add(memory.id);
      if (memory.status !== "candidate") continue;
      if (input.runId && !memory.source.path?.startsWith(`agent-run/${input.runId}`)) continue;
      const next: NovelMemory = {
        ...memory,
        status: input.decision === "approve" ? "active" : "rejected",
        updated_at: nowIso(),
      };
      rows[index] = next;
      updated.push(next);
      changed = true;
    }
    return changed ? rows : null;
  });
  return {
    updated,
    skipped: requested.filter((id) => !seen.has(id) || !updated.some((memory) => memory.id === id)),
  };
}

function queryTerms(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const terms = normalized.match(/[\u4e00-\u9fff]{2,8}|[a-z0-9_-]{2,}/g) ?? [];
  return Array.from(new Set(terms)).slice(0, 80);
}

function relevanceScore(
  memory: NovelMemory,
  query: string,
  terms: string[],
  currentChapter: number,
  expandedEntities: Set<string>,
  textRanks: Map<string, number>,
): number {
  const content = `${memory.content} ${memory.entities.join(" ")} ${memory.keywords.join(" ")}`.toLowerCase();
  let score = memory.importance === "high" ? 3 : memory.importance === "mid" ? 1.5 : 0.5;
  if (query && content.includes(query.toLowerCase())) score += 8;
  for (const term of terms) {
    if (content.includes(term)) score += memory.entities.includes(term) ? 5 : 2;
  }
  for (const entity of memory.entities) {
    if (expandedEntities.has(entity)) score += 3;
  }
  if (memory.chapter_end != null) {
    score += Math.max(0, 4 - Math.max(0, currentChapter - memory.chapter_end) * 0.15);
  }
  const textRank = textRanks.get(memory.id);
  if (textRank != null) {
    // Reciprocal Rank Fusion：让 FTS/BM25 命中参与排序，但不压过实体、时序和重要性约束。
    score += 12 * (60 / (60 + textRank));
  }
  score += memory.confidence;
  return score;
}

/**
 * 混合检索：FTS/BM25 先给出文本候选，再用实体扩展、时间与重要性重排。
 * SQLite 索引不可用时，searchMemoryIndex 返回空结果并自动退回原有 JSON 检索。
 */
export async function retrieveNovelMemories(input: {
  novelId: string;
  query?: string;
  currentChapter?: number;
  canonicalLimit?: number;
  longLimit?: number;
  shortLimit?: number;
}): Promise<MemoryRecallResult> {
  await syncCanonicalMemories(input.novelId);
  const currentChapter = input.currentChapter ?? Number.MAX_SAFE_INTEGER;
  const query = compactText(input.query ?? "", 2_000);
  const terms = queryTerms(query);
  const memories = listNovelMemories(input.novelId);
  const textRanks = new Map(
    searchMemoryIndex({
      novelId: input.novelId,
      memories,
      query,
      limit: 50,
    }).map((hit) => [hit.memoryId, hit.rank]),
  );
  const active = memories.filter(
    (row) =>
      row.status === "active" &&
      (row.tier !== "short" || row.expires_after_chapter == null || row.expires_after_chapter >= currentChapter),
  );

  const direct = active
    .filter((row) => row.tier !== "canonical")
    .map((row) => ({
      row,
      score: relevanceScore(row, query, terms, currentChapter, new Set(), textRanks),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const expandedEntities = new Set(direct.flatMap((item) => item.row.entities));

  const rank = (tier: NovelMemoryTier, limit: number) =>
    active
      .filter((row) => row.tier === tier)
      .map((row) => ({
        row,
        score: relevanceScore(row, query, terms, currentChapter, expandedEntities, textRanks),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.row);

  return {
    canonical: rank("canonical", input.canonicalLimit ?? 6),
    long: rank("long", input.longLimit ?? 10),
    short: rank("short", input.shortLimit ?? 8),
    expandedEntities: Array.from(expandedEntities),
  };
}

export function memoryRecallToMarkdown(result: MemoryRecallResult): string {
  const sections: string[] = [];
  const render = (items: NovelMemory[]) =>
    items
      .map((item) => {
        const source =
          item.source.type === "chapter" ? `第${item.source.chapter ?? "?"}章` : (item.source.path ?? item.source.type);
        // 注入时带上层级：depth>0 是 AI 归并产物，模型不该把它当作者确认的事实。
        const depth = depthOfMemory(item);
        const mark = depth > AUTHOR_FACT_DEPTH ? `|派生d${depth}` : "";
        return `- [${item.kind}|${source}${mark}] ${item.content}`;
      })
      .join("\n");

  if (result.canonical.length) sections.push(`### 作品规范记忆\n${render(result.canonical)}`);
  if (result.short.length) sections.push(`### 当前短期记忆\n${render(result.short)}`);
  if (result.long.length) sections.push(`### 按需召回的长期记忆\n${render(result.long)}`);
  return sections.join("\n\n");
}
