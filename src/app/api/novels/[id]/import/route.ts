import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { getNovel, listChapterFiles, saveChapterFile, saveNovelMeta } from "@/lib/local/store";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

type ConflictMode = "append" | "overwrite" | "skip";
const MAX_IMPORT_REQUEST_BYTES = 60 * 1024 * 1024;
const MAX_IMPORT_CHAPTERS = 2_000;
const MAX_IMPORT_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_CHAPTER_BYTES = 512 * 1024;

interface ImportChapterInput {
  number?: number;
  title?: string;
  content?: string;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  const { id } = await params;
  try {
    const credentials = workspaceCredentials(req);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, id);
  } catch (error) {
    return workspaceErrorResponse(error) ?? apiError("工作区校验失败", 500);
  }
  const novel = getNovel(id);
  if (!novel) return apiError("小说不存在", 404, "NOT_FOUND");

  try {
    enforceRateLimit(`import:${id}`, 6);
    const body = await readJsonBody<{
      title?: string;
      fileName?: string;
      conflictMode?: ConflictMode;
      chapters?: ImportChapterInput[];
    }>(req, MAX_IMPORT_REQUEST_BYTES);
    if (!Array.isArray(body.chapters) || !body.chapters.length) {
      return apiError("没有可导入的章节", 400, "NO_CHAPTERS");
    }
    if (body.chapters.length > MAX_IMPORT_CHAPTERS) {
      return apiError(`单次最多导入 ${MAX_IMPORT_CHAPTERS} 章`, 413, "TOO_MANY_CHAPTERS");
    }
    let totalImportBytes = 0;
    for (const chapter of body.chapters) {
      const chapterBytes = Buffer.byteLength(String(chapter?.content ?? ""), "utf8");
      if (chapterBytes > MAX_IMPORT_CHAPTER_BYTES) {
        return apiError("单章内容不能超过 512KB", 413, "CHAPTER_TOO_LARGE");
      }
      totalImportBytes += chapterBytes;
      if (totalImportBytes > MAX_IMPORT_TOTAL_BYTES) {
        return apiError("导入正文总量不能超过 50MB", 413, "IMPORT_TOO_LARGE");
      }
    }
    const mode: ConflictMode =
      body.conflictMode === "overwrite" || body.conflictMode === "skip" ? body.conflictMode : "append";
    const existing = listChapterFiles(id);
    const existingNumbers = new Set(existing.map((chapter) => chapter.number));
    const appendOffset = existing.reduce((max, chapter) => Math.max(max, chapter.number), 0);
    const saved: Array<{ number: number; title: string; content: string; wordCount: number }> = [];
    let skipped = 0;

    for (let index = 0; index < body.chapters.length; index += 1) {
      const input = body.chapters[index];
      const proposed = Number.isFinite(input.number) && Number(input.number) > 0 ? Number(input.number) : index + 1;
      const number = mode === "append" ? appendOffset + index + 1 : proposed;
      if (mode === "skip" && existingNumbers.has(number)) {
        skipped += 1;
        continue;
      }
      const title = String(input.title || `第${number}章`).trim() || `第${number}章`;
      const content = String(input.content || "").trim();
      if (!content) {
        skipped += 1;
        continue;
      }
      const chapter = await saveChapterFile({
        novel_id: id,
        number,
        title,
        content,
      });
      saved.push({
        number: chapter.number,
        title: chapter.title,
        content: chapter.content,
        wordCount: chapter.word_count,
      });
      existingNumbers.add(number);
    }

    const maxChapter = Math.max(novel.total_chapters, ...existingNumbers);
    saveNovelMeta(id, {
      title: body.title?.trim() || novel.title,
      total_chapters: maxChapter,
      metadata: {
        ...novel.metadata,
        lastImport: {
          fileName: body.fileName ?? "未命名文件",
          importedAt: new Date().toISOString(),
          saved: saved.length,
          skipped,
          mode,
        },
      },
    });

    return apiSuccess({ chapters: saved, skipped, totalChapters: maxChapter });
  } catch (error) {
    if (error instanceof RequestGuardError) return apiError(error.message, error.status, error.code);
    return apiError(error instanceof Error ? error.message : "导入失败", 500, "IMPORT_FAILED");
  }
}
