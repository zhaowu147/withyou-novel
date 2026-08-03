export const PI_HARNESS_POLICY_VERSION = 1;
const MAX_SCOPE_KEY = 320;
const MAX_MESSAGE = 120_000;
const MAX_RESOURCE_KEYS = 8;
const MAX_RESOURCE_KEY = 512;

export interface HarnessPromptRequest {
  scopeKey: string;
  message: string;
  resourceKeys?: string[];
}

export interface NormalizedHarnessPrompt {
  scopeKey: string;
  message: string;
  resourceKeys: string[];
}

export function createHarnessAbortError(): Error {
  const error = new Error("Pi 资源等待已取消");
  error.name = "AbortError";
  return error;
}

export function waitForHarnessAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createHarnessAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createHarnessAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function normalizeHarnessPrompt(input: HarnessPromptRequest): NormalizedHarnessPrompt {
  const scopeKey = input.scopeKey.trim();
  if (!scopeKey || scopeKey.length > MAX_SCOPE_KEY || /[\r\n]/.test(scopeKey)) {
    throw new Error("Pi 运行 scope 无效");
  }
  const message = input.message.trim();
  if (!message || message.length > MAX_MESSAGE) throw new Error("Pi 任务为空或超过长度限制");

  const resourceKeys = [...new Set([scopeKey, ...(input.resourceKeys ?? [])].map((key) => key.trim()))].filter(Boolean);
  if (
    resourceKeys.length > MAX_RESOURCE_KEYS ||
    resourceKeys.some((key) => key.length > MAX_RESOURCE_KEY || /[\r\n]/.test(key))
  ) {
    throw new Error("Pi 资源范围无效");
  }
  return { scopeKey, message, resourceKeys };
}

interface ResourceClaim {
  tail: Promise<void>;
  release: () => void;
}

/**
 * Process-local exclusive scheduler for real workspace resources. It queues
 * different scopes that share a workspace, while the existing same-scope
 * guard still rejects duplicate prompts immediately. Git has no separate lock.
 */
export class PiHarnessResourceScheduler {
  private readonly tails = new Map<string, ResourceClaim>();

  async acquire(resourceKeys: string[], signal?: AbortSignal): Promise<() => void> {
    const keys = [...new Set(resourceKeys)].sort();
    if (keys.length === 0) return () => undefined;

    const claims = keys.map((key) => {
      const previous = this.tails.get(key)?.tail ?? Promise.resolve();
      let resolveGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        resolveGate = resolve;
      });
      const tail = previous.then(() => gate);
      const claim: ResourceClaim = { tail, release: resolveGate };
      this.tails.set(key, claim);
      return { key, previous, claim };
    });

    try {
      await waitForHarnessAbort(Promise.all(claims.map(({ previous }) => previous)), signal);
    } catch (error) {
      for (const { key, claim } of claims) {
        if (this.tails.get(key) === claim) {
          claim.release();
          this.tails.delete(key);
        }
      }
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const { key, claim } of claims) {
        claim.release();
        if (this.tails.get(key) === claim) this.tails.delete(key);
      }
    };
  }

  getPendingResourceCount(): number {
    return this.tails.size;
  }
}
