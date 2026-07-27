import "server-only";

import { readSettingsFile } from "@/lib/settings/settings-file";
import { type AppSettings, resolveModelConfig } from "@/lib/settings/settings-store";

export type ModelConfigScope = "creationTool" | "chatAgent" | "coverGeneration" | "piAgent";

export interface RuntimeModelConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  provider: string;
  contextWindow?: number;
  scope: ModelConfigScope;
}

export function readRuntimeSettings(): AppSettings {
  return readSettingsFile();
}

export function getRuntimeModelConfig(scope: ModelConfigScope): RuntimeModelConfig {
  const settings = readRuntimeSettings();
  const selected = settings[scope];

  const envFallbacks =
    scope === "creationTool"
      ? {
          apiKey: process.env.STEPFUN_KEY_TOOL,
          apiBase: process.env.STEPFUN_API_BASE,
          model: process.env.STEPFUN_MODEL_TOOL,
        }
      : scope === "chatAgent"
        ? {
            apiKey: process.env.STEPFUN_KEY_WRITE || process.env.STEPFUN_KEY_CHAT,
            apiBase: process.env.STEPFUN_API_BASE,
            model: process.env.STEPFUN_MODEL_WRITE || process.env.STEPFUN_MODEL_CHAT,
          }
        : scope === "coverGeneration"
          ? {
              apiKey: process.env.AGNES_API_KEY,
              apiBase: process.env.AGNES_API_BASE,
              model: process.env.AGNES_IMAGE_MODEL,
            }
          : {
              apiKey: process.env.PI_AGENT_API_KEY,
              apiBase: process.env.PI_AGENT_API_BASE,
              model: process.env.PI_AGENT_MODEL,
            };

  const safeSelected = {
    ...selected,
    apiKey: selected.apiKey.includes("***") ? "" : selected.apiKey,
  };
  const resolved = resolveModelConfig(safeSelected, envFallbacks);
  return {
    ...resolved,
    apiBase: resolved.apiBase.replace(/\/$/, ""),
    provider: selected.provider,
    contextWindow: selected.contextWindow,
    scope,
  };
}
