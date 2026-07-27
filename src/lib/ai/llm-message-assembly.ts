/**
 * LLM 分层 messages 组装
 *
 * 标准五段（空段省略）:
 *   system_long  → exec_guide / 长流程说明
 *   user context → 只读上下文（大纲/实体/前文/伏笔）
 *   system_book  → hard_rules + writer preset（本书规则）
 *   system_round → 禁区 + 必须修正（本轮约束）
 *   user task    → 章节卡 + 用户剧情参考 + 任务收口
 *
 * gateway 仍接受 systemPrompt + messages；本模块把五段压成:
 *   systemPrompt = system_long + system_book + system_round
 *   messages     = [user:context, ...history, user:task]
 */

export type ChatRole = "user" | "assistant" | "system";

export interface LayeredParts {
  /** L0.5 exec_guide */
  systemLong?: string;
  /** 只读上下文 markdown */
  contextUser?: string;
  /** L0 hard_rules + preset */
  systemBook?: string;
  /** 本轮禁区 / 审稿意见 */
  systemRound?: string;
  /** 当前任务（章节卡 / 用户意图） */
  taskUser?: string;
}

export interface AssembledMessages {
  systemPrompt: string;
  messages: Array<{ role: ChatRole; content: string }>;
  /** 调试用：各层是否非空 */
  usedLayers: string[];
}

function nonEmpty(s?: string): s is string {
  return Boolean(s?.trim());
}

/**
 * 从 injection parts 组装 gateway 入参。
 * history 为既有对话轮次（user/assistant），插在 context 与 task 之间。
 */
export function assembleFromInjectionParts(
  parts: LayeredParts,
  history: Array<{ role: ChatRole; content: string }> = [],
): AssembledMessages {
  const systemChunks: string[] = [];
  const used: string[] = [];

  if (nonEmpty(parts.systemLong)) {
    systemChunks.push(parts.systemLong.trim());
    used.push("system_long");
  }
  if (nonEmpty(parts.systemBook)) {
    systemChunks.push(parts.systemBook.trim());
    used.push("system_book");
  }
  if (nonEmpty(parts.systemRound)) {
    systemChunks.push(parts.systemRound.trim());
    used.push("system_round");
  }

  const messages: Array<{ role: ChatRole; content: string }> = [];
  if (nonEmpty(parts.contextUser)) {
    messages.push({ role: "user", content: parts.contextUser.trim() });
    used.push("context_user");
  }
  for (const m of history) {
    if (m.role === "system") continue; // system 只走 systemPrompt
    if (!m.content.trim()) continue;
    messages.push({ role: m.role, content: m.content });
  }
  if (nonEmpty(parts.taskUser)) {
    messages.push({ role: "user", content: parts.taskUser.trim() });
    used.push("task_user");
  }

  return {
    systemPrompt: systemChunks.join("\n\n---\n\n"),
    messages,
    usedLayers: used,
  };
}

/**
 * 把扁平 vault/context 文本拆进 context_user，
 * hard/exec/preset 进 system 层 — Writer 默认路径。
 */
export function buildWriterLayeredParts(input: {
  execGuide?: string;
  hardRules?: string;
  presets?: string[];
  contextMarkdown?: string;
  forbiddenZone?: string;
  mustFix?: string;
  chapterCard?: string;
  userHint?: string;
  targetChapter?: number;
}): LayeredParts {
  const bookParts = [input.hardRules, ...(input.presets ?? [])].filter(nonEmpty);
  const systemBook = bookParts.map((s) => s.trim()).join("\n\n---\n\n");

  const roundParts: string[] = [];
  if (nonEmpty(input.forbiddenZone)) {
    roundParts.push(`## 【禁区】\n${input.forbiddenZone.trim()}`);
  }
  if (nonEmpty(input.mustFix)) {
    roundParts.push(`## 【必须修正】\n${input.mustFix.trim()}`);
  }

  const taskParts: string[] = [];
  if (input.targetChapter != null) {
    taskParts.push(`## 目标章节\n第 ${input.targetChapter} 章`);
  }
  if (nonEmpty(input.chapterCard)) {
    taskParts.push(`## 本章章节卡\n${input.chapterCard.trim()}`);
  }
  if (nonEmpty(input.userHint)) {
    taskParts.push(`## 作者指定剧情参考（优先级高于章节卡）\n${input.userHint.trim()}`);
  }
  if (taskParts.length) {
    taskParts.push("## 任务收口\n按章节卡与作者参考写正文；不得复述上下文条目；输出约定格式。");
  }

  return {
    systemLong: input.execGuide,
    contextUser: input.contextMarkdown,
    systemBook: systemBook || undefined,
    systemRound: roundParts.length ? roundParts.join("\n\n") : undefined,
    taskUser: taskParts.length ? taskParts.join("\n\n") : undefined,
  };
}

export default {
  assembleFromInjectionParts,
  buildWriterLayeredParts,
};
