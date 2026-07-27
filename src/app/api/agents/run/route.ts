import type { NextRequest } from "next/server";

import { type CoreAgentId, runCoreAgent } from "@/lib/agents/runtime";
import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_AGENT_IDS = new Set<CoreAgentId>(["planner", "reviewer", "memory"]);

function isBackendAgentId(value: unknown): value is CoreAgentId {
  return typeof value === "string" && BACKEND_AGENT_IDS.has(value as CoreAgentId);
}

export async function POST(request: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  try {
    enforceRateLimit("agents:run", 20);
    const body = await readJsonBody<Record<string, unknown>>(request, 512 * 1024);
    const novelId = typeof body.novelId === "string" ? body.novelId.trim() : "";
    const objective = typeof body.objective === "string" ? body.objective.trim() : "";
    if (!novelId) return apiError("novelId required", 400);
    if (!isBackendAgentId(body.agentId)) return apiError("invalid agentId", 400);
    if (!objective) return apiError("objective required", 400);

    const credentials = workspaceCredentials(request);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelId);
    const messages = Array.isArray(body.messages)
      ? body.messages
          .filter((message): message is { role: "user" | "assistant"; content: string } =>
            Boolean(
              message &&
                typeof message === "object" &&
                ((message as { role?: unknown }).role === "user" ||
                  (message as { role?: unknown }).role === "assistant") &&
                typeof (message as { content?: unknown }).content === "string",
            ),
          )
          .slice(-20)
      : undefined;

    const result = await runCoreAgent({
      workspaceId: credentials.workspaceId,
      novelId,
      agentId: body.agentId,
      objective,
      messages,
      maxToolCalls:
        typeof body.maxToolCalls === "number" && Number.isFinite(body.maxToolCalls) ? body.maxToolCalls : undefined,
      maxTokens: typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens) ? body.maxTokens : undefined,
      temperature:
        typeof body.temperature === "number" && Number.isFinite(body.temperature) ? body.temperature : undefined,
      signal: request.signal,
    });

    return apiSuccess({
      runId: result.run.id,
      agentId: result.run.agentId,
      output: result.output,
      trace: result.run.trace,
    });
  } catch (error) {
    if (error instanceof RequestGuardError) return apiError(error.message, error.status, error.code);
    const ownershipResponse = workspaceErrorResponse(error);
    if (ownershipResponse) return ownershipResponse;
    return apiError(error instanceof Error ? error.message : "Agent 运行失败", 500, "AGENT_RUN_FAILED");
  }
}
