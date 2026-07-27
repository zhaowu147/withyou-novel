import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { listForeshadows, upsertForeshadow } from "@/lib/local/store";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

/** GET /api/foreshadows?novel_id=xxx */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const novelId = req.nextUrl.searchParams.get("novel_id");
  if (!novelId) return apiError("novel_id required", 400);
  const denied = verifyWorkspaceRequest(req, novelId);
  if (denied) return denied;

  const data = listForeshadows(novelId);
  return apiSuccess({ foreshadows: data, count: data.length });
}

/** POST /api/foreshadows */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const body = await req.json();
  if (!body.novel_id || !body.description) {
    return apiError("novel_id and description required", 400);
  }
  const denied = verifyWorkspaceRequest(req, body.novel_id);
  if (denied) return denied;

  const data = await upsertForeshadow({
    novel_id: body.novel_id,
    description: body.description,
    plant_chapter: body.plant_chapter,
    target_resolve_chapter: body.target_resolve_chapter,
    actual_resolve_chapter: body.actual_resolve_chapter,
    state: body.state || "planted",
    related_entity_ids: body.related_entity_ids || [],
    id: body.id,
  });
  return apiSuccess({ foreshadow: data });
}
