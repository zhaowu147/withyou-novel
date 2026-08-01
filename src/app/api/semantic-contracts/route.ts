import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { parseSemanticContract } from "@/lib/semantic-alignment/service";
import type { SemanticTaskKind } from "@/lib/semantic-alignment/types";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

const TASK_KINDS = new Set<SemanticTaskKind>(["creation_tool", "writer", "tool_refinement", "local_edit"]);

export async function POST(request: NextRequest) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();
    const credentials = workspaceCredentials(request);
    enforceRateLimit(`semantic-contract:${credentials.workspaceId}`, 30);
    const body = await readJsonBody<Record<string, unknown>>(request, 512 * 1024);
    const novelId = typeof body.novelId === "string" ? body.novelId : "";
    const userInput = typeof body.userInput === "string" ? body.userInput : "";
    const taskKind = body.taskKind as SemanticTaskKind;
    if (!novelId || !userInput.trim() || !TASK_KINDS.has(taskKind)) {
      return apiError("novelId、taskKind 和 userInput 必填", 400, "INVALID_SEMANTIC_REQUEST");
    }
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelId);
    const formData =
      body.formData && typeof body.formData === "object" && !Array.isArray(body.formData)
        ? Object.fromEntries(
            Object.entries(body.formData as Record<string, unknown>)
              .filter(([, value]) => typeof value === "string")
              .map(([key, value]) => [key, String(value).slice(0, 20_000)]),
          )
        : undefined;
    return apiSuccess(
      await parseSemanticContract({
        novelId,
        workspaceId: credentials.workspaceId,
        taskKind,
        toolId: typeof body.toolId === "string" ? body.toolId : undefined,
        userInput,
        formData,
      }),
    );
  } catch (error) {
    if (error instanceof RequestGuardError) return apiError(error.message, error.status, error.code);
    const ownership = workspaceErrorResponse(error);
    if (ownership) return ownership;
    return apiError(error instanceof Error ? error.message : "语义契约解析失败", 500, "SEMANTIC_PARSE_FAILED");
  }
}
