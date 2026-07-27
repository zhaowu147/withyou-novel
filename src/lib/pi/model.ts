import "server-only";

import { appStateDir } from "@/lib/runtime/app-paths";
import { getRuntimeModelConfig } from "@/lib/settings/runtime-model-config";

import * as path from "node:path";

type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  const load = new Function("name", "return import(name)") as (name: string) => Promise<unknown>;
  return (await load(PI_CODING_AGENT_PACKAGE)) as PiCodingAgentModule;
}

function modelApi(provider: string): "anthropic-messages" | "openai-completions" {
  return provider === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function requiresBearerAuth(apiBase: string): boolean {
  try {
    return new URL(apiBase).hostname.toLocaleLowerCase() === "api.longcat.chat";
  } catch {
    return false;
  }
}

export async function createPiModelServices() {
  const pi = await loadPiCodingAgent();
  const config = getRuntimeModelConfig("piAgent");
  if (!config.apiKey) throw new Error("尚未配置 Pi 项目 Agent 的 API Key");
  if (!config.model || !config.apiBase) throw new Error("Pi 项目 Agent 的模型配置不完整");

  const runtimeProvider = `withyou-pi-${config.provider}`;
  const authHeader = requiresBearerAuth(config.apiBase);
  const authStorage = pi.AuthStorage.inMemory({
    [runtimeProvider]: { type: "api_key", key: config.apiKey },
  });
  const modelRegistry = pi.ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(runtimeProvider, {
    name: `Pi · ${config.provider}`,
    apiKey: config.apiKey,
    baseUrl: config.apiBase,
    api: modelApi(config.provider),
    // LongCat's Anthropic-compatible endpoint authenticates with
    // Authorization: Bearer instead of Anthropic's x-api-key header alone.
    authHeader,
    models: [
      {
        id: config.model,
        name: config.model,
        api: modelApi(config.provider),
        baseUrl: config.apiBase,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow ?? 128_000,
        maxTokens: Math.min(32_000, Math.max(4_096, Math.floor((config.contextWindow ?? 128_000) * 0.1))),
      },
    ],
  });
  const model = modelRegistry.find(runtimeProvider, config.model);
  if (!model) throw new Error(`Pi 无法加载模型 ${config.model}`);

  return {
    agentDir: path.join(appStateDir(), "pi-agent"),
    authStorage,
    config,
    fingerprint: JSON.stringify({ ...config, authHeader }),
    model,
    modelRegistry,
    runtimeProvider,
  };
}
