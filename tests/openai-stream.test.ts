import { readOpenAIChatStream } from "../src/lib/ai/openai-stream";
import assert from "node:assert/strict";
import test from "node:test";

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test("parses content across arbitrary SSE chunk boundaries", async () => {
  const message = await readOpenAIChatStream(
    chunkedStream([
      'data: {"choices":[{"delta":{"content":"第"}}]}\n\nda',
      'ta: {"choices":[{"delta":{"content":"二章"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]),
  );
  assert.equal(message.content, "第二章");
  assert.equal(message.finishReason, "stop");
  assert.deepEqual(message.toolCalls, []);
});

test("reassembles streamed tool call names and JSON arguments", async () => {
  const message = await readOpenAIChatStream(
    chunkedStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_context","arguments":"{\\"max"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"_bundle","arguments":"Chars\\":68000}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );
  assert.equal(message.finishReason, "tool_calls");
  assert.deepEqual(message.toolCalls, [
    {
      id: "call-1",
      type: "function",
      function: { name: "read_context_bundle", arguments: '{"maxChars":68000}' },
    },
  ]);
});
