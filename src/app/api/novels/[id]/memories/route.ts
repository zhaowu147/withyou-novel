import type { NextRequest } from "next/server";

import { resolveAgentRunConfirmation } from "@/lib/agents/runtime";
import { getApiUser } from "@/lib/api/auth";
import { RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { sanitizeNovelId } from "@/lib/local/paths";
import {
  decideMemoryCandidates,
  listNovelMemories,
  type NovelMemoryKind,
  type NovelMemoryStatus,
  type NovelMemoryTier,
  syncCanonicalMemories,
  updateNovelMemory,
} from "@/lib/memory/novel-memory";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  try {
    const { id } = await params;
    const denied = verifyWorkspaceRequest(req, id);
    if (denied) return denied;
    const novelId = sanitizeNovelId(id);
    await syncCanonicalMemories(novelId);
    const tier = req.nextUrl.searchParams.get("tier") as NovelMemoryTier | null;
    const status = req.nextUrl.searchParams.get("status") as NovelMemoryStatus | null;
    const memories = listNovelMemories(novelId)
      .filter((memory) => !tier || memory.tier === tier)
      .filter((memory) => !status || memory.status === status)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return apiSuccess(memories);
  } catch (error) {
    if (error instanceof RequestGuardError) {
      return apiError(error.message, error.status, error.code);
    }
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
    const body = await readJsonBody<Record<string, unknown>>(req, 64 * 1024);
    const memoryIds = Array.isArray(body.memoryIds)
      ? body.memoryIds.filter((value): value is string => typeof value === "string" && Boolean(value))
      : [];
    const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
    const runId = typeof body.runId === "string" ? body.runId.trim() : undefined;
    if (!memoryIds.length) return apiError("memoryIds required", 400);
    if (!decision) return apiError("decision must be approve or reject", 400);

    const result = await decideMemoryCandidates({ novelId, memoryIds, decision, runId });
    if (runId && result.updated.length > 0) {
      const remaining = listNovelMemories(novelId).some(
        (memory) => memory.status === "candidate" && memory.source.path?.startsWith(`agent-run/${runId}`),
      );
      if (!remaining) await resolveAgentRunConfirmation(novelId, runId, decision);
    }
    return apiSuccess(result);
  } catch (error) {
    if (error instanceof RequestGuardError) {
      return apiError(error.message, error.status, error.code);
    }
    return apiError(error instanceof Error ? error.message : "Unknown", 500);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  try {
    const { id } = await params;
    const denied = verifyWorkspaceRequest(req, id);
    if (denied) return denied;
    const novelId = sanitizeNovelId(id);
    const body = await readJsonBody<Record<string, unknown>>(req, 64 * 1024);
    if (typeof body.memoryId !== "string" || !body.memoryId) {
      return apiError("memoryId required", 400);
    }
    const updated = await updateNovelMemory(novelId, body.memoryId, {
      tier: body.tier as NovelMemoryTier | undefined,
      kind: body.kind as NovelMemoryKind | undefined,
      content: typeof body.content === "string" ? body.content : undefined,
      entities: Array.isArray(body.entities) ? (body.entities as string[]) : undefined,
      keywords: Array.isArray(body.keywords) ? (body.keywords as string[]) : undefined,
      importance: body.importance as "high" | "mid" | "low" | undefined,
      status: body.status as NovelMemoryStatus | undefined,
    });
    if (!updated) return apiError("Memory not found or invalid", 404);
    return apiSuccess(updated);
  } catch (error) {
    if (error instanceof RequestGuardError) {
      return apiError(error.message, error.status, error.code);
    }
    return apiError(error instanceof Error ? error.message : "Unknown", 500);
  }
}
