import type { NextRequest } from "next/server";

import type { NovelContext, VaultContext } from "@/lib/agents/context-types";
import { runCoreAgent } from "@/lib/agents/runtime";
import {
  autoCompressContext,
  type CompressionConfig,
  estimateMessagesTokens,
  estimateTokens,
} from "@/lib/ai/context-compressor";
import { type ChannelType, gatewayCall } from "@/lib/ai/gateway";
import { assembleContext, contextToLLMText } from "@/lib/ai/memory-retriever";
import { UNTRUSTED_DATA_POLICY } from "@/lib/ai/prompt-boundary";
import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiUnauthorized } from "@/lib/api/response";
import { listChapterFiles, listEntities } from "@/lib/local/store";
import { loadNovelDataFromDisk } from "@/lib/novel/server-novel-data";
import { compileToolPrompt } from "@/lib/prompts/prompt-compiler";
import type { ToolId } from "@/lib/prompts/prompt-package";
import { getActivatedToolPackage } from "@/lib/prompts/prompt-store";
import { readRuntimeSettings } from "@/lib/settings/runtime-model-config";
import { buildCompressionConfig, getModelContextWindow } from "@/lib/settings/settings-store";
import { PROMPT_TEMPLATES } from "@/lib/tools/prompt-templates";
import { buildServerToolContext, isToolId } from "@/lib/tools/server-tool-context";
import { assembleVaultContext } from "@/lib/vault/serverVault";
import { verifyWorkspaceAccess, workspaceCredentials, workspaceErrorResponse } from "@/lib/workspaces/ownership";

/** 读取用户设置并计算动态压缩配置 */
function getCompressionConfig(scope: "creationTool" | "chatAgent", outputTokens: number): CompressionConfig {
  const settings = readRuntimeSettings();
  const modelConfig = settings[scope];
  const contextWindow = getModelContextWindow(modelConfig.model, modelConfig.contextWindow);
  const compression = buildCompressionConfig(contextWindow);
  return { ...compression, maxTokens: Math.max(8_000, contextWindow - outputTokens) };
}

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();

  try {
    enforceRateLimit("chat:local", 30);
    const body = await readJsonBody<Record<string, unknown>>(req, 2 * 1024 * 1024);
    const { messages, novelId, toolId } = body as {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      novelId?: string;
      toolId?: string;
      checkpoint?: string;
    };

    if (!messages?.length) return apiError("messages required", 400);
    if (toolId && !PROMPT_TEMPLATES[toolId]) {
      return apiError("invalid toolId", 400);
    }

    // ─── Session Gate: 没有 novelId 时主动询问 ───
    if (!novelId) {
      const sessionGateReply =
        "当前是空白创作会话。请通过右侧导入已有作品，或在左侧功能区明确创建书名、角色和大纲；会话不会根据聊天内容自动识别书名或创建项目。";

      const stream = new ReadableStream<Uint8Array>({
        async start(s) {
          const enc = new TextEncoder();
          const e = (obj: Record<string, unknown>) => s.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
          e({ type: "chunk", content: sessionGateReply });
          e({ type: "done" });
          s.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    let workspaceId = "";
    try {
      const credentials = workspaceCredentials(req);
      workspaceId = credentials.workspaceId;
      verifyWorkspaceAccess(credentials.workspaceId, credentials.lease, novelId);
    } catch (error) {
      return workspaceErrorResponse(error) ?? apiError("工作区校验失败", 500);
    }

    // 普通会话交给真正的 Writer Runtime：由模型按任务调用只读工具，
    // 定向读取当前作品文件、记忆、章节和追踪数据，并保存完整运行轨迹。
    // 功能区接管仍保留原有独立 prompt / 模型链路，不与 Writer 记忆混用。
    if (!toolId) {
      const ac = new AbortController();
      req.signal?.addEventListener("abort", () => ac.abort());
      const latestUserMessage =
        [...messages]
          .reverse()
          .find((message) => message.role === "user")
          ?.content?.trim() ??
        messages.at(-1)?.content?.trim() ??
        "";
      const runtimeMessages =
        typeof body.checkpoint === "string" && body.checkpoint.startsWith("[结构化会话检查点]")
          ? [{ role: "user" as const, content: body.checkpoint }, ...messages]
          : messages;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const emit = (event: Record<string, unknown>) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          try {
            emit({
              type: "agent_info",
              agentId: "writer",
              agentName: "写作 Agent",
              runtime: "tool_loop",
            });
            const result = await runCoreAgent({
              workspaceId,
              novelId,
              agentId: "writer",
              objective: latestUserMessage,
              messages: runtimeMessages,
              signal: ac.signal,
              maxTokens: 12_000,
              temperature: 0.83,
              onEvent: (event) => emit({ ...event, type: "agent_progress", phase: event.type }),
            });
            for (let i = 0; i < result.output.length; i += 20) {
              emit({ type: "chunk", content: result.output.slice(i, i + 20) });
            }
            emit({ type: "done", runId: result.run.id });
            controller.close();
          } catch (error) {
            emit({
              type: "error",
              message: error instanceof Error ? error.message : "Writer Agent 运行失败",
            });
            controller.close();
          }
        },
        cancel() {
          ac.abort();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    // ─── 加载小说上下文（放开截断） ───
    const novelData: NovelContext = { novelId };

    try {
      // 统一走 FIELD_MAP 的文件优先读取，不再使用已经废弃的旧路径。
      const diskData = loadNovelDataFromDisk(novelId);
      novelData.novelName = diskData.novelName;
      if (diskData.outline) novelData.outline = diskData.outline.slice(0, 8000);
      if (diskData.characters) novelData.characters = diskData.characters.slice(0, 6000);
      if (diskData.worldview) novelData.worldview = diskData.worldview.slice(0, 6000);
      if (diskData.foreshadowing) novelData.foreshadowing = diskData.foreshadowing.slice(0, 6000);
    } catch {
      /* 项目资料暂时不可读时仍允许记忆召回继续 */
    }

    // ─── 为本次写作任务按需召回该作品的规范/长/短记忆 ───
    if (!toolId) {
      try {
        const chapterFiles = listChapterFiles(novelId);
        const latestChapter = chapterFiles.reduce((max, chapter) => Math.max(max, chapter.number), 0);
        const recallQuery = messages
          .slice(-4)
          .map((message) => message.content)
          .join("\n")
          .slice(0, 8_000);
        const recalled = await assembleContext({
          novelId,
          taskType: "write_chapter",
          currentChapterNum: latestChapter + 1,
          query: recallQuery,
        });
        novelData.currentChapterNum = latestChapter + 1;
        novelData.taskType = "write_chapter";
        novelData.retrievedMemory = contextToLLMText(recalled);
      } catch {
        // 记忆库尚未初始化或召回失败时，仍允许用户继续写作。
      }
    }

    // ─── 加载 Vault 上下文（伏笔 + 实体 + 时间线） ───
    let vaultContext: VaultContext | undefined;
    try {
      const vaultPrompt = await assembleVaultContext(novelId);
      const entities = listEntities(novelId);

      vaultContext = {
        activeForeshadows: vaultPrompt.activeForeshadows,
        recentTimeline: vaultPrompt.recentTimeline,
        activeEntities: entities
          .filter((e) => e.importance !== "low")
          .slice(0, 15)
          .map((e) => ({
            name: e.name,
            type: e.type,
            importance: e.importance || "mid",
            active_state: e.active_state || "active",
            summary: (e.summary || "").slice(0, 200),
          })),
      };
    } catch {
      /* vault 不存在时继续 */
    }

    // ─── 会话区固定为写作 Agent；只有功能区接管时才使用显式 toolId ───
    // 禁止根据用户消息猜测意图并切换 Agent，避免隐式上下文和记忆串线。
    const toolTemplate = toolId ? PROMPT_TEMPLATES[toolId] : null;
    const isToolSession = Boolean(toolId && toolTemplate);
    let serverToolProjectContext = "";
    if (isToolSession && isToolId(toolId)) {
      try {
        serverToolProjectContext = (await buildServerToolContext(novelId, toolId)).context;
      } catch {
        // 工具精修仍可继续，但绝不回退信任浏览器传入的上下文。
      }
    }

    // ─── 构建 system prompt ───
    const buildRequestSystemPrompt = () =>
      toolTemplate
        ? compileToolPrompt({
            toolId: toolId as ToolId,
            basePrompt: toolTemplate.systemPrompt,
            activatedPrompt: getActivatedToolPackage(novelId, toolId as ToolId)?.systemPrompt,
            projectContext: serverToolProjectContext,
            dialogueMode: true,
          })
        : "";
    const systemPrompt = buildRequestSystemPrompt();

    // ─── 自动压缩上下文（动态限制，根据用户选择的模型） ───
    const outputTokenBudget = isToolSession ? 16_384 : 8_192;
    const compressionConfig = getCompressionConfig(isToolSession ? "creationTool" : "chatAgent", outputTokenBudget);
    const { compressed, report } = autoCompressContext(
      {
        systemPrompt,
        messages:
          typeof body.checkpoint === "string" && body.checkpoint.startsWith("[结构化会话检查点]")
            ? [{ role: "system", content: body.checkpoint }, ...messages]
            : messages,
        novelData,
        vaultContext,
      },
      compressionConfig,
    );

    // 使用压缩后的数据
    const finalSystemPrompt = buildRequestSystemPrompt();
    const finalMessages: Array<{
      role: "user" | "assistant" | "system";
      content: string;
    }> = compressed.messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
      content: message.content,
    }));
    const finalInputTokens =
      estimateTokens(UNTRUSTED_DATA_POLICY) + estimateTokens(finalSystemPrompt) + estimateMessagesTokens(finalMessages);
    report.compressedTokens = finalInputTokens;
    if (finalInputTokens > compressionConfig.maxTokens) {
      return apiError(
        `上下文压缩后仍需约 ${finalInputTokens} tokens，超过当前输入预算 ${compressionConfig.maxTokens}，请缩小资料范围或选择更大上下文模型`,
        413,
        "CONTEXT_BUDGET_EXCEEDED",
      );
    }

    const ac = new AbortController();
    req.signal?.addEventListener("abort", () => ac.abort());

    // 普通会话不开放自动工具调用：作品写入必须经过用户显式确认。
    const channel: ChannelType = isToolSession ? "tool" : "write";

    const stream = new ReadableStream<Uint8Array>({
      async start(s) {
        const enc = new TextEncoder();
        const e = (obj: Record<string, unknown>) => s.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        try {
          // 告知前端当前使用的 agent + 压缩信息
          e({
            type: "agent_info",
            agentId: toolId,
            agentName: `${toolTemplate?.name ?? toolId} Agent`,
            compression: report.actions,
          });

          // 普通会话使用会话写作模型；工具接管使用功能区模型。
          const reply = await gatewayCall({
            channel,
            systemPrompt: finalSystemPrompt,
            messages: finalMessages,
            maxTokens: outputTokenBudget,
            temperature: 0.83,
            signal: ac.signal,
          });
          for (let i = 0; i < reply.length; i += 20) e({ type: "chunk", content: reply.slice(i, i + 20) });
          e({ type: "done" });
          s.close();
        } catch (err: unknown) {
          e({ type: "error", message: (err as Error).message || "fail" });
          s.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof RequestGuardError) return apiError(error.message, error.status, error.code);
    const ownershipResponse = workspaceErrorResponse(error);
    if (ownershipResponse) return ownershipResponse;
    return apiError("Request failed", 500);
  }
}
