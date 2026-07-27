import "server-only";

import { sanitizeNovelId } from "@/lib/local/paths";
import { appStateDir } from "@/lib/runtime/app-paths";

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface WorkspaceBinding {
  workspaceId: string;
  novelId: string | null;
  leaseHash: string;
  createdAt: string;
  updatedAt: string;
  recoveredAt?: string;
}

interface WorkspaceRegistry {
  version: 1;
  bindings: WorkspaceBinding[];
}

export class WorkspaceOwnershipError extends Error {
  readonly code:
    | "WORKSPACE_REQUIRED"
    | "WORKSPACE_NOT_FOUND"
    | "WORKSPACE_LEASE_INVALID"
    | "WORKSPACE_NOVEL_MISMATCH"
    | "NOVEL_ALREADY_BOUND";

  constructor(code: WorkspaceOwnershipError["code"], message: string) {
    super(message);
    this.name = "WorkspaceOwnershipError";
    this.code = code;
  }
}

function registryPath(): string {
  return path.join(appStateDir(), "workspace-bindings.json");
}

function emptyRegistry(): WorkspaceRegistry {
  return { version: 1, bindings: [] };
}

function readRegistry(): WorkspaceRegistry {
  const file = registryPath();
  try {
    if (!fs.existsSync(file)) return emptyRegistry();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as WorkspaceRegistry;
    if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) return emptyRegistry();
    return parsed;
  } catch {
    const recovery = `${file}.bak`;
    if (!fs.existsSync(recovery)) return emptyRegistry();
    const parsed = JSON.parse(fs.readFileSync(recovery, "utf8")) as WorkspaceRegistry;
    return parsed.version === 1 && Array.isArray(parsed.bindings) ? parsed : emptyRegistry();
  }
}

function writeRegistry(registry: WorkspaceRegistry): void {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak`);
  }
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(registry, null, 2), "utf8");
  fs.renameSync(temp, file);
}

function normalizeWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(normalized)) {
    throw new WorkspaceOwnershipError("WORKSPACE_REQUIRED", "无效的工作区标识");
  }
  return normalized;
}

function hashLease(lease: string): string {
  return createHash("sha256").update(lease, "utf8").digest("hex");
}

function issueLease(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashLease(raw) };
}

export function activateWorkspace(
  workspaceIdInput: string,
  novelIdInput?: string | null,
  leaseInput?: string | null,
  allowLeaseRecovery = false,
): { workspaceId: string; novelId: string | null; lease: string } {
  const workspaceId = normalizeWorkspaceId(workspaceIdInput);
  const novelId = novelIdInput ? sanitizeNovelId(novelIdInput) : null;
  const registry = readRegistry();
  const existing = registry.bindings.find((item) => item.workspaceId === workspaceId);

  if (existing) {
    if (leaseInput && hashLease(leaseInput) !== existing.leaseHash && !allowLeaseRecovery) {
      throw new WorkspaceOwnershipError("WORKSPACE_LEASE_INVALID", "工作区凭证不匹配，已停止加载以避免记忆串线");
    }
    if (existing.novelId && novelId && existing.novelId !== novelId) {
      throw new WorkspaceOwnershipError(
        "WORKSPACE_NOVEL_MISMATCH",
        `该会话已绑定作品 ${existing.novelId}，拒绝自动改绑到 ${novelId}`,
      );
    }
    const owner = novelId
      ? registry.bindings.find((item) => item.novelId === novelId && item.workspaceId !== workspaceId)
      : undefined;
    if (owner) {
      throw new WorkspaceOwnershipError("NOVEL_ALREADY_BOUND", "该作品已属于另一个会话，已阻止共享记忆");
    }
    const nextLease = issueLease();
    existing.novelId = existing.novelId ?? novelId;
    existing.leaseHash = nextLease.hash;
    existing.updatedAt = new Date().toISOString();
    if (allowLeaseRecovery) existing.recoveredAt = existing.updatedAt;
    writeRegistry(registry);
    return { workspaceId, novelId: existing.novelId, lease: nextLease.raw };
  }

  const owner = novelId ? registry.bindings.find((item) => item.novelId === novelId) : undefined;
  if (owner) {
    throw new WorkspaceOwnershipError("NOVEL_ALREADY_BOUND", "该作品已属于另一个会话，已阻止共享记忆");
  }

  const now = new Date().toISOString();
  const nextLease = issueLease();
  registry.bindings.push({
    workspaceId,
    novelId,
    leaseHash: nextLease.hash,
    createdAt: now,
    updatedAt: now,
  });
  writeRegistry(registry);
  return { workspaceId, novelId, lease: nextLease.raw };
}

export function bindWorkspaceNovel(workspaceIdInput: string, lease: string, novelIdInput: string): WorkspaceBinding {
  const workspaceId = normalizeWorkspaceId(workspaceIdInput);
  const novelId = sanitizeNovelId(novelIdInput);
  const registry = readRegistry();
  const binding = registry.bindings.find((item) => item.workspaceId === workspaceId);
  if (!binding) throw new WorkspaceOwnershipError("WORKSPACE_NOT_FOUND", "工作区尚未在服务端登记");
  if (hashLease(lease) !== binding.leaseHash) {
    throw new WorkspaceOwnershipError("WORKSPACE_LEASE_INVALID", "工作区凭证已失效");
  }
  if (binding.novelId && binding.novelId !== novelId) {
    throw new WorkspaceOwnershipError("WORKSPACE_NOVEL_MISMATCH", "该会话已经绑定其他作品");
  }
  const owner = registry.bindings.find((item) => item.novelId === novelId && item.workspaceId !== workspaceId);
  if (owner) throw new WorkspaceOwnershipError("NOVEL_ALREADY_BOUND", "该作品已经绑定其他会话");
  binding.novelId = novelId;
  binding.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return binding;
}

export function verifyWorkspaceAccess(workspaceIdInput: string, lease: string, novelIdInput: string): void {
  const workspaceId = normalizeWorkspaceId(workspaceIdInput);
  const novelId = sanitizeNovelId(novelIdInput);
  const binding = readRegistry().bindings.find((item) => item.workspaceId === workspaceId);
  if (!binding) throw new WorkspaceOwnershipError("WORKSPACE_NOT_FOUND", "工作区不存在或尚未激活");
  if (hashLease(lease) !== binding.leaseHash) {
    throw new WorkspaceOwnershipError("WORKSPACE_LEASE_INVALID", "工作区凭证已失效，拒绝访问项目数据");
  }
  if (binding.novelId !== novelId) {
    throw new WorkspaceOwnershipError("WORKSPACE_NOVEL_MISMATCH", "请求作品不属于当前会话，已阻止访问");
  }
}

export function verifyWorkspaceLease(workspaceIdInput: string, lease: string): WorkspaceBinding {
  const workspaceId = normalizeWorkspaceId(workspaceIdInput);
  const binding = readRegistry().bindings.find((item) => item.workspaceId === workspaceId);
  if (!binding) throw new WorkspaceOwnershipError("WORKSPACE_NOT_FOUND", "工作区不存在或尚未激活");
  if (hashLease(lease) !== binding.leaseHash) {
    throw new WorkspaceOwnershipError("WORKSPACE_LEASE_INVALID", "工作区凭证已失效");
  }
  return binding;
}

export function workspaceCredentials(request: Request): { workspaceId: string; lease: string } {
  const workspaceId = request.headers.get("x-withyou-workspace-id")?.trim() ?? "";
  const lease = request.headers.get("x-withyou-workspace-lease")?.trim() ?? "";
  if (!workspaceId || !lease) {
    throw new WorkspaceOwnershipError("WORKSPACE_REQUIRED", "缺少工作区凭证，已拒绝项目访问");
  }
  return { workspaceId, lease };
}

export function workspaceErrorResponse(error: unknown): Response | null {
  if (!(error instanceof WorkspaceOwnershipError)) return null;
  return Response.json(
    { success: false, error: { code: error.code, message: error.message } },
    { status: error.code === "WORKSPACE_REQUIRED" ? 401 : 409 },
  );
}

export function verifyWorkspaceRequest(request: Request, novelId: string): Response | null {
  try {
    const credentials = workspaceCredentials(request);
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelId);
    return null;
  } catch (error) {
    return (
      workspaceErrorResponse(error) ??
      Response.json({ success: false, error: { message: "工作区校验失败" } }, { status: 500 })
    );
  }
}

/**
 * 解析依附于工作区的项目资源。
 * 未绑定小说时使用不可反推的工作区草稿目录，保证图谱可用且不会与其他会话串线。
 */
export function resolveWorkspaceProjectScope(
  request: Request,
  novelIdInput: string | null | undefined,
  namespace: string,
): { projectId: string; isWorkspaceDraft: boolean } {
  const credentials = workspaceCredentials(request);
  verifyWorkspaceLease(credentials.workspaceId, credentials.lease);
  if (novelIdInput?.trim()) {
    verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelIdInput);
    return { projectId: sanitizeNovelId(novelIdInput), isWorkspaceDraft: false };
  }
  const safeNamespace =
    namespace
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .slice(0, 24) || "draft";
  const workspaceHash = createHash("sha256").update(credentials.workspaceId, "utf8").digest("hex").slice(0, 32);
  return {
    projectId: `workspace-${safeNamespace}-${workspaceHash}`,
    isWorkspaceDraft: true,
  };
}
