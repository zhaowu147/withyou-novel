/**
 * 提示词包 API
 *
 * GET    - 获取提示词包列表
 * POST   - 创建/导入提示词包
 * PATCH  - 更新提示词包
 * DELETE - 删除提示词包
 */

import { type NextRequest, NextResponse } from "next/server";

import type { PromptPackage, PromptPackageScope, ToolId } from "@/lib/prompts/prompt-package";
import { generatePackageId, getBuiltinPackages } from "@/lib/prompts/prompt-package";
import { deletePackage, listPackages, readPackage, savePackage } from "@/lib/prompts/prompt-store";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

/** GET /api/prompts?novel_id=xxx&scope=tool&toolId=outline */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const novelId = searchParams.get("novel_id");
  const scope = searchParams.get("scope") as PromptPackageScope | null;
  const toolId = searchParams.get("toolId") as ToolId | null;
  const packageId = searchParams.get("package_id");
  if (novelId) {
    const denied = verifyWorkspaceRequest(req, novelId);
    if (denied) return denied;
  }

  // 获取单个包
  if (packageId) {
    if (!novelId) {
      const builtin = getBuiltinPackages().find((pkg) => pkg.id === packageId);
      return builtin
        ? NextResponse.json({ package: builtin })
        : NextResponse.json({ error: "Package not found" }, { status: 404 });
    }
    const pkg = readPackage(novelId, packageId);
    if (!pkg) {
      return NextResponse.json({ error: "Package not found" }, { status: 404 });
    }
    return NextResponse.json({ package: pkg });
  }

  // 获取列表
  let packages = novelId
    ? listPackages(novelId, scope ?? undefined)
    : getBuiltinPackages().filter((pkg) => !scope || pkg.scope === scope);

  // 按工具过滤
  if (toolId) {
    packages = packages.filter((p) => p.scope === "tool" && p.toolId === toolId);
  }

  return NextResponse.json({ packages });
}

/** POST /api/prompts */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { novel_id, ...pkgData } = body;

  if (!novel_id) {
    return NextResponse.json({ error: "novel_id required" }, { status: 400 });
  }
  const denied = verifyWorkspaceRequest(req, novel_id);
  if (denied) return denied;

  if (!pkgData.name || !pkgData.scope || !pkgData.systemPrompt) {
    return NextResponse.json({ error: "name, scope, systemPrompt required" }, { status: 400 });
  }

  const pkg: PromptPackage = {
    id: pkgData.id || generatePackageId(),
    name: pkgData.name,
    description: pkgData.description || "",
    scope: pkgData.scope,
    toolId: pkgData.toolId,
    systemPrompt: pkgData.systemPrompt,
    variables: pkgData.variables,
    author: pkgData.author,
    version: pkgData.version || "1.0.0",
    builtin: false,
  };

  const saved = savePackage(novel_id, pkg);
  return NextResponse.json({ package: saved });
}

/** PATCH /api/prompts */
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { novel_id, id, ...updates } = body;

  if (!novel_id || !id) {
    return NextResponse.json({ error: "novel_id and id required" }, { status: 400 });
  }
  const denied = verifyWorkspaceRequest(req, novel_id);
  if (denied) return denied;

  const existing = readPackage(novel_id, id);
  if (!existing) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }

  if (existing.builtin) {
    return NextResponse.json({ error: "Cannot modify builtin package" }, { status: 403 });
  }

  const updated: PromptPackage = {
    ...existing,
    ...updates,
    id, // 不允许修改ID
    updatedAt: new Date().toISOString(),
  };

  const saved = savePackage(novel_id, updated);
  return NextResponse.json({ package: saved });
}

/** DELETE /api/prompts */
export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { novel_id, id } = body;

  if (!novel_id || !id) {
    return NextResponse.json({ error: "novel_id and id required" }, { status: 400 });
  }
  const denied = verifyWorkspaceRequest(req, novel_id);
  if (denied) return denied;

  const existing = readPackage(novel_id, id);
  if (!existing) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }

  if (existing.builtin) {
    return NextResponse.json({ error: "Cannot delete builtin package" }, { status: 403 });
  }

  deletePackage(novel_id, id);
  return NextResponse.json({ success: true });
}
