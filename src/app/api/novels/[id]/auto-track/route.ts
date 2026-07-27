/**
 * POST /api/novels/[id]/auto-track
 *
 * 章节写入文件树后异步触发的分层记忆追踪。
 * 提取章节摘要与短期/长期/规范记忆候选，不阻塞主写作流程。
 * 失败时静默返回，不影响用户操作。
 */
import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { sanitizeNovelId } from "@/lib/local/paths";
import { addTimelineEvent } from "@/lib/local/store";
import { extractChapterMemory } from "@/lib/memory/chapter-memory-extractor";
import { queueAffectedConsolidations, runPendingConsolidations } from "@/lib/memory/consolidation";
import { ingestChapterMemories } from "@/lib/memory/novel-memory";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();

    const { id } = await params;
    const denied = verifyWorkspaceRequest(req, id);
    if (denied) return denied;

    enforceRateLimit("auto-track:local", 30);

    const body = await readJsonBody<Record<string, unknown>>(req, 512 * 1024);
    const { chapterText, chapterNum } = body as {
      chapterText?: string;
      chapterNum?: number;
    };

    if (!chapterText?.trim()) return apiError("chapterText required", 400);
    if (!Number.isInteger(chapterNum) || (chapterNum ?? 0) < 1) {
      return apiError("chapterNum must be a positive integer", 400);
    }
    const chapterNumber = chapterNum as number;

    const novelId = sanitizeNovelId(id);
    const chapterLabel = `第${chapterNumber}章`;
    const extraction = await extractChapterMemory(chapterNumber, chapterText);

    const memory = await ingestChapterMemories(novelId, chapterNumber, chapterText, extraction);
    const summary = extraction.summary?.trim() ?? "";
    if (!summary && memory.inserted === 0) {
      return apiSuccess({ tracked: 0, unchanged: memory.unchanged });
    }

    const ev =
      summary && !memory.unchanged
        ? await addTimelineEvent(novelId, {
            chapter: chapterNumber,
            description: `[${chapterLabel}] ${summary}`,
          })
        : null;
    const queued = memory.unchanged ? [] : await queueAffectedConsolidations(novelId, chapterNumber);
    // 此接口由前端 fire-and-forget 调用；Dream 失败只记入任务状态，不影响正文和章节记忆。
    const consolidation = await runPendingConsolidations(novelId, 2);

    return apiSuccess({
      tracked: 1,
      eventId: ev?.id,
      summary,
      memories: memory.inserted,
      canonicalCandidates: memory.candidates,
      unchanged: memory.unchanged,
      consolidationQueued: queued.map((job) => job.id),
      consolidation,
    });
  } catch (e: unknown) {
    if (e instanceof RequestGuardError) return apiError(e.message, e.status, e.code);
    // 追踪失败不应中断用户流程，返回静默失败
    return apiSuccess({ tracked: 0, error: e instanceof Error ? e.message : "unknown" });
  }
}
