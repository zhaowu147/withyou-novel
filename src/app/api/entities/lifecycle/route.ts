import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { listEntities, upsertEntity } from "@/lib/local/store";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

/**
 * POST /api/entities/lifecycle
 * 按当前章节批量更新生命周期
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const body = await req.json();
  const { novel_id, current_chapter } = body;
  if (!novel_id || !current_chapter) return apiError("novel_id + current_chapter required", 400);
  const denied = verifyWorkspaceRequest(req, novel_id);
  if (denied) return denied;

  const cooling_window = body.cooling_window ?? 6;
  const multipliers = {
    high: body.major_multiplier ?? 2.0,
    mid: body.mid_multiplier ?? 1.0,
    low: body.minor_multiplier ?? 0.5,
    core: 0,
    major: body.major_multiplier ?? 2.0,
    minor: body.minor_multiplier ?? 0.5,
  };

  const entities = listEntities(novel_id).filter((e) => e.active_state === "active");
  let updated = 0;
  const changes: string[] = [];

  for (const entity of entities) {
    if (entity.importance === "core" || entity.importance === "high") continue;
    if (!entity.last_chapter) continue;

    const gap = current_chapter - entity.last_chapter;
    const multiplier = multipliers[entity.importance as keyof typeof multipliers] ?? 1;
    if (multiplier === 0) continue;
    const threshold = Math.max(1, Math.floor(cooling_window * multiplier));

    let newStatus: string | null = null;
    if (gap >= threshold * 2) newStatus = "cooling";
    else if (gap >= threshold) newStatus = "cooling";

    if (newStatus && newStatus !== entity.active_state) {
      await upsertEntity({
        ...entity,
        novel_id,
        name: entity.name,
        active_state: newStatus,
      });
      updated++;
      changes.push(`${entity.name}: ${entity.active_state} → ${newStatus} (gap=${gap}, threshold=${threshold})`);
    }
  }

  return apiSuccess({ updated, changes });
}
