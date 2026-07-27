/**
 * ContextCompressor — 对话上下文压缩（token-aware 版）
 *
 * 256k token 限制下的智能压缩策略:
 * 1. 估算 token 数（中文≈1.5字/token，英文≈4字/token）
 * 2. 超限时按优先级压缩：消息历史 > vault > 设定
 * 3. 保留最近 N 条消息，旧消息摘要化
 */

// ─── Token 估算 ───

/** 粗估 token 数：中文 1.5字/token，英文 4字/token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cn = 0;
  let en = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x7f) cn++;
    else en++;
  }
  return Math.ceil(cn / 1.5 + en / 4);
}

/** 估算消息数组的 token 数 */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content) + 4; // role overhead
  }
  return total;
}

// ─── 压缩配置 ───

export interface CompressionConfig {
  /** 最大 token 上限（默认 240000，留 16k 给输出） */
  maxTokens: number;
  /** 保留最近 N 条消息（不压缩） */
  keepRecentMessages: number;
  /** 压缩后消息历史的最大 token 数 */
  maxHistoryTokens: number;
  /** 压缩后 vault 的最大 token 数 */
  maxVaultTokens: number;
  /** 压缩后设定的最大 token 数 */
  maxNovelDataTokens: number;
}

const DEFAULT_CONFIG: CompressionConfig = {
  maxTokens: 240_000,
  keepRecentMessages: 10,
  maxHistoryTokens: 50_000,
  maxVaultTokens: 15_000,
  maxNovelDataTokens: 30_000,
};

// ─── 消息历史压缩 ───

/**
 * 压缩消息历史：
 * - 保留最近 N 条完整消息
 * - 旧消息合并为摘要
 */
export function compressMessages(
  messages: Array<{ role: string; content: string }>,
  config: Partial<CompressionConfig> = {},
): Array<{ role: string; content: string }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const totalTokens = estimateMessagesTokens(messages);

  // 没超限，不压缩
  if (totalTokens <= cfg.maxHistoryTokens) return messages;

  // 保留最近 N 条
  const keepCount = Math.min(cfg.keepRecentMessages, messages.length);
  const oldMessages = messages.slice(0, -keepCount);
  const recentMessages = messages.slice(-keepCount);

  const checkpoint = oldMessages.find(
    (message) => message.role === "system" && message.content.startsWith("[结构化会话检查点]"),
  );
  if (!checkpoint) return recentMessages;
  const compressed = [checkpoint, ...recentMessages];

  return compressed;
}

// ─── Vault 压缩 ───

export interface VaultData {
  activeForeshadows?: Array<{ description: string; plant_chapter?: number; state: string }>;
  activeEntities?: Array<{ name: string; type: string; importance: string; active_state: string; summary: string }>;
  recentTimeline?: Array<{ entity_name?: string; chapter?: number; description: string }>;
}

/**
 * 压缩 vault 数据：减少条目数
 */
export function compressVault(vault: VaultData, maxTokens = 15_000): VaultData {
  const estimate = (v: VaultData) => {
    let t = 0;
    for (const f of v.activeForeshadows ?? []) t += estimateTokens(f.description);
    for (const e of v.activeEntities ?? []) t += estimateTokens(e.summary) + 20;
    for (const tl of v.recentTimeline ?? []) t += estimateTokens(tl.description);
    return t;
  };

  if (estimate(vault) <= maxTokens) return vault;

  // 按优先级裁剪：先砍 timeline，再砍 entities，最后砍 foreshadows
  const result = { ...vault };

  // 砍 timeline：保留最近 5 条
  if (result.recentTimeline && result.recentTimeline.length > 5) {
    result.recentTimeline = result.recentTimeline.slice(0, 5);
  }

  // 砍 entities：只保留 high importance
  if (result.activeEntities && estimate(result) > maxTokens) {
    result.activeEntities = result.activeEntities.filter((e) => e.importance === "high");
  }

  // 砍 foreshadows：保留最近 5 条
  if (result.activeForeshadows && estimate(result) > maxTokens) {
    result.activeForeshadows = result.activeForeshadows.slice(0, 5);
  }

  return result;
}

// ─── 设定压缩 ───

export interface NovelData {
  novelName?: string;
  brainstorm?: string;
  outline?: string;
  detailedOutline?: string;
  characters?: string;
  worldview?: string;
  goldfinger?: string;
  synopsis?: string;
  opening?: string;
  foreshadowing?: string;
  chapters?: Record<string, string>;
  retrievedMemory?: string;
  novelId?: string;
  taskType?: string;
  currentChapterNum?: number;
}

/**
 * 压缩小说设定：截断超长字段
 */
export function compressNovelData(data: NovelData, maxTokens = 30_000): NovelData {
  const estimate = (d: NovelData) => {
    let t = 0;
    t += estimateTokens(d.brainstorm || "");
    t += estimateTokens(d.outline || "");
    t += estimateTokens(d.detailedOutline || "");
    t += estimateTokens(d.characters || "");
    t += estimateTokens(d.worldview || "");
    t += estimateTokens(d.goldfinger || "");
    t += estimateTokens(d.synopsis || "");
    t += estimateTokens(d.opening || "");
    t += estimateTokens(d.foreshadowing || "");
    t += estimateTokens(d.retrievedMemory || "");
    for (const ch of Object.values(d.chapters ?? {})) t += estimateTokens(ch);
    return t;
  };

  if (estimate(data) <= maxTokens) return data;

  const result = { ...data };

  // 按优先级截断：先砍世界观，再砍人物，最后砍大纲
  const priorities = [
    { field: "opening" as const, ratio: 0.15 },
    { field: "brainstorm" as const, ratio: 0.2 },
    { field: "worldview" as const, ratio: 0.2 },
    { field: "retrievedMemory" as const, ratio: 0.35 },
    { field: "goldfinger" as const, ratio: 0.25 },
    { field: "characters" as const, ratio: 0.3 },
    { field: "detailedOutline" as const, ratio: 0.45 },
    { field: "outline" as const, ratio: 0.5 },
  ];

  for (const { field, ratio } of priorities) {
    if (estimate(result) <= maxTokens) break;
    const current = result[field];
    if (!current) continue;
    const targetLen = Math.floor(current.length * ratio);
    if (targetLen > 1000) {
      (result as Record<string, unknown>)[field] = `${current.slice(0, targetLen)}\n\n[...已压缩...]`;
    }
  }

  return result;
}

// ─── 总入口 ───

export interface ContextBundle {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  novelData?: NovelData;
  vaultContext?: VaultData;
}

/**
 * 自动压缩整个上下文 bundle
 * 返回压缩后的 bundle + 压缩报告
 *
 * @param bundle - 上下文数据
 * @param dynamicConfig - 可选的动态压缩配置（从设置读取），不传则用默认值
 */
export function autoCompressContext(
  bundle: ContextBundle,
  dynamicConfig?: Partial<CompressionConfig>,
): {
  compressed: ContextBundle;
  report: { originalTokens: number; compressedTokens: number; actions: string[] };
} {
  const config = { ...DEFAULT_CONFIG, ...dynamicConfig };
  const actions: string[] = [];

  // 估算原始 token
  const originalTokens =
    estimateTokens(bundle.systemPrompt) +
    estimateMessagesTokens(bundle.messages) +
    estimateTokens(JSON.stringify(bundle.novelData || {})) +
    estimateTokens(JSON.stringify(bundle.vaultContext || {}));

  const compressed = { ...bundle };

  // 如果没超限，直接返回
  if (originalTokens <= config.maxTokens) {
    return {
      compressed,
      report: { originalTokens, compressedTokens: originalTokens, actions: ["无需压缩"] },
    };
  }

  // 第一步：压缩消息历史
  const msgTokens = estimateMessagesTokens(compressed.messages);
  if (msgTokens > config.maxHistoryTokens) {
    compressed.messages = compressMessages(compressed.messages, config);
    actions.push(`消息历史: ${msgTokens} → ${estimateMessagesTokens(compressed.messages)} tokens`);
  }

  // 第二步：压缩 vault
  if (compressed.vaultContext) {
    const vaultTokens = estimateTokens(JSON.stringify(compressed.vaultContext));
    if (vaultTokens > config.maxVaultTokens) {
      compressed.vaultContext = compressVault(compressed.vaultContext, config.maxVaultTokens);
      actions.push(`Vault: ${vaultTokens} → ${estimateTokens(JSON.stringify(compressed.vaultContext))} tokens`);
    }
  }

  // 第三步：压缩设定
  if (compressed.novelData) {
    const novelTokens = estimateTokens(JSON.stringify(compressed.novelData));
    if (novelTokens > config.maxNovelDataTokens) {
      compressed.novelData = compressNovelData(compressed.novelData, config.maxNovelDataTokens);
      actions.push(`设定: ${novelTokens} → ${estimateTokens(JSON.stringify(compressed.novelData))} tokens`);
    }
  }

  const compressedTokens =
    estimateTokens(compressed.systemPrompt) +
    estimateMessagesTokens(compressed.messages) +
    estimateTokens(JSON.stringify(compressed.novelData || {})) +
    estimateTokens(JSON.stringify(compressed.vaultContext || {}));

  return {
    compressed,
    report: { originalTokens, compressedTokens, actions },
  };
}

// ─── 兼容旧接口 ───

export interface CompressedContext {
  system: string;
  summary: string;
  recent: Array<{ role: "user" | "assistant"; content: string }>;
  stats: {
    originalMessages: number;
    compressedMessages: number;
    keptRecent: number;
    summaryLength: number;
  };
}

export function shouldCompress(messageCount: number, triggerCount = 30): boolean {
  return messageCount > triggerCount;
}

export function compressHistory(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  systemPrompt: string,
  keepRecent = 10,
): CompressedContext {
  if (messages.length <= keepRecent) {
    return {
      system: systemPrompt,
      summary: "",
      recent: [...messages],
      stats: {
        originalMessages: messages.length,
        compressedMessages: 0,
        keptRecent: messages.length,
        summaryLength: 0,
      },
    };
  }

  const splitPoint = messages.length - keepRecent;
  const toCompress = messages.slice(0, splitPoint);
  const recent = messages.slice(splitPoint);

  // 生成压缩摘要
  const summary = toCompress.map((m) => `[${m.role}] ${m.content.slice(0, 80)}...`).join("\n");

  return {
    system: systemPrompt,
    summary,
    recent,
    stats: {
      originalMessages: messages.length,
      compressedMessages: toCompress.length,
      keptRecent: recent.length,
      summaryLength: summary.length,
    },
  };
}

export default {
  estimateTokens,
  estimateMessagesTokens,
  compressMessages,
  compressVault,
  compressNovelData,
  autoCompressContext,
  shouldCompress,
  compressHistory,
};
