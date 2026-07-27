/**
 * 设置 API
 *
 * GET  /api/settings — 读取用户设置
 * POST /api/settings — 保存用户设置
 *
 * 存储位置：项目根目录下的 settings.json（EXE 打包后在 AppData）
 */
import "server-only";

import { NextResponse } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { readSettingsFile, writeSettingsFile } from "@/lib/settings/settings-file";
import { type AppSettings, DEFAULT_SETTINGS } from "@/lib/settings/settings-store";
import { verifyWorkspaceLease, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

function mergeConfig<T extends AppSettings["creationTool"]>(current: T, incoming?: Partial<T>): T {
  if (!incoming) return current;
  const apiKey =
    typeof incoming.apiKey === "string" && incoming.apiKey.includes("***") ? current.apiKey : incoming.apiKey;
  return {
    ...current,
    ...incoming,
    apiKey: apiKey ?? current.apiKey,
  };
}

export async function GET() {
  try {
    const user = await getApiUser();
    if (!user) return NextResponse.json({ success: false, error: "未登录" }, { status: 401 });
    const settings = readSettingsFile();
    // 返回时隐藏 API Key 的完整值，只显示前 8 位 + ***
    const sanitized = sanitizeKeys(settings);
    return NextResponse.json({ success: true, data: sanitized });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "读取设置失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const user = await getApiUser();
    if (!user) return NextResponse.json({ success: false, error: "未登录" }, { status: 401 });
    const credentials = workspaceCredentials(request);
    verifyWorkspaceLease(credentials.workspaceId, credentials.lease);
    enforceRateLimit(`settings:${credentials.workspaceId}`, 20);
    const body = await readJsonBody<Partial<AppSettings>>(request, 256 * 1024);
    const current = readSettingsFile();

    // 合并更新（只更新传入的字段）
    const updated: AppSettings = {
      ...current,
      ...body,
      creationTool: mergeConfig(current.creationTool, body.creationTool),
      chatAgent: mergeConfig(current.chatAgent, body.chatAgent),
      coverGeneration: mergeConfig(current.coverGeneration, body.coverGeneration),
      piAgent: mergeConfig(current.piAgent, body.piAgent),
      version: DEFAULT_SETTINGS.version,
      updatedAt: new Date().toISOString(),
    };

    // 基本验证
    if (updated.creationTool) validateConfig(updated.creationTool);
    if (updated.chatAgent) validateConfig(updated.chatAgent);
    if (updated.coverGeneration) validateConfig(updated.coverGeneration);
    if (updated.piAgent) validateConfig(updated.piAgent);

    writeSettingsFile(updated);

    return NextResponse.json({ success: true });
  } catch (e) {
    const ownershipResponse = workspaceErrorResponse(e);
    if (ownershipResponse) return ownershipResponse;
    if (e instanceof RequestGuardError) {
      return NextResponse.json({ success: false, error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "保存设置失败" },
      { status: 500 },
    );
  }
}

/** 隐藏 API Key 完整值 */
function sanitizeKeys(settings: AppSettings): AppSettings {
  const sanitize = (s: AppSettings["creationTool"]) => ({
    ...s,
    apiKey: s.apiKey ? `${s.apiKey.slice(0, 8)}***` : "",
  });
  return {
    ...settings,
    creationTool: sanitize(settings.creationTool),
    chatAgent: sanitize(settings.chatAgent),
    coverGeneration: sanitize(settings.coverGeneration),
    piAgent: sanitize(settings.piAgent),
  };
}

/** 基本验证 */
function validateConfig(config: { provider: string; model: string }) {
  if (!config.provider) throw new Error("Provider 不能为空");
  if (!config.model && config.provider !== "custom") throw new Error("模型名称不能为空");
}
