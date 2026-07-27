/**
 * 归并输入的层级约束（记忆隔离洞 2）。
 *
 * 交接文件里的原话：consolidation「读派生物又写回文件树，是唯一自我放大的
 * 污染路径」。具体是旧的 previousStageContext 读上一个 stage_summary —— 与本次
 * 产出同为 depth 2，等于阶段摘要接着阶段摘要写，一路传下去无限套娃。
 *
 * 这里锁死：任何输入都必须严格浅于产出层级。
 */
import { selectConsolidationInputs } from "../src/lib/memory/consolidation";
import type { NovelMemory, NovelMemoryKind } from "../src/lib/memory/novel-memory";
import { canFeed, depthOfMemory } from "../src/lib/memory/provenance";
import assert from "node:assert/strict";
import { test } from "node:test";

let seq = 0;

function chapterMemory(chapter: number, content = `第${chapter}章的事实`): NovelMemory {
  seq++;
  return {
    id: `ch-${seq}`,
    novel_id: "n1",
    tier: "short",
    kind: "chapter_summary",
    content,
    entities: [],
    keywords: [],
    importance: "high",
    confidence: 1,
    status: "active",
    source: { type: "chapter", chapter, content_hash: `h${seq}` },
    provenance: { depth: 0 },
    chapter_start: chapter,
    chapter_end: chapter,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function derivedMemory(kind: NovelMemoryKind, start: number, end: number, depth: number): NovelMemory {
  seq++;
  return {
    id: `${kind}-${start}-${end}`,
    novel_id: "n1",
    tier: "long",
    kind,
    content: `${kind} ${start}-${end} 的内容`,
    entities: [],
    keywords: [],
    importance: "high",
    confidence: 1,
    status: "active",
    source: { type: "derived", path: `派生记忆/x/${start}-${end}.md`, content_hash: `h${seq}` },
    provenance: { depth },
    chapter_start: start,
    chapter_end: end,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const BLOCK_JOB = { kind: "block" as const, chapter_start: 6, chapter_end: 10 };
const STAGE_JOB = { kind: "stage" as const, chapter_start: 11, chapter_end: 20 };

test("剧情块产出 depth 1，阶段产出 depth 2", () => {
  assert.equal(selectConsolidationInputs([], BLOCK_JOB).outputDepth, 1);
  assert.equal(selectConsolidationInputs([], STAGE_JOB).outputDepth, 2);
});

test("剧情块只吃区间内的章节事实", () => {
  const memories = [chapterMemory(5), chapterMemory(6), chapterMemory(10), chapterMemory(11)];
  const picked = selectConsolidationInputs(memories, BLOCK_JOB);
  assert.deepEqual(
    picked.chapterRows.map((m) => m.source.chapter),
    [6, 10],
  );
  assert.equal(picked.blockRows.length, 0, "剧情块不读别的剧情块");
  assert.equal(picked.previous, null, "剧情块没有阶段承接");
});

test("阶段汇总吃区间内的剧情块（depth 1 < 2，允许）", () => {
  const memories = [
    derivedMemory("block_summary", 11, 15, 1),
    derivedMemory("block_summary", 16, 20, 1),
    derivedMemory("block_summary", 21, 25, 1), // 区间外
  ];
  const picked = selectConsolidationInputs(memories, STAGE_JOB);
  assert.deepEqual(
    picked.blockRows.map((m) => m.chapter_start),
    [11, 16],
  );
});

test("★ 阶段汇总绝不吃上一个阶段汇总（depth 2 喂 depth 2 = 自我放大）", () => {
  const previousStage = derivedMemory("stage_summary", 1, 10, 2);
  const picked = selectConsolidationInputs([previousStage], STAGE_JOB);

  assert.equal(picked.previous, null, "上一阶段摘要不得作为承接来源");
  assert.ok(!picked.blockRows.some((m) => m.kind === "stage_summary"), "阶段摘要也不得混进剧情块输入");
});

test("阶段承接改用上一阶段末尾的剧情块（depth 1），承接不断但链条到此为止", () => {
  const memories = [
    derivedMemory("block_summary", 1, 5, 1),
    derivedMemory("block_summary", 6, 10, 1),
    derivedMemory("stage_summary", 1, 10, 2),
  ];
  const picked = selectConsolidationInputs(memories, STAGE_JOB);
  assert.equal(picked.previous?.kind, "block_summary");
  assert.equal(picked.previous?.chapter_end, 10, "取上一阶段最靠后的那个剧情块");
});

test("旧数据（没有 provenance 字段）也拦得住：按 kind 兜底判层级", () => {
  const legacy = derivedMemory("stage_summary", 1, 10, 2);
  legacy.provenance = undefined;
  assert.equal(depthOfMemory(legacy), 2, "缺字段时按 kind 推断为 2");
  assert.equal(selectConsolidationInputs([legacy], STAGE_JOB).previous, null);
});

test("非 active 的记忆不参与归并（已被 superseded 的旧版本）", () => {
  const stale = derivedMemory("block_summary", 11, 15, 1);
  stale.status = "superseded";
  const fresh = derivedMemory("block_summary", 16, 20, 1);
  const picked = selectConsolidationInputs([stale, fresh], STAGE_JOB);
  assert.deepEqual(
    picked.blockRows.map((m) => m.chapter_start),
    [16],
  );
});

test("总不变式：任何被选中的输入，层级都严格浅于产出", () => {
  const memories = [
    chapterMemory(11),
    chapterMemory(20),
    derivedMemory("block_summary", 11, 15, 1),
    derivedMemory("block_summary", 6, 10, 1),
    derivedMemory("stage_summary", 1, 10, 2),
  ];
  for (const job of [BLOCK_JOB, STAGE_JOB]) {
    const picked = selectConsolidationInputs(memories, job);
    const all = [...picked.chapterRows, ...picked.blockRows, ...(picked.previous ? [picked.previous] : [])];
    for (const memory of all) {
      assert.ok(
        canFeed(depthOfMemory(memory), picked.outputDepth),
        `${memory.id}(d${depthOfMemory(memory)}) 不该喂给 d${picked.outputDepth} 的产出`,
      );
    }
  }
});
