import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { sanitizeNovelId } from "@/lib/local/paths";
import { listConsolidationJobs, retryConsolidationJob, runPendingConsolidations } from "@/lib/memory/consolidation";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  try {
    const { id } = await params;
    const denied = verifyWorkspaceRequest(req, id);
    if (denied) return denied;
    return apiSuccess(listConsolidationJobs(sanitizeNovelId(id)));
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unknown", 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  try {
    const { id } = await params;
    const denied = verifyWorkspaceRequest(req, id);
    if (denied) return denied;
    const novelId = sanitizeNovelId(id);
    enforceRateLimit(`memory-consolidation:${novelId}`, 10);
    const body = await readJsonBody<Record<string, unknown>>(req, 32 * 1024);
    if (typeof body.jobId === "string" && !retryConsolidationJob(novelId, body.jobId)) {
      return apiError("Consolidation job not found", 404);
    }
    const maxJobs = typeof body.maxJobs === "number" ? Math.max(1, Math.min(5, Math.floor(body.maxJobs))) : 1;
    const results = await runPendingConsolidations(novelId, maxJobs);
    return apiSuccess({ results, jobs: listConsolidationJobs(novelId) });
  } catch (error) {
    if (error instanceof RequestGuardError) {
      return apiError(error.message, error.status, error.code);
    }
    return apiError(error instanceof Error ? error.message : "Unknown", 500);
  }
}
