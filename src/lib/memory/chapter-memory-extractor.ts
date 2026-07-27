/**
 * 章节记忆提取的统一入口，供新章自动追踪与历史章节回填共同使用。
 */
import "server-only";

import { gatewayCall } from "@/lib/ai/gateway";
import { wrapUntrustedData } from "@/lib/ai/prompt-boundary";
import type { ChapterMemoryExtraction } from "@/lib/memory/novel-memory";

const AUTO_TRACK_PROMPT = `你是小说章节记忆提取器。只依据本章正文提取可回溯事实，并将记忆分层。严格输出 JSON，不输出解释。

输出格式：
{
  "summary": "本章120字以内因果概要",
  "memories": [
    {
      "tier": "short|long|canonical",
      "kind": "event|character_state|relationship|location|faction|item|ability|foreshadow|conflict|setting|other",
      "content": "一条独立、明确、可检索的事实",
      "entities": ["涉及实体"],
      "keywords": ["检索关键词"],
      "importance": "high|mid|low",
      "confidence": 0.0,
      "ttlChapters": 5,
      "evidence": "正文中支持该事实的短证据"
    }
  ]
}

分层标准：
- short：最近几章需要保持连续的现场状态、位置、动作、情绪、临时目标、未结束场景，默认维持1至5章。
- long：会跨较多章节影响剧情的已发生事件、关系变化、能力物品变化、承诺、秘密、伏笔和未解决冲突。
- canonical：正文明确宣布的稳定世界规则或不可轻易改变的核心设定。不要把普通事件归入此层。

硬规则：
- 最多提取16条；每条只表达一个事实。
- 不得推测正文未确认的事实，不得把比喻、假设、角色误解当事实。
- summary 必须包含“谁做了什么、结果或当前承接点是什么”。
- short 必须提供 ttlChapters（1至12）；long/canonical 不提供 ttlChapters。
- evidence 必须来自本章正文，最多80字。`;

export async function extractChapterMemory(
  chapterNumber: number,
  chapterText: string,
): Promise<ChapterMemoryExtraction> {
  const snippet = chapterText.slice(0, 24_000);
  const raw = await gatewayCall({
    channel: "tool",
    systemPrompt: AUTO_TRACK_PROMPT,
    messages: [
      {
        role: "user",
        content: `第${chapterNumber}章正文：\n\n${wrapUntrustedData("chapter_text", snippet)}`,
      },
    ],
    maxTokens: 2_048,
    temperature: 0.1,
  });

  try {
    return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as ChapterMemoryExtraction;
  } catch {
    return {
      summary: raw
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, 120),
      memories: [],
    };
  }
}
