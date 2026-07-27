/**
 * 工具类模型调用的**唯一服务端上下文注入点**。
 *
 * 规矩：任何要给创作工具喂项目上下文的服务端代码，都从这里拿，不自己拼、
 * 更不采信请求体里前端送来的 context。前端送来的那份是浏览器内存里的副本，
 * 既可能是上一个工具刚生成、尚未落盘的推断，也可能被改包请求任意伪造。
 *
 * 这里做三件事：
 *   1. 自己从文件树回读 NovelData（loadNovelDataFromDisk，文件优先）；
 *   2. 复用前端同一份 buildToolContext 组装，避免前后端各写一套导致漂移；
 *   3. 服务端复核 TOOL_WORKFLOWS 的因果前置 —— 此前这个 DAG 只在前端强制，
 *      直接打 /api/generate 就能跳过（比如没有大纲直接要细纲）。
 */
import "server-only";

import { getGraph } from "@/lib/graph/store";
import { FIELD_MAP } from "@/lib/novel/field-map";
import { isUntouchedScaffold } from "@/lib/novel/project-scaffold";
import { loadNovelDataFromDisk } from "@/lib/novel/server-novel-data";
import { novelFS } from "@/lib/novel-fs";
import { summarizeGraphKnowledge } from "@/lib/tools/project-knowledge";
import {
  ARTIFACT_LABELS,
  buildToolContext,
  getWorkflowStatus,
  TOOL_WORKFLOWS,
  type ToolArtifactField,
} from "@/lib/tools/workflow";
import type { ToolId } from "@/stores/session-owner";
import type { NovelData } from "@/types/novel";

const TOOL_IDS: readonly ToolId[] = [
  "book-name",
  "brainstorm",
  "outline",
  "detailed-outline",
  "opening",
  "character",
  "worldview",
  "goldfinger",
  "synopsis",
];

export function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && (TOOL_IDS as readonly string[]).includes(value);
}

export interface ServerToolContext {
  /** 服务端自己从磁盘读出来的创作数据 */
  data: NovelData;
  /** 可直接塞进 compileToolPrompt 的 projectContext */
  context: string;
  /** 缺失的硬前置 */
  missingRequired: ToolArtifactField[];
  /** 缺失的「至少有其一」前置组 */
  missingRequiredGroups: ToolArtifactField[][];
  /** 本次按工具职责实际扫描到的补充文件，便于调用方诊断上下文来源 */
  scannedFiles: string[];
}

const STANDARD_ARTIFACT_FILES = new Set(
  FIELD_MAP.flatMap((entry) => (entry.filePath ? [entry.filePath.replaceAll("\\", "/")] : [])),
);

function pathMatchesArtifact(filePath: string, field: ToolArtifactField): boolean {
  switch (field) {
    case "novelName":
      return filePath === "设定/核心设定.md";
    case "brainstorm":
      return filePath === "大纲/创意方案.md";
    case "worldview":
      return (
        filePath === "设定/核心设定.md" || filePath.startsWith("设定/世界观/") || filePath.startsWith("设定/势力/")
      );
    case "characters":
      return filePath.startsWith("设定/角色/") || filePath === "追踪/角色状态.md";
    case "goldfinger":
      return filePath === "设定/金手指.md" || filePath === "设定/核心设定.md";
    case "outline":
      return filePath === "大纲/总纲.md" || /^大纲\/(分卷|卷|篇章)/.test(filePath);
    case "detailedOutline":
      return filePath === "大纲/细纲.md" || /^大纲\/细纲[_/-]/.test(filePath);
    case "synopsis":
      return filePath === "大纲/作品简介.md";
    case "opening":
      return filePath === "正文/黄金开篇草稿.md";
    case "foreshadowing":
      return filePath === "追踪/伏笔.md" || filePath === "追踪/时间线.md" || filePath === "追踪/上下文.md";
    case "chapters":
      // 正文由 buildChapterKnowledgeContext 按当前工具抽样，不能在这里重新全量扫描。
      return false;
  }
}

function scanRelevantProjectFiles(
  novelId: string,
  toolId: ToolId,
  maxFiles = 18,
  maxChars = 18_000,
): { context: string; files: string[] } {
  const relevantFields = new Set(TOOL_WORKFLOWS[toolId].context);
  const matches = novelFS
    .listAllFiles(novelId)
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.startsWith("vault/") && !file.startsWith("正文/"))
    .filter((file) => !STANDARD_ARTIFACT_FILES.has(file))
    .filter((file) => [...relevantFields].some((field) => pathMatchesArtifact(file, field)))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));

  const sections: string[] = [];
  const files: string[] = [];
  let usedChars = 0;
  for (const file of matches) {
    if (files.length >= maxFiles || usedChars >= maxChars) break;
    const raw = novelFS.readFileSafe(novelId, file);
    if (!raw?.trim() || isUntouchedScaffold(file, raw)) continue;
    const remaining = maxChars - usedChars;
    const content = raw.trim().slice(0, Math.min(4_000, remaining));
    if (!content) continue;
    files.push(file);
    sections.push(`### ${file}\n${content}`);
    usedChars += content.length;
  }

  return {
    context: sections.length ? `## 按当前功能扫描到的补充文件树资料\n${sections.join("\n\n")}` : "",
    files,
  };
}

export async function buildServerToolContext(novelId: string, toolId: ToolId): Promise<ServerToolContext> {
  const data = loadNovelDataFromDisk(novelId);
  // 图谱是可选增强：读不到就退化成纯文件树上下文，不让它阻断生成。
  let indexedKnowledge = "";
  try {
    indexedKnowledge = summarizeGraphKnowledge(await getGraph(novelId));
  } catch (error) {
    console.warn(`[server-tool-context] 读取故事图谱失败，本次不注入图谱知识: ${novelId}`, error);
  }

  const status = getWorkflowStatus(toolId, data);
  const scanned = scanRelevantProjectFiles(novelId, toolId);
  const canonicalContext = buildToolContext(toolId, data, indexedKnowledge);
  return {
    data,
    context: [scanned.context, canonicalContext].filter(Boolean).join("\n\n").slice(0, 60_000),
    missingRequired: status.missingRequired,
    missingRequiredGroups: status.missingRequiredGroups,
    scannedFiles: scanned.files,
  };
}

/** 前置不满足时给用户的说明；返回 null 表示前置齐备。 */
export function workflowBlockReason(ctx: ServerToolContext): string | null {
  const parts: string[] = [];
  if (ctx.missingRequired.length) {
    parts.push(ctx.missingRequired.map((field) => ARTIFACT_LABELS[field]).join("、"));
  }
  for (const group of ctx.missingRequiredGroups) {
    parts.push(group.map((field) => ARTIFACT_LABELS[field]).join(" 或 "));
  }
  if (!parts.length) return null;
  return `文件树里还缺少生成所需的前置内容：${parts.join("；")}。请先补齐再生成。`;
}
