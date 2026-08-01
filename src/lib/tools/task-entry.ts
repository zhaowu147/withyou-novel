import type { ToolId } from "@/stores/session-owner";

/**
 * 功能区自然语言任务入口的试点工具。
 * 先覆盖需要用户提供大量背景信息、但又最适合从项目上下文推断的工具。
 */
export const NATURAL_LANGUAGE_TASK_TOOLS: readonly ToolId[] = ["outline", "character"];

export interface TaskEntryCopy {
  eyebrow: string;
  title: string;
  description: string;
  placeholder: string;
  helper: string;
  advancedLabel: string;
}

const TASK_ENTRY_COPY: Partial<Record<ToolId, TaskEntryCopy>> = {
  outline: {
    eyebrow: "先说想法，细节交给我整理",
    title: "你想让这部作品接下来形成什么？",
    description: "可以只说题材、人物关系或一个冲突。系统会结合当前项目资料，整理成可确认的大纲方向。",
    placeholder: "例如：我想写一部都市重生文，女主重生后夺回公司和孩子，前期先压住身份，不要马上复仇成功。",
    helper: "不用填写完整设定；已有大纲、角色和正文会自动作为事实参考。",
    advancedLabel: "更多规划条件",
  },
  character: {
    eyebrow: "先说你需要什么样的人",
    title: "你想补充或设计谁？",
    description: "告诉我角色在故事里要做什么，或者直接说一段关系冲突。我会先读已有设定，避免重复造人。",
    placeholder: "例如：设计一个表面帮主角、其实掌握关键证据的女配，她不能一开始就完全信任主角。",
    helper: "不需要先填姓名、年龄和性格；这些会根据世界观和剧情功能一起整理。",
    advancedLabel: "更多人物条件",
  },
};

export function isNaturalLanguageTaskTool(toolId: ToolId): boolean {
  return NATURAL_LANGUAGE_TASK_TOOLS.includes(toolId);
}

export function getTaskEntryCopy(toolId: ToolId): TaskEntryCopy | null {
  return TASK_ENTRY_COPY[toolId] ?? null;
}
