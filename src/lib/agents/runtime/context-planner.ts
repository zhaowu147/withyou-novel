import "server-only";

import type { AgentContextPlan, CoreAgentId } from "./types";

const SHARED_SETTINGS = ["设定/核心设定.md", "设定/世界观/世界设定.md", "设定/角色/角色设定.md", "设定/金手指.md"];

const TRACKING_FILES = ["追踪/伏笔.md", "追踪/时间线.md", "追踪/角色状态.md", "追踪/上下文.md"];

const FILES_BY_AGENT: Record<CoreAgentId, string[]> = {
  planner: ["大纲/创意方案.md", "大纲/总纲.md", "大纲/细纲.md", ...SHARED_SETTINGS],
  writer: ["大纲/细纲.md", "大纲/总纲.md", ...SHARED_SETTINGS, ...TRACKING_FILES],
  reviewer: ["大纲/总纲.md", "大纲/细纲.md", ...SHARED_SETTINGS, ...TRACKING_FILES],
  memory: [...SHARED_SETTINGS, "大纲/总纲.md", "大纲/细纲.md", ...TRACKING_FILES],
};

export function buildAgentContextPlan(agentId: CoreAgentId, objective: string): AgentContextPlan {
  const query = objective.trim().slice(0, 4_000);
  switch (agentId) {
    case "planner":
      return {
        taskType: "plan_story",
        query,
        preferredFiles: FILES_BY_AGENT.planner,
        recentChapterCount: 3,
        memoryLimits: { canonical: 8, long: 10, short: 4 },
        includeEntities: true,
        includeForeshadows: true,
        includeTimeline: true,
        includeGraph: true,
      };
    case "reviewer":
      return {
        taskType: "review_story",
        query,
        preferredFiles: FILES_BY_AGENT.reviewer,
        recentChapterCount: 6,
        memoryLimits: { canonical: 8, long: 12, short: 10 },
        includeEntities: true,
        includeForeshadows: true,
        includeTimeline: true,
        includeGraph: true,
      };
    case "memory":
      return {
        taskType: "maintain_memory",
        query,
        preferredFiles: FILES_BY_AGENT.memory,
        recentChapterCount: 8,
        memoryLimits: { canonical: 10, long: 16, short: 16 },
        includeEntities: true,
        includeForeshadows: true,
        includeTimeline: true,
        includeGraph: true,
      };
    default:
      return {
        taskType: "write_chapter",
        query,
        preferredFiles: FILES_BY_AGENT.writer,
        recentChapterCount: 4,
        memoryLimits: { canonical: 8, long: 10, short: 10 },
        includeEntities: true,
        includeForeshadows: true,
        includeTimeline: true,
        includeGraph: true,
      };
  }
}
