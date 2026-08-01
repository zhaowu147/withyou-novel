import "server-only";

import { newId, nowIso, readCollection, updateCollection } from "@/lib/local/json-db";

import type {
  AgentContextPlan,
  AgentFileTrace,
  AgentMemoryTrace,
  AgentRun,
  AgentRunStatus,
  AgentTaskPhase,
  AgentToolTrace,
  CoreAgentId,
  ReviewerFocus,
} from "./types";

const RUN_COLLECTION = "agent-runs";
const DEFAULT_STALE_MS = 10 * 60 * 1000;

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export function listAgentRuns(novelId: string, limit = 50): AgentRun[] {
  return readCollection<AgentRun>(novelId, RUN_COLLECTION)
    .filter((run) => run?.novelId === novelId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

export function getAgentRun(novelId: string, runId: string): AgentRun | null {
  return listAgentRuns(novelId, 200).find((run) => run.id === runId) ?? null;
}

export async function createAgentRun(input: {
  workspaceId: string;
  novelId: string;
  agentId: CoreAgentId;
  objective: string;
  contextPlan: AgentContextPlan;
  maxToolCalls: number;
  ownerId?: string;
  maxAttempts?: number;
  reviewerFocus?: ReviewerFocus;
  recoveredFrom?: string;
  semanticContract?: {
    id: string;
    version: number;
    contentHash: string;
  };
  resumeRequest?: {
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
}): Promise<AgentRun> {
  const now = nowIso();
  const run: AgentRun = {
    id: newId(),
    workspaceId: input.workspaceId,
    novelId: input.novelId,
    agentId: input.agentId,
    semanticContract: input.semanticContract,
    reviewerFocus: input.reviewerFocus,
    recoveredFrom: input.recoveredFrom,
    recoveryCount: input.recoveredFrom ? 1 : 0,
    resumeRequest: {
      messages: input.resumeRequest?.messages?.slice(-20).map((message) => ({
        role: message.role,
        content: message.content.slice(0, 30_000),
      })),
      maxToolCalls: input.resumeRequest?.maxToolCalls,
      maxAttempts: input.resumeRequest?.maxAttempts,
      maxTokens: input.resumeRequest?.maxTokens,
      temperature: input.resumeRequest?.temperature,
      reviewerFocus: input.resumeRequest?.reviewerFocus,
      semanticContract: input.resumeRequest?.semanticContract,
    },
    objective: input.objective.slice(0, 12_000),
    status: "queued",
    phase: "initializing",
    progress: 0,
    attempt: 0,
    maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? (input.agentId === "writer" ? 3 : 2), 5)),
    ownerId: input.ownerId?.trim() || `${input.workspaceId}:${input.agentId}`,
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    contextPlan: input.contextPlan,
    trace: { files: [], memories: [], tools: [] },
    maxToolCalls: input.maxToolCalls,
    toolCallCount: 0,
  };
  await updateCollection<AgentRun>(input.novelId, RUN_COLLECTION, (rows) => [...rows, run]);
  return run;
}

export async function updateAgentRun(
  novelId: string,
  runId: string,
  patch: Partial<
    Pick<
      AgentRun,
      | "status"
      | "phase"
      | "subphase"
      | "progress"
      | "attempt"
      | "startedAt"
      | "finishedAt"
      | "output"
      | "error"
      | "toolCallCount"
      | "contextPlan"
      | "checkpoint"
    >
  >,
): Promise<AgentRun | null> {
  let result: AgentRun | null = null;
  await updateCollection<AgentRun>(novelId, RUN_COLLECTION, (rows) => {
    const index = rows.findIndex((run) => run.id === runId && run.novelId === novelId);
    if (index < 0) return null;
    const next: AgentRun = {
      ...rows[index],
      ...patch,
      updatedAt: nowIso(),
    };
    rows[index] = next;
    result = next;
    return rows;
  });
  return result;
}

/** 持久化统一任务进度，同时刷新心跳，供 UI 和恢复逻辑读取。 */
export async function updateAgentTask(
  novelId: string,
  runId: string,
  input: {
    phase: AgentTaskPhase;
    subphase?: string;
    progress?: number;
    text?: string;
    checkpoint?: string;
    attempt?: number;
  },
): Promise<AgentRun | null> {
  let result: AgentRun | null = null;
  await updateCollection<AgentRun>(novelId, RUN_COLLECTION, (rows) => {
    const index = rows.findIndex((run) => run.id === runId && run.novelId === novelId);
    if (index < 0) return null;
    const current = rows[index];
    const next: AgentRun = {
      ...current,
      phase: input.phase,
      subphase: input.subphase ?? current.subphase,
      progress: Math.max(0, Math.min(100, Math.round(input.progress ?? current.progress))),
      attempt: Math.max(0, Math.round(input.attempt ?? current.attempt)),
      checkpoint: input.checkpoint ?? current.checkpoint,
      updatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
    };
    if (input.phase === "waiting_user") next.status = "waiting_confirmation";
    if (input.phase === "completed") next.status = "completed";
    if (input.phase === "failed") next.status = "failed";
    if (input.phase === "cancelled") next.status = "cancelled";
    rows[index] = next;
    result = next;
    return rows;
  });
  return result;
}

export async function setAgentRunStatus(
  novelId: string,
  runId: string,
  status: AgentRunStatus,
): Promise<AgentRun | null> {
  const now = nowIso();
  return updateAgentRun(novelId, runId, {
    status,
    ...(status === "running" ? { startedAt: now } : {}),
    ...(status === "completed" || status === "failed" || status === "cancelled" ? { finishedAt: now } : {}),
  });
}

function mergeFiles(current: AgentFileTrace[], incoming: AgentFileTrace[]): AgentFileTrace[] {
  const merged = new Map(current.map((item) => [item.path, item]));
  for (const item of incoming) {
    const previous = merged.get(item.path);
    merged.set(item.path, previous ? { ...item, chars: previous.chars + item.chars } : item);
  }
  return Array.from(merged.values()).slice(0, 200);
}

function mergeMemories(current: AgentMemoryTrace[], incoming: AgentMemoryTrace[]): AgentMemoryTrace[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return Array.from(merged.values()).slice(0, 300);
}

export async function appendAgentTrace(
  novelId: string,
  runId: string,
  input: {
    tool: AgentToolTrace;
    files?: AgentFileTrace[];
    memories?: AgentMemoryTrace[];
  },
): Promise<AgentRun | null> {
  let result: AgentRun | null = null;
  await updateCollection<AgentRun>(novelId, RUN_COLLECTION, (rows) => {
    const index = rows.findIndex((run) => run.id === runId && run.novelId === novelId);
    if (index < 0) return null;
    const current = rows[index];
    const next: AgentRun = {
      ...current,
      updatedAt: nowIso(),
      toolCallCount: current.toolCallCount + 1,
      trace: {
        files: mergeFiles(current.trace.files, input.files ?? []),
        memories: mergeMemories(current.trace.memories, input.memories ?? []),
        tools: [...current.trace.tools, input.tool].slice(-300),
      },
    };
    rows[index] = next;
    result = next;
    return rows;
  });
  return result;
}

export async function completeAgentRun(
  novelId: string,
  runId: string,
  output: string,
  status: "completed" | "waiting_confirmation" = "completed",
): Promise<AgentRun | null> {
  return updateAgentRun(novelId, runId, {
    status,
    output: output.slice(0, 120_000),
    finishedAt: nowIso(),
    error: undefined,
  });
}

export async function failAgentRun(novelId: string, runId: string, error: unknown): Promise<AgentRun | null> {
  return updateAgentRun(novelId, runId, {
    status: "failed",
    error: cleanError(error),
    finishedAt: nowIso(),
  });
}

export async function cancelAgentRun(novelId: string, runId: string): Promise<AgentRun | null> {
  return updateAgentRun(novelId, runId, {
    status: "cancelled",
    finishedAt: nowIso(),
    error: undefined,
  });
}

function staleAfterMs(): number {
  const configured = Number(process.env.AGENT_RUN_STALE_MS);
  return Number.isFinite(configured) && configured >= 30_000 ? configured : DEFAULT_STALE_MS;
}

function isInterrupted(run: AgentRun, now = Date.now()): boolean {
  if (run.status !== "planning" && run.status !== "running") return false;
  const heartbeat = Date.parse(run.lastHeartbeatAt || run.updatedAt || run.createdAt);
  return !Number.isFinite(heartbeat) || now - heartbeat >= staleAfterMs();
}

/**
 * 回收进程中断后遗留的运行，并返回可安全重放的任务。
 * 原任务先变为 failed，避免恢复任务重复触发时再次被识别为 stale。
 */
export async function recoverInterruptedAgentRuns(
  workspaceId: string,
  novelId: string,
  limit = 3,
): Promise<AgentRun[]> {
  const stale = listAgentRuns(novelId, 200)
    .filter((run) => run.workspaceId === workspaceId && isInterrupted(run))
    .slice(0, Math.max(1, Math.min(limit, 10)));
  const recovered: AgentRun[] = [];
  for (const run of stale) {
    const failed = await updateAgentRun(novelId, run.id, {
      status: "failed",
      phase: "retrying",
      progress: Math.min(run.progress || 0, 95),
      error: "检测到上次 Agent 进程中断，已进入自动恢复",
      finishedAt: nowIso(),
      checkpoint: "interrupted-recovery-queued",
    });
    if (failed) recovered.push(failed);
  }
  return recovered;
}

export async function resolveAgentRunConfirmation(
  novelId: string,
  runId: string,
  decision: "approve" | "reject",
): Promise<AgentRun | null> {
  const run = getAgentRun(novelId, runId);
  if (run?.agentId !== "memory" || run.status !== "waiting_confirmation") return run;
  return updateAgentRun(novelId, runId, {
    status: decision === "approve" ? "completed" : "cancelled",
    finishedAt: nowIso(),
  });
}
