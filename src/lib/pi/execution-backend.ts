import "server-only";

import type { ChildProcess, SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";

export interface PiExecutionBackend {
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  spawnSync(command: string, args: readonly string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
}

/** The default backend keeps the current local process behavior unchanged. */
export const systemPiExecutionBackend: PiExecutionBackend = {
  spawn: (command, args, options) => spawn(command, [...args], options),
  spawnSync: (command, args, options) => spawnSync(command, [...args], options),
};

const globalForPiExecution = globalThis as typeof globalThis & {
  __withyouPiExecutionBackend?: PiExecutionBackend;
};

export function getPiExecutionBackend(): PiExecutionBackend {
  return globalForPiExecution.__withyouPiExecutionBackend ?? systemPiExecutionBackend;
}

/**
 * Replace process execution for an embedding host or deterministic acceptance
 * test. The returned function restores the previous backend.
 */
export function installPiExecutionBackend(backend: PiExecutionBackend): () => void {
  const previous = globalForPiExecution.__withyouPiExecutionBackend;
  globalForPiExecution.__withyouPiExecutionBackend = backend;
  return () => {
    if (previous) globalForPiExecution.__withyouPiExecutionBackend = previous;
    else delete globalForPiExecution.__withyouPiExecutionBackend;
  };
}
