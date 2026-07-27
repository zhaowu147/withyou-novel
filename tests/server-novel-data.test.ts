/**
 * 服务端回读文件树的落地测试（记忆隔离洞 1）。
 *
 * 核心断言：/api/generate 用的项目上下文来自磁盘，且**文件优先于 meta**。
 * 这条与 /api/novels/[id]/data 的 GET（meta 优先）有意不同 —— 见
 * src/lib/novel/server-novel-data.ts 头部说明：文件树是用户和 Pi agent 能直接
 * 改的那一面，要"回读文件树确认"就得以文件为准。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-serverdata-"));
process.env.NOVELS_BASE_DIR = path.join(tmpRoot, "novels");

let loadNovelDataFromDisk: typeof import("../src/lib/novel/server-novel-data").loadNovelDataFromDisk;
let saveNovelMeta: typeof import("../src/lib/local/store").saveNovelMeta;
let novelFS: typeof import("../src/lib/novel-fs").novelFS;

before(async () => {
  ({ loadNovelDataFromDisk } = await import("../src/lib/novel/server-novel-data"));
  ({ saveNovelMeta } = await import("../src/lib/local/store"));
  ({ novelFS } = await import("../src/lib/novel-fs"));
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const OUTLINE_PATH = "大纲/总纲.md";

test("字段从文件树读出来", () => {
  const id = "book-basic";
  saveNovelMeta(id, { title: "测试书" });
  novelFS.writeFile(id, OUTLINE_PATH, "文件里的大纲");
  novelFS.writeFile(id, "设定/角色/角色设定.md", "文件里的人设");

  const data = loadNovelDataFromDisk(id);
  assert.equal(data.outline, "文件里的大纲");
  assert.equal(data.characters, "文件里的人设");
});

test("文件与 meta 冲突时以文件为准（外部编辑过文件树的情形）", () => {
  const id = "book-conflict";
  saveNovelMeta(id, { title: "测试书", metadata: { outline: "meta 里的旧大纲" } });
  novelFS.writeFile(id, OUTLINE_PATH, "文件里的新大纲");

  assert.equal(
    loadNovelDataFromDisk(id).outline,
    "文件里的新大纲",
    "meta 可能被外部编辑绕过而过期，回读必须以文件为准",
  );
});

test("文件缺失时回落到 meta（老项目还没生成文件）", () => {
  const id = "book-nofile";
  saveNovelMeta(id, { title: "测试书", metadata: { outline: "只有 meta 有" } });
  assert.equal(loadNovelDataFromDisk(id).outline, "只有 meta 有");
});

test("文件存在但是空白 → 也回落到 meta，不返回空串", () => {
  const id = "book-blank";
  saveNovelMeta(id, { title: "测试书", metadata: { outline: "meta 兜底" } });
  novelFS.writeFile(id, OUTLINE_PATH, "   \n  ");
  assert.equal(loadNovelDataFromDisk(id).outline, "meta 兜底");
});

test("两边都没有 → 空串，调用方据此判定「该产物还不存在」", () => {
  const id = "book-empty";
  saveNovelMeta(id, { title: "测试书" });
  const data = loadNovelDataFromDisk(id);
  assert.equal(data.outline, "");
  assert.equal(data.characters, "");
  assert.deepEqual(data.chapters, {});
});

test("书名与总章数从 meta / 项目信息取，且 novelId 回填", () => {
  const id = "book-meta";
  saveNovelMeta(id, { title: "标题来自项目", metadata: { totalChapters: 120 } });
  const data = loadNovelDataFromDisk(id);
  assert.equal(data.novelName, "标题来自项目");
  assert.equal(data.totalChapters, 120);
  assert.equal(data.novelId, id);
});

test("正文按 NovelData.chapters 的编码格式装配（前端解码得回标题与正文）", async () => {
  const { decodeChapterRecord } = await import("../src/lib/novel/import-parser");
  const id = "book-chapters";
  saveNovelMeta(id, { title: "测试书" });
  novelFS.writeChapter(id, 1, "初到贵地", "第一章正文内容");

  const data = loadNovelDataFromDisk(id);
  const keys = Object.keys(data.chapters);
  assert.equal(keys.length, 1, "应读到 1 章");
  const decoded = decodeChapterRecord(keys[0], data.chapters[keys[0]]);
  assert.equal(decoded.number, 1);
  assert.match(decoded.content, /第一章正文内容/);
});

test("纯读：回读不会把 meta 回写成文件、也不改文件内容", () => {
  const id = "book-readonly";
  saveNovelMeta(id, { title: "测试书", metadata: { characters: "meta 人设" } });
  novelFS.writeFile(id, OUTLINE_PATH, "原始大纲");
  const before = fs.statSync(path.join(process.env.NOVELS_BASE_DIR as string, id, OUTLINE_PATH)).mtimeMs;

  loadNovelDataFromDisk(id);
  loadNovelDataFromDisk(id);

  assert.equal(
    fs.statSync(path.join(process.env.NOVELS_BASE_DIR as string, id, OUTLINE_PATH)).mtimeMs,
    before,
    "回读必须是纯读",
  );
  // 该文件在建项目时已有空模板；关键是回读没把 meta 里的人设写进去。
  assert.equal(
    novelFS.readFileSafe(id, "设定/角色/角色设定.md")?.trimEnd(),
    "# 角色设定",
    "meta 里的人设不应被回读过程落进文件",
  );
});

test("空模板不算内容：不能用一行占位标题盖掉 meta 里的真数据", async () => {
  const { isUntouchedScaffold } = await import("../src/lib/novel/project-scaffold");
  // 建项目时 大纲/总纲.md 就有 `# xxx — 总纲` 占位，这时 meta 才是唯一真数据
  const id = "book-scaffold";
  saveNovelMeta(id, { title: "测试书", metadata: { outline: "meta 里的真大纲" } });
  assert.ok(
    isUntouchedScaffold("大纲/总纲.md", novelFS.readFile(id, "大纲/总纲.md")),
    "新建项目的总纲应被识别为空模板",
  );
  assert.equal(loadNovelDataFromDisk(id).outline, "meta 里的真大纲");
});

test("用户往空模板里补了内容 → 文件立刻优先于 meta", () => {
  const id = "book-touched";
  saveNovelMeta(id, { title: "测试书", metadata: { outline: "meta 旧值" } });
  novelFS.writeFile(id, OUTLINE_PATH, "# book-touched — 总纲\n\n第一卷：下山");
  assert.equal(loadNovelDataFromDisk(id).outline, "# book-touched — 总纲\n\n第一卷：下山");
});
