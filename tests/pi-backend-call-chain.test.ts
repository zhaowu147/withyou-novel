import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { PiHarnessCoordinator } from "../src/lib/pi/harness/coordinator";
import { PiHarnessEventStore } from "../src/lib/pi/harness/event-store";
import { createPiSseStream } from "../src/lib/pi/harness/transport";
import { resetDataRootCache } from "../src/lib/runtime/app-paths";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

interface TestEvent {
  type: string;
  runId?: string;
  sequence?: number;
  text?: string;
}

function fakeSession(blockPrompt = false) {
  let listener: ((event: unknown) => void) | undefined;
  let releasePrompt: (() => void) | undefined;
  let streaming = false;
  let aborted = false;
  const session = {
    get isStreaming() {
      return streaming;
    },
    subscribe(callback: (event: unknown) => void) {
      listener = callback;
      return () => {
        if (listener === callback) listener = undefined;
      };
    },
    async prompt() {
      streaming = true;
      listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
      if (blockPrompt) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
      streaming = false;
    },
    async abort() {
      aborted = true;
      releasePrompt?.();
      streaming = false;
    },
    dispose() {
      // Fake session cleanup is intentionally a no-op for this transport test.
    },
  } as unknown as AgentSession;
  return {
    session,
    get aborted() {
      return aborted;
    },
    get streaming() {
      return streaming;
    },
  };
}

async function readSse(stream: ReadableStream<Uint8Array>): Promise<TestEvent[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: TestEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
      if (line) events.push(JSON.parse(line.slice(6)) as TestEvent);
    }
  }
  return events;
}

test("Pi backend call chain streams, persists, replays and cancels through the same harness", async () => {
  const previousDataDir = process.env.WITHYOU_DATA_DIR;
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-pi-chain-"));
  fs.mkdirSync(path.join(tempDataDir, ".data"), { recursive: true });
  process.env.WITHYOU_DATA_DIR = tempDataDir;
  resetDataRootCache();
  try {
    const scopeKey = "chain-workspace:chain-novel";
    const entry = fakeSession();
    const coordinator = new PiHarnessCoordinator({ journal: new PiHarnessEventStore() });
    let runId = "";
    const stream = createPiSseStream({
      errorMessage: "Pi 运行失败",
      prompt: (emit) =>
        coordinator.prompt({
          scopeKey,
          resourceKeys: ["workspace:chain-root"],
          message: "检查项目",
          getSession: async () => ({ session: entry.session, fingerprint: "chain-v1" }),
          onRun: (run) => {
            runId = run.id;
            emit({ type: "run_started", runId: run.id });
          },
          onEvent: (_event, run) => {
            const sequence = coordinator.recordEvent(scopeKey, run.id, {
              type: "text",
              runId: run.id,
              text: "已检查",
            });
            emit({ type: "text", runId: run.id, sequence, text: "已检查" });
          },
        }),
      abort: async () => {
        await coordinator.abort(scopeKey);
      },
    });

    const events = await readSse(stream);
    assert.deepEqual(
      events.map((event) => event.type),
      ["run_started", "text", "done"],
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
    assert.equal(events[1]?.runId, runId);
    assert.equal(events[1]?.sequence, 1);

    const snapshot = await coordinator.readSnapshot(scopeKey, runId);
    assert.equal(snapshot.run?.status, "completed");
    assert.equal(snapshot.events.length, 1);
    const persisted = await new PiHarnessEventStore().readSnapshot(scopeKey, runId);
    assert.equal(persisted.run?.status, "completed");
    assert.equal(persisted.events[0]?.sequence, 1);

    const blocked = fakeSession(true);
    const cancelCoordinator = new PiHarnessCoordinator();
    const cancelStream = createPiSseStream({
      errorMessage: "Pi 运行失败",
      prompt: (emit) =>
        cancelCoordinator.prompt({
          scopeKey: "cancel-workspace:novel",
          resourceKeys: ["workspace:cancel-root"],
          message: "长任务",
          getSession: async () => ({ session: blocked.session, fingerprint: "cancel-v1" }),
          onRun: (run) => emit({ type: "run_started", runId: run.id }),
          onEvent: () => undefined,
        }),
      abort: async () => {
        await cancelCoordinator.abort("cancel-workspace:novel");
      },
    });
    const cancelReader = cancelStream.getReader();
    const first = await cancelReader.read();
    assert.equal(first.done, false);
    for (let attempt = 0; attempt < 200 && !blocked.streaming; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(blocked.streaming, true);
    await cancelCoordinator.abort("cancel-workspace:novel");
    await cancelReader.cancel();
    assert.equal(blocked.aborted, true);
    assert.equal(cancelCoordinator.getActiveRun("cancel-workspace:novel"), undefined);
  } finally {
    if (previousDataDir === undefined) delete process.env.WITHYOU_DATA_DIR;
    else process.env.WITHYOU_DATA_DIR = previousDataDir;
    resetDataRootCache();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});
