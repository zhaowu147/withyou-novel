import { normalizeProjectId, resolveProjectPath } from "../src/lib/security/project-path";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-path-test-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("accepts a normal Unicode project id", () => {
  assert.equal(normalizeProjectId(" 测试小说 "), "测试小说");
  assert.equal(
    resolveProjectPath(root, "测试小说", "正文/第一章.md"),
    path.join(root, "测试小说", "正文", "第一章.md"),
  );
});

for (const value of [
  "..",
  "../escape",
  "..\\escape",
  "C:\\escape",
  "C:escape",
  "\\\\server\\share",
  "/tmp/escape",
  "NUL",
  "name.",
]) {
  test(`rejects dangerous project id: ${JSON.stringify(value)}`, () => {
    assert.throws(() => normalizeProjectId(value), /invalid novel id/);
  });
}

for (const value of ["../escape.md", "..\\escape.md", "C:\\escape.md", "\\\\server\\share.md", "/tmp/escape.md"]) {
  test(`rejects dangerous file path: ${JSON.stringify(value)}`, () => {
    assert.throws(() => resolveProjectPath(root, "测试小说", value), /路径穿越检测/);
  });
}

test("rejects an existing symlink that escapes the novels root", { skip: process.platform === "win32" }, () => {
  const project = path.join(root, "测试小说");
  fs.mkdirSync(project, { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(project, "outside"), "dir");
  assert.throws(() => resolveProjectPath(root, "测试小说", "outside/file.md"), /路径穿越检测/);
});
