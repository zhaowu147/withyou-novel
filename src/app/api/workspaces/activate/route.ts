import { activateWorkspace, workspaceErrorResponse } from "@/lib/workspaces/ownership";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as {
      workspaceId?: string;
      novelId?: string | null;
      lease?: string | null;
      recoverLease?: boolean;
    };
    if (!body.workspaceId) {
      return Response.json({ success: false, error: { message: "缺少 workspaceId" } }, { status: 400 });
    }
    return Response.json({
      success: true,
      data: activateWorkspace(body.workspaceId, body.novelId, body.lease, body.recoverLease === true),
    });
  } catch (error) {
    return (
      workspaceErrorResponse(error) ??
      Response.json(
        { success: false, error: { message: error instanceof Error ? error.message : "工作区激活失败" } },
        { status: 500 },
      )
    );
  }
}
