import "server-only";

import { lock as acquireCrossProcessLock } from "proper-lockfile";

import { readJsonFile, writeJsonFile } from "@/lib/local/json-db";
import { appStateDir } from "@/lib/runtime/app-paths";

import type { HarnessEventRecord, HarnessRun } from "./coordinator";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const STORE_VERSION = 1;
const MAX_RUNS = 100;
const MAX_EVENTS = 2_000;

export interface HarnessEventInput {
  runId: string;
  event: unknown;
  occurredAt?: string;
}

export interface HarnessSnapshot {
  run?: Readonly<HarnessRun>;
  events: HarnessEventRecord[];
}

interface PersistedHarnessState {
  version: number;
  scopeKey: string;
  runs: HarnessRun[];
  events: HarnessEventRecord[];
}

function emptyState(scopeKey: string): PersistedHarnessState {
  return { version: STORE_VERSION, scopeKey, runs: [], events: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeState(scopeKey: string, value: unknown): PersistedHarnessState {
  if (!isObject(value) || value.scopeKey !== scopeKey || value.version !== STORE_VERSION) return emptyState(scopeKey);
  const runs = Array.isArray(value.runs) ? (value.runs.filter(isObject) as unknown as HarnessRun[]) : [];
  const events = Array.isArray(value.events)
    ? (value.events.filter(
        (event): event is Record<string, unknown> =>
          isObject(event) && typeof event.runId === "string" && typeof event.sequence === "number",
      ) as unknown as HarnessEventRecord[])
    : [];
  return {
    version: STORE_VERSION,
    scopeKey,
    runs: runs.slice(-MAX_RUNS),
    events: events.slice(-MAX_EVENTS),
  };
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function statePath(scopeKey: string): string {
  const digest = createHash("sha256").update(scopeKey, "utf8").digest("hex");
  return path.join(appStateDir(), "pi-harness-runs", `${digest}.json`);
}

const fileQueues = new Map<string, Promise<void>>();

async function withStateLock<T>(filePath: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = fileQueues.get(filePath) ?? Promise.resolve();
  const current = previous.then(async () => {
    ensureParent(filePath);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}", "utf8");
    const release = await acquireCrossProcessLock(filePath, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 12, factor: 1.6, minTimeout: 100, maxTimeout: 2_000 },
    });
    try {
      return await operation();
    } finally {
      await release().catch((error) => {
        console.warn(`[pi-harness] 释放事件日志锁失败（可忽略）: ${filePath}`, error);
      });
    }
  });
  fileQueues.set(
    filePath,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

function readState(scopeKey: string, filePath: string): PersistedHarnessState {
  return normalizeState(scopeKey, readJsonFile<unknown>(filePath, emptyState(scopeKey)));
}

export class PiHarnessEventStore {
  async saveRun(scopeKey: string, run: HarnessRun): Promise<void> {
    const filePath = statePath(scopeKey);
    await withStateLock(filePath, () => {
      const state = readState(scopeKey, filePath);
      const index = state.runs.findIndex((current) => current.id === run.id);
      if (index >= 0) state.runs[index] = { ...run };
      else state.runs.push({ ...run });
      state.runs = state.runs.slice(-MAX_RUNS);
      writeJsonFile(filePath, state);
    });
  }

  async appendEvents(scopeKey: string, inputs: HarnessEventInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const filePath = statePath(scopeKey);
    await withStateLock(filePath, () => {
      const state = readState(scopeKey, filePath);
      let sequence = state.events.at(-1)?.sequence ?? 0;
      state.events.push(
        ...inputs.map((input) => ({
          sequence: ++sequence,
          runId: input.runId,
          occurredAt: input.occurredAt ?? new Date().toISOString(),
          event: input.event,
        })),
      );
      state.events = state.events.slice(-MAX_EVENTS);
      writeJsonFile(filePath, state);
    });
  }

  async readSnapshot(scopeKey: string, runId: string, afterSequence = 0): Promise<HarnessSnapshot> {
    const filePath = statePath(scopeKey);
    const state = readState(scopeKey, filePath);
    const run = state.runs.find((candidate) => candidate.id === runId);
    const events = state.events.filter((event) => event.runId === runId && event.sequence > afterSequence);
    return { run, events };
  }
}
