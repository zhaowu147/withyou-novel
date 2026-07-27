import "server-only";

import { repoRootCandidate } from "@/lib/runtime/app-paths";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type PiAccessLevel = "observer" | "project" | "source";

export interface PiSourceAccessStatus {
  available: boolean;
  unlocked: boolean;
  workspace: string | null;
  expiresAt: string | null;
  testMode?: boolean;
  reason?: string;
}

interface SourceGrant {
  workspace: string;
  ownerWorkspaceId: string;
  tokenHash: string;
  expiresAt: number;
}

const globalForSourcePermission = globalThis as typeof globalThis & {
  __withyouPiSourceGrant?: SourceGrant;
};

export const SOURCE_UNLOCK_PHRASE = "授权 Pi 修改源码";
/** 临时验收开关：仅开发环境放开三级源码入口，生产环境仍执行完整授权流程。 */
export const PI_FULL_ACCESS_TEST_MODE = process.env.NODE_ENV !== "production";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(expectedHash: string, token: string): boolean {
  if (!token) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function candidateWorkspace(): string | null {
  if (process.env.PI_SOURCE_WORKSPACE) return path.resolve(process.env.PI_SOURCE_WORKSPACE);
  if (process.env.NODE_ENV !== "production") {
    // 仓库根由 app-paths 统一定位：cwd 不对时也能找到，找不到就明确返回不可用。
    return repoRootCandidate();
  }
  return null;
}

function inspectWorkspace(): { workspace: string | null; reason?: string } {
  const workspace = candidateWorkspace();
  if (!workspace) {
    return {
      workspace: null,
      reason: "生产安装包需要显式配置 PI_SOURCE_WORKSPACE 才能启用源码维护",
    };
  }
  if (!fs.existsSync(path.join(/* turbopackIgnore: true */ workspace, "package.json"))) {
    return { workspace: null, reason: "当前安装包没有可维护的源码工作区" };
  }
  if (!fs.existsSync(path.join(/* turbopackIgnore: true */ workspace, "src"))) {
    return { workspace: null, reason: "源码工作区缺少 src 目录" };
  }
  if (!fs.existsSync(path.join(/* turbopackIgnore: true */ workspace, ".git"))) {
    return { workspace: null, reason: "源码维护模式要求 Git 工作区，以便建立检查点和回滚" };
  }
  return { workspace };
}

export function getSourceAccessStatus(ownerWorkspaceId?: string, grantToken = ""): PiSourceAccessStatus {
  const inspected = inspectWorkspace();
  if (PI_FULL_ACCESS_TEST_MODE) {
    return {
      available: Boolean(inspected.workspace),
      unlocked: Boolean(inspected.workspace),
      workspace: inspected.workspace ? path.basename(inspected.workspace) : null,
      expiresAt: null,
      testMode: true,
      reason: inspected.reason,
    };
  }
  const grant = globalForSourcePermission.__withyouPiSourceGrant;
  const active = Boolean(
    inspected.workspace && grant && grant.workspace === inspected.workspace && grant.expiresAt > Date.now(),
  );
  const unlocked = Boolean(
    active && grant && grant.ownerWorkspaceId === ownerWorkspaceId && tokenMatches(grant.tokenHash, grantToken),
  );
  if (grant && !active) delete globalForSourcePermission.__withyouPiSourceGrant;

  return {
    available: Boolean(inspected.workspace),
    unlocked,
    workspace: inspected.workspace ? path.basename(inspected.workspace) : null,
    expiresAt: unlocked && grant ? new Date(grant.expiresAt).toISOString() : null,
    reason: inspected.reason,
  };
}

export function unlockSourceAccess(
  confirmation: string,
  ownerWorkspaceId: string,
  durationMinutes = 30,
): { status: PiSourceAccessStatus; grantToken: string } {
  const inspected = inspectWorkspace();
  if (!inspected.workspace) throw new Error(inspected.reason ?? "源码工作区不可用");
  if (confirmation !== SOURCE_UNLOCK_PHRASE) throw new Error("授权口令不正确");
  const safeDuration = Math.min(60, Math.max(5, Math.floor(durationMinutes)));
  const grantToken = randomBytes(32).toString("base64url");
  globalForSourcePermission.__withyouPiSourceGrant = {
    workspace: inspected.workspace,
    ownerWorkspaceId,
    tokenHash: hashToken(grantToken),
    expiresAt: Date.now() + safeDuration * 60_000,
  };
  return { status: getSourceAccessStatus(ownerWorkspaceId, grantToken), grantToken };
}

export function lockSourceAccess(ownerWorkspaceId: string, grantToken: string): PiSourceAccessStatus {
  if (PI_FULL_ACCESS_TEST_MODE) return getSourceAccessStatus(ownerWorkspaceId, grantToken);
  validateSourceGrant(ownerWorkspaceId, grantToken);
  delete globalForSourcePermission.__withyouPiSourceGrant;
  return getSourceAccessStatus(ownerWorkspaceId, grantToken);
}

export function validateSourceGrant(ownerWorkspaceId: string, grantToken: string): void {
  if (PI_FULL_ACCESS_TEST_MODE) {
    const inspected = inspectWorkspace();
    if (!inspected.workspace) throw new Error(inspected.reason ?? "源码维护模式不可用");
    return;
  }
  const status = getSourceAccessStatus(ownerWorkspaceId, grantToken);
  if (!status.unlocked) throw new Error("源码维护授权无效、已撤销或已过期");
}

export function requireSourceAccess(): string {
  const inspected = inspectWorkspace();
  if (!inspected.workspace) throw new Error(inspected.reason ?? "源码维护模式不可用");
  if (PI_FULL_ACCESS_TEST_MODE) return inspected.workspace;
  const grant = globalForSourcePermission.__withyouPiSourceGrant;
  if (!grant || grant.workspace !== inspected.workspace || grant.expiresAt <= Date.now()) {
    if (grant) delete globalForSourcePermission.__withyouPiSourceGrant;
    throw new Error("源码维护权限未解锁或已过期");
  }
  return inspected.workspace;
}
