import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { getNovel } from "@/lib/local/store";
import { createProjectBackup, restoreProjectBackup } from "@/lib/novel/project-backup";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();
    const { id } = await params;
    const credentials = workspaceCredentials(req);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, id);
    if (!getNovel(id)) return apiError("Not found", 404);
    enforceRateLimit(`backup-export:${credentials.workspaceId}`, 10);
    return apiSuccess(createProjectBackup(id));
  } catch (error) {
    const ownershipResponse = workspaceErrorResponse(error);
    if (ownershipResponse) return ownershipResponse;
    return apiError(error instanceof Error ? error.message : "备份导出失败", 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();
    const { id } = await params;
    const credentials = workspaceCredentials(req);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, id);
    if (!getNovel(id)) return apiError("Not found", 404);
    enforceRateLimit(`backup-restore:${credentials.workspaceId}`, 4);
    const body = await readJsonBody<unknown>(req, 30 * 1024 * 1024);
    return apiSuccess(await restoreProjectBackup(id, body));
  } catch (error) {
    const ownershipResponse = workspaceErrorResponse(error);
    if (ownershipResponse) return ownershipResponse;
    if (error instanceof RequestGuardError) return apiError(error.message, error.status, error.code);
    const message = error instanceof Error ? error.message : "备份恢复失败";
    const status = message.includes("备份") || message.includes("安全") ? 400 : 500;
    return apiError(message, status);
  }
}
