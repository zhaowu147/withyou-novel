import "server-only";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getGraph } from "@/lib/graph/store";
import { sanitizeNovelId } from "@/lib/local/paths";
import {
  getNovel,
  listChapterFiles,
  listEntities,
  listForeshadows,
  listTimeline,
  loadChapterFile,
  saveChapterFile,
  saveNovelMeta,
  upsertEntity,
  upsertForeshadow,
} from "@/lib/local/store";
import {
  type AgentMemoryCandidateInput,
  memoryRecallToMarkdown,
  retrieveNovelMemories,
  stageAgentMemoryCandidates,
} from "@/lib/memory/novel-memory";
import { contentVersionHash } from "@/lib/novel/content-hash";
import { fieldFilePaths, type NovelTextField } from "@/lib/novel/field-map";
import { novelFS } from "@/lib/novel-fs";
import { appStateDir } from "@/lib/runtime/app-paths";
import { summarizeGraphKnowledge } from "@/lib/tools/project-knowledge";

import * as fs from "node:fs";
import * as path from "node:path";

type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");
// biome-ignore lint/suspicious/noExplicitAny: Pi SDK tools intentionally use heterogeneous parameter schemas.
type AnyToolDefinition = ToolDefinition<any, any, any>;

const MAX_CONTEXT_CHARS = 36_000;
const MAX_CHAPTER_BYTES = 200_000;
const MAX_FIELD_BYTES = 100_000;
const MAX_CHECKPOINTS = 50;

export const PROJECT_PERSIST_FIELDS = [
  "brainstorm",
  "outline",
  "detailedOutline",
  "characters",
  "worldview",
  "goldfinger",
  "synopsis",
  "opening",
  "foreshadowing",
  "novelName",
  "totalChapters",
] as const;

type ProjectPersistField = (typeof PROJECT_PERSIST_FIELDS)[number];

export function validateProjectChapterNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new Error("章节编号必须是 1 到 100000 的整数");
  return value;
}

export function validateProjectField(field: string): ProjectPersistField {
  if (!(PROJECT_PERSIST_FIELDS as readonly string[]).includes(field)) throw new Error(`项目字段不允许写入：${field}`);
  return field as ProjectPersistField;
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.length > max ? `${normalized.slice(0, max)}\n…（已截断）` : normalized;
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error("limit 必须是正整数");
  return Math.min(value, maximum);
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function requireProject(novelId: string | null): string {
  if (!novelId) throw new Error("当前工作区尚未绑定小说，请先打开一部小说");
  const novel = getNovel(novelId);
  if (!novel) throw new Error("当前工作区绑定的小说不存在");
  return novel.id;
}

function checkpointFile(novelId: string): string {
  const safeId = sanitizeNovelId(novelId);
  return path.join(appStateDir(), "pi-project-checkpoints", `${safeId}.json`);
}

interface ChapterCheckpoint {
  kind: "chapter";
  id: string;
  novelId: string;
  number: number;
  title: string;
  previousContent: string;
  previousHash: string;
  nextHash: string;
  createdAt: string;
  rolledBackAt?: string;
}

interface DataCheckpoint {
  kind: "data";
  id: string;
  novelId: string;
  previous: Record<string, string | number>;
  next: Record<string, string | number>;
  createdAt: string;
  rolledBackAt?: string;
}

type ProjectCheckpoint = ChapterCheckpoint | DataCheckpoint;

function readCheckpoints(novelId: string): ProjectCheckpoint[] {
  const file = checkpointFile(novelId);
  if (!fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(value)
      ? (value as ProjectCheckpoint[]).filter((item) => item && item.novelId === novelId)
      : [];
  } catch {
    return [];
  }
}

function writeCheckpoints(novelId: string, checkpoints: ProjectCheckpoint[]): void {
  const file = checkpointFile(novelId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(checkpoints.slice(-MAX_CHECKPOINTS), null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function addCheckpoint(checkpoint: ProjectCheckpoint): void {
  writeCheckpoints(checkpoint.novelId, [...readCheckpoints(checkpoint.novelId), checkpoint]);
}

function projectData(
  novelId: string,
  fields: readonly ProjectPersistField[] = PROJECT_PERSIST_FIELDS,
): Record<string, unknown> {
  const novel = getNovel(novelId);
  if (!novel) throw new Error("小说不存在");
  const files = fieldFilePaths();
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    if (novel.metadata[field] !== undefined) {
      data[field] = novel.metadata[field];
      continue;
    }
    const filePath = files[field as NovelTextField];
    if (filePath) data[field] = novelFS.readFileSafe(novelId, filePath) ?? "";
  }
  return data;
}

function persistProjectData(novelId: string, patch: Record<string, string | number>): void {
  const metadata: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) metadata[validateProjectField(field)] = value;
  saveNovelMeta(novelId, { metadata });
  const files = fieldFilePaths();
  for (const [field, value] of Object.entries(patch)) {
    const filePath = files[field as NovelTextField];
    if (filePath && typeof value === "string") novelFS.writeFileAtomic(novelId, filePath, value);
  }
}

function readChapter(novelId: string, number: number) {
  const chapter = loadChapterFile(novelId, number);
  if (!chapter) throw new Error(`第 ${number} 章不存在`);
  const contentHash = contentVersionHash(chapter.content);
  return { chapter, contentHash };
}

function chapterTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s*(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

function createProjectTools(pi: PiCodingAgentModule, novelId: string | null): AnyToolDefinition[] {
  const context = pi.defineTool({
    name: "project_context",
    label: "读取项目上下文",
    description: "读取当前工作区绑定小说的受限项目上下文：作品字段、章节索引、实体、伏笔、时间线、记忆和图谱摘要。",
    promptSnippet: "project_context: 先读取当前小说项目上下文",
    parameters: Type.Object({
      includeRecentChapters: Type.Optional(Type.Boolean()),
      recentChapterCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 4_000, maximum: MAX_CONTEXT_CHARS })),
    }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      const maxChars = boundedLimit(params.maxChars, MAX_CONTEXT_CHARS, MAX_CONTEXT_CHARS);
      const chapters = listChapterFiles(id);
      const recent = params.includeRecentChapters
        ? chapters.slice(-(params.recentChapterCount ?? 3)).map((item) => ({
            number: item.number,
            title: item.title,
            content: clip(item.content, 4_000),
            contentHash: contentVersionHash(item.content),
          }))
        : undefined;
      const graph = await getGraph(id);
      const memories = await retrieveNovelMemories({
        novelId: id,
        query: "",
        canonicalLimit: 4,
        longLimit: 6,
        shortLimit: 4,
      });
      const payload = {
        novel: projectData(id),
        chapters: chapters.map((item) => ({
          number: item.number,
          title: item.title,
          wordCount: item.word_count,
          isFinal: item.is_final,
          updatedAt: item.updated_at,
          contentHash: contentVersionHash(item.content),
        })),
        recentChapters: recent,
        entities: listEntities(id).slice(0, 80),
        foreshadows: listForeshadows(id).slice(0, 80),
        timeline: listTimeline(id, 80),
        memories: {
          canonical: memories.canonical.length,
          long: memories.long.length,
          short: memories.short.length,
          preview: clip(memoryRecallToMarkdown(memories), 6_000),
        },
        graph: graph
          ? {
              revision: graph.revision,
              activeStageId: graph.activeStageId,
              stages: graph.stages.length,
              nodes: graph.nodes.length,
              edges: graph.edges.length,
              events: graph.events.length,
              summary: clip(summarizeGraphKnowledge(graph), 8_000),
            }
          : null,
      };
      return textResult(clip(JSON.stringify(payload, null, 2), maxChars), {
        novelId: id,
        chapterCount: chapters.length,
      });
    },
  });

  const listChapters = pi.defineTool({
    name: "project_list_chapters",
    label: "列出项目章节",
    description: "列出当前小说的章节索引，不返回正文，适合先确认可读取或可编辑的章节。",
    promptSnippet: "project_list_chapters: 列出当前小说章节",
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      const chapters = listChapterFiles(id).slice(0, boundedLimit(params.limit, 200, 500));
      return textResult(
        JSON.stringify(
          chapters.map((item) => ({
            number: item.number,
            title: item.title,
            wordCount: item.word_count,
            isFinal: item.is_final,
            updatedAt: item.updated_at,
            contentHash: contentVersionHash(item.content),
          })),
          null,
          2,
        ),
        { novelId: id, count: chapters.length },
      );
    },
  });

  const readChapterTool = pi.defineTool({
    name: "project_read_chapter",
    label: "读取项目章节",
    description: "读取当前小说指定章节正文和内容版本哈希；写入章节前必须使用本工具取得 expectedHash。",
    promptSnippet: "project_read_chapter: 读取章节正文和版本哈希",
    parameters: Type.Object({
      number: Type.Integer({ minimum: 1, maximum: 100_000 }),
      maxChars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_CHAPTER_BYTES })),
    }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      const number = validateProjectChapterNumber(params.number);
      const { chapter, contentHash } = readChapter(id, number);
      const maxChars = boundedLimit(params.maxChars, MAX_CHAPTER_BYTES, MAX_CHAPTER_BYTES);
      return textResult(clip(chapter.content, maxChars), {
        novelId: id,
        number,
        title: chapter.title,
        contentHash,
        truncated: chapter.content.length > maxChars,
      });
    },
  });

  const writeChapterTool = pi.defineTool({
    name: "project_write_chapter",
    label: "写入项目章节",
    description: "在用户明确要求后更新已有章节正文。必须携带读取时得到的 expectedHash，写入后会建立可回滚检查点。",
    promptSnippet: "project_write_chapter: 带版本校验和检查点更新章节",
    promptGuidelines: [
      "先调用 project_read_chapter",
      "仅在用户明确要求写入或修改正文时调用",
      "发生版本冲突时重新读取，不要覆盖其他修改",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      number: Type.Integer({ minimum: 1, maximum: 100_000 }),
      content: Type.String({ maxLength: MAX_CHAPTER_BYTES }),
      expectedHash: Type.String({ minLength: 64, maxLength: 64 }),
      title: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      const number = validateProjectChapterNumber(params.number);
      const { chapter: existing, contentHash: currentHash } = readChapter(id, number);
      if (params.expectedHash !== currentHash) throw new Error("章节已被其他修改更新，请重新读取后再保存");
      if (Buffer.byteLength(params.content, "utf8") > MAX_CHAPTER_BYTES) throw new Error("章节正文超过 200KB 安全上限");
      const title = params.title?.trim() || existing.title || chapterTitle(existing.content, `第${number}章`);
      const nextHash = contentVersionHash(params.content);
      await saveChapterFile({
        novel_id: id,
        number,
        title,
        content: params.content,
        is_final: existing.is_final,
        id: existing.id,
      });
      const checkpoint: ChapterCheckpoint = {
        kind: "chapter",
        id: `pi-chapter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        novelId: id,
        number,
        title,
        previousContent: existing.content,
        previousHash: currentHash,
        nextHash,
        createdAt: new Date().toISOString(),
      };
      addCheckpoint(checkpoint);
      return textResult(`第 ${number} 章已更新，可使用检查点 ${checkpoint.id} 回滚。`, {
        number,
        title,
        contentHash: nextHash,
        checkpointId: checkpoint.id,
      });
    },
  });

  const rollback = pi.defineTool({
    name: "project_rollback",
    label: "回滚项目修改",
    description: "回滚 Pi 最近建立的章节或项目字段检查点；回滚前会再次校验当前版本，避免覆盖用户之后的修改。",
    promptSnippet: "project_rollback: 回滚带检查点的项目修改",
    promptGuidelines: ["仅在用户明确要求回滚时调用", "当前内容版本变化时停止并让用户重新确认"],
    executionMode: "sequential",
    parameters: Type.Object({ checkpointId: Type.String({ minLength: 8, maxLength: 120 }) }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      const checkpoints = readCheckpoints(id);
      const checkpoint = checkpoints.find((item) => item.id === params.checkpointId && !item.rolledBackAt);
      if (!checkpoint) throw new Error("找不到可回滚的项目检查点");
      if (checkpoint.kind === "chapter") {
        const { chapter: current, contentHash } = readChapter(id, checkpoint.number);
        if (contentHash !== checkpoint.nextHash) throw new Error("章节已在检查点之后再次变化，已停止回滚以避免覆盖");
        await saveChapterFile({
          novel_id: id,
          number: checkpoint.number,
          title: checkpoint.title,
          content: checkpoint.previousContent,
          is_final: current.is_final,
          id: current.id,
        });
      } else {
        const current = projectData(id);
        for (const [field, value] of Object.entries(checkpoint.next)) {
          if (current[field] !== value) throw new Error(`项目字段 ${field} 已在检查点之后再次变化，已停止回滚`);
        }
        persistProjectData(id, checkpoint.previous);
      }
      checkpoint.rolledBackAt = new Date().toISOString();
      writeCheckpoints(id, checkpoints);
      return textResult(`项目修改已回滚：${checkpoint.id}`, { checkpointId: checkpoint.id, kind: checkpoint.kind });
    },
  });

  const readData = pi.defineTool({
    name: "project_read_data",
    label: "读取项目创作资料",
    description: "读取当前小说白名单内的创作字段和文件树内容，不返回用户账号或密钥信息。",
    promptSnippet: "project_read_data: 读取作品大纲、人设和设定",
    parameters: Type.Object({
      fields: Type.Optional(
        Type.Array(Type.Union(PROJECT_PERSIST_FIELDS.map((field) => Type.Literal(field))), {
          maxItems: PROJECT_PERSIST_FIELDS.length,
        }),
      ),
    }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      const fields = (params.fields?.length ? params.fields : PROJECT_PERSIST_FIELDS) as readonly ProjectPersistField[];
      const data = projectData(id, fields);
      return textResult(JSON.stringify(data, null, 2), { novelId: id, fields });
    },
  });

  const writeData = pi.defineTool({
    name: "project_write_data",
    label: "写入项目创作资料",
    description: "在用户明确要求后更新白名单内的创作字段；写入字段文件并建立可回滚检查点，不允许任意元数据键。",
    promptSnippet: "project_write_data: 更新作品大纲、人设或设定并建立检查点",
    promptGuidelines: [
      "先调用 project_read_data 或 project_context",
      "仅在用户明确要求保存或修改资料时调用",
      "不要写入 id、user_id 或任意未列出的字段",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      field: Type.Union(PROJECT_PERSIST_FIELDS.map((field) => Type.Literal(field))),
      value: Type.Union([
        Type.String({ maxLength: MAX_FIELD_BYTES }),
        Type.Integer({ minimum: 0, maximum: 1_000_000 }),
      ]),
    }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      const field = validateProjectField(params.field);
      if (field !== "totalChapters" && typeof params.value !== "string") throw new Error("文本创作字段必须写入字符串");
      if (field === "totalChapters" && typeof params.value !== "number") throw new Error("totalChapters 必须写入整数");
      if (typeof params.value === "string" && Buffer.byteLength(params.value, "utf8") > MAX_FIELD_BYTES)
        throw new Error("创作字段超过 100KB 安全上限");
      const previousValue = projectData(id, [field])[field];
      const nextValue = params.value as string | number;
      persistProjectData(id, { [field]: nextValue });
      const checkpoint: DataCheckpoint = {
        kind: "data",
        id: `pi-data-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        novelId: id,
        previous: { [field]: typeof previousValue === "number" ? previousValue : String(previousValue ?? "") },
        next: { [field]: nextValue },
        createdAt: new Date().toISOString(),
      };
      addCheckpoint(checkpoint);
      return textResult(`项目字段已更新：${field}，可使用检查点 ${checkpoint.id} 回滚。`, {
        field,
        checkpointId: checkpoint.id,
      });
    },
  });

  const entities = pi.defineTool({
    name: "project_entities",
    label: "读取或更新项目实体",
    description: "读取当前小说实体卡片，或在用户明确要求后新增/更新实体；不提供删除接口。",
    promptSnippet: "project_entities: 查看或保存人物、地点和物品实体",
    promptGuidelines: ["默认使用 list", "只有用户明确要求新增或更新时才使用 upsert", "不要为了合并而删除实体"],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("upsert")]),
      query: Type.Optional(Type.String({ maxLength: 200 })),
      id: Type.Optional(Type.String({ maxLength: 160 })),
      name: Type.Optional(Type.String({ maxLength: 200 })),
      type: Type.Optional(
        Type.Union(["character", "location", "item", "faction", "event", "other"].map((value) => Type.Literal(value))),
      ),
      importance: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("mid"), Type.Literal("low")])),
      activeState: Type.Optional(Type.String({ maxLength: 40 })),
      summary: Type.Optional(Type.String({ maxLength: MAX_FIELD_BYTES })),
      lastChapter: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      if (params.action === "list") {
        const query = params.query?.trim().toLocaleLowerCase();
        const rows = listEntities(id)
          .filter((row) => !query || `${row.name} ${row.summary}`.toLocaleLowerCase().includes(query))
          .slice(0, 200);
        return textResult(JSON.stringify(rows, null, 2), { count: rows.length });
      }
      if (!params.name?.trim() || !params.summary?.trim()) throw new Error("upsert 实体必须提供 name 和 summary");
      const row = await upsertEntity({
        novel_id: id,
        id: params.id,
        name: params.name.trim(),
        type: params.type,
        importance: params.importance,
        active_state: params.activeState,
        summary: params.summary,
        last_chapter: params.lastChapter,
      });
      return textResult(`实体已保存：${row.name}`, { entity: row });
    },
  });

  const foreshadows = pi.defineTool({
    name: "project_foreshadows",
    label: "读取或更新项目伏笔",
    description: "读取当前小说伏笔，或在用户明确要求后新增/更新伏笔；不提供删除接口。",
    promptSnippet: "project_foreshadows: 查看或保存伏笔追踪",
    promptGuidelines: ["默认使用 list", "只有用户明确要求新增或更新时才使用 upsert"],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("upsert")]),
      id: Type.Optional(Type.String({ maxLength: 160 })),
      description: Type.Optional(Type.String({ maxLength: MAX_FIELD_BYTES })),
      state: Type.Optional(
        Type.Union(["planted", "activated", "dormant", "resolved", "abandoned"].map((value) => Type.Literal(value))),
      ),
      plantChapter: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      targetResolveChapter: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      actualResolveChapter: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      activatedChapter: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      relatedEntityIds: Type.Optional(Type.Array(Type.String({ maxLength: 160 }), { maxItems: 50 })),
    }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      if (params.action === "list")
        return textResult(JSON.stringify(listForeshadows(id).slice(0, 200), null, 2), {
          count: listForeshadows(id).length,
        });
      if (!params.description?.trim()) throw new Error("upsert 伏笔必须提供 description");
      const row = await upsertForeshadow({
        novel_id: id,
        id: params.id,
        description: params.description.trim(),
        state: params.state,
        plant_chapter: params.plantChapter,
        target_resolve_chapter: params.targetResolveChapter,
        actual_resolve_chapter: params.actualResolveChapter,
        activated_chapter: params.activatedChapter,
        related_entity_ids: params.relatedEntityIds,
      });
      return textResult(`伏笔已保存：${row.description}`, { foreshadow: row });
    },
  });

  const timeline = pi.defineTool({
    name: "project_timeline",
    label: "读取项目时间线",
    description: "读取当前小说的时间线事件；这是只读工具，避免 Pi 未经确认改写事实记录。",
    promptSnippet: "project_timeline: 查看当前小说时间线",
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      const rows = listTimeline(id, boundedLimit(params.limit, 80, 200));
      return textResult(JSON.stringify(rows, null, 2), { count: rows.length });
    },
  });

  const memories = pi.defineTool({
    name: "project_memories",
    label: "召回或暂存项目记忆",
    description: "召回当前小说的已确认记忆，或把用户明确要求保存的推断暂存为候选记忆；候选不会自动成为事实。",
    promptSnippet: "project_memories: 召回记忆或暂存候选记忆",
    promptGuidelines: ["默认使用 recall", "stage 只暂存候选，不代表用户已批准", "不得调用审批或把候选描述为已确认事实"],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("recall"), Type.Literal("stage")]),
      query: Type.Optional(Type.String({ maxLength: 2_000 })),
      currentChapter: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      runId: Type.Optional(Type.String({ maxLength: 160 })),
      candidates: Type.Optional(
        Type.Array(
          Type.Object({
            tier: Type.Optional(Type.Union(["canonical", "long", "short"].map((value) => Type.Literal(value)))),
            kind: Type.Optional(Type.String({ maxLength: 60 })),
            content: Type.String({ minLength: 1, maxLength: 500 }),
            entities: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 12 })),
            keywords: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 12 })),
            importance: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("mid"), Type.Literal("low")])),
            confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
            ttlChapters: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
            evidence: Type.Optional(Type.String({ maxLength: 180 })),
            sourcePath: Type.Optional(Type.String({ maxLength: 300 })),
          }),
          { maxItems: 24 },
        ),
      ),
    }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      if (params.action === "recall") {
        const result = await retrieveNovelMemories({
          novelId: id,
          query: params.query,
          currentChapter: params.currentChapter,
        });
        return textResult(memoryRecallToMarkdown(result) || "当前没有匹配的已确认记忆", {
          expandedEntities: result.expandedEntities,
          canonical: result.canonical.length,
          long: result.long.length,
          short: result.short.length,
        });
      }
      if (!params.runId?.trim() || !params.candidates?.length)
        throw new Error("stage 记忆必须提供 runId 和 candidates");
      const created = await stageAgentMemoryCandidates({
        novelId: id,
        runId: params.runId.trim(),
        currentChapter: params.currentChapter,
        candidates: params.candidates as unknown as AgentMemoryCandidateInput[],
      });
      return textResult(`已暂存 ${created.length} 条候选记忆；它们仍需用户确认后才会进入已确认召回。`, {
        count: created.length,
        memoryIds: created.map((item) => item.id),
      });
    },
  });

  const graphRead = pi.defineTool({
    name: "project_graph_read",
    label: "读取项目故事图谱",
    description: "读取当前小说故事图谱的统计和已确认知识摘要；不自动提取、覆盖或删除图谱。",
    promptSnippet: "project_graph_read: 读取故事图谱摘要",
    parameters: Type.Object({ maxChars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 20_000 })) }),
    execute: async (_id, params) => {
      const id = requireProject(novelId);
      const graph = await getGraph(id);
      if (!graph) return textResult("当前小说还没有故事图谱", { novelId: id, exists: false });
      const summary = summarizeGraphKnowledge(graph, params.maxChars ?? 12_000);
      return textResult(summary || "当前图谱没有可展示的已确认知识", {
        novelId: id,
        exists: true,
        revision: graph.revision,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        events: graph.events.length,
      });
    },
  });

  return [
    context,
    listChapters,
    readChapterTool,
    writeChapterTool,
    rollback,
    readData,
    writeData,
    entities,
    foreshadows,
    timeline,
    memories,
    graphRead,
  ];
}

export function createProjectApiToolDefinitions(pi: PiCodingAgentModule, novelId: string | null): ToolDefinition[] {
  return createProjectTools(pi, novelId);
}
