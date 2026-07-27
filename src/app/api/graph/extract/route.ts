import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { extractKnowledge, mergeExtraction, refreshGraphFromProject, syncGraphFromVault } from "@/lib/graph/extractor";
import { setGraphActiveStage } from "@/lib/graph/store";
import { resolveWorkspaceProjectScope, workspaceErrorResponse } from "@/lib/workspaces/ownership";

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  const body = (await req.json()) as {
    novelId?: string;
    action?: "from-outline" | "from-detailed-outline" | "refresh" | "preview" | "sync";
    text?: string;
    stageId?: string;
  };
  try {
    const { projectId } = resolveWorkspaceProjectScope(req, body.novelId, "story-graph");
    if (body.stageId) await setGraphActiveStage(projectId, body.stageId);
    if (body.action === "sync") {
      return apiSuccess({ graph: await syncGraphFromVault(projectId) });
    }
    if (body.action === "preview") {
      return apiSuccess(await extractKnowledge(projectId, body.text));
    }
    const graph =
      body.action === "from-outline" || body.action === "from-detailed-outline"
        ? await mergeExtraction(projectId, await extractKnowledge(projectId, body.text))
        : await refreshGraphFromProject(projectId, body.text);
    return apiSuccess({ graph, message: "故事图谱已增量更新" });
  } catch (error) {
    const ownershipResponse = workspaceErrorResponse(error);
    if (ownershipResponse) return ownershipResponse;
    console.error("[graph/extract]", error);
    return apiError(error instanceof Error ? error.message : "图谱提取失败", 500);
  }
}
