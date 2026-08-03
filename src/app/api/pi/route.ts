import { createPiSseStream } from "@/lib/pi/harness/transport";
import { authorizeSourceRequest, sourceRequestErrorResponse } from "@/lib/pi/source-request-auth";
import { abortSourcePi, promptSourcePi, readSourcePiRun } from "@/lib/pi/source-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

/** The default Pi endpoint is the coding-agent runtime. */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { message?: string };
  const message = body.message?.trim();
  if (!message) return Response.json({ success: false, error: "缺少 message" }, { status: 400 });
  let auth: Awaited<ReturnType<typeof authorizeSourceRequest>>;
  try {
    auth = await authorizeSourceRequest(request);
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }

  const stream = createPiSseStream({
    prompt: (emit) => promptSourcePi(auth.workspaceId, auth.novelId, message, emit),
    abort: () => abortSourcePi(auth.workspaceId, auth.novelId),
    errorMessage: "Pi 运行失败",
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
