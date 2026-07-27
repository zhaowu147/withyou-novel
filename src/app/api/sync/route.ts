/**
 * 同步 API — 从文件系统读取最新状态
 *
 * 前端在以下时机调用:
 * 1. 工具写入后
 * 2. 切换面板时
 * 3. 定期轮询（可选）
 */

import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiUnauthorized } from "@/lib/api/response";
import {
  syncChaptersFromFileSystem,
  syncEntitiesFromFileSystem,
  syncSettingsFromFileSystem,
} from "@/lib/collaboration";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

export async function GET(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  try {
    const { searchParams } = new URL(req.url);
    const novelId = searchParams.get("novelId");

    if (!novelId) {
      return apiError("novelId required", 400);
    }
    const denied = verifyWorkspaceRequest(req, novelId);
    if (denied) return denied;

    const settings = syncSettingsFromFileSystem(novelId);
    const chapters = syncChaptersFromFileSystem(novelId);
    const entities = syncEntitiesFromFileSystem(novelId);

    return Response.json({
      success: true,
      data: {
        settings,
        chapters,
        entities,
        syncedAt: Date.now(),
      },
    });
  } catch {
    return apiError("Sync failed", 500);
  }
}
