import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { deleteEntity, getEntity, upsertEntity } from "@/lib/local/store";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

/** PATCH /api/entities/:id */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const { id } = await params;
  const body = await req.json();
  const novelId = body.novel_id;
  if (!novelId) return apiError("entity not found", 404);
  const denied = verifyWorkspaceRequest(req, novelId);
  if (denied) return denied;

  const existing = getEntity(novelId, id);
  if (!existing) return apiError("entity not found", 404);

  const allowed = ["importance", "active_state", "summary", "last_chapter", "metadata", "name", "type"] as const;
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (!Object.keys(patch).length) return apiError("no valid fields", 400);

  const data = await upsertEntity({
    ...existing,
    ...patch,
    novel_id: novelId,
    name: (patch.name as string) || existing.name,
  });
  return apiSuccess({ entity: data });
}

/** DELETE /api/entities/:id */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const { id } = await params;
  const novelId = req.nextUrl.searchParams.get("novel_id");
  if (!novelId) return apiError("entity not found", 404);
  const denied = verifyWorkspaceRequest(req, novelId);
  if (denied) return denied;
  await deleteEntity(novelId, id);
  return apiSuccess({ deleted: true });
}
