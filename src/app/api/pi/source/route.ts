import type { PiRuntimeEvent } from "@/lib/pi/runtime";
import { validateSourceGrant } from "@/lib/pi/source-permissions";
import { authorizeSourceRequest, sourceRequestErrorResponse } from "@/lib/pi/source-request-auth";
import { abortSourcePi, promptSourcePi } from "@/lib/pi/source-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encodeEvent(event: PiRuntimeEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeSourceRequest>>;
  try {
    auth = await authorizeSourceRequest(request);
    validateSourceGrant(auth.workspaceId, auth.grantToken);
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
  const body = (await request.json()) as { message?: string };
  const message = body.message?.trim();
  if (!message) {
    return Response.json({ success: false, error: "缺少 message" }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: PiRuntimeEvent) => {
        if (!closed) controller.enqueue(encodeEvent(event));
      };
      void promptSourcePi(message, send)
        .then(() => send({ type: "done" }))
        .catch((error: unknown) => {
          send({ type: "error", text: error instanceof Error ? error.message : "源码 Pi 运行失败" });
        })
        .finally(() => {
          closed = true;
          controller.close();
        });
    },
    async cancel() {
      await abortSourcePi();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    validateSourceGrant(auth.workspaceId, auth.grantToken);
    await abortSourcePi();
    return Response.json({ success: true });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}
