import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { assertRequestSize, enforceRateLimit, RequestGuardError } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { saveUploadBuffer } from "@/lib/upload/server";
import { verifyWorkspaceLease, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

/** POST /api/upload  multipart form field: file */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  try {
    const credentials = workspaceCredentials(req);
    verifyWorkspaceLease(credentials.workspaceId, credentials.lease);
    enforceRateLimit(`upload:${credentials.workspaceId}`, 12);
    assertRequestSize(req, 11 * 1024 * 1024);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return apiError("file required", 400);

    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await saveUploadBuffer(bytes, file.name, file.type);
    return apiSuccess(result);
  } catch (e: unknown) {
    const ownershipResponse = workspaceErrorResponse(e);
    if (ownershipResponse) return ownershipResponse;
    if (e instanceof RequestGuardError) return apiError(e.message, e.status, e.code);
    return apiError(e instanceof Error ? e.message : "upload failed", 500);
  }
}
