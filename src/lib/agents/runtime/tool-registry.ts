import "server-only";

import { getGraph } from "@/lib/graph/store";
import { listChapterFiles, listEntities, listForeshadows, listTimeline, loadChapterFile } from "@/lib/local/store";
import {
  type AgentMemoryCandidateInput,
  memoryRecallToMarkdown,
  retrieveNovelMemories,
  stageAgentMemoryCandidates,
} from "@/lib/memory/novel-memory";
import { novelFS } from "@/lib/novel-fs";
import { summarizeGraphKnowledge } from "@/lib/tools/project-knowledge";

import { appendAgentTrace } from "./run-store";
import type {
  AgentContextPlan,
  AgentFileTrace,
  AgentMemoryTrace,
  AgentToolDefinition,
  AgentToolTrace,
  CoreAgentId,
} from "./types";

interface RuntimeToolContext {
  workspaceId: string;
  novelId: string;
  runId: string;
  agentId: CoreAgentId;
  plan: AgentContextPlan;
  maxToolCalls: number;
}

interface ToolExecutionResult {
  value: unknown;
  summary: string;
  files?: AgentFileTrace[];
  memories?: AgentMemoryTrace[];
}

const MAX_FILE_CHARS = 24_000;
const MAX_SEARCH_FILE_CHARS = 80_000;

function intArg(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function textArg(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/").trim();
}

function isVisibleProjectFile(filePath: string): boolean {
  const normalized = normalizedPath(filePath);
  const segments = normalized.split("/");
  return (
    Boolean(normalized) &&
    segments[0] !== "vault" &&
    !segments.some((segment) => segment.startsWith(".")) &&
    !normalized.endsWith(".tmp") &&
    !normalized.endsWith(".bak")
  );
}

function visibleFiles(novelId: string): Array<{ path: string; rawPath: string }> {
  return novelFS
    .listAllFiles(novelId)
    .map((rawPath) => ({ path: normalizedPath(rawPath), rawPath }))
    .filter((item) => isVisibleProjectFile(item.path))
    .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
}

function resolveVisibleFile(novelId: string, requestedPath: string): { path: string; rawPath: string } {
  const requested = normalizedPath(requestedPath);
  if (!requested || requested.includes("..") || /^[a-zA-Z]:/.test(requested)) {
    throw new Error("无效的项目文件路径");
  }
  const hit = visibleFiles(novelId).find((file) => file.path === requested);
  if (!hit) throw new Error(`当前作品中不存在可读取文件：${requested}`);
  return hit;
}

function toolDefinition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): AgentToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

export const AGENT_READ_TOOLS: AgentToolDefinition[] = [
  toolDefinition(
    "read_context_bundle",
    "按当前 Agent 的上下文计划一次读取定向资料包：计划文件、近期章节、相关记忆和结构化追踪事实。写作 Agent 必须优先调用；仅当结果明确缺失时再追加单文件读取。",
    {
      maxChars: { type: "integer", description: "资料包中文件和近期正文的总字符上限，默认 68000，上限 96000" },
    },
  ),
  toolDefinition("project_list_files", "列出当前小说可读取的文件树，可按目录前缀过滤。", {
    prefix: { type: "string", description: "可选目录前缀，如 设定/ 或 正文/" },
  }),
  toolDefinition(
    "project_read_file",
    "读取当前小说中的一个明确文件。设定、大纲与追踪文件应优先用它核对。",
    {
      path: { type: "string", description: "project_list_files 返回的相对路径" },
      maxChars: { type: "integer", description: `最多返回字符数，默认 12000，上限 ${MAX_FILE_CHARS}` },
    },
    ["path"],
  ),
  toolDefinition(
    "project_search",
    "在当前小说文件中搜索关键词，返回命中文件与短上下文。不要用它代替明确文件读取。",
    {
      query: { type: "string", description: "关键词或短语" },
      prefix: { type: "string", description: "可选目录前缀" },
      maxResults: { type: "integer", description: "最多命中数，默认 12，上限 30" },
    },
    ["query"],
  ),
  toolDefinition(
    "memory_recall",
    "只从当前小说的规范、长期、短期记忆库按任务语义召回相关记忆。",
    {
      query: { type: "string", description: "本次任务相关的角色、事件、设定或冲突" },
      currentChapter: { type: "integer", description: "当前或目标章节号，可省略" },
    },
    ["query"],
  ),
  toolDefinition(
    "read_chapter_range",
    "读取当前小说的一段连续章节。范围要小，优先读取与任务最相关的近期章节。",
    {
      start: { type: "integer", description: "起始章节号" },
      end: { type: "integer", description: "结束章节号，最多连续 8 章" },
      maxChars: { type: "integer", description: "全部章节合计字符上限，默认 24000，上限 48000" },
    },
    ["start", "end"],
  ),
  toolDefinition("get_entities", "读取当前小说的结构化实体卡，可按名称或重要性过滤。", {
    names: { type: "array", items: { type: "string" }, description: "可选实体名列表" },
    importance: { type: "string", enum: ["high", "mid", "low"], description: "可选重要性" },
  }),
  toolDefinition("get_foreshadows", "读取当前小说的结构化伏笔记录，可按状态过滤。", {
    state: {
      type: "string",
      enum: ["planted", "activated", "dormant", "resolved", "abandoned"],
      description: "可选伏笔状态",
    },
  }),
  toolDefinition("get_timeline", "读取当前小说的结构化时间线。", {
    limit: { type: "integer", description: "返回条数，默认 30，上限 100" },
  }),
  toolDefinition("get_story_graph", "读取当前小说中已经确认且未隐藏的故事图谱知识。", {
    query: { type: "string", description: "可选关注点，用于说明此次读取目的" },
  }),
  toolDefinition(
    "agent_done",
    "证据读取充分后报告任务已完成。此工具不写文件，也不替代最终给用户的正文或方案。",
    {
      summary: { type: "string", description: "一句话说明完成了什么" },
      nextSteps: { type: "array", items: { type: "string" }, description: "可选后续动作" },
    },
    ["summary"],
  ),
];

const MEMORY_CANDIDATE_TOOL = toolDefinition(
  "propose_memory_candidates",
  "将已经核对过来源的记忆作为待审批候选暂存。不会激活记忆，用户批准前不得把它们当事实使用。",
  {
    candidates: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        properties: {
          tier: { type: "string", enum: ["canonical", "long", "short"] },
          kind: {
            type: "string",
            enum: [
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
              "other",
            ],
          },
          content: { type: "string", description: "一条独立、明确、可检索的事实候选" },
          entities: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } },
          importance: { type: "string", enum: ["high", "mid", "low"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          ttlChapters: { type: "integer", minimum: 1, maximum: 12 },
          evidence: { type: "string", description: "支持该候选的短证据" },
          sourcePath: { type: "string", description: "证据所在的项目相对路径或章节标识" },
        },
        required: ["tier", "kind", "content", "evidence", "sourcePath"],
        additionalProperties: false,
      },
    },
  },
  ["candidates"],
);

function sourceLabel(memory: { source: { type: string; chapter?: number; path?: string } }): string {
  if (memory.source.type === "chapter") return `第${memory.source.chapter ?? "?"}章`;
  return memory.source.path ?? memory.source.type;
}

async function executeReadTool(
  context: RuntimeToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const { novelId, plan } = context;
  if (name === "read_context_bundle") {
    const maxChars = intArg(args.maxChars, 68_000, 8_000, 96_000);
    const perFileLimit = (path: string) => {
      if (path === "大纲/细纲.md") return 16_000;
      if (path === "大纲/总纲.md") return 8_000;
      if (path.startsWith("设定/")) return 5_000;
      return 2_500;
    };
    let remaining = maxChars;
    const files: AgentFileTrace[] = [];
    const projectFiles: Array<{ path: string; content: string; truncated: boolean }> = [];
    for (const preferredPath of plan.preferredFiles) {
      if (remaining <= 0) break;
      const found = visibleFiles(novelId).find((file) => file.path === preferredPath);
      if (!found) continue;
      const full = novelFS.readFile(novelId, found.rawPath);
      const content = full.slice(0, Math.min(remaining, perFileLimit(found.path)));
      projectFiles.push({ path: found.path, content, truncated: full.length > content.length });
      files.push({ path: found.path, reason: "定向上下文资料包", chars: content.length });
      remaining -= content.length;
    }

    const latestChapter = listChapterFiles(novelId).at(-1)?.number ?? 0;
    const recentStart = Math.max(1, latestChapter - plan.recentChapterCount + 1);
    const chapters: Array<{ number: number; title: string; content: string; truncated: boolean }> = [];
    for (let chapterNumber = recentStart; chapterNumber <= latestChapter && remaining > 0; chapterNumber += 1) {
      const chapter = loadChapterFile(novelId, chapterNumber);
      if (!chapter) continue;
      const content = chapter.content.slice(0, Math.min(remaining, 12_000));
      chapters.push({
        number: chapter.number,
        title: chapter.title,
        content,
        truncated: chapter.content.length > content.length,
      });
      files.push({ path: `正文/第${chapter.number}章`, reason: "近期正文上下文", chars: content.length });
      remaining -= content.length;
    }

    const recall = await retrieveNovelMemories({
      novelId,
      query: plan.query,
      currentChapter: latestChapter + 1,
      canonicalLimit: plan.memoryLimits.canonical,
      longLimit: plan.memoryLimits.long,
      shortLimit: plan.memoryLimits.short,
    });
    const memories = [...recall.canonical, ...recall.long, ...recall.short];
    return {
      value: {
        plan: { preferredFiles: plan.preferredFiles, recentChapterCount: plan.recentChapterCount },
        projectFiles,
        recentChapters: chapters,
        memories: memoryRecallToMarkdown(recall),
        entities: plan.includeEntities
          ? listEntities(novelId)
              .filter((entity) => entity.importance !== "low")
              .slice(0, 40)
          : [],
        foreshadows: plan.includeForeshadows ? listForeshadows(novelId).slice(0, 60) : [],
        timeline: plan.includeTimeline ? listTimeline(novelId, 60) : [],
        missingPreferredFiles: plan.preferredFiles.filter((path) => !projectFiles.some((file) => file.path === path)),
      },
      summary: `读取 ${projectFiles.length} 份计划资料、${chapters.length} 章近期正文和 ${memories.length} 条相关记忆`,
      files,
      memories: memories.map((memory) => ({
        id: memory.id,
        tier: memory.tier,
        kind: memory.kind,
        source: sourceLabel(memory),
      })),
    };
  }

  if (name === "project_list_files") {
    const prefix = normalizedPath(textArg(args.prefix, 200));
    const files = visibleFiles(novelId)
      .map((file) => file.path)
      .filter((file) => !prefix || file.startsWith(prefix))
      .slice(0, 500);
    return {
      value: {
        files,
        preferredForTask: plan.preferredFiles.filter((file) => files.includes(file)),
        latestChapter: listChapterFiles(novelId).at(-1)?.number ?? 0,
      },
      summary: `列出 ${files.length} 个项目文件`,
    };
  }

  if (name === "project_read_file") {
    const file = resolveVisibleFile(novelId, textArg(args.path, 500));
    const maxChars = intArg(args.maxChars, 12_000, 500, MAX_FILE_CHARS);
    const full = novelFS.readFile(novelId, file.rawPath);
    const content = full.slice(0, maxChars);
    return {
      value: { path: file.path, content, truncated: full.length > content.length },
      summary: `读取 ${file.path}（${content.length} 字符）`,
      files: [{ path: file.path, reason: "明确读取", chars: content.length }],
    };
  }

  if (name === "project_search") {
    const query = textArg(args.query, 200);
    if (!query) throw new Error("搜索词不能为空");
    const prefix = normalizedPath(textArg(args.prefix, 200));
    const maxResults = intArg(args.maxResults, 12, 1, 30);
    const needle = query.toLocaleLowerCase();
    const matches: Array<{ path: string; excerpt: string }> = [];
    const scans: AgentFileTrace[] = [];
    for (const file of visibleFiles(novelId)) {
      if (prefix && !file.path.startsWith(prefix)) continue;
      const content = novelFS.readFile(novelId, file.rawPath).slice(0, MAX_SEARCH_FILE_CHARS);
      const index = content.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      matches.push({
        path: file.path,
        excerpt: content.slice(Math.max(0, index - 180), Math.min(content.length, index + query.length + 320)),
      });
      scans.push({ path: file.path, reason: `搜索命中：${query}`, chars: content.length });
      if (matches.length >= maxResults) break;
    }
    return {
      value: { query, matches },
      summary: `搜索“${query}”，命中 ${matches.length} 个文件`,
      files: scans,
    };
  }

  if (name === "memory_recall") {
    const query = textArg(args.query, 2_000);
    const currentChapter = intArg(
      args.currentChapter,
      (listChapterFiles(novelId).at(-1)?.number ?? 0) + 1,
      1,
      1_000_000,
    );
    const recall = await retrieveNovelMemories({
      novelId,
      query,
      currentChapter,
      canonicalLimit: plan.memoryLimits.canonical,
      longLimit: plan.memoryLimits.long,
      shortLimit: plan.memoryLimits.short,
    });
    const all = [...recall.canonical, ...recall.long, ...recall.short];
    return {
      value: {
        markdown: memoryRecallToMarkdown(recall),
        expandedEntities: recall.expandedEntities,
        count: all.length,
      },
      summary: `召回 ${all.length} 条当前作品记忆`,
      memories: all.map((memory) => ({
        id: memory.id,
        tier: memory.tier,
        kind: memory.kind,
        source: sourceLabel(memory),
      })),
    };
  }

  if (name === "read_chapter_range") {
    const start = intArg(args.start, 1, 1, 1_000_000);
    const requestedEnd = intArg(args.end, start, start, 1_000_000);
    const end = Math.min(requestedEnd, start + 7);
    const maxChars = intArg(args.maxChars, 24_000, 1_000, 48_000);
    const chapters: Array<{ number: number; title: string; content: string; truncated: boolean }> = [];
    const files: AgentFileTrace[] = [];
    let remaining = maxChars;
    for (let chapterNumber = start; chapterNumber <= end && remaining > 0; chapterNumber += 1) {
      const chapter = loadChapterFile(novelId, chapterNumber);
      if (!chapter) continue;
      const content = chapter.content.slice(0, remaining);
      chapters.push({
        number: chapter.number,
        title: chapter.title,
        content,
        truncated: chapter.content.length > content.length,
      });
      files.push({ path: `正文/第${chapter.number}章`, reason: "章节范围读取", chars: content.length });
      remaining -= content.length;
    }
    return {
      value: { start, end, chapters },
      summary: `读取第 ${start}-${end} 章中的 ${chapters.length} 章`,
      files,
    };
  }

  if (name === "get_entities") {
    const names = Array.isArray(args.names)
      ? new Set(args.names.filter((value): value is string => typeof value === "string").map((value) => value.trim()))
      : null;
    const importance = textArg(args.importance, 20);
    const entities = listEntities(novelId)
      .filter((entity) => !names?.size || names.has(entity.name))
      .filter((entity) => !importance || entity.importance === importance)
      .slice(0, 100);
    return { value: { entities }, summary: `读取 ${entities.length} 张实体卡` };
  }

  if (name === "get_foreshadows") {
    const state = textArg(args.state, 30);
    const foreshadows = listForeshadows(novelId)
      .filter((item) => !state || item.state === state)
      .slice(0, 100);
    return { value: { foreshadows }, summary: `读取 ${foreshadows.length} 条伏笔` };
  }

  if (name === "get_timeline") {
    const limit = intArg(args.limit, 30, 1, 100);
    const timeline = listTimeline(novelId, limit);
    return { value: { timeline }, summary: `读取 ${timeline.length} 条时间线事件` };
  }

  if (name === "get_story_graph") {
    const graph = await getGraph(novelId);
    const knowledge = summarizeGraphKnowledge(graph, 16_000);
    return {
      value: { query: textArg(args.query, 500), knowledge, available: Boolean(knowledge) },
      summary: knowledge ? "读取当前作品已确认的图谱知识" : "当前作品暂无已确认的图谱知识",
    };
  }

  if (name === "propose_memory_candidates") {
    if (context.agentId !== "memory") throw new Error("只有 Memory Agent 可以暂存记忆候选");
    const rawCandidates = Array.isArray(args.candidates) ? args.candidates.slice(0, 24) : [];
    const candidates: AgentMemoryCandidateInput[] = rawCandidates
      .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object"))
      .map((candidate) => ({
        tier: candidate.tier as AgentMemoryCandidateInput["tier"],
        kind: candidate.kind as AgentMemoryCandidateInput["kind"],
        content: textArg(candidate.content, 500),
        entities: Array.isArray(candidate.entities) ? candidate.entities : [],
        keywords: Array.isArray(candidate.keywords) ? candidate.keywords : [],
        importance: candidate.importance as AgentMemoryCandidateInput["importance"],
        confidence: typeof candidate.confidence === "number" ? candidate.confidence : undefined,
        ttlChapters:
          typeof candidate.ttlChapters === "number" && Number.isFinite(candidate.ttlChapters)
            ? candidate.ttlChapters
            : undefined,
        evidence: textArg(candidate.evidence, 180),
        sourcePath: textArg(candidate.sourcePath, 300),
      }))
      .filter((candidate) => Boolean(candidate.content));
    if (!candidates.length) throw new Error("没有可暂存的有效记忆候选");
    const currentChapter = listChapterFiles(novelId).at(-1)?.number ?? 0;
    const staged = await stageAgentMemoryCandidates({
      novelId,
      runId: context.runId,
      currentChapter,
      candidates,
    });
    return {
      value: {
        candidateIds: staged.map((memory) => memory.id),
        staged: staged.length,
        duplicatesSkipped: candidates.length - staged.length,
      },
      summary: `暂存 ${staged.length} 条待用户审批的记忆候选`,
      memories: staged.map((memory) => ({
        id: memory.id,
        tier: memory.tier,
        kind: memory.kind,
        source: sourceLabel(memory),
      })),
    };
  }

  if (name === "agent_done") {
    return {
      value: {
        accepted: true,
        summary: textArg(args.summary, 1_000),
        nextSteps: Array.isArray(args.nextSteps) ? args.nextSteps.slice(0, 10) : [],
      },
      summary: "Agent 已报告证据读取和任务处理完成",
    };
  }

  throw new Error(`不支持的 Agent 工具：${name}`);
}

export function createAgentToolRegistry(context: RuntimeToolContext): {
  definitions: AgentToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  didSignalDone: () => boolean;
  doneSummary: () => string | null;
  didCreateProposal: () => boolean;
} {
  let toolCalls = 0;
  let signalledDone = false;
  let completedSummary: string | null = null;
  let createdProposal = false;
  return {
    definitions: context.agentId === "memory" ? [...AGENT_READ_TOOLS, MEMORY_CANDIDATE_TOOL] : AGENT_READ_TOOLS,
    async execute(name, args) {
      const startedAt = new Date().toISOString();
      if (toolCalls >= context.maxToolCalls) {
        throw new Error(`本次 Agent 最多调用 ${context.maxToolCalls} 次工具`);
      }
      toolCalls += 1;
      try {
        const result = await executeReadTool(context, name, args);
        if (name === "agent_done") {
          signalledDone = true;
          completedSummary =
            typeof result.value === "object" && result.value !== null
              ? String((result.value as { summary?: unknown }).summary ?? "").trim() || null
              : null;
        }
        if (
          name === "propose_memory_candidates" &&
          typeof result.value === "object" &&
          result.value !== null &&
          Number((result.value as { staged?: unknown }).staged) > 0
        ) {
          createdProposal = true;
        }
        const finishedAt = new Date().toISOString();
        const trace: AgentToolTrace = {
          name,
          args,
          summary: result.summary,
          startedAt,
          finishedAt,
        };
        await appendAgentTrace(context.novelId, context.runId, {
          tool: trace,
          files: result.files,
          memories: result.memories,
        });
        return JSON.stringify({ success: true, data: result.value });
      } catch (error) {
        const message = error instanceof Error ? error.message : "工具执行失败";
        const finishedAt = new Date().toISOString();
        await appendAgentTrace(context.novelId, context.runId, {
          tool: {
            name,
            args,
            summary: "工具执行失败",
            startedAt,
            finishedAt,
            error: message.slice(0, 1_000),
          },
        });
        return JSON.stringify({ success: false, error: message });
      }
    },
    didSignalDone: () => signalledDone,
    doneSummary: () => completedSummary,
    didCreateProposal: () => createdProposal,
  };
}
