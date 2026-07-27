import "server-only";

import { getApiUser } from "@/lib/api/auth";
import { checkLocalOrigin } from "@/lib/api/local-origin-guard";
import { verifyWorkspaceLease, workspaceCredentials } from "@/lib/workspaces/ownership";

export class SourceRequestAuthError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = "SourceRequestAuthError";
  }
}

/**
 * 与全局中间件同一套 loopback+Origin 校验（源码维护接口不吃 WITHYOU_ALLOW_LAN
 * 逃生门 —— 它能改写运行中的代码，永远只允许本机）。
 */
function assertLocalRequest(request: Request): void {
  const verdict = checkLocalOrigin({
    requestUrl: request.url,
    hostHeader: request.headers.get("host"),
    originHeader: request.headers.get("origin"),
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
  if (!verdict.ok) throw new SourceRequestAuthError(verdict.reason, verdict.status);
}

export async function authorizeSourceRequest(request: Request): Promise<{ workspaceId: string; grantToken: string }> {
  assertLocalRequest(request);
  const user = await getApiUser();
  if (!user) throw new SourceRequestAuthError("请先登录", 401);
  const credentials = workspaceCredentials(request);
  verifyWorkspaceLease(credentials.workspaceId, credentials.lease);
  return {
    workspaceId: credentials.workspaceId,
    grantToken: request.headers.get("x-withyou-source-grant")?.trim() ?? "",
  };
}

export function sourceRequestErrorResponse(error: unknown): Response {
  if (error instanceof SourceRequestAuthError) {
    return Response.json({ success: false, error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "源码权限校验失败";
  return Response.json({ success: false, error: message }, { status: 403 });
}
