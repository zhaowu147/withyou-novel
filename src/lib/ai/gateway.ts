/**
 * AI Gateway — 4 key 池路由器
 *
 * 4 个 Worker 各自独立：各自有自己的 key + model + prompt 上下文
 * 互不"记忆污染" — 每个 Channel 仅处理自己的任务类型
 *
 * 功能区与会话区使用独立模型路由；会话不会根据消息自动切换 Agent。
 */

import { Agent, fetch as undiciFetch } from "undici";

import { UNTRUSTED_DATA_POLICY } from "@/lib/ai/prompt-boundary";
import { getRuntimeModelConfig, type ModelConfigScope } from "@/lib/settings/runtime-model-config";

// ─── Rate Limiter: 每用户每 N 秒最多 M 次调用 ───
const RATE_WINDOW_MS = 60_000; // 1 分钟窗口
const RATE_MAX_PER_WINDOW = 30; // 每用户最多 30 次/分钟
const CLEANUP_INTERVAL_MS = 300_000; // 每 5 分钟清理一次过期记录
const userCallLog = new Map<string, number[]>();
const activeCalls = new Map<ChannelType, number>();
const MAX_CONCURRENT_CALLS = 3;
let lastCleanup = Date.now();
const globalForGateway = globalThis as typeof globalThis & {
  __withyouDirectModelDispatcher?: Agent;
};
const directModelDispatcher =
  globalForGateway.__withyouDirectModelDispatcher ??
  new Agent({
    connectTimeout: 15_000,
    headersTimeout: 120_000,
    bodyTimeout: 300_000,
  });
globalForGateway.__withyouDirectModelDispatcher = directModelDispatcher;
const DIRECT_MODEL_HOSTS = new Set(["api.stepfun.com"]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

function fetchErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const directCode = (error as Error & { code?: string }).code;
  const causeCode = (error.cause as { code?: string } | undefined)?.code;
  return directCode || causeCode || "";
}

function isTransientFetchError(error: unknown): boolean {
  if (TRANSIENT_NETWORK_CODES.has(fetchErrorCode(error))) return true;
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

async function modelFetch(url: string, init: RequestInit): Promise<Response> {
  const hostname = new URL(url).hostname.toLocaleLowerCase();
  const useDirectConnection = DIRECT_MODEL_HOSTS.has(hostname);

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (useDirectConnection) {
        return (await undiciFetch(url, {
          method: init.method,
          headers: init.headers,
          body: typeof init.body === "string" ? init.body : undefined,
          signal: init.signal ?? undefined,
          dispatcher: directModelDispatcher,
        } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
      }
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError(error) || init.signal?.aborted || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

function cleanupExpiredEntries(now: number): void {
  for (const [userId, log] of userCallLog) {
    const recent = log.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) {
      userCallLog.delete(userId);
    } else {
      userCallLog.set(userId, recent);
    }
  }
  lastCleanup = now;
}

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  // 定期清理过期条目，防止 Map 无限膨胀
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    cleanupExpiredEntries(now);
  }
  const log = userCallLog.get(userId) || [];
  const recent = log.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_PER_WINDOW) {
    return false;
  }
  recent.push(now);
  userCallLog.set(userId, recent);
  return true;
}

function acquireChannelSlot(channel: ChannelType): () => void {
  if (!checkRateLimit(`local:${channel}`)) throw new Error("模型请求过于频繁，请稍后重试");
  const current = activeCalls.get(channel) ?? 0;
  if (current >= MAX_CONCURRENT_CALLS) throw new Error("当前模型任务已达到并发上限，请稍后重试");
  activeCalls.set(channel, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeCalls.get(channel) ?? 1) - 1;
    if (remaining > 0) activeCalls.set(channel, remaining);
    else activeCalls.delete(channel);
  };
}

export type ChannelType = "dispatch" | "chat" | "tool" | "write";

/**
 * 模型配置的作用域是固定的：
 * - tool / dispatch：功能区模型（dispatch 仅供显式分析任务使用）
 * - chat / write：会话写作模型
 * 封面模型不经过文本 Gateway。
 */
export function getChannelModelScope(channel: ChannelType): ModelConfigScope {
  return channel === "tool" || channel === "dispatch" ? "creationTool" : "chatAgent";
}

function resolveChannelConfig(channel: ChannelType) {
  return getRuntimeModelConfig(getChannelModelScope(channel));
}

/** 消息内容：纯文本或多模态数组（OpenAI 兼容格式） */
export type MessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
    >;

interface GatewayOptions {
  channel: ChannelType;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: MessageContent }>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
}

/**
 * 核心路由：选择 channel → 调用对应 key/model → 返回结果
 */
export async function gatewayCall(opts: GatewayOptions): Promise<string> {
  const release = acquireChannelSlot(opts.channel);
  const config = resolveChannelConfig(opts.channel);
  try {
    if (!config.apiKey) {
      throw new Error(`未配置${config.scope === "creationTool" ? "功能区" : "会话写作区"} API Key`);
    }
    return await streamCall(config.apiBase, config.apiKey, config.model, opts);
  } finally {
    release();
  }
}

async function streamCall(apiBase: string, key: string, model: string, opts: GatewayOptions): Promise<string> {
  const controller = new AbortController();
  const outer = opts.signal;
  if (outer) {
    outer.addEventListener("abort", () => controller.abort());
  }

  const res = await modelFetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: `${UNTRUSTED_DATA_POLICY}\n\n${opts.systemPrompt}` }, ...opts.messages],
      max_tokens: opts.maxTokens ?? 30000,
      temperature: opts.temperature ?? 0.83,
      stream: true,
      ...(opts.tools ? { tools: opts.tools } : {}),
    }),
    signal: controller.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`[${opts.channel}] API ${res.status}: ${errText}`);
  }

  // 流式解析 SSE
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") break;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content || "";
        if (delta) full += delta;
      } catch {
        // skip malformed
      }
    }
  }

  return full;
}

/**
 * 公开流式接口 — callback 方式逐字输出
 *
 * Workbench 模式：区分 reasoning(思考) 和 content(输出)
 *  - onReasoning: 推理过程 (思考链, display 用)
 *  - onChunk: 实际正文 token
 */
export async function gatewayStream(
  opts: GatewayOptions,
  onChunk: (chunk: string) => void,
  onReasoning?: (reasoning: string) => void,
): Promise<string> {
  const config = resolveChannelConfig(opts.channel);

  if (!config.apiKey) {
    throw new Error(`未配置${config.scope === "creationTool" ? "功能区" : "会话写作区"} API Key`);
  }

  const res = await modelFetch(`${config.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "system", content: `${UNTRUSTED_DATA_POLICY}\n\n${opts.systemPrompt}` }, ...opts.messages],
      max_tokens: opts.maxTokens ?? 30000,
      temperature: opts.temperature ?? 0.83,
      stream: true,
      ...(opts.tools ? { tools: opts.tools } : {}),
    }),
    signal: opts.signal,
  });

  if (!res.ok) throw new Error(`API ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No body");
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") break;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta;
        // 推理过程 (step-3.7-flash 放在 delta.reasoning)
        const reasoning = delta?.reasoning || "";
        if (reasoning) {
          onReasoning?.(reasoning);
        }
        // 正文 token
        const content = delta?.content || "";
        if (content) {
          full += content;
          onChunk(content);
        }
      } catch {
        /* skip */
      }
    }
  }

  return full;
}

/**
 * 带 tool calling 的循环调用。
 * 发送消息 + tools → 模型返回 tool_calls → 执行工具 → 结果追加到消息 →
 * 继续调用直到模型返回纯文本。
 *
 * onToolCall: 每次工具执行时回调，用于流式通知前端
 */
export async function gatewayToolLoop(
  opts: GatewayOptions,
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  onToolCall?: (name: string, args: Record<string, unknown>, result: string) => void,
): Promise<string> {
  const release = acquireChannelSlot(opts.channel);
  try {
    const config = resolveChannelConfig(opts.channel);
    if (!config.apiKey) {
      throw new Error(`未配置${config.scope === "creationTool" ? "功能区" : "会话写作区"} API Key`);
    }

    const messages: Array<{ role: string; content: MessageContent; tool_call_id?: string; tool_calls?: unknown[] }> = [
      { role: "system", content: `${UNTRUSTED_DATA_POLICY}\n\n${opts.systemPrompt}` },
      ...opts.messages,
    ];

    for (let loop = 0; loop < 10; loop++) {
      const res = await modelFetch(`${config.apiBase}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: opts.maxTokens ?? 30000,
          temperature: opts.temperature ?? 0.83,
          tools: opts.tools,
        }),
        signal: opts.signal,
      });

      if (!res.ok) throw new Error(`[${opts.channel}] API ${res.status}`);

      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
          finish_reason?: string;
        }>;
      };

      const choice = json.choices?.[0];
      if (!choice) throw new Error("No response from model");

      const msg = choice.message;
      if (!msg) throw new Error("No message in response");

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });

        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            /* */
          }
          const result = await executeTool(tc.function.name, args);
          onToolCall?.(tc.function.name, args, result);
          messages.push({ role: "tool", content: result, tool_call_id: tc.id });
        }
        continue;
      }

      return msg.content || "";
    }

    throw new Error("Tool loop exceeded max iterations");
  } finally {
    release();
  }
}
