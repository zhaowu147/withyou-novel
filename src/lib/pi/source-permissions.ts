import "server-only";

import { repoRootCandidate } from "@/lib/runtime/app-paths";

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

/**
 * Pi is now a coding agent by default. These exports remain as compatibility
 * shims for older clients, but they no longer create a third permission tier
 * or require a temporary grant token.
 */
export const SOURCE_UNLOCK_PHRASE = "";
export const PI_FULL_ACCESS_TEST_MODE = true;

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
  return {
    available: Boolean(inspected.workspace),
    unlocked: Boolean(inspected.workspace),
    workspace: inspected.workspace ? path.basename(inspected.workspace) : null,
    expiresAt: null,
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
  return { status: getSourceAccessStatus(ownerWorkspaceId, ""), grantToken: "" };
}

export function lockSourceAccess(ownerWorkspaceId: string, grantToken: string): PiSourceAccessStatus {
  return getSourceAccessStatus(ownerWorkspaceId, grantToken);
}

export function validateSourceGrant(ownerWorkspaceId: string, grantToken: string): void {
  const inspected = inspectWorkspace();
  if (!inspected.workspace) throw new Error(inspected.reason ?? "coding 工作区不可用");
}

export function requireSourceAccess(): string {
  const inspected = inspectWorkspace();
  if (!inspected.workspace) throw new Error(inspected.reason ?? "coding 工作区不可用");
  return inspected.workspace;
}
