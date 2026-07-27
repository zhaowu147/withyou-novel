import "server-only";

import { newId, nowIso, readCollection, updateCollection } from "@/lib/local/json-db";

import type {
  AgentContextPlan,
  AgentFileTrace,
  AgentMemoryTrace,
  AgentRun,
  AgentRunStatus,
  AgentToolTrace,
  CoreAgentId,
} from "./types";

const RUN_COLLECTION = "agent-runs";

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
}): Promise<AgentRun> {
  const now = nowIso();
  const run: AgentRun = {
    id: newId(),
    workspaceId: input.workspaceId,
    novelId: input.novelId,
    agentId: input.agentId,
    objective: input.objective.slice(0, 12_000),
    status: "queued",
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
    Pick<AgentRun, "status" | "startedAt" | "finishedAt" | "output" | "error" | "toolCallCount" | "contextPlan">
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
