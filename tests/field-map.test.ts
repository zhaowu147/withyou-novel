import {
  editableLabelToField,
  FIELD_MAP,
  fieldFilePaths,
  fieldToLabel,
  labelToField,
} from "../src/lib/novel/field-map";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 这些期望值 = 收敛前各处硬编码的既有值，也 = novel-fs.createProject 实际落盘路径。
 * 任何改动若使派生结果偏离，即视为可能读不到用户旧文件的回归。
 */
const EXPECTED_FILE_PATHS: Record<string, string> = {
  brainstorm: "大纲/创意方案.md",
  outline: "大纲/总纲.md",
  detailedOutline: "大纲/细纲.md",
  characters: "设定/角色/角色设定.md",
  worldview: "设定/世界观/世界设定.md",
  goldfinger: "设定/金手指.md",
  synopsis: "大纲/作品简介.md",
  opening: "正文/黄金开篇草稿.md",
  foreshadowing: "追踪/伏笔.md",
};

const EXPECTED_TREE_LABELS: Record<string, string> = {
  novelName: "书名",
  brainstorm: "创意方案",
  outline: "大纲",
  detailedOutline: "细纲",
  characters: "人设",
  worldview: "世界观",
  goldfinger: "金手指",
  synopsis: "作品简介",
  opening: "黄金开篇",
  foreshadowing: "伏笔追踪",
};

test("fieldFilePaths 与 novel-fs 落盘路径逐字节一致（含 foreshadowing）", () => {
  assert.deepEqual(fieldFilePaths(), EXPECTED_FILE_PATHS);
});

test("novelName 无文件路径（存于 vault meta，不落文件树）", () => {
  assert.equal(fieldFilePaths().novelName, undefined);
  const novelNameEntry = FIELD_MAP.find((e) => e.field === "novelName");
  assert.equal(novelNameEntry?.filePath, null);
});

test("fieldToLabel 覆盖全部字段（含 novelName），与旧 FIELD_TO_LABEL 一致", () => {
  assert.deepEqual(fieldToLabel(), EXPECTED_TREE_LABELS);
});

test("labelToField 是 fieldToLabel 的无损反转", () => {
  const forward = fieldToLabel();
  const backward = labelToField();
  for (const [field, label] of Object.entries(forward)) {
    assert.equal(backward[label], field, `标签 ${label} 应反解回 ${field}`);
  }
  assert.equal(Object.keys(backward).length, Object.keys(forward).length, "无重复标签");
});

test("editableLabelToField 等于旧 novel.ts FILE_FIELDS（显示名→字段，排除书名）", () => {
  const expected: Record<string, string> = {
    创意方案: "brainstorm",
    大纲: "outline",
    细纲: "detailedOutline",
    人设: "characters",
    世界观: "worldview",
    金手指: "goldfinger",
    作品简介: "synopsis",
    黄金开篇: "opening",
    伏笔追踪: "foreshadowing",
  };
  assert.deepEqual(editableLabelToField(), expected);
  assert.equal(editableLabelToField().书名, undefined, "书名无文件，不应作为可编辑节点");
});

test("文件树创作节点顺序 = FIELD_MAP 过滤后顺序（与旧内联顺序一致）", () => {
  const treeOrder = FIELD_MAP.filter((e) => e.filePath).map((e) => e.label);
  assert.deepEqual(treeOrder, [
    "创意方案",
    "大纲",
    "细纲",
    "人设",
    "世界观",
    "金手指",
    "作品简介",
    "黄金开篇",
    "伏笔追踪",
  ]);
});

test("每个字段的 label 唯一、field 唯一（无重复条目）", () => {
  const fields = FIELD_MAP.map((e) => e.field);
  const labels = FIELD_MAP.map((e) => e.label);
  assert.equal(new Set(fields).size, fields.length, "field 无重复");
  assert.equal(new Set(labels).size, labels.length, "label 无重复");
});
