import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { type HarnessEventInput, type HarnessSnapshot, PiHarnessEventStore } from "./event-store";
import { normalizeHarnessPrompt, PiHarnessResourceScheduler } from "./policy";
import { PiHarnessResourceLeaseManager } from "./resource-lease";
import { randomUUID } from "node:crypto";

export type { HarnessSnapshot } from "./event-store";

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

export interface HarnessEventRecord {
  sequence: number;
  runId: string;
  occurredAt: string;
  event: unknown;
}

interface PiHarnessCoordinatorOptions {
  journal?: PiHarnessEventStore;
  scheduler?: PiHarnessResourceScheduler;
  leaseManager?: PiHarnessResourceLeaseManager;
}

type HarnessAgentEventHandler<TEvent> = (event: TEvent, run: Readonly<HarnessRun>) => void;
type HarnessRunHandler = (run: Readonly<HarnessRun>) => void;

/**
 * Owns process-local Pi sessions and the lifecycle of one prompt execution.
 *
 * Persistence of the Pi transcript remains delegated to SessionManager. The
 * event journal is deliberately bounded and local, while this layer keeps enough
 * correlated output to recover a dropped SSE connection.
 */
export class PiHarnessCoordinator {
  private readonly journal?: PiHarnessEventStore;
  private readonly scheduler: PiHarnessResourceScheduler;
  private readonly leaseManager: PiHarnessResourceLeaseManager;
  private readonly sessions = new Map<string, Promise<HarnessSessionEntry>>();
  private readonly activeSessions = new Map<string, Promise<HarnessSessionEntry>>();
  private readonly runs = new Map<string, HarnessRun>();
  private readonly activeRuns = new Map<string, string>();
  private readonly events = new Map<string, HarnessEventRecord[]>();
  private readonly pendingEvents = new Map<string, HarnessEventInput[]>();
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly eventTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runAborts = new Map<string, AbortController>();

  constructor(options: PiHarnessCoordinatorOptions = {}) {
    this.journal = options.journal;
    this.scheduler = options.scheduler ?? new PiHarnessResourceScheduler();
    this.leaseManager = options.leaseManager ?? new PiHarnessResourceLeaseManager();
  }

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
    resourceKeys?: string[];
    getSession: () => Promise<HarnessSessionEntry>;
    onEvent: HarnessAgentEventHandler<TEvent>;
    onRun?: HarnessRunHandler;
  }): Promise<Readonly<HarnessRun>> {
    const request = normalizeHarnessPrompt(input);
    if (this.activeRuns.has(request.scopeKey)) throw new Error("Pi 正在处理上一项任务");

    const run: HarnessRun = {
      id: randomUUID(),
      scopeKey: request.scopeKey,
      message: request.message,
      status: "queued",
      startedAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    this.activeRuns.set(request.scopeKey, run.id);
    const abortController = new AbortController();
    this.runAborts.set(run.id, abortController);
    this.queueRunSave(request.scopeKey, run);
    let releaseResources: () => void = () => undefined;
    let releaseLease: () => Promise<void> = async () => undefined;

    try {
      input.onRun?.(run);
      releaseResources = await this.scheduler.acquire(request.resourceKeys, abortController.signal);
      releaseLease = await this.leaseManager.acquire(request.resourceKeys, abortController.signal);
      if (run.status === "cancelled") return run;
      const sessionPromise = Promise.resolve().then(input.getSession);
      this.activeSessions.set(request.scopeKey, sessionPromise);
      const entry = await sessionPromise;
      if (entry.session.isStreaming) throw new Error("Pi 正在处理上一项任务");
      run.status = "running";
      this.queueRunSave(request.scopeKey, run);

      const unsubscribe = entry.session.subscribe((event) => input.onEvent(event as TEvent, run));
      try {
        await entry.session.prompt(request.message);
        if ((run.status as HarnessRunStatus) !== "cancelled") run.status = "completed";
        this.queueRunSave(request.scopeKey, run);
      } catch (error) {
        if ((run.status as HarnessRunStatus) !== "cancelled") {
          run.status = "failed";
          run.error = error instanceof Error ? error.message : String(error);
        }
        this.queueRunSave(request.scopeKey, run);
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
      this.queueRunSave(request.scopeKey, run);
      throw error;
    } finally {
      run.finishedAt = new Date().toISOString();
      this.queueRunSave(request.scopeKey, run);
      if (this.activeRuns.get(request.scopeKey) === run.id) this.activeRuns.delete(request.scopeKey);
      if (this.activeSessions.get(request.scopeKey)) this.activeSessions.delete(request.scopeKey);
      this.runAborts.delete(run.id);
      await releaseLease();
      releaseResources();
      await this.flush(request.scopeKey);
      this.pruneRuns();
    }
  }

  async abort(scopeKey: string): Promise<boolean> {
    const runId = this.activeRuns.get(scopeKey);
    if (!runId) return false;

    const run = this.runs.get(runId);
    if (run && (run.status === "queued" || run.status === "running")) {
      run.status = "cancelled";
      this.queueRunSave(scopeKey, run);
    }
    this.runAborts.get(runId)?.abort();
    const pending = this.activeSessions.get(scopeKey) ?? this.sessions.get(scopeKey);
    if (!pending) return true;
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

  recordEvent(scopeKey: string, runId: string, event: unknown): number {
    const current = this.events.get(scopeKey) ?? [];
    const next: HarnessEventRecord = {
      sequence: (current.filter((event) => event.runId === runId).at(-1)?.sequence ?? 0) + 1,
      runId,
      occurredAt: new Date().toISOString(),
      event,
    };
    current.push(next);
    this.events.set(scopeKey, current.slice(-2_000));
    if (!this.journal) return next.sequence;

    const pending = this.pendingEvents.get(scopeKey) ?? [];
    pending.push({ runId, event, occurredAt: next.occurredAt });
    this.pendingEvents.set(scopeKey, pending);
    if (pending.length >= 20) {
      void this.flushEvents(scopeKey);
    } else if (!this.eventTimers.has(scopeKey)) {
      const timer = setTimeout(() => {
        this.eventTimers.delete(scopeKey);
        void this.flushEvents(scopeKey);
      }, 100);
      this.eventTimers.set(scopeKey, timer);
    }
    return next.sequence;
  }

  async readSnapshot(scopeKey: string, runId: string, afterSequence = 0): Promise<HarnessSnapshot> {
    await this.flush(scopeKey);
    const run = this.runs.get(runId);
    if (run && run.scopeKey === scopeKey) {
      return {
        run: { ...run },
        events: (this.events.get(scopeKey) ?? []).filter(
          (event) => event.runId === runId && event.sequence > afterSequence,
        ),
      };
    }
    if (!this.journal) return { events: [] };
    return this.journal.readSnapshot(scopeKey, runId, afterSequence);
  }

  private queueRunSave(scopeKey: string, run: HarnessRun): void {
    if (!this.journal) return;
    this.queueWrite(scopeKey, () => this.journal?.saveRun(scopeKey, run));
  }

  private queueWrite(scopeKey: string, operation: () => Promise<void> | undefined): void {
    const previous = this.pendingWrites.get(scopeKey) ?? Promise.resolve();
    const next = previous
      .then(() => operation())
      .catch((error) => console.warn(`[pi-harness] 事件日志写入失败（本次运行继续）: ${String(error)}`));
    this.pendingWrites.set(scopeKey, next);
  }

  private async flushEvents(scopeKey: string): Promise<void> {
    if (!this.journal) return;
    const pending = this.pendingEvents.get(scopeKey);
    if (!pending?.length) return;
    this.pendingEvents.delete(scopeKey);
    this.queueWrite(scopeKey, () => this.journal?.appendEvents(scopeKey, pending));
  }

  private async flush(scopeKey: string): Promise<void> {
    const timer = this.eventTimers.get(scopeKey);
    if (timer) {
      clearTimeout(timer);
      this.eventTimers.delete(scopeKey);
    }
    await this.flushEvents(scopeKey);
    const pending = this.pendingWrites.get(scopeKey);
    if (pending) await pending;
    if (this.pendingEvents.has(scopeKey)) await this.flush(scopeKey);
    if (!this.activeRuns.has(scopeKey) && !this.pendingEvents.has(scopeKey)) this.pendingWrites.delete(scopeKey);
  }

  private pruneRuns(): void {
    if (this.runs.size > 200) {
      for (const [runId, run] of this.runs) {
        if (this.runs.size <= 150) break;
        if (!this.activeRuns.has(run.scopeKey)) this.runs.delete(runId);
      }
    }
    if (this.events.size <= 200) return;
    for (const scopeKey of this.events.keys()) {
      if (this.events.size <= 150) break;
      if (!this.activeRuns.has(scopeKey)) this.events.delete(scopeKey);
    }
  }
}

const globalForPiHarness = globalThis as typeof globalThis & {
  __withyouPiHarness?: PiHarnessCoordinator;
};

export const piHarness =
  globalForPiHarness.__withyouPiHarness ?? new PiHarnessCoordinator({ journal: new PiHarnessEventStore() });
globalForPiHarness.__withyouPiHarness = piHarness;
