import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { listNovels, saveNovelMeta } from "@/lib/local/store";
import { initializeNovelMemory } from "@/lib/memory/novel-memory";
import { novelFS } from "@/lib/novel-fs";
import {
  bindWorkspaceNovel,
  verifyWorkspaceLease,
  workspaceCredentials,
  workspaceErrorResponse,
} from "@/lib/workspaces/ownership";

/** GET /api/novels — 列出本地全部小说 */
export async function GET() {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();
    const data = listNovels().map((n) => ({
      id: n.id,
      title: n.title,
      genre: n.genre,
      total_chapters: n.total_chapters,
      metadata: n.metadata,
      created_at: n.created_at,
      updated_at: n.updated_at,
    }));
    return apiSuccess(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown";
    return apiError(msg, 500, "FETCH_NOVELS_FAILED");
  }
}

/** POST /api/novels — 创建本地小说项目 */
export async function POST(req: NextRequest) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();

    const body = await req.json();
    const credentials = workspaceCredentials(req);
    const currentBinding = verifyWorkspaceLease(credentials.workspaceId, credentials.lease);
    if (currentBinding.novelId) {
      return apiError("当前会话已经绑定作品，拒绝创建第二个项目", 409, "WORKSPACE_ALREADY_BOUND");
    }
    const title = (body.title || "未命名作品") as string;
    let id = title.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名作品";
    // 同名不覆盖：第二本起加短后缀，保证「新对话 = 新书」
    if (novelFS.projectExists(id)) {
      id = `${id}-${Date.now().toString(36).slice(-4)}`;
    }
    novelFS.createProject(id);
    const novel = saveNovelMeta(id, {
      title,
      genre: body.genre || null,
      total_chapters: body.total_chapters || 300,
      metadata: body.metadata || {},
    });
    // 必须 await：不然响应先返回，记忆初始化与客户端随后的请求抢同一批文件，
    // 且一旦失败就是进程级 unhandled rejection（打包成 exe 后会直接崩）。
    // 初始化失败不该挡住建项目 —— 后续 syncCanonicalMemories 会自动补上。
    try {
      await initializeNovelMemory(novel.id);
    } catch (error) {
      console.warn(`[novels] 记忆库初始化失败，稍后会自动重试: ${novel.id}`, error);
    }
    bindWorkspaceNovel(credentials.workspaceId, credentials.lease, novel.id);
    return apiSuccess(novel);
  } catch (e: unknown) {
    const ownershipResponse = workspaceErrorResponse(e);
    if (ownershipResponse) return ownershipResponse;
    const msg = e instanceof Error ? e.message : "Unknown";
    return apiError(msg, 500, "CREATE_NOVEL_FAILED");
  }
}
