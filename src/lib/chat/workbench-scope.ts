/**
 * workbench-scope.ts
 *
 * 按工作台场景选择对应 Agent，并拼装系统提示词。
 *
 * Workbench scope:
 *   - "chapter"  章节正文撰写
 *   - "plan"     大纲/细纲规划
 *   - "state"    剧情状态追踪
 *   - "memory"   记忆/对话
 *   - "refine"   润色修改
 */

import { buildSystemPrompt } from "@/lib/chat/prompts-loader";

/** scope → Agent 名 */
export const WORKBENCH_SCOPE_AGENT: Record<string, string> = {
  chapter: "WriterAgent",
  plan: "OutlineAgent",
  state: "StateUpdateAgent",
  memory: "CoachAgent",
  refine: "RefineAgent",
};

/** prompt 目录中的 scope → agentId 映射 */
const SCOPE_AGENT_ID: Record<string, string> = {
  chapter: "write",
  plan: "outline",
  state: "state_update",
  memory: "chat",
  refine: "refine",
};

/** 可用 scope 列表 */
export const VALID_SCOPES = Object.keys(WORKBENCH_SCOPE_AGENT);

// ─── scope 专属 prompt 注入 ───

interface WorkbenchContext {
  novelName?: string;
  totalChapters?: number;
  outline?: string;
  characters?: string;
  worldview?: string;
  foreshadowing?: string;
  chapters?: Record<string, string>;
  novelId?: string;
  chapterNum?: number;
  blockIndex?: number;
}

/**
 * 按 scope 构建 workbench system prompt
 *
 * 返回: { systemPrompt, routingInfo }
 *   routingInfo 给前端告知正在用哪个 agent/skill
 */
export function buildWorkbenchSystemPrompt(
  scope: string,
  userMsg: string,
  taskHint: string,
  planSessionLevel: string,
  novelCtx?: WorkbenchContext,
): { systemPrompt: string; routingInfo: Record<string, unknown> } {
  const agentId = SCOPE_AGENT_ID[scope] || "writer";

  // 加载 agent 分层 prompts (L0 + L0.5 + L1 + sub-prompts)
  const loaded = buildSystemPrompt(agentId, "");
  let systemPrompt = loaded ?? "";

  // scope 专属追加规则
  const scopeExtra = buildScopeExtra(scope, userMsg, taskHint, planSessionLevel, novelCtx);
  if (scopeExtra) {
    systemPrompt += `\n\n---\n\n${scopeExtra}`;
  }

  // vault / novel context 已在外层注入 — 这里不再重复
  const routingInfo: Record<string, unknown> = {
    scope,
    agent: WORKBENCH_SCOPE_AGENT[scope] || "WriterAgent",
    task_hint: taskHint || null,
    hinted_skill: pickHintedSkill(scope, userMsg, taskHint),
  };

  return { systemPrompt, routingInfo };
}

/** scope 专属追加规则 */
function buildScopeExtra(
  scope: string,
  _userMsg: string,
  taskHint: string,
  planSessionLevel: string,
  novelCtx?: WorkbenchContext,
): string {
  const novelName = novelCtx?.novelName || "未命名";
  const parts: string[] = [];

  switch (scope) {
    case "chapter":
      parts.push(
        "## 章节撰写模式 (chapter)",
        "",
        `当前作品：《${novelName}》`,
        "你是网文小说作者，正在创作指定章节的正文。",
        "",
        "### 写作要求（必须遵守）",
        "1. 2500-3500 字",
        "2. 每 300 字一个钩子/爽点",
        "3. 对话+行动 ≥ 70%",
        "4. 章末留悬念",
        "5. 纯文本，不要任何 markdown",
        '6. 禁用"非常/极其/十分/无比/瞬间/不禁/顿时"等 AI 高频副词',
        "",
        "### 章节结束协议",
        "正文末尾（独立一行）固定加：",
        '  - 已完成时：写 "第 X 章写完。满意请告诉我「存入第 X 章」。"',
        '  - 同时附加元数据: [WORKBENCH_META]{"task":"write_chapter","chapter_num":X,"task_label":"第X章撰写完成"}',
      );
      if (novelCtx?.outline) {
        parts.push("", "### 大纲锚点", novelCtx.outline.slice(0, 1000));
      }
      if (novelCtx?.characters) {
        parts.push("", "### 当前人物设定", novelCtx.characters.slice(0, 500));
      }
      break;

    case "plan":
      parts.push(
        "## 大纲规划模式 (plan)",
        "",
        `当前作品：《${novelName}》`,
        "你是网文大纲规划师，负责产出/修改小说大纲、细纲、卷纲、块纲。",
        "",
        "### 规划要求",
        "1. 先分析当前作品已有设定，再给出规划建议",
        "2. 总纲 → 卷纲 → 块纲 → 章纲，层级递进",
        "3. 每章 2500-3500 字，规划时节奏/爽点/钩子必须落实",
        "",
        "### 回复协议",
        "回复末尾（独立一行）附元数据：",
        '  [WORKBENCH_META]{"task":"outline_plan","phase":"<阶段>","task_label":"<一句话描述>"}',
      );
      if (planSessionLevel) {
        parts.push("", `### 当前规划层级: ${planSessionLevel}`);
      }
      break;

    case "state":
      parts.push(
        "## 状态追踪模式 (state)",
        "",
        `当前作品：《${novelName}》`,
        "你是剧情状态追踪员，负责从章节正文中提取状态变化。",
        "",
        "### 追踪要求",
        "1. 角色关系变化、势力变化、实力变化、感情变化",
        "2. 伏笔埋下/伏笔揭示",
        "3. 新设定的引入",
        "",
        "### 回复协议",
        "回复末尾附：",
        '  [STATE_UPDATE]{"characters":[],"foreshadows":[],"worldview":[]}',
        '  [WORKBENCH_META]{"task":"state_update","task_label":"状态已提取"}',
      );
      break;

    case "refine":
      parts.push(
        "## 润色模式 (refine)",
        "",
        `当前作品：《${novelName}》`,
        "你是网文文风编辑，负责润色章节正文。",
        "",
        "### 润色要求",
        "1. 短句网感优先",
        "2. 删除 AI 高频副词、模板句",
        "3. 对话 ≥ 50%（动作+语言推动剧情）",
        "4. 标点节奏感（紧张处 5-15 字一句）",
        "",
        "### 回复协议",
        "润色完成后回复末尾附：",
        '  [WORKBENCH_META]{"task":"refine_complete","task_label":"润色完成"}',
      );
      break;
    default:
      parts.push(
        "## 对话模式 (memory)",
        "",
        `当前作品：《${novelName}》`,
        "你是写作教练，陪伴用户写作、答疑、给建议。",
        "",
        "### 回复协议",
        "末尾附：",
        '  [WORKBENCH_META]{"task":"chat","task_label":"对话回复"}',
      );
      break;
  }

  // task_hint 追加
  if (taskHint) {
    parts.push("", "### 用户补充指令", taskHint);
  }

  return parts.join("\n");
}

/** 简单 hinted_skill 推断 (供前端 UI 展示) */
function pickHintedSkill(scope: string, userMsg: string, taskHint: string): string | null {
  const text = `${userMsg} ${taskHint}`.toLowerCase();
  if (scope === "chapter") {
    if (/打斗|战斗|战/.test(text)) return "scene_combat";
    if (/对话|谈|说/.test(text)) return "scene_dialogue";
    if (/钩子|悬念|结尾/.test(text)) return "scene_hook";
    return "scene_default";
  }
  if (scope === "plan") {
    if (/卷|volume/.test(text)) return "outline_volume";
    if (/块|章|block/.test(text)) return "outline_block";
    if (/总|全书|整体/.test(text)) return "outline_global";
    return "outline_default";
  }
  return null;
}

export default buildWorkbenchSystemPrompt;
