import { consumeSse } from "../src/lib/ai/sse-client";
import assert from "node:assert/strict";
import test from "node:test";

const encoder = new TextEncoder();

test("SSE 消费器跨分块解析事件并跳过畸形 JSON", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"chu'));
      controller.enqueue(encoder.encode('nk","content":"你"}\n\ndata: not-json\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  const events: Array<Record<string, unknown>> = [];
  await consumeSse(stream, {
    onEvent: (event) => {
      events.push(event);
    },
  });
  assert.deepEqual(events, [{ type: "chunk", content: "你" }, { type: "done" }]);
});

test("SSE 消费器在调用方失效时主动停止旧流", async () => {
  let active = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"chunk","content":"旧"}\n\n'));
      active = false;
      controller.enqueue(encoder.encode('data: {"type":"chunk","content":"不应处理"}\n\n'));
    },
  });
  const events: Array<Record<string, unknown>> = [];
  await consumeSse(stream, {
    isActive: () => active,
    onEvent: (event) => {
      events.push(event);
    },
  });
  assert.deepEqual(events, []);
});

test("SSE 消费器对无数据流进行有界超时并取消读取", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      // 故意保持连接打开，用于验证无数据超时。
    },
  });
  await assert.rejects(consumeSse(stream, { inactivityTimeoutMs: 1_000, onEvent: () => undefined }), /SSE 流超时/);
});
