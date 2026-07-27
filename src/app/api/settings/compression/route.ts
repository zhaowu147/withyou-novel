/**
 * 获取当前模型的压缩配置
 *
 * GET /api/settings/compression — 根据用户选择的模型返回动态压缩参数
 */
import "server-only";

import { NextResponse } from "next/server";

import { readSettingsFile } from "@/lib/settings/settings-file";
import { buildCompressionConfig, DEFAULT_SETTINGS, getModelContextWindow } from "@/lib/settings/settings-store";

export async function GET() {
  try {
    const settings = readSettingsFile();

    // 根据对话写作模型计算压缩配置
    const chatModel = settings.chatAgent.model || DEFAULT_SETTINGS.chatAgent.model;
    const contextWindow = getModelContextWindow(chatModel, settings.chatAgent.contextWindow);
    const compressionConfig = buildCompressionConfig(contextWindow);

    return NextResponse.json({
      success: true,
      data: {
        model: chatModel,
        contextWindow,
        compression: compressionConfig,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "获取配置失败" },
      { status: 500 },
    );
  }
}
