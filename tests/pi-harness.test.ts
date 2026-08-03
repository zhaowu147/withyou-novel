import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { PiHarnessCoordinator } from "../src/lib/pi/harness/coordinator";
import { PiHarnessEventStore } from "../src/lib/pi/harness/event-store";
import { normalizeHarnessPrompt, PiHarnessResourceScheduler } from "../src/lib/pi/harness/policy";
import { resetDataRootCache } from "../src/lib/runtime/app-paths";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

function fakeSession(options: { blockPrompt?: boolean } = {}) {
  let listener: ((event: unknown) => void) | undefined;
  let releasePrompt: (() => void) | undefined;
  let disposed = false;
  let aborted = false;
  let streaming = false;

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
      if (options.blockPrompt) {
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
      disposed = true;
    },
  } as unknown as AgentSession;

  return {
    session,
    get disposed() {
      return disposed;
    },
    get aborted() {
      return aborted;
    },
    get streaming() {
      return streaming;
    },
  };
}

test("harness reuses a matching session and replaces stale fingerprints", async () => {
  const harness = new PiHarnessCoordinator();
  const first = fakeSession();
  const second = fakeSession();
  let factoryCalls = 0;

  const create = async () => {
    factoryCalls += 1;
    return factoryCalls === 1
      ? { session: first.session, fingerprint: "v1" }
      : { session: second.session, fingerprint: "v2" };
  };

  const reused = await harness.getOrCreateSession("scope", "v1", create);
  assert.equal(await harness.getOrCreateSession("scope", "v1", create), reused);
  assert.equal(factoryCalls, 1);

  const replaced = await harness.getOrCreateSession("scope", "v2", create);
  assert.notEqual(replaced, reused);
  assert.equal(first.disposed, true);
  assert.equal(factoryCalls, 2);
});

test("harness correlates events with a completed run", async () => {
  const harness = new PiHarnessCoordinator();
  const entry = fakeSession();
  const runIds: string[] = [];

  const run = await harness.prompt({
    scopeKey: "scope",
    message: "检查项目",
    getSession: async () => ({ session: entry.session, fingerprint: "v1" }),
    onEvent: (_event, currentRun) => {
      runIds.push(currentRun.id);
      harness.recordEvent("scope", currentRun.id, { type: "text", text: "ok" });
    },
  });

  assert.equal(run.status, "completed");
  assert.equal(runIds.length, 1);
  assert.equal(runIds[0], run.id);
  assert.equal(harness.getActiveRun("scope"), undefined);
  const snapshot = await harness.readSnapshot("scope", run.id);
  assert.equal(snapshot.run?.status, "completed");
  assert.equal(snapshot.events.length, 1);
  assert.deepEqual(snapshot.events[0]?.event, { type: "text", text: "ok" });
  assert.equal((await harness.readSnapshot("scope", run.id, snapshot.events[0]?.sequence ?? 0)).events.length, 0);
});

test("harness rejects a second run and can cancel the active one", async () => {
  const harness = new PiHarnessCoordinator();
  const entry = fakeSession({ blockPrompt: true });
  const input = {
    scopeKey: "scope",
    message: "长任务",
    getSession: async () => ({ session: entry.session, fingerprint: "v1" }),
    onEvent: () => undefined,
  };

  const first = harness.prompt(input);
  for (let attempt = 0; attempt < 20 && !entry.streaming; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(entry.streaming, true);
  await assert.rejects(() => harness.prompt(input), /上一项任务/);
  assert.equal(await harness.abort("scope"), true);
  const result = await first;
  assert.equal(result.status, "cancelled");
  assert.equal(entry.aborted, true);
});

test("harness journal reopens a scoped run and replays events", async () => {
  const previousDataDir = process.env.WITHYOU_DATA_DIR;
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-pi-harness-"));
  fs.mkdirSync(path.join(tempDataDir, ".data"), { recursive: true });
  process.env.WITHYOU_DATA_DIR = tempDataDir;
  resetDataRootCache();
  try {
    const run = {
      id: "persisted-run",
      scopeKey: "persisted-scope",
      message: "读取项目",
      status: "completed" as const,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const firstStore = new PiHarnessEventStore();
    await firstStore.saveRun(run.scopeKey, run);
    await firstStore.appendEvents(run.scopeKey, [{ runId: run.id, event: { type: "text", text: "已读取" } }]);

    const reopened = await new PiHarnessEventStore().readSnapshot(run.scopeKey, run.id);
    assert.equal(reopened.run?.id, run.id);
    assert.deepEqual(reopened.events[0]?.event, { type: "text", text: "已读取" });
  } finally {
    if (previousDataDir === undefined) delete process.env.WITHYOU_DATA_DIR;
    else process.env.WITHYOU_DATA_DIR = previousDataDir;
    resetDataRootCache();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

test("harness policy normalizes scope and queues shared workspace resources", async () => {
  const normalized = normalizeHarnessPrompt({
    scopeKey: " scope ",
    message: " 检查项目 ",
    resourceKeys: ["workspace:repo", "workspace:repo"],
  });
  assert.deepEqual(normalized, {
    scopeKey: "scope",
    message: "检查项目",
    resourceKeys: ["scope", "workspace:repo"],
  });

  const scheduler = new PiHarnessResourceScheduler();
  const releaseFirst = await scheduler.acquire(["workspace:repo"]);
  let secondStarted = false;
  const second = scheduler.acquire(["workspace:repo"]).then((release) => {
    secondStarted = true;
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondStarted, true);
  releaseSecond();
  assert.equal(scheduler.getPendingResourceCount(), 0);
});
