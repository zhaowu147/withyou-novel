export interface SseClientOptions<T extends Record<string, unknown>> {
  inactivityTimeoutMs?: number;
  signal?: AbortSignal;
  isActive?: () => boolean;
  onEvent: (event: T) => void | Promise<void>;
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`SSE 流超时：${Math.round(timeoutMs / 1_000)} 秒未收到新数据`)),
      timeoutMs,
    );
    if (signal) {
      abortHandler = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

function eventPayload(record: string): string | null {
  const data = record
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  return data && data !== "[DONE]" ? data : null;
}

/**
 * 浏览器端 SSE 的统一消费器。
 * 每次 read 的超时计时器都会在成功、失败和取消时清理，避免长任务累计悬空回调。
 */
export async function consumeSse<T extends Record<string, unknown>>(
  stream: ReadableStream<Uint8Array>,
  options: SseClientOptions<T>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const timeoutMs = Math.max(1_000, options.inactivityTimeoutMs ?? 120_000);
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader, timeoutMs, options.signal);
      if (options.isActive && !options.isActive()) {
        await reader.cancel("stale generation");
        return;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? "";
      for (const record of records) {
        const payload = eventPayload(record);
        if (!payload) continue;
        try {
          await options.onEvent(JSON.parse(payload) as T);
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
    buffer += decoder.decode();
    const payload = eventPayload(buffer);
    if (payload) {
      try {
        await options.onEvent(JSON.parse(payload) as T);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
