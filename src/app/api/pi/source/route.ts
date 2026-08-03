import type { PiRuntimeEvent } from "@/lib/pi/runtime";
import { authorizeSourceRequest, sourceRequestErrorResponse } from "@/lib/pi/source-request-auth";
import { abortSourcePi, promptSourcePi, readSourcePiRun } from "@/lib/pi/source-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encodeEvent(event: PiRuntimeEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId")?.trim();
    if (!runId || runId.length > 160) return Response.json({ success: false, error: "runId 无效" }, { status: 400 });
    const parsedAfter = Number(url.searchParams.get("after") ?? "0");
    const after = Number.isFinite(parsedAfter) ? Math.max(0, Math.floor(parsedAfter)) : 0;
    const snapshot = await readSourcePiRun(auth.workspaceId, auth.novelId, runId, after);
    if (!snapshot.run) return Response.json({ success: false, error: "运行记录不存在" }, { status: 404 });
    return Response.json({ success: true, run: snapshot.run, events: snapshot.events });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeSourceRequest>>;
  try {
    auth = await authorizeSourceRequest(request);
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
      void promptSourcePi(auth.workspaceId, auth.novelId, message, send)
        .then((run) => send({ type: "done", runId: run.id }))
        .catch((error: unknown) => {
          send({ type: "error", text: error instanceof Error ? error.message : "源码 Pi 运行失败" });
        })
        .finally(() => {
          closed = true;
          controller.close();
        });
    },
    async cancel() {
      await abortSourcePi(auth.workspaceId, auth.novelId);
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
    await abortSourcePi(auth.workspaceId, auth.novelId);
    return Response.json({ success: true });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}
