"use client";

export interface WorkspaceCredentials {
  workspaceId: string;
  lease: string;
  novelId: string | null;
}

let activeCredentials: WorkspaceCredentials | null = null;

export function setActiveWorkspaceCredentials(credentials: WorkspaceCredentials | null): void {
  activeCredentials = credentials;
}

export function getActiveWorkspaceCredentials(): WorkspaceCredentials | null {
  return activeCredentials;
}

export function workspaceHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (activeCredentials) {
    headers.set("x-withyou-workspace-id", activeCredentials.workspaceId);
    headers.set("x-withyou-workspace-lease", activeCredentials.lease);
  }
  return headers;
}

export function workspaceFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, headers: workspaceHeaders(init.headers) });
}

export async function readableApiError(response: Response, fallback = "请求失败"): Promise<string> {
  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  const detail =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.error?.message === "string"
        ? payload.error.message
        : typeof payload?.message === "string"
          ? payload.message
          : "";
  if (detail) return detail;
  if (response.status === 401) return "工作区凭证已失效，请切换会话后重试";
  if (response.status === 409) return "检测到项目绑定冲突，已停止写入以保护源数据";
  if (response.status === 429) return "模型额度或请求频率已达到上限，请稍后重试";
  if (response.status >= 500) return "模型服务暂时不可用，请检查网络、模型地址和密钥配置";
  return `${fallback}（HTTP ${response.status}）`;
}
