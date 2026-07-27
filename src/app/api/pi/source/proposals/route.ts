import { validateSourceGrant } from "@/lib/pi/source-permissions";
import { decideSourceProposal, listSourceProposals, rollbackSourceProposal } from "@/lib/pi/source-proposal-store";
import { authorizeSourceRequest, sourceRequestErrorResponse } from "@/lib/pi/source-request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    validateSourceGrant(auth.workspaceId, auth.grantToken);
    return Response.json({ success: true, data: listSourceProposals() });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    validateSourceGrant(auth.workspaceId, auth.grantToken);
    const body = (await request.json()) as {
      proposalId?: string;
      decision?: "apply" | "reject" | "rollback";
    };
    if (!body.proposalId || !body.decision) {
      return Response.json({ success: false, error: "审批参数不完整" }, { status: 400 });
    }
    const proposal =
      body.decision === "rollback"
        ? rollbackSourceProposal(body.proposalId)
        : decideSourceProposal(body.proposalId, body.decision);
    return Response.json({ success: true, data: proposal });
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "源码补丁操作失败" },
      { status: 409 },
    );
  }
}
