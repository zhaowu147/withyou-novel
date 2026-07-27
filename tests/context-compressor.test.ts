/**
 * context-compressor 语义锁定测试。
 *
 * 背景：vault 数据链（listTimeline / listActiveForeshadows → assembleVaultPrompt /
 * VaultClient.assembleForPrompt）按 created_at 降序排列 —— 最新在前。
 * 因此 compressVault 用 slice(0, 5) 保留的正是「最近 5 条」，与注释一致。
 * 本测试锁死该语义，防止未来把它「纠正」成 slice(-5)（那才是真 bug：
 * 对最新在前的数组取尾部，会变成保留最早的 5 条）。
 */

import { compressMessages, compressVault } from "../src/lib/ai/context-compressor";
import assert from "node:assert/strict";
import { test } from "node:test";

// 足够长的描述，把 vault 撑过给定 token 上限，触发裁剪
const LONG = "这是一段用来撑爆预算的很长的描述文本。".repeat(20);

function timelineDesc(i: number): { chapter: number; description: string } {
  return { chapter: i, description: `第${i}章事件 ${LONG}` };
}

test("compressVault：未超限时原样返回", () => {
  const vault = { recentTimeline: [{ chapter: 1, description: "短" }] };
  assert.equal(compressVault(vault, 15_000), vault);
});

test("compressVault：timeline 最新在前，slice(0,5) 保留的是最新 5 条", () => {
  // 模拟 listTimeline 的降序输出：chapter 10 最新、排最前
  const timeline = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(timelineDesc);
  const out = compressVault({ recentTimeline: timeline }, 10);
  assert.equal(out.recentTimeline?.length, 5);
  assert.deepEqual(
    out.recentTimeline?.map((t) => t.chapter),
    [10, 9, 8, 7, 6],
    "应保留数组头部（最新）的 5 条，而不是最旧的 5 条",
  );
});

test("compressVault：foreshadows 同样保留头部（最新）5 条", () => {
  const foreshadows = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((i) => ({
    description: `伏笔${i} ${LONG}`,
    plant_chapter: i,
    state: "planted",
  }));
  const out = compressVault({ activeForeshadows: foreshadows }, 10);
  assert.equal(out.activeForeshadows?.length, 5);
  assert.deepEqual(
    out.activeForeshadows?.map((f) => f.plant_chapter),
    [10, 9, 8, 7, 6],
  );
});

test("compressVault：entities 超限时只保留 high importance", () => {
  const entities = [
    { name: "主角", type: "person", importance: "high", active_state: "active", summary: LONG },
    { name: "路人", type: "person", importance: "low", active_state: "active", summary: LONG },
  ];
  const out = compressVault({ activeEntities: entities }, 10);
  assert.deepEqual(
    out.activeEntities?.map((e) => e.name),
    ["主角"],
  );
});

test("compressMessages：超限时保留最近（尾部）N 条完整消息", () => {
  // 消息历史与 vault 相反，按时间正序 push —— 最新在尾部
  const messages = Array.from({ length: 30 }, (_, i) => ({
    role: "user",
    content: `第${i}条 ${LONG}`,
  }));
  const out = compressMessages(messages, { maxHistoryTokens: 10, keepRecentMessages: 10 });
  assert.equal(out.length, 10);
  assert.ok(out[0].content.startsWith("第20条"), "应保留尾部（最新）的 10 条");
  assert.ok(out[9].content.startsWith("第29条"));
});
