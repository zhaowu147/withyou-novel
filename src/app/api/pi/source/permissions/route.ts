import { getSourceAccessStatus, lockSourceAccess, unlockSourceAccess } from "@/lib/pi/source-permissions";
import { authorizeSourceRequest, sourceRequestErrorResponse } from "@/lib/pi/source-request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    return Response.json({ success: true, data: getSourceAccessStatus(auth.workspaceId, auth.grantToken) });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    const body = (await request.json()) as { confirmation?: string; durationMinutes?: number };
    const unlocked = unlockSourceAccess(body.confirmation ?? "", auth.workspaceId, body.durationMinutes);
    return Response.json({ success: true, data: { ...unlocked.status, grantToken: unlocked.grantToken } });
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "无法解锁源码权限" },
      { status: 403 },
    );
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    return Response.json({ success: true, data: lockSourceAccess(auth.workspaceId, auth.grantToken) });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}
