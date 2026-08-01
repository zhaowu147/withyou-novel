import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import {
  confirmSemanticContractForExecution,
  getSemanticContractEnvelope,
  rejectSemanticContract,
  reparseSemanticContract,
  updateSemanticContract,
} from "@/lib/semantic-alignment/service";
import type { SemanticContractEditableFields } from "@/lib/semantic-alignment/types";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

async function verifiedContext(request: NextRequest, novelId: string) {
  const credentials = workspaceCredentials(request);
  verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelId);
  return credentials;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();
    const novelId = request.nextUrl.searchParams.get("novelId") ?? "";
    if (!novelId) return apiError("novelId 必填", 400);
    await verifiedContext(request, novelId);
    const { id } = await context.params;
    return apiSuccess(getSemanticContractEnvelope(novelId, id));
  } catch (error) {
    const ownership = workspaceErrorResponse(error);
    if (ownership) return ownership;
    return apiError(error instanceof Error ? error.message : "读取语义契约失败", 404);
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();
    const body = await readJsonBody<Record<string, unknown>>(request, 1024 * 1024);
    const novelId = typeof body.novelId === "string" ? body.novelId : "";
    if (!novelId) return apiError("novelId 必填", 400);
    const credentials = await verifiedContext(request, novelId);
    enforceRateLimit(`semantic-contract-update:${credentials.workspaceId}`, 40);
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) return apiError("无效的契约版本", 400);
    const { id } = await context.params;
    const action = typeof body.action === "string" ? body.action : "";
    if (action === "update") {
      if (!body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) {
        return apiError("fields 必填", 400);
      }
      return apiSuccess(
        await updateSemanticContract({
          novelId,
          contractId: id,
          expectedVersion: version,
          fields: body.fields as unknown as SemanticContractEditableFields,
        }),
      );
    }
    if (action === "confirm") {
      return apiSuccess(
        await confirmSemanticContractForExecution({
          novelId,
          contractId: id,
          version,
          saveAsLongTerm: body.saveAsLongTerm === true,
        }),
      );
    }
    if (action === "reject") return apiSuccess(await rejectSemanticContract(novelId, id, version));
    if (action === "reparse") return apiSuccess(await reparseSemanticContract(novelId, id, version));
    return apiError("无效的契约操作", 400, "INVALID_SEMANTIC_ACTION");
  } catch (error) {
    if (error instanceof RequestGuardError) return apiError(error.message, error.status, error.code);
    const ownership = workspaceErrorResponse(error);
    if (ownership) return ownership;
    return apiError(error instanceof Error ? error.message : "更新语义契约失败", 409);
  }
}
