import "server-only";

import { lock as acquireCrossProcessLock } from "proper-lockfile";

import { appStateDir } from "@/lib/runtime/app-paths";

import { createHarnessAbortError, waitForHarnessAbort } from "./policy";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const LEASE_STALE_MS = 60_000;
const LEASE_UPDATE_MS = 20_000;
const RETRY_DELAY_MS = 250;

function leasePath(resourceKey: string): string {
  const digest = createHash("sha256").update(resourceKey, "utf8").digest("hex");
  return path.join(appStateDir(), "pi-harness-leases", `${digest}.resource`);
}

function ensureLeaseFile(target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    try {
      fs.writeFileSync(target, "pi-harness-resource\n", { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
}

function isLocked(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return waitForHarnessAbort(new Promise((resolve) => setTimeout(resolve, ms)), signal);
}

async function acquireOne(target: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  ensureLeaseFile(target);
  while (true) {
    if (signal?.aborted) throw createHarnessAbortError();
    try {
      return await acquireCrossProcessLock(target, {
        realpath: false,
        stale: LEASE_STALE_MS,
        update: LEASE_UPDATE_MS,
        retries: 0,
      });
    } catch (error) {
      if (!isLocked(error)) throw error;
      await delay(RETRY_DELAY_MS, signal);
    }
  }
}

/**
 * Cross-process resource lease for Pi runs. Resource keys are hashed before
 * touching disk, so the lease directory never reflects user-controlled paths.
 * Locks are acquired in sorted order to avoid multi-resource deadlocks and
 * proper-lockfile refreshes long-running leases until the owner exits.
 */
export class PiHarnessResourceLeaseManager {
  async acquire(resourceKeys: string[], signal?: AbortSignal): Promise<() => Promise<void>> {
    const keys = [...new Set(resourceKeys)].sort();
    const releases: Array<() => Promise<void>> = [];
    try {
      for (const key of keys) releases.push(await acquireOne(leasePath(key), signal));
    } catch (error) {
      await this.releaseAll(releases);
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.releaseAll(releases);
    };
  }

  private async releaseAll(releases: Array<() => Promise<void>>): Promise<void> {
    for (const release of [...releases].reverse()) {
      await release().catch((error) => {
        console.warn(`[pi-harness] 释放跨进程资源租约失败（可忽略）: ${String(error)}`);
      });
    }
  }
}
