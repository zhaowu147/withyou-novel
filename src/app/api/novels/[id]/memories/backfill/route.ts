import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { sanitizeNovelId } from "@/lib/local/paths";
import {
  listMemoryBackfillJobs,
  pauseMemoryBackfill,
  queueMemoryBackfill,
  resumeMemoryBackfill,
  retryMemoryBackfillFailures,
  runMemoryBackfill,
} from "@/lib/memory/backfill";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  try {
    const { id } = await params;
    const denied = verifyWorkspaceRequest(req, id);
    if (denied) return denied;
    return apiSuccess(await listMemoryBackfillJobs(sanitizeNovelId(id)));
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
    enforceRateLimit(`memory-backfill:${novelId}`, 20);
    const body = await readJsonBody<Record<string, unknown>>(req, 32 * 1024);
    const action = typeof body.action === "string" ? body.action : "run";
    const jobId = typeof body.jobId === "string" ? body.jobId : undefined;

    if (action === "start") {
      return apiSuccess({
        job: await queueMemoryBackfill(novelId),
        jobs: await listMemoryBackfillJobs(novelId),
      });
    }
    if (action === "pause") {
      const job = await pauseMemoryBackfill(novelId, jobId);
      if (!job) return apiError("可暂停的建库任务不存在", 404);
      return apiSuccess({ job, jobs: await listMemoryBackfillJobs(novelId) });
    }
    if (action === "resume") {
      const job = await resumeMemoryBackfill(novelId, jobId);
      if (!job) return apiError("可继续的建库任务不存在", 404);
      return apiSuccess({ job, jobs: await listMemoryBackfillJobs(novelId) });
    }
    if (action === "retry") {
      const job = await retryMemoryBackfillFailures(novelId, jobId);
      if (!job) return apiError("可重试的建库任务不存在", 404);
      return apiSuccess({ job, jobs: await listMemoryBackfillJobs(novelId) });
    }
    if (action !== "run") return apiError("不支持的建库操作", 400);

    if ((await listMemoryBackfillJobs(novelId)).length === 0) {
      await queueMemoryBackfill(novelId);
    }
    const maxChapters =
      typeof body.maxChapters === "number" ? Math.max(1, Math.min(5, Math.floor(body.maxChapters))) : 2;
    const result = await runMemoryBackfill(novelId, maxChapters);
    return apiSuccess({ ...result, jobs: await listMemoryBackfillJobs(novelId) });
  } catch (error) {
    if (error instanceof RequestGuardError) {
      return apiError(error.message, error.status, error.code);
    }
    return apiError(error instanceof Error ? error.message : "Unknown", 500);
  }
}
