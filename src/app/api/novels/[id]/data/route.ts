/**
 * 小说创作数据持久化 API
 *
 * GET  /api/novels/[id]/data — 读取创作数据（大纲/人设/世界观/伏笔）
 * PUT  /api/novels/[id]/data — 保存创作数据
 *
 * 存储在 meta.json 的 metadata 字段中
 */
import "server-only";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess } from "@/lib/api/response";
import { getNovel, saveNovelMeta } from "@/lib/local/store";
import { fieldFilePaths } from "@/lib/novel/field-map";
import { novelFS } from "@/lib/novel-fs";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

/** 可持久化的创作数据字段 */
const PERSIST_FIELDS = [
  "brainstorm",
  "outline",
  "detailedOutline",
  "characters",
  "worldview",
  "goldfinger",
  "synopsis",
  "opening",
  "foreshadowing",
  "novelName",
  "totalChapters",
] as const;

// 字段→文件路径从 field-map 单一真相源派生，不再在此手写。
const FIELD_FILES: Partial<Record<(typeof PERSIST_FIELDS)[number], string>> = fieldFilePaths();

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();

    const { id } = await params;
    const credentials = workspaceCredentials(request);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, id);
    const novel = getNovel(id);
    if (!novel) return apiError("小说不存在", 404, "NOT_FOUND");

    const meta = novel.metadata;
    const data: Record<string, unknown> = {};
    for (const field of PERSIST_FIELDS) {
      if (meta[field] !== undefined) {
        data[field] = meta[field];
        continue;
      }
      const filePath = FIELD_FILES[field];
      if (filePath) {
        try {
          data[field] = novelFS.readFile(id, filePath);
        } catch {
          // 旧项目可能尚未生成对应文件。
        }
      }
    }
    return apiSuccess(data);
  } catch (error) {
    return workspaceErrorResponse(error) ?? apiError(error instanceof Error ? error.message : "读取失败", 500);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const { id } = await params;
  try {
    const credentials = workspaceCredentials(request);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, id);
  } catch (error) {
    return workspaceErrorResponse(error) ?? apiError("工作区校验失败", 500);
  }
  const body = (await request.json()) as Record<string, unknown>;

  // 只允许写入白名单字段
  const metadata: Record<string, unknown> = {};
  for (const field of PERSIST_FIELDS) {
    if (body[field] !== undefined) {
      metadata[field] = body[field];
    }
  }

  if (Object.keys(metadata).length === 0) {
    return apiError("没有有效的字段", 400, "NO_FIELDS");
  }

  try {
    saveNovelMeta(id, { metadata });
    for (const [field, filePath] of Object.entries(FIELD_FILES)) {
      const value = metadata[field];
      if (typeof value === "string") {
        novelFS.writeFile(id, filePath, value);
      }
    }
    return apiSuccess({ saved: true });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : "保存失败", 500, "SAVE_FAILED");
  }
}

function apiUnauthorized() {
  return apiError("未登录", 401, "UNAUTHORIZED");
}
