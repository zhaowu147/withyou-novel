/**
 * 记忆来源层级（provenance depth）—— 记忆隔离的深度护栏。
 *
 * 背景：作者的核心诉求是「每个功能自己回读文件树确认，不继承他人推断」。
 * 但归并出的派生记忆会被写回文件树的 `派生记忆/` 目录，一旦有功能把整棵文件树
 * 当作者事实回读，AI 的推断就会以「已确认事实」的身份重新进入下一轮推断，
 * 再被归并、再写回 —— 这是项目里唯一能自我放大的污染路径。
 *
 * 这里给每条记忆一个 depth：
 *   0 = 作者事实（正文章节、手写设定文件、项目元数据）
 *   1 = 一级派生（5 章剧情块摘要，只允许读 depth 0）
 *   2 = 二级派生（10 章阶段摘要，只允许读 depth ≤ 1）
 *
 * 硬约束：`depth(输入) < depth(输出)`。因此 depth 2 不能再喂给任何归并，
 * 「摘要的摘要的摘要」不会无限套娃，漂移被限制在两层之内。
 *
 * 本文件是纯常量与纯函数，不 import 任何记忆模块 —— 避免与 novel-memory /
 * consolidation 形成 import 环（biome noImportCycles 会报错）。
 */

/** 作者事实：正文、手写设定、项目元数据。任何功能都可无条件采信。 */
export const AUTHOR_FACT_DEPTH = 0;

/** 允许存在的最深派生层级。超过这一层的记忆不得再作为任何归并的输入。 */
export const MAX_DERIVED_DEPTH = 2;

/** 派生产物在文件树中的根目录。写在这里的东西一律不是作者事实。 */
export const DERIVED_ARTIFACT_ROOT = "派生记忆/";

/** 记忆种类 → 固定层级。未列出的种类都视为作者事实（depth 0）。 */
const KIND_DEPTH: Readonly<Record<string, number>> = {
  block_summary: 1,
  stage_summary: 2,
};

/** provenance 落盘结构。旧数据没有这个字段，读取侧一律走 depthOfMemory 兜底。 */
export interface MemoryProvenance {
  /** 见本文件头部的层级定义 */
  depth: number;
  /** 本条记忆由哪些记忆归并而来（记 id，便于人工追溯） */
  derived_from?: string[];
}

/** 供本文件判定用的最小记忆结构，避免反向依赖 novel-memory 的完整类型。 */
interface MemoryLike {
  kind?: string;
  provenance?: MemoryProvenance;
  source?: { type?: string; path?: string };
}

export function depthForMemoryKind(kind: string | undefined): number {
  return KIND_DEPTH[kind ?? ""] ?? AUTHOR_FACT_DEPTH;
}

/**
 * 读取一条记忆的层级。
 * 优先用落盘的 provenance；旧数据缺字段时按 kind 推断，保证升级前写入的
 * 派生记忆也不会被当成 depth 0 的作者事实。
 */
export function depthOfMemory(memory: MemoryLike): number {
  const stored = memory.provenance?.depth;
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= 0) return stored;
  if (memory.source?.type === "derived") return Math.max(1, depthForMemoryKind(memory.kind));
  return depthForMemoryKind(memory.kind);
}

/** 输入能否用于产出 outputDepth 层的记忆。等深或更深一律拒绝。 */
export function canFeed(inputDepth: number, outputDepth: number): boolean {
  return inputDepth < outputDepth && outputDepth <= MAX_DERIVED_DEPTH;
}

/** 该路径是否是 AI 派生产物（写回文件树但不是作者事实）。 */
export function isDerivedArtifactPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
  return normalized === DERIVED_ARTIFACT_ROOT.slice(0, -1) || normalized.startsWith(DERIVED_ARTIFACT_ROOT);
}

/** 写进派生 .md 头部的告警行，让人和模型读到文件时都知道这不是作者确认的事实。 */
export function derivedArtifactBanner(depth: number): string {
  return `> ⚠ 记忆层级：派生 depth=${depth}（AI 归并产物，非作者确认事实；不得作为回读文件树时的事实源）`;
}
