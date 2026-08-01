import { validateProjectChapterNumber, validateProjectField } from "../src/lib/pi/project-tools";
import assert from "node:assert/strict";
import { test } from "node:test";

test("项目工具的章节和字段边界不会放宽到任意文件或元数据", () => {
  assert.equal(validateProjectChapterNumber(1), 1);
  assert.equal(validateProjectChapterNumber(100_000), 100_000);
  assert.throws(() => validateProjectChapterNumber(0));
  assert.throws(() => validateProjectChapterNumber(1.5));
  assert.equal(validateProjectField("outline"), "outline");
  assert.equal(validateProjectField("totalChapters"), "totalChapters");
  assert.throws(() => validateProjectField("user_id"));
  assert.throws(() => validateProjectField("arbitraryMetadata"));
});

test("未绑定小说时仍暴露稳定的项目工具集合，但执行会明确提示绑定要求", async () => {
  const { createProjectApiToolDefinitions } = await import("../src/lib/pi/project-tools");
  const fakePi = {
    defineTool: (definition: unknown) => definition,
  } as unknown as typeof import("@earendil-works/pi-coding-agent");
  const tools = createProjectApiToolDefinitions(fakePi, null) as unknown as Array<{
    name: string;
    execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
  }>;
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "project_context",
    "project_list_chapters",
    "project_read_chapter",
    "project_write_chapter",
    "project_rollback",
    "project_read_data",
    "project_write_data",
    "project_entities",
    "project_foreshadows",
    "project_timeline",
    "project_memories",
    "project_graph_read",
  ]);
  await assert.rejects(() => tools[0].execute("call", {}), /尚未绑定小说/);
});
