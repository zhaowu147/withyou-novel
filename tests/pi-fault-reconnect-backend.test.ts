import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { getCodingEnvironmentStatus } from "../src/lib/pi/coding-environment";
import { installPiExecutionBackend, type PiExecutionBackend } from "../src/lib/pi/execution-backend";
import { PiHarnessCoordinator } from "../src/lib/pi/harness/coordinator";
import { PiHarnessEventStore } from "../src/lib/pi/harness/event-store";
import { createPiSseStream } from "../src/lib/pi/harness/transport";
import { resetDataRootCache } from "../src/lib/runtime/app-paths";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

function fakeSession(): AgentSession {
  let listener: ((event: unknown) => void) | undefined;
  const session = {
    get isStreaming() {
      return false;
    },
    subscribe(callback: (event: unknown) => void) {
      listener = callback;
      return () => {
        if (listener === callback) listener = undefined;
      };
    },
    async prompt() {
      listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "完成" } });
    },
    async abort() {
      // Fault acceptance does not need to abort the completed fake session.
    },
    dispose() {
      // Fault acceptance does not need session cleanup.
    },
  } as unknown as AgentSession;
  return session;
}

test("故障注入使 SSE 断开但运行继续，回放可补齐事件并到达终态", async () => {
  const previousDataDir = process.env.WITHYOU_DATA_DIR;
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-pi-fault-reconnect-"));
  fs.mkdirSync(path.join(tempDataDir, ".data"), { recursive: true });
  process.env.WITHYOU_DATA_DIR = tempDataDir;
  resetDataRootCache();
  try {
    const scopeKey = "fault-workspace:fault-novel";
    const coordinator = new PiHarnessCoordinator({ journal: new PiHarnessEventStore() });
    const session = fakeSession();
    let runPromise!: Promise<Readonly<import("../src/lib/pi/harness/coordinator").HarnessRun>>;
    const stream = createPiSseStream({
      errorMessage: "Pi 运行失败",
      prompt: (emit) => {
        runPromise = coordinator.prompt({
          scopeKey,
          resourceKeys: ["workspace:fault-root"],
          message: "执行故障恢复演练",
          getSession: async () => ({ session, fingerprint: "fault-v1" }),
          onRun: (run) => emit({ type: "run_started", runId: run.id }),
          onEvent: (_event, run) => {
            const sequence = coordinator.recordEvent(scopeKey, run.id, {
              type: "text",
              runId: run.id,
              text: "完成",
            });
            emit({ type: "text", runId: run.id, sequence, text: "完成" });
          },
        });
        return runPromise;
      },
      abort: async () => {
        await coordinator.abort(scopeKey);
      },
      faultInjector: (event) => (event.type === "text" ? "drop" : undefined),
    });

    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await assert.rejects(reader.read(), /注入的 SSE 断线/);
    const run = await runPromise;
    assert.equal(run.status, "completed");

    const replay = await coordinator.readSnapshot(scopeKey, run.id);
    assert.equal(replay.run?.status, "completed");
    assert.deepEqual(
      replay.events.map((event) => event.sequence),
      [1],
    );
    assert.deepEqual(replay.events[0]?.event, { type: "text", runId: run.id, text: "完成" });
    assert.equal((await coordinator.readSnapshot(scopeKey, run.id, 1)).events.length, 0);
  } finally {
    if (previousDataDir === undefined) delete process.env.WITHYOU_DATA_DIR;
    else process.env.WITHYOU_DATA_DIR = previousDataDir;
    resetDataRootCache();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

test("故障注入错误会转成单个可读 SSE error 终态", async () => {
  const runId = "fault-run";
  const stream = createPiSseStream({
    errorMessage: "默认错误",
    prompt: async (emit) => {
      emit({ type: "run_started", runId });
      emit({ type: "text", runId, text: "即将失败" });
      return {
        id: runId,
        scopeKey: "fault",
        message: "故障",
        status: "completed",
        startedAt: new Date().toISOString(),
      };
    },
    abort: async () => {
      // The stream never reaches an active session in this transport-only case.
    },
    faultInjector: (event) => (event.type === "text" ? "error" : undefined),
  });
  const reader = stream.getReader();
  const events: Array<{ type?: string; text?: string }> = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const frame = new TextDecoder().decode(result.value);
    events.push(JSON.parse(frame.replace(/^data: /, "").trim()) as { type?: string; text?: string });
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ["run_started", "error"],
  );
  assert.match(events[1]?.text ?? "", /注入的 SSE 传输故障/);
});

test("PiExecutionBackend 可替换环境探测而不触碰真实进程", () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const backend: PiExecutionBackend = {
    spawn: () => {
      throw new Error("测试后端未预期调用异步进程");
    },
    spawnSync: (command, args) => {
      calls.push({ command, args });
      const stdout =
        command === "where.exe" ? "C:\\fake\\tool.exe" : command === "python.exe" ? "Python 3.12.0" : "v22.0.0";
      return {
        pid: 1,
        output: [stdout, ""],
        stdout,
        stderr: "",
        status: 0,
        signal: null,
        error: undefined,
      } as ReturnType<NonNullable<PiExecutionBackend["spawnSync"]>>;
    },
  };
  const restore = installPiExecutionBackend(backend);
  try {
    const status = getCodingEnvironmentStatus(os.tmpdir());
    assert.equal(status.ready, true);
    assert.ok(calls.some((call) => call.command === "where.exe" || call.command === "which"));
    assert.ok(calls.some((call) => call.args.includes("--version")));
  } finally {
    restore();
  }
});
