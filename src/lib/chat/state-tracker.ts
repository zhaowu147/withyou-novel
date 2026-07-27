/**
 * 状态追踪 — localStorage 版（客户端）+ vault fallback（服务端）
 * 记录角色状态、世界事件、伏笔
 */

const STATE_KEY = "withyou_novel_state";

export interface CharacterState {
  name: string;
  level?: string;
  location?: string;
  items?: string[];
  status?: string; // 伤势/状态
  relationships?: Record<string, string>;
}

export interface NovelState {
  characters: CharacterState[];
  worldFacts: string[];
  unresolvedHooks: string[];
  lastChapterSummary?: string;
  updatedAt: string;
}

const EMPTY_STATE: NovelState = {
  characters: [],
  worldFacts: [],
  unresolvedHooks: [],
  updatedAt: new Date().toISOString(),
};

export function getNovelState(): NovelState {
  if (typeof window === "undefined") return EMPTY_STATE;
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return EMPTY_STATE;
    return { ...EMPTY_STATE, ...JSON.parse(raw) };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveNovelState(state: NovelState): void {
  if (typeof window === "undefined") return;
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

export function updateNovelState(diff: Partial<NovelState>): NovelState {
  const current = getNovelState();
  const merged: NovelState = {
    characters: diff.characters ?? current.characters,
    worldFacts: [...current.worldFacts, ...(diff.worldFacts ?? [])],
    unresolvedHooks: [...new Set([...current.unresolvedHooks, ...(diff.unresolvedHooks ?? [])])],
    lastChapterSummary: diff.lastChapterSummary ?? current.lastChapterSummary,
    updatedAt: new Date().toISOString(),
  };
  saveNovelState(merged);
  return merged;
}

/** vault 上下文类型 (from serverVault.ts) */
export interface VaultPromptContext {
  activeForeshadows?: Array<{ description: string; plant_chapter?: number; state: string }>;
  recentTimeline?: Array<{ entity_name?: string; chapter?: number; description: string }>;
}

/**
 * 格式化状态为 prompt 文本。
 * 服务端时优先用 vault 数据（本地 JSON），客户端 fallback 到 localStorage。
 */
export function formatStateForPrompt(vaultCtx?: VaultPromptContext): string {
  // 服务端：从 vault context 组装
  if (typeof window === "undefined" && vaultCtx) {
    const lines: string[] = [];
    if (vaultCtx.activeForeshadows?.length) {
      lines.push("## 活跃伏笔");
      for (const f of vaultCtx.activeForeshadows) {
        lines.push(`- [${f.state}] ${f.description}${f.plant_chapter ? ` (第${f.plant_chapter}章埋)` : ""}`);
      }
    }
    if (vaultCtx.recentTimeline?.length) {
      if (lines.length) lines.push("");
      lines.push("## 近期状态追踪");
      for (const t of vaultCtx.recentTimeline) {
        lines.push(`- 第${t.chapter}章: ${t.entity_name || "全局"} - ${t.description}`);
      }
    }
    return lines.length ? lines.join("\n") : "";
  }

  // 客户端：localStorage
  const state = getNovelState();
  if (state.characters.length === 0 && state.worldFacts.length === 0 && state.unresolvedHooks.length === 0) {
    return "";
  }

  const lines: string[] = ["## 当前状态账本"];

  if (state.characters.length > 0) {
    lines.push("\n### 角色状态");
    for (const ch of state.characters) {
      const parts = [
        ch.level ? `等级:${ch.level}` : "",
        ch.location ? `位置:${ch.location}` : "",
        ch.items?.length ? `持有:${ch.items.join(",")}` : "",
        ch.status ? `状态:${ch.status}` : "",
      ].filter(Boolean);
      lines.push(`- ${ch.name}：${parts.join(" / ") || "无变化"}`);
    }
  }

  if (state.worldFacts.length > 0) {
    lines.push("\n### 已发生事件");
    for (const f of state.worldFacts.slice(-10)) {
      lines.push(`- ${f}`);
    }
  }

  if (state.unresolvedHooks.length > 0) {
    lines.push("\n### 未回收伏笔");
    for (const h of state.unresolvedHooks) {
      lines.push(`- ${h}`);
    }
  }

  return lines.join("\n");
}

/**
 * 从 AI 回复中提取 [STATE_UPDATE]{...} 标签并应用
 */
export function applyStateDiffFromText(aiResponse: string): NovelState | null {
  const match = aiResponse.match(/\[STATE_UPDATE\]\s*(\{[\s\S]*?\})/);
  if (!match) return null;
  try {
    const diff = JSON.parse(match[1]);
    return updateNovelState(diff);
  } catch {
    return null;
  }
}

/**
 * 清理 AI 回复中的状态标签，只给用户看正文
 */
export function stripStateTags(text: string): string {
  return text.replace(/\[STATE_UPDATE\]\s*\{[\s\S]*?\}/g, "").trim();
}
