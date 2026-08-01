import type { NextRequest } from "next/server";

import { type CoreAgentId, type ReviewerFocus, runCoreAgent } from "@/lib/agents/runtime";
import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import {
  recordSemanticExecutionFailure,
  requireExecutableSemanticContract,
  SemanticAlignmentError,
  validateSemanticExecution,
} from "@/lib/semantic-alignment/service";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_AGENT_IDS = new Set<CoreAgentId>(["planner", "reviewer", "memory"]);

function isBackendAgentId(value: unknown): value is CoreAgentId {
  return typeof value === "string" && BACKEND_AGENT_IDS.has(value as CoreAgentId);
}

function isReviewerFocus(value: unknown): value is ReviewerFocus {
  return value === "all" || value === "lore" || value === "pacing" || value === "continuity";
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
    const semanticContractId = typeof body.semanticContractId === "string" ? body.semanticContractId : "";
    const semanticContractVersion = Number(body.semanticContractVersion);
    if (!semanticContractId || !Number.isInteger(semanticContractVersion)) {
      return apiError("Agent 执行前必须提供已确认的语义契约", 409, "SEMANTIC_CONTRACT_REQUIRED");
    }
    const semanticContract = await requireExecutableSemanticContract(
      novelId,
      semanticContractId,
      semanticContractVersion,
    );
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

    const runtimeInput = {
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
      ownerId: typeof body.ownerId === "string" ? body.ownerId.trim().slice(0, 160) : undefined,
      maxAttempts:
        typeof body.maxAttempts === "number" && Number.isFinite(body.maxAttempts)
          ? Math.trunc(body.maxAttempts)
          : undefined,
      reviewerFocus: isReviewerFocus(body.reviewerFocus) ? body.reviewerFocus : undefined,
      signal: request.signal,
      semanticContract,
    } as const;

    if (body.stream === true) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const emit = (event: Record<string, unknown>) => {
            if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          };
          void runCoreAgent({
            ...runtimeInput,
            onEvent: (event) => emit({ ...event, type: "agent_progress", phase: event.type }),
          })
            .then((result) => {
              return validateSemanticExecution(semanticContract, result.output).then((validation) => {
                emit({
                  type: "semantic_validation",
                  contractId: semanticContract.id,
                  contractVersion: semanticContract.version,
                  validation,
                });
                emit({
                  type: "result",
                  runId: result.run.id,
                  agentId: result.run.agentId,
                  output: result.output,
                  trace: result.run.trace,
                });
                emit({ type: "done", runId: result.run.id });
              });
            })
            .catch((error: unknown) => {
              void recordSemanticExecutionFailure(semanticContract, error).catch((recordError) =>
                console.error("[agents/run] 记录语义执行失败状态时出错", recordError),
              );
              emit({ type: "error", message: error instanceof Error ? error.message : "Agent 运行失败" });
            })
            .finally(() => {
              closed = true;
              controller.close();
            });
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    let result: Awaited<ReturnType<typeof runCoreAgent>>;
    try {
      result = await runCoreAgent(runtimeInput);
    } catch (error) {
      await recordSemanticExecutionFailure(semanticContract, error);
      throw error;
    }
    const validation = await validateSemanticExecution(semanticContract, result.output);

    return apiSuccess({
      runId: result.run.id,
      agentId: result.run.agentId,
      output: result.output,
      trace: result.run.trace,
      semanticContract: {
        id: semanticContract.id,
        version: semanticContract.version,
        validation,
      },
    });
  } catch (error) {
    if (error instanceof RequestGuardError) return apiError(error.message, error.status, error.code);
    if (error instanceof SemanticAlignmentError) return apiError(error.message, error.status, error.code);
    const ownershipResponse = workspaceErrorResponse(error);
    if (ownershipResponse) return ownershipResponse;
    return apiError(error instanceof Error ? error.message : "Agent 运行失败", 500, "AGENT_RUN_FAILED");
  }
}
