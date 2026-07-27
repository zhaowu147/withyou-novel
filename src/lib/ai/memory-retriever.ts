/**
 * memory_retriever.ts — 纯后端上下文检索（本地 JSON）
 */
import "server-only";

import { getNovel, listChapterFiles, listEntities, listForeshadows } from "@/lib/local/store";
import { memoryRecallToMarkdown, retrieveNovelMemories } from "@/lib/memory/novel-memory";

export interface ContextOptions {
  novelId: string;
  taskType:
    | "write_chapter"
    | "block_outline"
    | "volume_outline"
    | "logic_check"
    | "state_update"
    | "entity_enrich"
    | "refine";
  currentChapterNum?: number;
  lookbackChapters?: number;
  maxEntities?: number;
  maxForeshadows?: number;
  maxOutlineTokens?: number;
  /** 当前章节目标、最近用户要求或章节卡，用于按需召回 */
  query?: string;
  extras?: Record<string, unknown>;
}

export interface EntityCard {
  id: string;
  name: string;
  type: "character" | "location" | "faction" | "item" | "event" | "other";
  importance: "high" | "mid" | "low";
  active_state: "active" | "cooling" | "resolved" | "abandoned";
  summary: string;
}

export interface Foreshadow {
  id: string;
  description: string;
  plant_chapter?: number;
  target_resolve_chapter?: number;
  state: "planted" | "activated" | "dormant" | "resolved" | "abandoned";
}

export interface AssembledContext {
  contextSections: Array<{ title: string; body: string }>;
  stats: {
    entitiesTotal: number;
    entitiesSlim: number;
    foreshadowsActive: number;
    chaptersLookback: number;
    outlineTokens: number;
    canonicalMemories: number;
    longMemories: number;
    shortMemories: number;
  };
}

const PROFILES: Record<
  ContextOptions["taskType"],
  {
    lookback: number;
    maxEntities: number;
    maxForeshadows: number;
    useResolvedEntities: boolean;
    useResolvedForeshadows: boolean;
    outlineSlice: number;
    outlineChars: number;
  }
> = {
  write_chapter: {
    lookback: 5,
    maxEntities: 12,
    maxForeshadows: 6,
    useResolvedEntities: false,
    useResolvedForeshadows: false,
    outlineSlice: 600,
    outlineChars: 300,
  },
  block_outline: {
    lookback: 0,
    maxEntities: 20,
    maxForeshadows: 10,
    useResolvedEntities: true,
    useResolvedForeshadows: true,
    outlineSlice: 1200,
    outlineChars: 600,
  },
  volume_outline: {
    lookback: 0,
    maxEntities: 15,
    maxForeshadows: 8,
    useResolvedEntities: true,
    useResolvedForeshadows: false,
    outlineSlice: 1000,
    outlineChars: 500,
  },
  logic_check: {
    lookback: 3,
    maxEntities: 8,
    maxForeshadows: 4,
    useResolvedEntities: false,
    useResolvedForeshadows: false,
    outlineSlice: 400,
    outlineChars: 200,
  },
  state_update: {
    lookback: 3,
    maxEntities: 10,
    maxForeshadows: 8,
    useResolvedEntities: false,
    useResolvedForeshadows: false,
    outlineSlice: 500,
    outlineChars: 250,
  },
  entity_enrich: {
    lookback: 10,
    maxEntities: 30,
    maxForeshadows: 15,
    useResolvedEntities: true,
    useResolvedForeshadows: true,
    outlineSlice: 1500,
    outlineChars: 750,
  },
  refine: {
    lookback: 2,
    maxEntities: 6,
    maxForeshadows: 3,
    useResolvedEntities: false,
    useResolvedForeshadows: false,
    outlineSlice: 300,
    outlineChars: 150,
  },
};

export async function assembleContext(opts: ContextOptions): Promise<AssembledContext> {
  const profile = PROFILES[opts.taskType] || PROFILES.write_chapter;
  const novelId = opts.novelId;
  const lookback = opts.lookbackChapters ?? profile.lookback;
  const maxEntities = opts.maxEntities ?? profile.maxEntities;
  const maxForeshadows = opts.maxForeshadows ?? profile.maxForeshadows;

  const novel = getNovel(novelId);
  const chapterFiles = listChapterFiles(novelId);

  let entities = listEntities(novelId).map(
    (e): EntityCard => ({
      id: e.id,
      name: e.name,
      type: e.type as EntityCard["type"],
      importance: (e.importance as EntityCard["importance"]) || "mid",
      active_state: (e.active_state as EntityCard["active_state"]) || "active",
      summary: e.summary,
    }),
  );
  if (!profile.useResolvedEntities) {
    entities = entities.filter((e) => e.active_state !== "resolved" && e.active_state !== "abandoned");
  }
  entities = entities.slice(0, maxEntities);

  let foreshadows = listForeshadows(novelId).map(
    (f): Foreshadow => ({
      id: f.id,
      description: f.description,
      plant_chapter: f.plant_chapter,
      target_resolve_chapter: f.target_resolve_chapter,
      state: f.state,
    }),
  );
  if (!profile.useResolvedForeshadows) {
    foreshadows = foreshadows.filter((f) => f.state !== "resolved" && f.state !== "abandoned" && f.state !== "dormant");
  }
  foreshadows = foreshadows.slice(0, maxForeshadows);

  const latestChapter = chapterFiles.reduce((max, chapter) => Math.max(max, chapter.number), 0);
  const cur = opts.currentChapterNum ?? latestChapter + 1;
  const minCh = Math.max(1, cur - lookback);
  const recentChapters =
    lookback > 0
      ? chapterFiles
          .filter((c) => c.number <= cur && c.number >= minCh)
          .sort((a, b) => b.number - a.number)
          .slice(0, lookback)
      : [];

  const sections: Array<{ title: string; body: string }> = [];
  const recalled = await retrieveNovelMemories({
    novelId,
    query: opts.query,
    currentChapter: cur,
    canonicalLimit: opts.taskType === "write_chapter" ? 6 : 8,
    longLimit: opts.taskType === "write_chapter" ? 10 : 14,
    shortLimit: opts.taskType === "write_chapter" ? 8 : 5,
  });
  const recalledMarkdown = memoryRecallToMarkdown(recalled);
  if (recalledMarkdown) {
    sections.push({
      title: "分层小说记忆（均可追溯到文件或章节）",
      body: recalledMarkdown,
    });
  }

  const metaLines: string[] = [`作品: ${novel?.title ?? "未命名"}`, `总章数: ${novel?.total_chapters ?? "?"}`];
  const meta = (novel?.metadata || {}) as Record<string, string>;
  const outline = (meta.outline || "").slice(0, profile.outlineSlice);
  if (outline) metaLines.push(`大纲摘录(${profile.outlineChars}): ${outline}`);
  const premise = (meta.premise || "").slice(0, 400);
  if (premise) metaLines.push(`前提设定: ${premise}`);
  sections.push({ title: "作品概况", body: metaLines.join("\n") });

  if (entities.length > 0) {
    const high = entities.filter((e) => e.importance === "high");
    const mid = entities.filter((e) => e.importance === "mid");
    const lines: string[] = [];
    if (high.length > 0) lines.push(`**核心实体**: ${high.map(formatEntity).join(" / ")}`);
    if (mid.length > 0) lines.push(`**重要实体**: ${mid.map(formatEntity).join(" / ")}`);
    sections.push({ title: `实体卡片(${entities.length})`, body: lines.join("\n") });
  }

  const activeFs = foreshadows.filter((f) => f.state === "planted" || f.state === "activated");
  if (activeFs.length > 0) {
    const lines = activeFs.map((f, i) => {
      const marker = f.plant_chapter ? `(埋${f.plant_chapter}章` : "(章未标";
      const target = f.target_resolve_chapter ? `→预期${f.target_resolve_chapter}章)` : ")";
      return `${i + 1}. ${f.description} ${marker}${target}`;
    });
    sections.push({ title: `未回收伏笔(${activeFs.length})`, body: lines.join("\n") });
  }

  if (recentChapters.length > 0) {
    const summaries = recentChapters.map((ch) => {
      const oneLiner = (ch.content || "").replace(/\s+/g, " ").slice(0, 160);
      return `- 第${ch.number}章「${ch.title || "无题"}」: ${oneLiner}`;
    });
    sections.push({
      title: `前 ${recentChapters.length} 章摘要`,
      body: summaries.join("\n"),
    });
  }

  return {
    contextSections: sections,
    stats: {
      entitiesTotal: entities.length,
      entitiesSlim: entities.length,
      foreshadowsActive: activeFs.length,
      chaptersLookback: recentChapters.length,
      outlineTokens: Math.ceil((outline?.length ?? 0) / 2),
      canonicalMemories: recalled.canonical.length,
      longMemories: recalled.long.length,
      shortMemories: recalled.short.length,
    },
  };
}

function formatEntity(e: EntityCard): string {
  const stateMarker = e.active_state === "active" ? "" : e.active_state === "cooling" ? "(冷)" : "(完结)";
  const shortSummary = e.summary ? `:${e.summary.slice(0, 30)}` : "";
  return `${e.name}${stateMarker}${shortSummary}`;
}

export function contextToLLMText(ctx: AssembledContext): string {
  return ctx.contextSections.map((s) => `## ${s.title}\n${s.body}`).join("\n\n");
}
