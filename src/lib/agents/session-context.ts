/**
 * 会话上下文构建器
 *
 * 当工具 Agent 接管中栏会话时，构建其需要的完整上下文：
 *  1. 工具专属 system prompt
 *  2. 共享小说上下文（世界观、角色、大纲等，从文件树读取）
 *  3. 用户的原始需求
 *  4. 工具的输出内容（待修改）
 */
import type { ToolSessionContext } from "@/stores/session-owner";

/** 工具 ID → 中文名称映射 */
const TOOL_NAMES: Record<string, string> = {
  "book-name": "书名生成",
  brainstorm: "脑洞生成",
  outline: "大纲生成",
  "detailed-outline": "细纲生成",
  opening: "黄金开篇",
  character: "人设生成",
  worldview: "世界观生成",
  goldfinger: "金手指生成",
  names: "名字生成",
  synopsis: "简介生成",
};

/**
 * 构建工具 Agent 接管中栏时的首条消息
 *
 * 这条消息注入到工具 Agent 的对话中，让它知道：
 * - 自己在处理什么
 * - 用户原始需求是什么
 * - 自己之前生成了什么
 * - 用户可以要求怎么改
 */
export function buildToolTakeoverMessage(ctx: ToolSessionContext): string {
  const toolName = TOOL_NAMES[ctx.toolId] || ctx.toolId;

  return [
    `${toolName}已进入精修模式。`,
    ``,
    `原始需求`,
    ctx.userInput || "（无特定需求，使用默认生成）",
    ``,
    `待精修内容`,
    ctx.toolOutput,
    ``,
    `直接告诉我需要修改哪里即可。`,
    `例如：“第3章节奏太慢，改成动作开场”；“主角性格太单薄，加入矛盾面”；“整体保留，只改结局方向”。`,
    ``,
    `修改满意后点击「确认写入文件树」保存。`,
  ].join("\n");
}
