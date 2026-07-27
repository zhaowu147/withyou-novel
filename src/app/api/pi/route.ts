import { abortPi, type PiRuntimeEvent, promptPi } from "@/lib/pi/runtime";
import { resolveWorkspaceProjectScope, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encodeEvent(event: PiRuntimeEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    novelId?: string;
    message?: string;
    accessLevel?: "observer" | "project";
  };
  const requestedNovelId = body.novelId?.trim();
  const message = body.message?.trim();
  if (!message) {
    return Response.json({ success: false, error: "缺少 message" }, { status: 400 });
  }
  let workspaceId: string;
  let projectId: string;
  try {
    const credentials = workspaceCredentials(request);
    workspaceId = credentials.workspaceId;
    projectId = resolveWorkspaceProjectScope(request, requestedNovelId, "pi").projectId;
  } catch (error) {
    return workspaceErrorResponse(error) ?? Response.json({ success: false, error: "工作区校验失败" }, { status: 500 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: PiRuntimeEvent) => {
        if (!closed) controller.enqueue(encodeEvent(event));
      };
      void promptPi(workspaceId, projectId, message, send, body.accessLevel === "observer" ? "observer" : "project")
        .then(() => send({ type: "done" }))
        .catch((error: unknown) => {
          send({
            type: "error",
            text: error instanceof Error ? error.message : "Pi 运行失败",
          });
        })
        .finally(() => {
          closed = true;
          controller.close();
        });
    },
    async cancel() {
      await abortPi(workspaceId, projectId);
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
  const url = new URL(request.url);
  const requestedNovelId = url.searchParams.get("novelId");
  try {
    const credentials = workspaceCredentials(request);
    const projectId = resolveWorkspaceProjectScope(request, requestedNovelId, "pi").projectId;
    await abortPi(credentials.workspaceId, projectId);
  } catch (error) {
    return workspaceErrorResponse(error) ?? Response.json({ success: false, error: "工作区校验失败" }, { status: 500 });
  }
  return Response.json({ success: true });
}
