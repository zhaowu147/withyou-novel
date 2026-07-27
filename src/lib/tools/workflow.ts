import { buildChapterKnowledgeContext } from "@/lib/tools/project-knowledge";
import type { ToolId } from "@/stores/session-owner";
import type { NovelData } from "@/types/novel";

export type ToolArtifactField =
  | "novelName"
  | "brainstorm"
  | "worldview"
  | "characters"
  | "goldfinger"
  | "outline"
  | "detailedOutline"
  | "synopsis"
  | "opening"
  | "foreshadowing"
  | "chapters";

export interface ToolWorkflow {
  outputField: ToolArtifactField | null;
  required: ToolArtifactField[];
  /** 每一组至少存在一个；用于“已有大纲或已有正文”这类动态入口。 */
  requiredOneOf?: ToolArtifactField[][];
  recommended: ToolArtifactField[];
  context: ToolArtifactField[];
  variableBindings?: Partial<Record<string, ToolArtifactField>>;
}

export const ARTIFACT_LABELS: Record<ToolArtifactField, string> = {
  novelName: "书名",
  brainstorm: "创意方案",
  worldview: "世界观",
  characters: "角色设定",
  goldfinger: "金手指",
  outline: "全书大纲",
  detailedOutline: "章节细纲",
  synopsis: "作品简介",
  opening: "黄金开篇",
  foreshadowing: "伏笔账本",
  chapters: "已有正文",
};

export const ARTIFACT_PRODUCERS: Partial<Record<ToolArtifactField, ToolId>> = {
  novelName: "book-name",
  brainstorm: "brainstorm",
  worldview: "worldview",
  characters: "character",
  goldfinger: "goldfinger",
  outline: "outline",
  detailedOutline: "detailed-outline",
  synopsis: "synopsis",
  opening: "opening",
};

export const TOOL_WORKFLOWS: Record<ToolId, ToolWorkflow> = {
  "book-name": {
    outputField: "novelName",
    required: [],
    recommended: ["brainstorm", "outline"],
    context: ["brainstorm", "worldview", "characters", "goldfinger", "outline"],
    variableBindings: {
      background: "worldview",
      cheat: "goldfinger",
    },
  },
  brainstorm: {
    outputField: "brainstorm",
    required: [],
    recommended: ["worldview"],
    context: ["worldview", "characters", "goldfinger"],
  },
  worldview: {
    outputField: "worldview",
    required: [],
    recommended: ["brainstorm"],
    context: ["brainstorm", "characters"],
    variableBindings: {
      basic: "brainstorm",
    },
  },
  character: {
    outputField: "characters",
    required: [],
    recommended: ["brainstorm", "worldview"],
    context: ["brainstorm", "worldview", "goldfinger", "outline"],
    variableBindings: {
      theme: "worldview",
    },
  },
  goldfinger: {
    outputField: "goldfinger",
    required: [],
    recommended: ["worldview", "characters"],
    context: ["brainstorm", "worldview", "characters"],
    variableBindings: {
      setting: "worldview",
    },
  },
  outline: {
    outputField: "outline",
    required: [],
    requiredOneOf: [["characters", "chapters"]],
    recommended: ["brainstorm", "worldview", "goldfinger"],
    context: ["brainstorm", "worldview", "characters", "goldfinger", "foreshadowing", "chapters"],
    variableBindings: {
      background: "worldview",
      cheat: "goldfinger",
      protagonist: "characters",
    },
  },
  "detailed-outline": {
    outputField: "detailedOutline",
    required: [],
    requiredOneOf: [["outline", "chapters"]],
    recommended: ["characters", "worldview"],
    context: ["outline", "characters", "worldview", "goldfinger", "foreshadowing", "chapters"],
  },
  opening: {
    outputField: "opening",
    required: [],
    requiredOneOf: [
      ["detailedOutline", "outline", "chapters"],
      ["characters", "chapters"],
    ],
    recommended: ["detailedOutline", "worldview", "goldfinger"],
    context: ["detailedOutline", "outline", "characters", "worldview", "goldfinger", "foreshadowing", "chapters"],
    variableBindings: {
      outline: "detailedOutline",
      characters: "characters",
      cheat: "goldfinger",
    },
  },
  synopsis: {
    outputField: "synopsis",
    required: [],
    requiredOneOf: [["outline", "chapters"]],
    recommended: ["characters"],
    context: ["outline", "characters", "worldview", "goldfinger", "chapters"],
    variableBindings: {
      title: "novelName",
      outline: "outline",
    },
  },
};

export function hasArtifact(data: NovelData, field: ToolArtifactField): boolean {
  const value = data[field];
  if (field === "chapters") return typeof value === "object" && value !== null && Object.keys(value).length > 0;
  if (typeof value === "number") return value > 0;
  return typeof value === "string" && value.trim().length > 0 && value !== "我的作品";
}

export function getWorkflowStatus(toolId: ToolId, data: NovelData) {
  const workflow = TOOL_WORKFLOWS[toolId];
  return {
    workflow,
    missingRequired: workflow.required.filter((field) => !hasArtifact(data, field)),
    missingRequiredGroups: (workflow.requiredOneOf ?? []).filter(
      (group) => !group.some((field) => hasArtifact(data, field)),
    ),
    missingRecommended: workflow.recommended.filter((field) => !hasArtifact(data, field)),
    availableContext: workflow.context.filter((field) => hasArtifact(data, field)),
  };
}

export function buildToolContext(toolId: ToolId, data: NovelData, indexedKnowledge = ""): string {
  const { availableContext } = getWorkflowStatus(toolId, data);
  const artifactContext = availableContext
    .filter((field) => field !== "chapters")
    .map((field) => `## ${ARTIFACT_LABELS[field]}\n${String(data[field]).trim()}`)
    .join("\n\n");
  const chapterContext = buildChapterKnowledgeContext(toolId, data);
  const sections =
    toolId === "detailed-outline" || toolId === "opening"
      ? [chapterContext, indexedKnowledge, artifactContext]
      : [artifactContext, indexedKnowledge, chapterContext];
  return sections
    .filter((value) => value.trim())
    .join("\n\n")
    .slice(0, 48_000);
}

export function applyArtifactBindings(
  toolId: ToolId,
  data: NovelData,
  variables: Record<string, string>,
): Record<string, string> {
  const bindings = TOOL_WORKFLOWS[toolId].variableBindings ?? {};
  const next = { ...variables };
  for (const [variable, field] of Object.entries(bindings)) {
    if (!field || next[variable]?.trim() || !hasArtifact(data, field)) continue;
    next[variable] = String(data[field]);
  }
  return next;
}
