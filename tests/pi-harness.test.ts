import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { PiHarnessCoordinator } from "../src/lib/pi/harness/coordinator";
import assert from "node:assert/strict";
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
    onEvent: (_event, currentRun) => runIds.push(currentRun.id),
  });

  assert.equal(run.status, "completed");
  assert.equal(runIds.length, 1);
  assert.equal(runIds[0], run.id);
  assert.equal(harness.getActiveRun("scope"), undefined);
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
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => harness.prompt(input), /上一项任务/);
  assert.equal(await harness.abort("scope"), true);
  const result = await first;
  assert.equal(result.status, "cancelled");
  assert.equal(entry.aborted, true);
});
