import { novelDataChapters } from "@/lib/novel/import-parser";
import type { ToolId } from "@/stores/session-owner";
import type { StoryGraph } from "@/types/graph";
import type { NovelData } from "@/types/novel";

export interface DynamicToolState {
  actionLabel: string;
  mode: "create" | "continue" | "extract" | "improve" | "check";
  description: string;
  sources: string[];
  variableDefaults: Record<string, string>;
}

function chapterSources(data: NovelData): string[] {
  const chapters = novelDataChapters(data.chapters);
  return chapters.length ? [`已有正文 ${chapters.length} 章（至第 ${chapters.at(-1)?.number} 章）`] : [];
}

export function getDynamicToolState(toolId: ToolId, data: NovelData): DynamicToolState {
  const chapters = novelDataChapters(data.chapters);
  const lastChapter = chapters.at(-1)?.number ?? 0;
  const sources = chapterSources(data);
  const nextStart = Math.max(1, lastChapter + 1);
  const commonDefaults = {
    startChapter: String(nextStart),
    endChapter: String(nextStart + 4),
  };

  switch (toolId) {
    case "detailed-outline":
      if (chapters.length && !data.detailedOutline.trim()) {
        return {
          actionLabel: "反推并规划后续细纲",
          mode: "extract",
          description: "先从已有正文识别章节状态，再承接最后一章规划后续。",
          sources,
          variableDefaults: commonDefaults,
        };
      }
      if (chapters.length) {
        return {
          actionLabel: "继续规划细纲",
          mode: "continue",
          description: "承接已有正文、人物状态和未完成事件，生成下一批章节计划。",
          sources,
          variableDefaults: commonDefaults,
        };
      }
      return {
        actionLabel: data.detailedOutline.trim() ? "扩展或修订细纲" : "展开大纲为细纲",
        mode: data.detailedOutline.trim() ? "improve" : "create",
        description: "从已有大纲节点展开逐章执行计划。",
        sources,
        variableDefaults: { startChapter: "1", endChapter: "5" },
      };
    case "outline":
      if (chapters.length && !data.outline.trim()) {
        return {
          actionLabel: "从正文反推并续写大纲",
          mode: "extract",
          description: "识别已发生剧情，再规划尚未写出的故事阶段。",
          sources,
          variableDefaults: {},
        };
      }
      if (chapters.length) {
        return {
          actionLabel: "校准并续写大纲",
          mode: "check",
          description: "以正文事实为准检查偏差，并继续规划后续。",
          sources,
          variableDefaults: {},
        };
      }
      break;
    case "character":
      if (chapters.length && !data.characters.trim()) {
        return {
          actionLabel: "从正文识别人物",
          mode: "extract",
          description: "提取已有角色、别名、关系和当前状态，再补足人物档案。",
          sources,
          variableDefaults: {},
        };
      }
      if (data.characters.trim()) {
        return {
          actionLabel: "补充或新增角色",
          mode: "improve",
          description: "保留已确认人物，按剧情缺口补充角色。",
          sources,
          variableDefaults: {},
        };
      }
      break;
    case "worldview":
      if (chapters.length && !data.worldview.trim()) {
        return {
          actionLabel: "从正文识别世界设定",
          mode: "extract",
          description: "从地点、势力、规则和能力限制中反推世界观。",
          sources,
          variableDefaults: {},
        };
      }
      break;
    case "synopsis":
      if (chapters.length) {
        return {
          actionLabel: data.synopsis.trim() ? "更新作品简介" : "根据正文生成简介",
          mode: data.synopsis.trim() ? "improve" : "extract",
          description: "结合实际正文与规划内容生成不剧透的作品简介。",
          sources,
          variableDefaults: {},
        };
      }
      break;
    case "opening":
      if (chapters.length) {
        return {
          actionLabel: "优化已有开篇",
          mode: "improve",
          description: "基于导入的开篇正文检查钩子、人物登场和信息释放。",
          sources,
          variableDefaults: {},
        };
      }
      break;
  }

  const labels: Partial<Record<ToolId, string>> = {
    "book-name": "书名",
    brainstorm: "创意方案",
    worldview: "世界观",
    character: "角色",
    goldfinger: "金手指",
    outline: "大纲",
    "detailed-outline": "细纲",
    opening: "开篇",
    synopsis: "作品简介",
  };
  const outputExists: Partial<Record<ToolId, boolean>> = {
    "book-name": data.novelName !== "我的作品",
    brainstorm: Boolean(data.brainstorm.trim()),
    worldview: Boolean(data.worldview.trim()),
    character: Boolean(data.characters.trim()),
    goldfinger: Boolean(data.goldfinger.trim()),
    outline: Boolean(data.outline.trim()),
    "detailed-outline": Boolean(data.detailedOutline.trim()),
    opening: Boolean(data.opening.trim()),
    synopsis: Boolean(data.synopsis.trim()),
  };
  const label = labels[toolId] || "内容";
  return {
    actionLabel: outputExists[toolId] ? `完善${label}` : `生成${label}`,
    mode: outputExists[toolId] ? "improve" : "create",
    description: "根据当前文件树中已经确认的创作资料生成。",
    sources,
    variableDefaults: {},
  };
}

function selectedChapters(toolId: ToolId, data: NovelData) {
  const chapters = novelDataChapters(data.chapters);
  if (chapters.length <= 6) return chapters;
  if (toolId === "detailed-outline" || toolId === "opening") return chapters.slice(-4);
  if (toolId === "outline" || toolId === "character" || toolId === "worldview" || toolId === "synopsis") {
    return [...chapters.slice(0, 2), ...chapters.slice(-4)];
  }
  return chapters.slice(-3);
}

export function buildChapterKnowledgeContext(toolId: ToolId, data: NovelData, maxChars = 24_000): string {
  const chapters = selectedChapters(toolId, data);
  if (!chapters.length) return "";
  const sections: string[] = [];
  let used = 0;
  for (const chapter of chapters) {
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    const content = chapter.content.slice(0, Math.min(6_000, remaining));
    used += content.length;
    sections.push(`### 第${chapter.number}章 ${chapter.title}\n${content}`);
  }
  return `## 文件树中的已有正文\n${sections.join("\n\n")}`;
}

export function summarizeGraphKnowledge(graph: StoryGraph | null, maxChars = 12_000): string {
  if (!graph || (!graph.nodes.length && !graph.events.length)) return "";
  const isUsable = (item: { reviewStatus?: string; visibility?: string; freshness?: string }) =>
    item.reviewStatus === "confirmed" && item.visibility !== "hidden" && item.freshness !== "superseded";
  const confirmedNodes = graph.nodes.filter(isUsable);
  const names = new Map(confirmedNodes.map((node) => [node.id, node.name]));
  const nodes = graph.nodes
    .filter(isUsable)
    .slice(0, 80)
    .map(
      (node) =>
        `- [${node.type}] ${node.name}${node.description ? `：${node.description}` : ""}${node.status ? `（状态：${node.status}）` : ""}`,
    )
    .join("\n");
  const relations = graph.edges
    .filter((edge) => isUsable(edge) && names.has(edge.source) && names.has(edge.target))
    .slice(0, 80)
    .map(
      (edge) =>
        `- ${names.get(edge.source) || edge.source} —${edge.relation}→ ${names.get(edge.target) || edge.target}`,
    )
    .join("\n");
  const events = graph.events
    .filter(isUsable)
    .slice(-60)
    .map((event) => `- 第${event.chapterStart ?? "?"}章 ${event.title}${event.summary ? `：${event.summary}` : ""}`)
    .join("\n");
  return [
    `## 已识别的项目知识`,
    nodes && `### 实体\n${nodes}`,
    relations && `### 关系\n${relations}`,
    events && `### 事件\n${events}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, maxChars);
}
