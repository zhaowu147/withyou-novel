import type { PromptPackage } from "../src/lib/prompts/prompt-package";
import { deletePackage, readPackage, savePackage } from "../src/lib/prompts/prompt-store";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

test("自定义提示词包原子保存、保留备份并可从损坏主文件恢复", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-prompts-"));
  const previous = process.env.NOVELS_BASE_DIR;
  process.env.NOVELS_BASE_DIR = root;
  try {
    const initial: PromptPackage = {
      id: "custom-safe",
      name: "安全提示词",
      description: "测试",
      scope: "writer",
      systemPrompt: "第一版",
    };
    savePackage("测试小说", initial);
    savePackage("测试小说", { ...initial, systemPrompt: "第二版" });
    const file = path.join(root, "测试小说", "prompts", "custom-safe.json");
    assert.equal(readPackage("测试小说", "custom-safe")?.systemPrompt, "第二版");
    assert.equal(fs.existsSync(`${file}.bak`), true);

    fs.writeFileSync(file, "{broken", "utf8");
    assert.equal(readPackage("测试小说", "custom-safe")?.systemPrompt, "第一版");
    assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith("custom-safe.json.corrupt.")));
  } finally {
    if (previous === undefined) delete process.env.NOVELS_BASE_DIR;
    else process.env.NOVELS_BASE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("提示词包路径拒绝越界 ID", () => {
  assert.equal(readPackage("测试小说", "../outside"), null);
  assert.equal(deletePackage("测试小说", "../outside"), false);
  assert.throws(
    () =>
      savePackage("测试小说", {
        id: "../outside",
        name: "越界",
        description: "",
        scope: "writer",
        systemPrompt: "x",
      }),
    /ID 无效/,
  );
});
