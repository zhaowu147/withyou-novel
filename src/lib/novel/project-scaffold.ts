/**
 * 新建项目时写入的空模板 —— 单一真相源。
 *
 * 为什么要单独抽出来：createProject 会给每个创作文件先落一份占位模板
 * （比如 `大纲/总纲.md` 里只有一行 `# 书名 — 总纲`）。于是"文件存在"并不等于
 * "用户写过东西"。服务端回读文件树时若把占位模板当成真内容，就会用一行标题
 * 盖掉 meta 里真正的数据。
 *
 * 用逐字节比对判定"还是空模板"，不做启发式猜测 —— 模板内容就在这里，
 * 改模板时两边一起改，不会漂。
 *
 * 纯函数、无 IO、无 server-only，novel-fs 与回读侧共用。
 */

/** 与项目名无关的固定模板。 */
const STATIC_SCAFFOLD: Readonly<Record<string, string>> = {
  "设定/角色/角色设定.md": "# 角色设定\n",
  "设定/世界观/世界设定.md": "# 世界设定\n",
  "设定/金手指.md": "# 金手指设定\n",
  "追踪/伏笔.md":
    "# 伏笔追踪\n\n| ID | 描述 | 埋设章 | 预计回收 | 实际回收 | 状态 |\n|----|------|--------|----------|----------|------|\n",
  "追踪/时间线.md": "# 故事时间线\n\n| 章节 | 事件 | 涉及角色 | 备注 |\n|------|------|----------|------|\n",
  "追踪/角色状态.md":
    "# 角色当前状态\n\n> 每写完一章后更新\n\n| 角色 | 身份 | 能力/等级 | 位置 | 状态 | 关系变化 |\n|------|------|-----------|------|------|----------|\n",
  "追踪/上下文.md": "# 日更进度\n\n- 当前位置: 准备开始\n- 下一章: 第1章\n- 待处理: \n",
};

/** 标题里带项目名的模板。 */
const TITLED_SCAFFOLD: Readonly<Record<string, string>> = {
  "大纲/总纲.md": "总纲",
  "大纲/细纲.md": "章节细纲",
  "大纲/创意方案.md": "创意方案",
  "大纲/作品简介.md": "作品简介",
};

/** 核心设定模板带创建时间戳，内容随时间变化，因此不参与"是否仍是模板"的比对。 */
export function coreSettingScaffold(projectName: string, createdAt: string): string {
  return `# ${projectName} — 核心设定\n\n> 创建时间: ${createdAt}\n\n## 基本信息\n- 书名: ${projectName}\n- 题材: \n- 目标平台: \n- 预计字数: \n\n## 一句话梗概\n\n## 主角设定\n- 姓名: \n- 核心特质: \n- 金手指: \n- 弱点: \n\n## 世界观骨架\n\n## 核心冲突\n`;
}

/** 新项目要落盘的所有可比对模板（不含带时间戳的核心设定）。 */
export function scaffoldFiles(projectName: string): Record<string, string> {
  const out: Record<string, string> = { ...STATIC_SCAFFOLD };
  for (const [filePath, title] of Object.entries(TITLED_SCAFFOLD)) {
    out[filePath] = `# ${projectName} — ${title}\n`;
  }
  return out;
}

/**
 * 该文件是否仍是新建时的空模板（＝用户从未写过内容）。
 *
 * 只比对结尾空白，其余逐字节相同才算 —— 用户哪怕多敲一个字都算有内容。
 * 带标题的那几个不比对项目名：落盘时用的是 normalizeProjectId 归一化后的名字，
 * 调用方手里往往是原始 novelId，硬比会因为归一化差异漏判。整份内容只有那一行
 * 标题，就足以断定用户没写过东西。
 */
export function isUntouchedScaffold(filePath: string, content: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const body = content.trimEnd();

  const staticTemplate = STATIC_SCAFFOLD[normalizedPath];
  if (staticTemplate !== undefined) return body === staticTemplate.trimEnd();

  const title = TITLED_SCAFFOLD[normalizedPath];
  if (title === undefined) return false;
  // 形如 `# 任意书名 — 总纲`，且全文再无其他内容。
  // 标题都是固定中文词，不含正则元字符，直接拼接安全。
  return new RegExp(`^# [^#\\n]*—\\s*${title}$`).test(body);
}
