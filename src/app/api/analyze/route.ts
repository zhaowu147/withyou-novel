import type { NextRequest } from "next/server";

import { gatewayCall, type MessageContent } from "@/lib/ai/gateway";
import { wrapUntrustedData } from "@/lib/ai/prompt-boundary";
import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";

const TEXT_ANALYSIS_PROMPT = `你是小说章节分析专家。分析以下章节，输出结构化报告。

输出格式（严格 JSON）：
{
  "chapter_number": 章节号,
  "summary": "100字摘要",
  "pacing": { "score": 0-10, "note": "节奏评价" },
  "hooks": [{ "type": "章首钩|章中钩|章末钩", "strength": "strong|medium|weak", "description": "钩子内容" }],
  "characters_active": ["出场的角色名"],
  "foreshadow_planted": ["新埋的伏笔"],
  "foreshadow_resolved": ["回收的伏笔"],
  "issues": [{ "severity": "critical|warning|info", "type": "逻辑矛盾|角色OOC|设定冲突|节奏问题", "detail": "具体问题" }],
  "next_chapter_hints": "对下一章的建议"
}`;

const IMAGE_ANALYSIS_PROMPT = `你是一位专业的视觉设计分析师。分析这张图片的风格特征，输出简洁的风格描述。

输出格式（纯文本，不要 JSON）：
用 3-5 句话描述这张图的：整体风格、色调/配色方案、构图特点、氛围/情绪、关键视觉元素。
描述要具体，可以直接作为 AI 生图的风格参考。`;

export async function POST(req: NextRequest) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();

    enforceRateLimit("analyze:local", 20);
    const body = await readJsonBody<Record<string, unknown>>(req, 10 * 1024 * 1024);
    const { chapterText, chapterNum, imageUrl, customPrompt } = body as {
      chapterText?: string;
      chapterNum?: number;
      imageUrl?: string;
      customPrompt?: string;
    };

    // ─── 图像分析模式（封面风格参考） ───
    if (imageUrl) {
      const prompt = customPrompt || IMAGE_ANALYSIS_PROMPT;
      const userContent: MessageContent = [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } },
      ];

      const raw = await gatewayCall({
        channel: "tool",
        systemPrompt: IMAGE_ANALYSIS_PROMPT,
        messages: [{ role: "user", content: userContent }],
        maxTokens: 512,
        temperature: 0.5,
      });

      return apiSuccess({ raw, imageUrl });
    }

    // ─── 文本分析模式（章节分析） ───
    if (!chapterText) {
      return apiError("chapterText or imageUrl is required", 400, "MISSING_INPUT");
    }

    const prompt = customPrompt || TEXT_ANALYSIS_PROMPT;
    const snippet = chapterText.slice(0, 8000); // 截断保护

    const raw = await gatewayCall({
      channel: "tool",
      systemPrompt: prompt,
      messages: [
        {
          role: "user",
          content: `分析第${chapterNum || "?"}章:\n\n${wrapUntrustedData("chapter_text", snippet)}`,
        },
      ],
      maxTokens: 2048,
      temperature: 0.3,
    });

    // 尝试提取 JSON
    try {
      const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
      return apiSuccess(json);
    } catch {
      return apiSuccess({ raw, chapterNum });
    }
  } catch (e: unknown) {
    if (e instanceof RequestGuardError) return apiError(e.message, e.status, e.code);
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("Analyze route error:", message);
    return apiError("分析请求失败，请重试", 500);
  }
}
