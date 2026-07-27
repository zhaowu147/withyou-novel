import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { listEntities, upsertEntity } from "@/lib/local/store";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

/** GET /api/entities?novel_id=xxx */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const novelId = req.nextUrl.searchParams.get("novel_id");
  if (!novelId) return apiError("novel_id required", 400);
  const denied = verifyWorkspaceRequest(req, novelId);
  if (denied) return denied;

  const data = listEntities(novelId).sort((a, b) => (b.last_chapter ?? 0) - (a.last_chapter ?? 0));
  return apiSuccess({ entities: data, count: data.length });
}

/** POST /api/entities */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const body = await req.json();
  if (!body.novel_id || !body.name) return apiError("novel_id and name required", 400);
  const denied = verifyWorkspaceRequest(req, body.novel_id);
  if (denied) return denied;

  const data = await upsertEntity({
    novel_id: body.novel_id,
    name: body.name,
    type: body.type || "character",
    importance: body.importance || "mid",
    active_state: "active",
    summary: body.summary || "",
    last_chapter: body.last_chapter,
    metadata: body.metadata || {},
  });
  return apiSuccess({ entity: data });
}
