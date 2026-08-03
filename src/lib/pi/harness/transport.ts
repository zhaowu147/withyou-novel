import "server-only";

import type { PiRuntimeEvent } from "../runtime";
import type { HarnessRun } from "./coordinator";

export interface PiSseTransportOptions {
  prompt: (emit: (event: PiRuntimeEvent) => void) => Promise<Readonly<HarnessRun>>;
  abort: () => Promise<void>;
  errorMessage: string;
}

function encodeEvent(event: PiRuntimeEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** Shared server transport for both Pi routes. Auth remains owned by each route. */
export function createPiSseStream(options: PiSseTransportOptions): ReadableStream<Uint8Array> {
  let closed = false;
  let terminalSent = false;
  let currentRunId: string | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: PiRuntimeEvent): void => {
        if (closed || terminalSent) return;
        if (event.runId) currentRunId = event.runId;
        if (event.type === "done" || event.type === "error") terminalSent = true;
        try {
          controller.enqueue(encodeEvent(event));
        } catch {
          closed = true;
        }
      };

      void options
        .prompt(send)
        .then((run) => {
          if (!terminalSent) send({ type: "done", runId: run.id });
        })
        .catch((error: unknown) => {
          if (!closed) {
            send({
              type: "error",
              runId: currentRunId,
              text: error instanceof Error ? error.message : options.errorMessage,
            });
          }
        })
        .finally(() => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // The client may have cancelled between the last enqueue and close.
          }
        });
    },
    async cancel() {
      if (closed) return;
      closed = true;
      await options.abort();
    },
  });
}
