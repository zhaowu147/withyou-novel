import { decidePiProposal, listPiProposals } from "@/lib/pi/proposal-store";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const novelId = new URL(request.url).searchParams.get("novelId");
  if (!novelId) {
    return Response.json({ success: false, error: "缺少 novelId" }, { status: 400 });
  }
  try {
    const credentials = workspaceCredentials(request);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelId);
    return Response.json({
      success: true,
      data: listPiProposals(novelId).filter(
        (proposal) => !proposal.workspaceId || proposal.workspaceId === credentials.workspaceId,
      ),
    });
  } catch (error) {
    return workspaceErrorResponse(error) ?? Response.json({ success: false, error: "工作区校验失败" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as {
      novelId?: string;
      proposalId?: string;
      decision?: "apply" | "reject";
    };
    if (!body.novelId || !body.proposalId || !body.decision) {
      return Response.json({ success: false, error: "审批参数不完整" }, { status: 400 });
    }
    const credentials = workspaceCredentials(request);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, body.novelId);
    const proposal = decidePiProposal(credentials.workspaceId, body.novelId, body.proposalId, body.decision);
    return Response.json({ success: true, data: proposal });
  } catch (error) {
    const ownershipResponse = workspaceErrorResponse(error);
    if (ownershipResponse) return ownershipResponse;
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "审批失败" },
      { status: 409 },
    );
  }
}
