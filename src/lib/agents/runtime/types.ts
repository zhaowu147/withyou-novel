import type { ChannelType } from "@/lib/ai/gateway";
import type { SemanticContract } from "@/lib/semantic-alignment/types";

export type CoreAgentId = "planner" | "writer" | "reviewer" | "memory";
export type ReviewerFocus = "all" | "lore" | "pacing" | "continuity";

export type AgentRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

/** 可跨 UI、SSE 和持久化运行记录复用的任务阶段。 */
export type AgentTaskPhase =
  | "initializing"
  | "planning"
  | "loading"
  | "reading"
  | "generating"
  | "parsing"
  | "reviewing"
  | "saving"
  | "waiting_user"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentContextPlan {
  taskType: string;
  query: string;
  preferredFiles: string[];
  recentChapterCount: number;
  memoryLimits: {
    canonical: number;
    long: number;
    short: number;
  };
  includeEntities: boolean;
  includeForeshadows: boolean;
  includeTimeline: boolean;
  includeGraph: boolean;
}

export interface AgentFileTrace {
  path: string;
  reason: string;
  chars: number;
}

export interface AgentMemoryTrace {
  id: string;
  tier: string;
  kind: string;
  source: string;
}

export interface AgentToolTrace {
  name: string;
  args: Record<string, unknown>;
  summary: string;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export interface AgentContextTrace {
  files: AgentFileTrace[];
  memories: AgentMemoryTrace[];
  tools: AgentToolTrace[];
}

export interface AgentRun {
  id: string;
  workspaceId: string;
  novelId: string;
  agentId: CoreAgentId;
  semanticContract?: {
    id: string;
    version: number;
    contentHash: string;
  };
  reviewerFocus?: ReviewerFocus;
  recoveredFrom?: string;
  recoveryCount: number;
  resumeRequest: {
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
    maxToolCalls?: number;
    maxAttempts?: number;
    maxTokens?: number;
    temperature?: number;
    reviewerFocus?: ReviewerFocus;
    semanticContract?: {
      id: string;
      version: number;
      contentHash: string;
    };
  };
  objective: string;
  status: AgentRunStatus;
  phase: AgentTaskPhase;
  subphase?: string;
  progress: number;
  attempt: number;
  maxAttempts: number;
  ownerId: string;
  lastHeartbeatAt: string;
  checkpoint?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  contextPlan: AgentContextPlan;
  trace: AgentContextTrace;
  output?: string;
  error?: string;
  maxToolCalls: number;
  toolCallCount: number;
}

export interface AgentRuntimeRequest {
  workspaceId: string;
  novelId: string;
  agentId: CoreAgentId;
  objective: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  maxToolCalls?: number;
  maxTokens?: number;
  temperature?: number;
  ownerId?: string;
  maxAttempts?: number;
  reviewerFocus?: ReviewerFocus;
  recoveredFrom?: string;
  semanticContract?: SemanticContract;
  onEvent?: (event: AgentRuntimeEvent) => void;
}

export type AgentRuntimeEvent =
  | { type: "run_started"; runId: string; agentId: CoreAgentId }
  | {
      type: "task_event";
      runId: string;
      phase: AgentTaskPhase;
      subphase?: string;
      progress: number;
      text: string;
      attempt: number;
      heartbeatAt: string;
    }
  | { type: "status"; status: AgentRunStatus; text: string }
  | { type: "tool_completed"; name: string; success: boolean }
  | { type: "protocol_retry"; text: string }
  | { type: "run_completed"; runId: string; status: AgentRunStatus };

export interface AgentRuntimeResult {
  run: AgentRun;
  output: string;
}

export interface AgentPolicy {
  id: CoreAgentId;
  name: string;
  channel: ChannelType;
  taskType: string;
  role: string;
  outputRules: string[];
}

export interface AgentToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
