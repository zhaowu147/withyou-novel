import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { getNovel, listChapterFiles, saveChapterFile, saveNovelMeta } from "@/lib/local/store";
import { queueMemoryBackfill } from "@/lib/memory/backfill";
import { fieldFilePaths } from "@/lib/novel/field-map";
import { novelFS } from "@/lib/novel-fs";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

/** GET /api/novels/:id */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();

    const { id } = await params;
    const credentials = workspaceCredentials(req);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, id);
    const novel = getNovel(id);
    if (!novel) return apiError("Not found", 404);

    const chapters = listChapterFiles(id).map((c) => ({
      number: c.number,
      title: c.title,
      content: c.content,
    }));
    return apiSuccess({ ...novel, chapters });
  } catch (e: unknown) {
    const ownershipResponse = workspaceErrorResponse(e);
    if (ownershipResponse) return ownershipResponse;
    return apiError(e instanceof Error ? e.message : "Unknown", 500);
  }
}

/** PUT /api/novels/:id */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();

    const { id } = await params;
    const credentials = workspaceCredentials(req);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, id);
    if (!getNovel(id)) return apiError("Not found", 404);

    const body = await req.json();
    const { title, genre, total_chapters, metadata, content_json } = body;

    saveNovelMeta(id, {
      title,
      genre,
      total_chapters,
      metadata,
    });

    // 浏览器草稿、vault 元数据与用户可见 Markdown 文件必须保持同一份事实。
    // Pi 和服务端工具按文件树读取；只写 metadata 会让它们看到空模板。
    if (metadata && typeof metadata === "object") {
      const paths = fieldFilePaths();
      for (const [field, filePath] of Object.entries(paths)) {
        const value = metadata[field];
        if (!filePath || typeof value !== "string") continue;
        novelFS.writeFileAtomic(id, filePath, value);
      }
    }

    if (typeof title === "string" && title.trim()) {
      const corePath = "设定/核心设定.md";
      const currentCore = novelFS.readFileSafe(id, corePath);
      if (currentCore) {
        const nextCore = currentCore
          .replace(/^# .* — 核心设定$/m, `# ${title.trim()} — 核心设定`)
          .replace(/^- 书名:.*$/m, `- 书名: ${title.trim()}`);
        if (nextCore !== currentCore) novelFS.writeFileAtomic(id, corePath, nextCore);
      }
    }

    let backfillJobId: string | undefined;
    if (Array.isArray(content_json)) {
      for (const ch of content_json as Array<{
        number: number;
        title: string;
        content: string;
      }>) {
        if (!Number.isInteger(ch.number) || ch.number < 1) continue;
        await saveChapterFile({
          novel_id: id,
          number: ch.number,
          title: ch.title || `第${ch.number}章`,
          content: ch.content || "",
        });
      }
      backfillJobId = (await queueMemoryBackfill(id)).id;
    }

    return apiSuccess({ id, updated: true, memoryBackfillJobId: backfillJobId });
  } catch (e: unknown) {
    const ownershipResponse = workspaceErrorResponse(e);
    if (ownershipResponse) return ownershipResponse;
    return apiError(e instanceof Error ? e.message : "Unknown", 500);
  }
}

/** DELETE /api/novels/:id */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();

    const { id } = await params;
    const credentials = workspaceCredentials(req);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, id);
    if (!getNovel(id)) return apiError("Not found", 404);
    novelFS.deleteProject(id);
    return apiSuccess({ deleted: true });
  } catch (e: unknown) {
    const ownershipResponse = workspaceErrorResponse(e);
    if (ownershipResponse) return ownershipResponse;
    return apiError(e instanceof Error ? e.message : "Unknown", 500);
  }
}
