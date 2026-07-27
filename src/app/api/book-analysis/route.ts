import type { NextRequest } from "next/server";

import { gatewayCall } from "@/lib/ai/gateway";
import { wrapUntrustedData } from "@/lib/ai/prompt-boundary";
import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";

export const maxDuration = 300;
export const runtime = "nodejs";

const BOOK_ANALYSIS_SYSTEM_PROMPT = `你是独立的小说拆书分析专家。

这个任务只分析用户本次上传的作品，不属于当前创作会话，也不得要求用户先创建小说、书名、角色、大纲或文件树。
严格根据用户提供的原文和分析要求工作，不要把作品内容写入任何创作项目。
输出面向小说作者的中文分析报告，具体引用情节和章节，避免空泛结论。`;

export async function POST(req: NextRequest) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();

    enforceRateLimit("book-analysis:local", 12);
    const body = await readJsonBody<Record<string, unknown>>(req, 10 * 1024 * 1024);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const analysisPrompt = typeof body.analysisPrompt === "string" ? body.analysisPrompt.trim() : "";
    const extra = typeof body.extra === "string" ? body.extra.trim() : "";
    const mode = body.mode === "split" ? "split" : "merge";

    if (!content) return apiError("请先上传并选择要分析的小说章节", 400, "MISSING_CONTENT");
    if (!analysisPrompt) return apiError("请填写拆书要求", 400, "MISSING_ANALYSIS_PROMPT");

    const modeInstruction =
      mode === "split"
        ? "按章节分别拆解，每章给出独立结论，最后再总结跨章节规律。"
        : "将所选章节作为一个连续整体分析，重点说明结构之间的因果关系。";

    const result = await gatewayCall({
      channel: "dispatch",
      systemPrompt: BOOK_ANALYSIS_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `${modeInstruction}

拆书要求：
${analysisPrompt}
${extra ? `\n补充信息：\n${extra}` : ""}

${wrapUntrustedData("uploaded_novel_excerpt", content)}`,
        },
      ],
      maxTokens: 16_384,
      temperature: 0.35,
    });

    return apiSuccess({ result });
  } catch (error: unknown) {
    if (error instanceof RequestGuardError) return apiError(error.message, error.status, error.code);
    const message = error instanceof Error ? error.message : "未知错误";
    console.error("Book analysis route error:", message);
    return apiError("拆书分析失败，请稍后重试", 502, "BOOK_ANALYSIS_FAILED");
  }
}
