import { getTaskEntryCopy, isNaturalLanguageTaskTool } from "@/lib/tools/task-entry";

import assert from "node:assert/strict";
import test from "node:test";

test("大纲和角色使用自然语言任务入口", () => {
  assert.equal(isNaturalLanguageTaskTool("outline"), true);
  assert.equal(isNaturalLanguageTaskTool("character"), true);
  assert.equal(isNaturalLanguageTaskTool("book-name"), false);
});

test("任务入口文案明确告诉用户可以少填信息", () => {
  const outline = getTaskEntryCopy("outline");
  const character = getTaskEntryCopy("character");

  assert.ok(outline?.placeholder.includes("例如"));
  assert.ok(outline?.helper.includes("不用填写完整设定"));
  assert.ok(character?.helper.includes("不需要先填姓名"));
});

test("非试点工具没有任务入口文案", () => {
  assert.equal(getTaskEntryCopy("worldview"), null);
});
