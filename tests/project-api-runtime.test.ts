import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

test("项目章节写入经过版本校验并可以通过检查点回滚", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-pi-project-api-"));
  const previousRoot = process.env.WITHYOU_DATA_DIR;
  process.env.WITHYOU_DATA_DIR = root;
  try {
    const { resetDataRootCache } = await import("../src/lib/runtime/app-paths");
    resetDataRootCache();
    const { novelFS } = await import("../src/lib/novel-fs");
    const { saveChapterFile } = await import("../src/lib/local/store");
    const { contentVersionHash } = await import("../src/lib/novel/content-hash");
    const { createProjectApiToolDefinitions } = await import("../src/lib/pi/project-tools");
    const novelId = "pi-api-fixture";
    novelFS.createProject(novelId);
    await saveChapterFile({ novel_id: novelId, number: 1, title: "开端", content: "旧正文" });
    const fakePi = {
      defineTool: (definition: unknown) => definition,
    } as unknown as typeof import("@earendil-works/pi-coding-agent");
    const tools = createProjectApiToolDefinitions(fakePi, novelId) as unknown as Array<{
      name: string;
      execute: (id: string, params: Record<string, unknown>) => Promise<{ details?: Record<string, unknown> }>;
    }>;
    const read = tools.find((tool) => tool.name === "project_read_chapter");
    const write = tools.find((tool) => tool.name === "project_write_chapter");
    const rollback = tools.find((tool) => tool.name === "project_rollback");
    assert.ok(read && write && rollback);
    const before = await read.execute("read", { number: 1 });
    const expectedHash = contentVersionHash("旧正文");
    assert.equal(before.details?.contentHash, expectedHash);
    const updated = await write.execute("write", { number: 1, content: "新正文", expectedHash });
    const checkpointId = updated.details?.checkpointId;
    assert.equal(typeof checkpointId, "string");
    await assert.rejects(
      () => write.execute("stale", { number: 1, content: "覆盖", expectedHash }),
      /已被其他修改更新/,
    );
    await rollback.execute("rollback", { checkpointId });
    const after = await read.execute("read-after", { number: 1 });
    assert.equal(after.details?.contentHash, expectedHash);
  } finally {
    if (previousRoot === undefined) delete process.env.WITHYOU_DATA_DIR;
    else process.env.WITHYOU_DATA_DIR = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
