import type { NextRequest } from "next/server";

import { listAgentRuns } from "@/lib/agents/runtime";
import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const novelId = request.nextUrl.searchParams.get("novelId")?.trim();
  if (!novelId) return apiError("novelId required", 400);

  try {
    const credentials = workspaceCredentials(request);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelId);
  } catch (error) {
    return workspaceErrorResponse(error) ?? apiError("工作区校验失败", 500);
  }

  const rawLimit = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), 100)) : 30;
  const includeOutput = request.nextUrl.searchParams.get("includeOutput") === "1";
  const runs = listAgentRuns(novelId, limit).map((run) =>
    includeOutput
      ? run
      : {
          ...run,
          output: run.output ? `${run.output.slice(0, 500)}${run.output.length > 500 ? "…" : ""}` : undefined,
        },
  );
  return apiSuccess({ runs });
}
