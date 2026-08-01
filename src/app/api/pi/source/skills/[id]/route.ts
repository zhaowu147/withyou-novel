import { setSourceSkillEnabled, uninstallSourceSkill } from "@/lib/pi/source-skill-manager";
import { validateSourceGrant } from "@/lib/pi/source-permissions";
import { authorizeSourceRequest, sourceRequestErrorResponse } from "@/lib/pi/source-request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    validateSourceGrant(auth.workspaceId, auth.grantToken);
    const body = (await request.json()) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return Response.json({ success: false, error: "缺少 enabled" }, { status: 400 });
    const { id } = await params;
    return Response.json({ success: true, data: setSourceSkillEnabled(id, body.enabled) });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    validateSourceGrant(auth.workspaceId, auth.grantToken);
    const { id } = await params;
    return Response.json({ success: true, data: uninstallSourceSkill(id) });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}
