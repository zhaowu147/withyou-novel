/**
 * /api/novels/files — 小说项目文件系统 API
 *
 * GET    ?project=&action=list          — 列出所有文件
 * GET    ?project=&action=read&path=    — 读取文件
 * GET    ?project=&action=chapters      — 列出章节
 * GET    ?project=&action=context&ch=   — 组装写作上下文
 * POST   { project, action, path, content }  — 写入/创建/删除
 */

import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { novelFS } from "@/lib/novel-fs";
import {
  bindWorkspaceNovel,
  verifyWorkspaceLease,
  verifyWorkspaceRequest,
  workspaceCredentials,
  workspaceErrorResponse,
} from "@/lib/workspaces/ownership";

export async function GET(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  const project = req.nextUrl.searchParams.get("project");
  const action = req.nextUrl.searchParams.get("action") || "list";
  const filePath = req.nextUrl.searchParams.get("path") || "";
  const ch = req.nextUrl.searchParams.get("ch");

  if (!project) return apiError("project is required", 400);
  const denied = verifyWorkspaceRequest(req, project);
  if (denied) return denied;

  try {
    switch (action) {
      case "list":
        return apiSuccess({ files: novelFS.listAllFiles(project) });

      case "read":
        if (!filePath) return apiError("path is required", 400);
        return apiSuccess({ content: novelFS.readFile(project, filePath) });

      case "chapters":
        return apiSuccess({ chapters: novelFS.listChapters(project) });

      case "context":
        if (!ch) return apiError("ch (chapter number) is required", 400);
        return apiSuccess(novelFS.assembleWriteContext(project, parseInt(ch, 10)));

      default:
        return apiError(`Unknown action: ${action}`, 400);
    }
  } catch (e: unknown) {
    return apiError((e as Error).message || "操作失败", 500);
  }
}

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  try {
    enforceRateLimit("novel-files:local", 60);
    const body = await readJsonBody<Record<string, unknown>>(req, 2 * 1024 * 1024);
    const {
      project,
      action,
      path: filePath,
      content,
      title,
      chapterNum,
    } = body as {
      project?: string;
      action?: string;
      path?: string;
      content?: string;
      title?: string;
      chapterNum?: number;
    };

    if (!project) return apiError("project is required", 400);
    if (action === "create") {
      const credentials = workspaceCredentials(req);
      const binding = verifyWorkspaceLease(credentials.workspaceId, credentials.lease);
      if (binding.novelId) return apiError("当前会话已经绑定作品", 409, "WORKSPACE_ALREADY_BOUND");
    } else {
      const denied = verifyWorkspaceRequest(req, project);
      if (denied) return denied;
    }

    switch (action) {
      case "create":
        // 创建新项目
        novelFS.createProject(project);
        {
          const credentials = workspaceCredentials(req);
          bindWorkspaceNovel(credentials.workspaceId, credentials.lease, project);
        }
        return apiSuccess({ project, files: novelFS.listAllFiles(project) });

      case "write":
        if (!filePath || content === undefined) return apiError("path and content are required", 400);
        novelFS.writeFile(project, filePath, content);
        return apiSuccess({ path: filePath, written: true });

      case "append":
        if (!filePath || content === undefined) return apiError("path and content are required", 400);
        novelFS.appendFile(project, filePath, content);
        return apiSuccess({ path: filePath, appended: true });

      case "write_chapter": {
        if (!chapterNum || !content) return apiError("chapterNum and content are required", 400);
        const chapterTitle = title || `第${chapterNum}章`;
        const written = novelFS.writeChapter(project, chapterNum, chapterTitle, content);
        return apiSuccess({ path: written, chapterNum });
      }

      case "update_after_write":
        // 写后更新追踪
        if (!chapterNum) return apiError("chapterNum is required", 400);
        novelFS.updateAfterWrite(project, chapterNum, body.updates || {});
        return apiSuccess({ updated: true, chapterNum });

      case "delete":
        if (!filePath) return apiError("path is required", 400);
        novelFS.deleteFile(project, filePath);
        return apiSuccess({ path: filePath, deleted: true });

      case "delete_project":
        novelFS.deleteProject(project);
        return apiSuccess({ project, deleted: true });

      default:
        return apiError(`Unknown action: ${action}`, 400);
    }
  } catch (e: unknown) {
    if (e instanceof RequestGuardError) return apiError(e.message, e.status, e.code);
    const ownershipResponse = workspaceErrorResponse(e);
    if (ownershipResponse) return ownershipResponse;
    return apiError((e as Error).message || "操作失败", 500);
  }
}
