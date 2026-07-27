/**
 * 创作字段 ↔ 文件树路径 ↔ 显示名 —— 全项目唯一真相源。
 *
 * 背景：项目此前有多处各自硬编码"字段/文件/显示名"的对应关系
 * （novel-fs.createProject 的落盘路径、data/route 的 FIELD_FILES、
 * novel.ts 的 FILE_FIELDS、file-tree 内联的节点数组、collaboration 的
 * sync 读取），措辞和路径互有出入，改一处极易漏改其余。
 *
 * 这里把它们收敛成一张表；所有消费者从这张表派生，不再自己写映射。
 *
 * 路径以 novel-fs.createProject 实际落盘为准 —— 用户已有项目的物理文件
 * 就按这些路径存在，任何改动都必须与它对齐，否则会读不到旧数据。
 */

import type { NovelData } from "@/types/novel";

/** NovelData 中「以文本文件承载、可在文件树里查看/编辑」的字段 */
export type NovelTextField =
  | "novelName"
  | "brainstorm"
  | "outline"
  | "detailedOutline"
  | "characters"
  | "worldview"
  | "goldfinger"
  | "synopsis"
  | "opening"
  | "foreshadowing";

export interface FieldMapEntry {
  /** NovelData 字段名 */
  field: NovelTextField;
  /** 文件树节点显示名（中文），与侧栏 label 一致 */
  label: string;
  /**
   * 相对项目根的物理文件路径。
   * novelName 无独立文件（存在 vault meta），故为 null。
   */
  filePath: string | null;
}

/**
 * 唯一真相源。顺序即文件树内创作节点的推荐展示顺序。
 * filePath 与 src/lib/novel-fs.ts createProject 落盘完全一致。
 */
export const FIELD_MAP: readonly FieldMapEntry[] = [
  { field: "novelName", label: "书名", filePath: null },
  { field: "brainstorm", label: "创意方案", filePath: "大纲/创意方案.md" },
  { field: "outline", label: "大纲", filePath: "大纲/总纲.md" },
  { field: "detailedOutline", label: "细纲", filePath: "大纲/细纲.md" },
  { field: "characters", label: "人设", filePath: "设定/角色/角色设定.md" },
  { field: "worldview", label: "世界观", filePath: "设定/世界观/世界设定.md" },
  { field: "goldfinger", label: "金手指", filePath: "设定/金手指.md" },
  { field: "synopsis", label: "作品简介", filePath: "大纲/作品简介.md" },
  { field: "opening", label: "黄金开篇", filePath: "正文/黄金开篇草稿.md" },
  { field: "foreshadowing", label: "伏笔追踪", filePath: "追踪/伏笔.md" },
] as const;

// 编译期护栏：确保每个 field 都是 NovelData 的真实键，改字段名时这里会报错。
type _AssertFieldsAreNovelDataKeys = (typeof FIELD_MAP)[number]["field"] extends keyof NovelData ? true : never;
const _fieldCheck: _AssertFieldsAreNovelDataKeys = true;
void _fieldCheck;

/** 字段 → 物理文件路径（仅含有文件的字段）。data/route 的 FIELD_FILES 用它。 */
export function fieldFilePaths(): Partial<Record<NovelTextField, string>> {
  const out: Partial<Record<NovelTextField, string>> = {};
  for (const entry of FIELD_MAP) {
    if (entry.filePath) out[entry.field] = entry.filePath;
  }
  return out;
}

/** 字段 → 显示名（含 novelName）。 */
export function fieldToLabel(): Record<NovelTextField, string> {
  const out = {} as Record<NovelTextField, string>;
  for (const entry of FIELD_MAP) out[entry.field] = entry.label;
  return out;
}

/** 显示名 → 字段（含 novelName）。 */
export function labelToField(): Record<string, NovelTextField> {
  const out: Record<string, NovelTextField> = {};
  for (const entry of FIELD_MAP) out[entry.label] = entry.field;
  return out;
}

/**
 * 显示名 → 字段，但只含「有文件、可编辑」的字段（排除 novelName）。
 * novel.ts 的 FILE_FIELDS 用它：点击文件树节点读写对应文件内容，
 * 书名没有文件、不作为可编辑文本节点，故排除。
 */
export function editableLabelToField(): Record<string, NovelTextField> {
  const out: Record<string, NovelTextField> = {};
  for (const entry of FIELD_MAP) {
    if (entry.filePath) out[entry.label] = entry.field;
  }
  return out;
}
