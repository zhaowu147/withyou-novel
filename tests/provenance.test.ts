import {
  AUTHOR_FACT_DEPTH,
  canFeed,
  DERIVED_ARTIFACT_ROOT,
  depthForMemoryKind,
  depthOfMemory,
  derivedArtifactBanner,
  isDerivedArtifactPath,
  MAX_DERIVED_DEPTH,
} from "../src/lib/memory/provenance";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 这些断言锁死记忆隔离的深度模型。改动它们等于改动「派生记忆能不能回流成事实」
 * 这条核心约束，请先回到 provenance.ts 头部的说明确认是有意为之。
 */

test("层级：作者事实=0，剧情块=1，阶段=2", () => {
  assert.equal(AUTHOR_FACT_DEPTH, 0);
  assert.equal(depthForMemoryKind("block_summary"), 1);
  assert.equal(depthForMemoryKind("stage_summary"), 2);
  assert.equal(MAX_DERIVED_DEPTH, 2);
});

test("未登记的种类一律按作者事实处理（正文/设定抽取出来的记忆）", () => {
  for (const kind of ["chapter_summary", "setting", "outline", "event", undefined]) {
    assert.equal(depthForMemoryKind(kind), AUTHOR_FACT_DEPTH, `${kind} 应为 depth 0`);
  }
});

test("canFeed：只允许严格更浅的输入", () => {
  assert.equal(canFeed(0, 1), true, "章节事实可以喂剧情块");
  assert.equal(canFeed(0, 2), true, "章节事实可以喂阶段");
  assert.equal(canFeed(1, 2), true, "剧情块可以喂阶段");
  assert.equal(canFeed(1, 1), false, "同深不可互喂");
  assert.equal(canFeed(2, 2), false, "阶段不能喂阶段 —— 这正是自我放大的入口");
  assert.equal(canFeed(2, 1), false, "更深的不能倒喂更浅的");
});

test("canFeed：产出层级不得超过 MAX_DERIVED_DEPTH（摘要的摘要的摘要）", () => {
  assert.equal(canFeed(2, 3), false);
  assert.equal(canFeed(0, 3), false, "即使输入是作者事实，也不许再造第三层");
});

test("depthOfMemory 优先读落盘 provenance", () => {
  assert.equal(depthOfMemory({ kind: "block_summary", provenance: { depth: 1 } }), 1);
  assert.equal(depthOfMemory({ kind: "stage_summary", provenance: { depth: 2 } }), 2);
});

test("depthOfMemory 兜底：升级前写入的旧派生记录不会被当成作者事实", () => {
  // 旧数据没有 provenance 字段，只有 kind 和 source.type
  assert.equal(depthOfMemory({ kind: "block_summary" }), 1);
  assert.equal(depthOfMemory({ kind: "stage_summary" }), 2);
  // kind 也丢了、只剩 source.type=derived 时，至少保证 ≥1，不许当 depth 0 用
  assert.equal(depthOfMemory({ source: { type: "derived" } }), 1);
});

test("depthOfMemory：非法 provenance 值退回按 kind 推断", () => {
  assert.equal(depthOfMemory({ kind: "stage_summary", provenance: { depth: Number.NaN } }), 2);
  assert.equal(depthOfMemory({ kind: "stage_summary", provenance: { depth: -1 } }), 2);
});

test("isDerivedArtifactPath 认得派生目录及其子路径", () => {
  assert.equal(isDerivedArtifactPath(`${DERIVED_ARTIFACT_ROOT}剧情块/第001-005章.md`), true);
  assert.equal(isDerivedArtifactPath(`${DERIVED_ARTIFACT_ROOT}阶段/第001-010章.md`), true);
  assert.equal(isDerivedArtifactPath(`${DERIVED_ARTIFACT_ROOT}当前状态.md`), true);
  assert.equal(isDerivedArtifactPath("派生记忆"), true, "目录本身也算");
});

test("isDerivedArtifactPath 容忍反斜杠与前导 ./（Windows 路径拼接）", () => {
  assert.equal(isDerivedArtifactPath("派生记忆\\剧情块\\第001-005章.md"), true);
  assert.equal(isDerivedArtifactPath("./派生记忆/阶段/第001-010章.md"), true);
});

test("isDerivedArtifactPath 不误伤作者文件", () => {
  for (const p of [
    "设定/核心设定.md",
    "大纲/总纲.md",
    "正文/第001章.md",
    "追踪/伏笔.md",
    "我的派生记忆笔记.md", // 名字里含关键词但不在派生目录下
  ]) {
    assert.equal(isDerivedArtifactPath(p), false, `${p} 是作者文件`);
  }
});

test("派生 .md 头部带层级告警，人和模型读到都知道这不是作者事实", () => {
  const banner = derivedArtifactBanner(1);
  assert.match(banner, /depth=1/);
  assert.match(banner, /非作者确认事实/);
});
