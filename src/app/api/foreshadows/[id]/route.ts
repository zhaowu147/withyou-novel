import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { deleteForeshadow, listForeshadows, upsertForeshadow } from "@/lib/local/store";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

/** PATCH /api/foreshadows/:id */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const { id } = await params;
  const body = await req.json();
  const novelId = body.novel_id;
  if (!novelId) return apiError("foreshadow not found", 404);
  const denied = verifyWorkspaceRequest(req, novelId);
  if (denied) return denied;

  const existing = listForeshadows(novelId).find((f) => f.id === id);
  if (!existing) return apiError("foreshadow not found", 404);

  const data = await upsertForeshadow({
    ...existing,
    ...body,
    id,
    novel_id: novelId,
    description: body.description ?? existing.description,
  });
  return apiSuccess({ foreshadow: data });
}

/** DELETE /api/foreshadows/:id */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const { id } = await params;
  const novelId = req.nextUrl.searchParams.get("novel_id");
  if (!novelId) return apiError("foreshadow not found", 404);
  const denied = verifyWorkspaceRequest(req, novelId);
  if (denied) return denied;
  await deleteForeshadow(novelId, id);
  return apiSuccess({ deleted: true });
}
