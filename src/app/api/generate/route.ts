import type { NextRequest } from "next/server";

import { generateAgnesImage } from "@/lib/ai/agnes-image";
import { buildCoverImagePrompt, type CoverRatio, resolveCoverSize } from "@/lib/ai/cover-prompt";
import { gatewayCall } from "@/lib/ai/gateway";
import { wrapUntrustedData } from "@/lib/ai/prompt-boundary";
import { getApiUser } from "@/lib/api/auth";
import { enforceRateLimit, RequestGuardError, readJsonBody } from "@/lib/api/request-guards";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { compileToolFieldPrompt, compileToolPrompt } from "@/lib/prompts/prompt-compiler";
import type { ToolId } from "@/lib/prompts/prompt-package";
import { getActivatedCoverPackage, getActivatedToolPackage } from "@/lib/prompts/prompt-store";
import { expectsStructuredOutput, extractJsonText, validateStructuredOutput } from "@/lib/prompts/structured-output";
import { PROMPT_TEMPLATES } from "@/lib/tools/prompt-templates";
import { buildServerToolContext, isToolId, workflowBlockReason } from "@/lib/tools/server-tool-context";
import { verifyWorkspaceRequest } from "@/lib/workspaces/ownership";

// 封面生图：Agnes 单次常 75–180s，给足路由上限（本地 dev 也生效于某些部署）
export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const user = await getApiUser();
    if (!user) return apiUnauthorized();

    enforceRateLimit("generate:local", 20);
    const body = await readJsonBody<Record<string, unknown>>(req, 2 * 1024 * 1024);
    if (typeof body.novel_id === "string" && body.novel_id) {
      const denied = verifyWorkspaceRequest(req, body.novel_id);
      if (denied) return denied;
    }
    const novelId = typeof body.novel_id === "string" ? body.novel_id : "";

    /**
     * 记忆隔离：项目上下文一律由服务端自己回读文件树组装，**不采信 body.context**。
     * 前端仍会送 context（旧客户端兼容），这里直接忽略。
     * 拿不到 novelId（未绑定项目的一次性生成）时上下文为空 —— 宁可少给，
     * 也不让请求体里的内容冒充"已确认的项目上下文"。
     */
    const serverContext =
      novelId && isToolId(body.toolType) ? await buildServerToolContext(novelId, body.toolType) : null;
    const projectContext = serverContext?.context ?? "";
    const projectDataOnlyPrompt = projectContext.trim()
      ? `以下是当前小说文件树中已经确认的资料，仅作为事实背景使用：\n${wrapUntrustedData(
          "project_context",
          projectContext,
        )}`
      : "";

    const resolveToolPrompt = (toolType: string) => {
      const template = PROMPT_TEMPLATES[toolType];
      if (!template || !novelId) {
        return { basePrompt: template?.systemPrompt ?? "", package: null };
      }

      const activated = getActivatedToolPackage(novelId, toolType as ToolId);
      return {
        basePrompt: template.systemPrompt,
        package: activated,
      };
    };

    // ─── 图像生成（封面）— Agnes ───
    // 约定：有 prompt / coverBrief 且无 toolType → 走封面生图
    // expandPrompt !== false 时用 cover-prompt 把短中文需求扩成专业英文 prompt
    if ((body.prompt || body.coverBrief) && !body.toolType) {
      try {
        const userBrief = String(body.coverBrief ?? body.prompt ?? "");
        const expand = body.expandPrompt !== false;
        const explicitRatio = body.ratio as CoverRatio | undefined;
        const explicitSize = typeof body.size === "string" ? body.size : undefined;

        let finalPrompt: string;
        let finalSize: string;
        let finalRatio: CoverRatio = "9:16";
        let genre: string | undefined;
        let sceneHint: string | undefined;

        if (expand) {
          // 获取已激活的封面提示词包
          let activatedCoverPrompt: string | null = null;
          if (novelId) {
            try {
              const activatedPkg = getActivatedCoverPackage(novelId);
              if (activatedPkg) {
                activatedCoverPrompt = activatedPkg.systemPrompt;
              }
            } catch {
              // ignore
            }
          }

          const built = buildCoverImagePrompt({
            userText: userBrief,
            analysis: typeof body.analysis === "string" ? body.analysis : undefined,
            ratio: explicitRatio,
            activatedCoverPrompt,
          });
          // 若调用方给了具体 WxH，优先用；否则用模板解析出的 size
          if (explicitSize && /^\d{3,4}x\d{3,4}$/i.test(explicitSize)) {
            finalSize = explicitSize;
            finalRatio = resolveCoverSize(explicitSize).ratio;
          } else if (explicitSize) {
            const resolved = resolveCoverSize(explicitSize);
            finalSize = resolved.size;
            finalRatio = resolved.ratio;
          } else {
            finalSize = built.size;
            finalRatio = built.ratio;
          }
          finalPrompt = built.prompt;
          genre = built.genre;
          sceneHint = built.sceneHint;
        } else {
          finalPrompt = userBrief;
          const resolved = resolveCoverSize(explicitSize ?? "9:16");
          finalSize = resolved.size;
          finalRatio = resolved.ratio;
        }

        const { images } = await generateAgnesImage({
          prompt: finalPrompt,
          size: finalSize,
          n: typeof body.n === "number" ? body.n : 1,
          // 与 maxDuration 对齐；实测短图 75–110s，长封面 prompt 常 2–4 分钟
          timeoutMs: 300_000,
        });
        // data.images = [{ url }]；data.meta 含实际 size/ratio/题材（调试用）
        return apiSuccess({
          images,
          meta: {
            size: finalSize,
            ratio: finalRatio,
            genre,
            sceneHint,
            expanded: expand,
          },
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "图像生成失败";
        console.error("[generate] AGNES error:", message);
        if (/timeout|aborted|TimeoutError|生图超时/i.test(message)) {
          return apiError(message, 504, "IMAGE_GEN_TIMEOUT");
        }
        if (/未配置 AGNES_API_KEY/.test(message)) {
          return apiError(message, 500, "AGNES_KEY_MISSING");
        }
        // 上游 Service busy / 503 — 前端可提示稍后再试
        if (/Service busy|上游繁忙|503|429|ServiceUnavailable/i.test(message)) {
          return apiError(message, 503, "IMAGE_GEN_BUSY");
        }
        return apiError(message, 502, "IMAGE_GEN_FAILED");
      }
    }

    // ─── AI填充（基于各自工具的prompt，隔离记忆） ───
    if (body.action === "ai-fill") {
      const { toolType, variables, targetField } = body as {
        toolType: string;
        variables: Record<string, string>;
        targetField: string;
      };

      if (!toolType || !PROMPT_TEMPLATES[toolType]) {
        return apiError("无效的工具类型", 400, "INVALID_TOOL");
      }

      const template = PROMPT_TEMPLATES[toolType];
      const effectivePrompt = resolveToolPrompt(toolType);
      const targetVariable = template.variableSchema.find((variable) => variable.key === targetField);
      if (!targetVariable) {
        return apiError("目标字段不属于当前工具", 400, "INVALID_TARGET_FIELD");
      }
      const targetLabel = targetVariable.label;
      const allowedFieldKeys = new Set(template.variableSchema.map((variable) => variable.key));
      const isPromptlessCharacterExperiment = toolType === "character";

      // 构建已有信息摘要
      const filledFields = Object.entries(variables)
        .filter(([key, value]) => allowedFieldKeys.has(key) && key !== targetField && value?.trim())
        .map(([k, v]) => {
          const label = template.variableSchema.find((sv) => sv.key === k)?.label || k;
          return `${label}：${v}`;
        })
        .join("\n");

      // 基于当前工具的system prompt，为指定字段生成建议
      const systemPrompt = isPromptlessCharacterExperiment
        ? projectDataOnlyPrompt
        : `${compileToolFieldPrompt({
            toolId: toolType as ToolId,
            basePrompt: effectivePrompt.basePrompt,
            activatedPrompt: effectivePrompt.package?.systemPrompt,
            projectContext,
          })}

## 当前任务
用户正在填写「${template.name}」工具的表单。请根据已有信息，为「${targetLabel}」字段生成一个建议值。

要求：
- 直接输出建议内容，不要解释
- 内容要与已有信息风格一致
- 长度适中，不要太长`;

      const userPrompt = filledFields
        ? `当前工具表单中的已有信息：\n${wrapUntrustedData("tool_form_fields", filledFields)}\n\n请为「${targetLabel}」生成建议。`
        : `请为「${targetLabel}」生成一个建议值。`;

      // 使用 tool channel，保持隔离
      const result = await gatewayCall({
        channel: "tool",
        systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 1024,
        temperature: 0.83,
      });

      return apiSuccess({
        result,
        activePrompt: effectivePrompt.package
          ? { id: effectivePrompt.package.id, name: effectivePrompt.package.name }
          : null,
      });
    }

    // ─── 文本工具生成 ───
    const { toolType, variables } = body as {
      toolType: string;
      variables: Record<string, string>;
    };

    if (!toolType || !PROMPT_TEMPLATES[toolType]) {
      return apiError("无效的工具类型", 400, "INVALID_TOOL");
    }

    // 服务端复核因果前置：TOOL_WORKFLOWS 此前只在前端强制，直接打这个路由能绕过。
    // 依据是服务端刚回读的文件树，不是前端说它有什么。
    if (serverContext) {
      const blocked = workflowBlockReason(serverContext);
      if (blocked) return apiError(blocked, 409, "WORKFLOW_PREREQUISITE_MISSING");
    }

    const template = PROMPT_TEMPLATES[toolType];
    const effectivePrompt = resolveToolPrompt(toolType);
    const promptText = template.buildUserPrompt(variables);
    // 角色生成当前处于纯模型能力对照实验：不叠加角色模板、提示词包、工具契约
    // 或 JSON 修复；只保留用户表单，以及文件树中已经确认的事实资料。
    const isPromptlessCharacterExperiment = toolType === "character";

    // 创作工具用 chat channel（step-3.7-flash 强模型）+ 更大 token 上限
    let result = await gatewayCall({
      channel: "tool",
      systemPrompt: isPromptlessCharacterExperiment
        ? projectDataOnlyPrompt
        : compileToolPrompt({
            toolId: toolType as ToolId,
            basePrompt: effectivePrompt.basePrompt,
            activatedPrompt: effectivePrompt.package?.systemPrompt,
            projectContext,
          }),
      messages: [{ role: "user", content: promptText }],
      maxTokens: 16384,
      temperature: 0.83,
    });

    const validationError = isPromptlessCharacterExperiment ? null : validateStructuredOutput(toolType, result);
    if (validationError) {
      const repaired = await gatewayCall({
        channel: "tool",
        systemPrompt:
          "你是 JSON 格式修复器。只修复语法和缺失的必需字段，不改写创作内容。只输出合法 JSON，不要代码围栏或解释。",
        messages: [
          {
            role: "user",
            content: `工具：${toolType}\n校验错误：${validationError}\n\n待修复内容：\n${result}`,
          },
        ],
        maxTokens: 16384,
        temperature: 0.1,
      });
      const repairedError = validateStructuredOutput(toolType, repaired);
      if (repairedError) {
        return apiError(`生成结果格式校验失败：${repairedError}`, 502, "INVALID_GENERATION_FORMAT");
      }
      result = extractJsonText(repaired);
    } else if (expectsStructuredOutput(toolType)) {
      result = extractJsonText(result);
    }

    return apiSuccess({
      result,
      activePrompt: effectivePrompt.package
        ? { id: effectivePrompt.package.id, name: effectivePrompt.package.name }
        : null,
    });
  } catch (e: unknown) {
    if (e instanceof RequestGuardError) return apiError(e.message, e.status, e.code);
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("Generate route error:", message);
    return apiError("请求失败，请重试", 500);
  }
}
