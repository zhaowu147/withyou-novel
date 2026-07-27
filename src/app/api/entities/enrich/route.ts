import type { NextRequest } from "next/server";

import { assembleContext, contextToLLMText } from "@/lib/ai/memory-retriever";
import { getLocalAdapter, type NovelEntityCard } from "@/lib/ai/novel-storage";
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
 * POST /api/entities/enrich
 * body: { text: string, novelId?: string }
 *
 * 改进 v2:
 *   - 自动注入已有实体卡给 LLM(避免重复)
 *   - 自动注入上下文(实体卡 + 前 N 章摘要)
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  try {
    const body = (await req.json()) as { text?: string; novelId?: string; mode?: "enrich" | "patch" };
    if (!body.text) return apiError("text required", 400, "MISSING_TEXT");
    if (body.novelId) {
      const denied = verifyWorkspaceRequest(req, body.novelId);
      if (denied) return denied;
    }

    // 1. 自动拉已有实体卡(如果 novelId 存在)—— 加 5 秒超时保护
    let existingNames: string[] = [];
    let contextText = "";
    if (body.novelId) {
      try {
        const adapter = await Promise.race([
          getLocalAdapter(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        if (adapter) {
          const cards = await Promise.race([
            adapter.listEntities(body.novelId),
            new Promise<NovelEntityCard[]>((resolve) => setTimeout(() => resolve([]), 3000)),
          ]);
          existingNames = cards.map((c) => c.name);
        }

        // 2. 用 memory_retriever 组装上下文
        try {
          const ctx = await Promise.race([
            assembleContext({
              novelId: body.novelId,
              taskType: "entity_enrich",
              lookbackChapters: 5,
              maxEntities: 20,
              maxForeshadows: 10,
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
          contextText = contextToLLMText(ctx);
        } catch (e) {
          console.warn("[entities-enrich] context timeout, fallback:", (e as Error).message);
        }
      } catch (e) {
        console.warn("[entities-enrich] DB timeout, continue without enrichment", (e as Error).message);
      }
    }

    const ENRICH_PROMPT = `你是小说实体识别专家. 从下面文本中识别角色/地点/势力/物品/事件实体.

输出严格 JSON:
{
  "entities": [
    { "name": "...", "type": "character|location|faction|item|event|other",
      "importance": "high|mid|low", "summary": "一句话(<=30字)", "active_state": "active" }
  ]
}

规则:
1. 只提取文本中明确出现的, 不脑补
2. importance: high=主角/核心反派, mid=重要配角, low=龙套
3. 同实体只输出一次
4. 不要输出已有实体(见下)
5. 3-15 个
6. 只输出JSON

${existingNames.length > 0 ? `已有实体(不要重复输出): ${JSON.stringify(existingNames.slice(0, 30))}` : ""}
${contextText ? `\n## 当前上下文\n${contextText}` : ""}

待分析文本:
"""${body.text.slice(0, 8000)}"""`;

    const { gatewayCall } = await import("@/lib/ai/gateway");
    const raw = await gatewayCall({
      channel: "dispatch",
      systemPrompt: "你是一个严格的实体识别工具. 只输出 JSON.",
      messages: [{ role: "user", content: ENRICH_PROMPT }],
      maxTokens: 2048,
      temperature: 0.3,
    });

    const parsed = extractJson(raw);
    if (!parsed) return apiError("LLM 输出解析失败", 502, "PARSE_FAIL");

    // 自动写库
    const saved: NovelEntityCard[] = [];
    if (body.novelId && parsed.entities) {
      const adapter = await getLocalAdapter();
      if (adapter) {
        for (const e of parsed.entities as Array<Omit<NovelEntityCard, "novel_id">>) {
          if (existingNames.includes(e.name)) continue; // 跳过已有
          const card = await adapter.upsertEntity({
            novel_id: body.novelId,
            name: e.name,
            type: e.type || "other",
            importance: e.importance || "mid",
            active_state: "active",
            summary: e.summary || "",
          });
          if (card) saved.push(card);
        }
      }
    }

    return apiSuccess({ raw: parsed, saved, savedCount: saved.length });
  } catch (e: unknown) {
    console.error("[entities] enrich error", e);
    return apiError("实体识别失败", 500, "ERROR");
  }
}
