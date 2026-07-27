/**
 * 空模板判定。
 *
 * createProject 会给每个创作文件先落一份占位模板，因此「文件存在」不等于
 * 「用户写过东西」。服务端回读文件树时要靠这个判定决定用文件还是回落 meta，
 * 判错的后果是：一行占位标题盖掉用户真正的大纲。
 */
import { coreSettingScaffold, isUntouchedScaffold, scaffoldFiles } from "../src/lib/novel/project-scaffold";
import assert from "node:assert/strict";
import { test } from "node:test";

test("createProject 落盘的每一份模板，都能被认出是空模板", () => {
  for (const [filePath, content] of Object.entries(scaffoldFiles("我的书"))) {
    assert.ok(isUntouchedScaffold(filePath, content), `${filePath} 应被判为空模板`);
  }
});

test("判定不依赖项目名（落盘用的是归一化后的名字，调用方手里是原始 id）", () => {
  assert.ok(isUntouchedScaffold("大纲/总纲.md", "# 完全不同的名字 — 总纲\n"));
  assert.ok(isUntouchedScaffold("大纲/细纲.md", "# my-novel-2026 — 章节细纲\n"));
});

test("用户补了内容就不再是空模板 —— 哪怕只多一行", () => {
  assert.equal(isUntouchedScaffold("大纲/总纲.md", "# 我的书 — 总纲\n\n第一卷：下山"), false);
  assert.equal(isUntouchedScaffold("设定/角色/角色设定.md", "# 角色设定\n\n林墨：主角"), false);
  assert.equal(
    isUntouchedScaffold(
      "追踪/伏笔.md",
      "# 伏笔追踪\n\n| ID | 描述 | 埋设章 | 预计回收 | 实际回收 | 状态 |\n|----|------|--------|----------|----------|------|\n| 1 | 玉佩 | 3 | 40 | | planted |\n",
    ),
    false,
  );
});

test("结尾空白差异不影响判定（编辑器可能加/去尾部换行）", () => {
  assert.ok(isUntouchedScaffold("大纲/总纲.md", "# 我的书 — 总纲"));
  assert.ok(isUntouchedScaffold("大纲/总纲.md", "# 我的书 — 总纲\n\n\n"));
  assert.ok(isUntouchedScaffold("设定/金手指.md", "# 金手指设定"));
});

test("不在模板清单里的文件一律不算空模板（正文、派生记忆等）", () => {
  assert.equal(isUntouchedScaffold("正文/第001章.md", "# 第一章\n"), false);
  assert.equal(isUntouchedScaffold("正文/黄金开篇草稿.md", "# 黄金开篇\n"), false);
  assert.equal(isUntouchedScaffold("派生记忆/剧情块/第001-005章.md", "# 派生\n"), false);
});

test("标题形似但不是那一份模板的，不误判", () => {
  assert.equal(isUntouchedScaffold("大纲/总纲.md", "# 我的书 — 细纲\n"), false, "标题对不上");
  assert.equal(isUntouchedScaffold("大纲/总纲.md", "## 我的书 — 总纲\n"), false, "层级不同");
});

test("Windows 反斜杠路径也能命中", () => {
  assert.ok(isUntouchedScaffold("大纲\\总纲.md", "# 我的书 — 总纲\n"));
});

test("核心设定模板带时间戳，不参与比对（但生成函数本身可用）", () => {
  const content = coreSettingScaffold("我的书", "2026-07-26T00:00:00.000Z");
  assert.match(content, /# 我的书 — 核心设定/);
  assert.match(content, /2026-07-26T00:00:00.000Z/);
  assert.equal(isUntouchedScaffold("设定/核心设定.md", content), false, "内容随时间变化，不做模板比对");
});
