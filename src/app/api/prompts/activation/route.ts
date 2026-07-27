/**
 * 提示词包激活状态 API
 *
 * GET    - 获取激活状态
 * POST   - 激活提示词包
 * DELETE - 停用提示词包
 */

import { type NextRequest, NextResponse } from "next/server";

import type { PromptPackageScope, ToolId } from "@/lib/prompts/prompt-package";
import {
  activateCoverPackage,
  activateToolPackage,
  activateWriterPackage,
  deactivateCoverPackage,
  deactivateToolPackage,
  deactivateWriterPackage,
  getActivatedPackages,
  readPackage,
} from "@/lib/prompts/prompt-store";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

/** GET /api/prompts/activation?novel_id=xxx */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const novelId = searchParams.get("novel_id");

  if (!novelId) {
    return NextResponse.json({ error: "novel_id required" }, { status: 400 });
  }
  const denied = verifyWorkspaceRequest(req, novelId);
  if (denied) return denied;

  const activated = getActivatedPackages(novelId);
  return NextResponse.json(activated);
}

/** POST /api/prompts/activation */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { novel_id, scope, toolId, package_id } = body;

  if (!novel_id || !scope || !package_id) {
    return NextResponse.json({ error: "novel_id, scope, package_id required" }, { status: 400 });
  }
  const denied = verifyWorkspaceRequest(req, novel_id);
  if (denied) return denied;

  const pkg = readPackage(novel_id, package_id);
  if (!pkg) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }
  if (pkg.scope !== scope) {
    return NextResponse.json({ error: "Package scope mismatch" }, { status: 400 });
  }

  switch (scope as PromptPackageScope) {
    case "tool":
      if (!toolId) {
        return NextResponse.json({ error: "toolId required for tool scope" }, { status: 400 });
      }
      if (pkg.toolId !== toolId) {
        return NextResponse.json({ error: "Package tool mismatch" }, { status: 400 });
      }
      activateToolPackage(novel_id, toolId as ToolId, package_id);
      break;
    case "writer":
      activateWriterPackage(novel_id, package_id);
      break;
    case "cover":
      activateCoverPackage(novel_id, package_id);
      break;
    default:
      return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}

/** DELETE /api/prompts/activation */
export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { novel_id, scope, toolId } = body;

  if (!novel_id || !scope) {
    return NextResponse.json({ error: "novel_id and scope required" }, { status: 400 });
  }
  const denied = verifyWorkspaceRequest(req, novel_id);
  if (denied) return denied;

  switch (scope as PromptPackageScope) {
    case "tool":
      if (!toolId) {
        return NextResponse.json({ error: "toolId required for tool scope" }, { status: 400 });
      }
      deactivateToolPackage(novel_id, toolId as ToolId);
      break;
    case "writer":
      deactivateWriterPackage(novel_id);
      break;
    case "cover":
      deactivateCoverPackage(novel_id);
      break;
    default:
      return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
