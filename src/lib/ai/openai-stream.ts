export interface OpenAIStreamToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIStreamMessage {
  content: string;
  toolCalls: OpenAIStreamToolCall[];
  finishReason?: string;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface StreamPayload {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string;
  }>;
}

function dataPayloads(buffer: string): { payloads: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() ?? "";
  const payloads = blocks.flatMap((block) =>
    block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean),
  );
  return { payloads, remainder };
}

/**
 * 解析 OpenAI 兼容 SSE，同时支持正文增量与 tool_calls 参数分片。
 * 解析器只负责协议，不依赖 Next/server-only，便于对断片边界做单元回归。
 */
export async function readOpenAIChatStream(body: ReadableStream<Uint8Array>): Promise<OpenAIStreamMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const tools = new Map<number, OpenAIStreamToolCall>();
  let content = "";
  let finishReason: string | undefined;
  let buffer = "";
  let streamDone = false;

  const applyPayload = (payload: string) => {
    if (payload === "[DONE]") {
      streamDone = true;
      return;
    }
    const parsed = JSON.parse(payload) as StreamPayload;
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (typeof choice.delta?.content === "string") content += choice.delta.content;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    for (const delta of choice.delta?.tool_calls ?? []) {
      const index = Number.isInteger(delta.index) ? (delta.index as number) : tools.size;
      const current = tools.get(index) ?? {
        id: delta.id ?? `tool-call-${index}`,
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.function.name += delta.function.name;
      if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
      tools.set(index, current);
    }
  };

  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = dataPayloads(buffer);
    buffer = parsed.remainder;
    for (const payload of parsed.payloads) {
      applyPayload(payload);
      if (streamDone) break;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = dataPayloads(`${buffer}\n\n`);
    for (const payload of parsed.payloads) {
      applyPayload(payload);
      if (streamDone) break;
    }
  }

  return {
    content,
    toolCalls: [...tools.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, tool]) => tool)
      .filter((tool) => Boolean(tool.function.name)),
    finishReason,
  };
}
