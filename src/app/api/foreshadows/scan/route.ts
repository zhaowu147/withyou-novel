import type { NextRequest } from "next/server";

import { assembleContext, contextToLLMText } from "@/lib/ai/memory-retriever";
import { getLocalAdapter, type NovelForeshadow } from "@/lib/ai/novel-storage";
import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

function extractJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    /* 该策略解析失败，继续尝试下一种 */
  }
  const m = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      /* 该策略解析失败，继续尝试下一种 */
    }
  }
  const b = text.match(/\{[\s\S]*\}/);
  if (b) {
    try {
      return JSON.parse(b[0]);
    } catch {
      /* 该策略解析失败，继续尝试下一种 */
    }
  }
  return null;
}

/**
 * POST /api/foreshadows/scan
 * body: { text: string, chapterNum?: number, novelId?: string, mode: "scan"|"suggest"|"resolve" }
 *
 * 改进 v2:
 *   - 自动从 DB 拉已有伏笔(不再依赖前端传 existing)
 *   - 自动注入上下文(实体卡 + 前 N 章摘要)给 LLM
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  try {
    const body = (await req.json()) as {
      text?: string;
      chapterNum?: number;
      novelId?: string;
      mode?: "scan" | "suggest" | "resolve";
    };
    if (!body.text || !body.mode) return apiError("text + mode required", 400, "MISSING");

    const mode = body.mode;
    const chapterNum = body.chapterNum ?? 0;
    const novelId = body.novelId;
    if (novelId) {
      const denied = verifyWorkspaceRequest(req, novelId);
      if (denied) return denied;
    }

    // 1. 自动拉已有伏笔(如果 novelId 存在)—— 加 5 秒超时保护
    let existingForeshadows: string[] = [];
    let contextText = "";
    if (novelId) {
      try {
        const adapter = await Promise.race([
          getLocalAdapter(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        if (adapter) {
          const fsList = await Promise.race([
            adapter.listForeshadows(novelId),
            new Promise<NovelForeshadow[]>((resolve) => setTimeout(() => resolve([]), 3000)),
          ]);
          existingForeshadows = fsList.map((f) => f.description);
        }
        try {
          const ctx = await Promise.race([
            assembleContext({
              novelId,
              taskType: mode === "resolve" ? "logic_check" : "entity_enrich",
              currentChapterNum: chapterNum,
              lookbackChapters: 3,
              maxEntities: 10,
              maxForeshadows: 8,
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
          contextText = contextToLLMText(ctx);
        } catch (e) {
          console.warn("[foreshadow-scan] context timeout:", (e as Error).message);
        }
      } catch (e) {
        console.warn("[foreshadow-scan] DB timeout, continue without", (e as Error).message);
      }
    }

    const SYSTEM = `你是小说伏笔与线索专家. 严格按mode输出JSON, 不要解释.`;

    const modePrompt: Record<string, string> = {
      scan: `从下面文本中找伏笔.
输出: { "found": [{ "type":"明示|暗示", "description":"<=50字", "plant_chapter": ${chapterNum}, "suggested_target": 预收章(可选数字), "reason":"一句话" }] }
已有伏笔(不要重复): ${JSON.stringify(existingForeshadows.slice(0, 20))}
${contextText ? `\n\n## 当前上下文\n${contextText}` : ""}
规则:
1. 明示伏笔要具体可证, 暗示伏笔要合理可多角度解读
2. plant_chapter 必须 <= 当前章(${chapterNum})
3. 1-5 个(宁少勿滥)
4. 只输出JSON

文本:
"""${body.text.slice(0, 6000)}"""`,

      suggest: `根据当前故事轮廓 + 已有伏笔, 建议下一章埋的新伏笔.
输出: { "suggestions": [{ "description":"<=50字", "plant_chapter": 应在第N章, "target_chapter": 预收章, "related_entities": ["实体名"], "type":"明示|暗示" }] }
已有伏笔: ${JSON.stringify(existingForeshadows.slice(0, 20))}
当前章: ${chapterNum}
${contextText ? `\n\n## 当前上下文\n${contextText}` : ""}
规则:
1. 不与已有伏笔重复
2. 描述具体可操作
3. 1-3 个即可
4. 只输出JSON

当前故事轮廓:
"""${body.text.slice(0, 4000)}"""`,

      resolve: `当前章写完, 判定哪些待伏笔被回收/激活.
输出: { "resolve": [{ "desc_match":"已有伏笔描述", "actual_chapter": ${chapterNum}, "evidence":"原文摘录<=30字" }] }
待回收伏笔: ${JSON.stringify(existingForeshadows.slice(0, 20))}
${contextText ? `\n\n## 当前上下文\n${contextText}` : ""}
规则:
1. 严格按本章实际内容, 不要脑补
2. 只有明确对应才输出
3. 1-3 个
4. 只输出JSON

本章正文:
"""${body.text.slice(0, 6000)}"""`,
    };

    const { gatewayCall } = await import("@/lib/ai/gateway");
    const raw = await gatewayCall({
      channel: "dispatch",
      systemPrompt: SYSTEM,
      messages: [{ role: "user", content: modePrompt[mode] || modePrompt.scan }],
      maxTokens: 2048,
      temperature: 0.3,
    });

    const parsed = extractJson(raw) as {
      found?: Array<Omit<NovelForeshadow, "novel_id">>;
      suggestions?: Array<Omit<NovelForeshadow, "novel_id">>;
      resolve?: Array<{ desc_match: string }>;
    } | null;

    if (!parsed) return apiError("LLM 输出解析失败", 502, "PARSE_FAIL");

    return apiSuccess({ raw: parsed });
  } catch (e: unknown) {
    console.error("[foreshadows] scan error", e);
    return apiError("伏笔扫描失败", 500, "ERROR");
  }
}
