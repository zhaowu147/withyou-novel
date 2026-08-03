import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { randomUUID } from "node:crypto";

export type HarnessRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface HarnessRun {
  id: string;
  scopeKey: string;
  message: string;
  status: HarnessRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface HarnessSessionEntry {
  session: AgentSession;
  fingerprint: string;
}

type HarnessAgentEventHandler<TEvent> = (event: TEvent, run: Readonly<HarnessRun>) => void;

/**
 * Owns process-local Pi sessions and the lifecycle of one prompt execution.
 *
 * Persistence of the Pi transcript remains delegated to SessionManager. This
 * coordinator deliberately keeps the first phase small: durable run events,
 * replay, policy, and resource locks will be layered on top of this boundary.
 */
export class PiHarnessCoordinator {
  private readonly sessions = new Map<string, Promise<HarnessSessionEntry>>();
  private readonly activeSessions = new Map<string, Promise<HarnessSessionEntry>>();
  private readonly runs = new Map<string, HarnessRun>();
  private readonly activeRuns = new Map<string, string>();

  async getOrCreateSession<TEntry extends HarnessSessionEntry>(
    scopeKey: string,
    fingerprint: string,
    create: () => Promise<TEntry>,
  ): Promise<TEntry> {
    const existing = this.sessions.get(scopeKey);
    if (existing) {
      let entry: HarnessSessionEntry;
      try {
        entry = await existing;
      } catch (error) {
        if (this.sessions.get(scopeKey) === existing) this.sessions.delete(scopeKey);
        throw error;
      }
      if (entry.fingerprint === fingerprint) return entry as TEntry;
      entry.session.dispose();
      this.sessions.delete(scopeKey);
    }

    const pending = Promise.resolve().then(create);
    this.sessions.set(scopeKey, pending);
    try {
      return (await pending) as TEntry;
    } catch (error) {
      if (this.sessions.get(scopeKey) === pending) this.sessions.delete(scopeKey);
      throw error;
    }
  }

  async prompt<TEvent>(input: {
    scopeKey: string;
    message: string;
    getSession: () => Promise<HarnessSessionEntry>;
    onEvent: HarnessAgentEventHandler<TEvent>;
  }): Promise<Readonly<HarnessRun>> {
    if (this.activeRuns.has(input.scopeKey)) throw new Error("Pi 正在处理上一项任务");

    const run: HarnessRun = {
      id: randomUUID(),
      scopeKey: input.scopeKey,
      message: input.message,
      status: "queued",
      startedAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    this.activeRuns.set(input.scopeKey, run.id);

    try {
      const sessionPromise = Promise.resolve().then(input.getSession);
      this.activeSessions.set(input.scopeKey, sessionPromise);
      const entry = await sessionPromise;
      if (entry.session.isStreaming) throw new Error("Pi 正在处理上一项任务");
      run.status = "running";

      const unsubscribe = entry.session.subscribe((event) => input.onEvent(event as TEvent, run));
      try {
        await entry.session.prompt(input.message);
        if ((run.status as HarnessRunStatus) !== "cancelled") run.status = "completed";
      } catch (error) {
        if ((run.status as HarnessRunStatus) !== "cancelled") {
          run.status = "failed";
          run.error = error instanceof Error ? error.message : String(error);
        }
        throw error;
      } finally {
        unsubscribe();
      }
      return run;
    } catch (error) {
      if (run.status !== "cancelled" && run.status !== "failed") {
        run.status = "failed";
        run.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      run.finishedAt = new Date().toISOString();
      if (this.activeRuns.get(input.scopeKey) === run.id) this.activeRuns.delete(input.scopeKey);
      if (this.activeSessions.get(input.scopeKey)) this.activeSessions.delete(input.scopeKey);
      this.pruneRuns();
    }
  }

  async abort(scopeKey: string): Promise<boolean> {
    const runId = this.activeRuns.get(scopeKey);
    const pending = this.activeSessions.get(scopeKey) ?? this.sessions.get(scopeKey);
    if (!runId || !pending) return false;

    const run = this.runs.get(runId);
    if (run && (run.status === "queued" || run.status === "running")) run.status = "cancelled";
    const entry = await pending;
    await entry.session.abort();
    return true;
  }

  async abortMatching(prefix: string): Promise<number> {
    const keys = [...this.activeRuns.keys()].filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => this.abort(key)));
    return keys.length;
  }

  getRun(runId: string): Readonly<HarnessRun> | undefined {
    const run = this.runs.get(runId);
    return run ? { ...run } : undefined;
  }

  getActiveRun(scopeKey: string): Readonly<HarnessRun> | undefined {
    const runId = this.activeRuns.get(scopeKey);
    return runId ? this.getRun(runId) : undefined;
  }

  private pruneRuns(): void {
    if (this.runs.size <= 200) return;
    for (const [runId, run] of this.runs) {
      if (this.runs.size <= 150) break;
      if (!this.activeRuns.has(run.scopeKey)) this.runs.delete(runId);
    }
  }
}

const globalForPiHarness = globalThis as typeof globalThis & {
  __withyouPiHarness?: PiHarnessCoordinator;
};

export const piHarness = globalForPiHarness.__withyouPiHarness ?? new PiHarnessCoordinator();
globalForPiHarness.__withyouPiHarness = piHarness;
