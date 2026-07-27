/**
 * 用户设置存储层
 *
 * 存储位置：用户 AppData 目录下的 settings.json
 * 优先级：用户设置 > .env.local 环境变量
 *
 * 用途：
 *  - 创作工具模型配置（/api/generate 使用）
 *  - 对话写作模型配置（/api/chat 使用）
 *  - 封面生成模型配置（图像 API 使用）
 */

export interface ModelProviderConfig {
  /** Provider 名称 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** API Key（加密存储） */
  apiKey: string;
  /** API Base URL（可选，某些 Provider 需要） */
  apiBase?: string;
  /** 上下文窗口大小（token 数，用户自行填写） */
  contextWindow?: number;
}

export interface AppSettings {
  /** 版本号，用于未来迁移 */
  version: number;
  /** 创作工具模型配置 */
  creationTool: ModelProviderConfig;
  /** 对话写作模型配置 */
  chatAgent: ModelProviderConfig;
  /** 封面生成模型配置 */
  coverGeneration: ModelProviderConfig;
  /** Pi 全局项目 Agent 模型配置 */
  piAgent: ModelProviderConfig;
  /** 上次修改时间 */
  updatedAt: string;
}

/** 默认上下文窗口（用户未配置时） */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 获取模型的上下文窗口大小
 * 优先级：用户设置的 contextWindow > 默认值
 */
export function getModelContextWindow(_model: string, userContextWindow?: number): number {
  return userContextWindow || DEFAULT_CONTEXT_WINDOW;
}

/**
 * 根据上下文窗口计算压缩配置
 * @param contextWindow - 模型的上下文窗口大小
 * @returns 压缩配置（留 10% 给输出，剩余按比例分配）
 */
export function buildCompressionConfig(contextWindow: number) {
  const maxTokens = Math.floor(contextWindow * 0.9); // 留 10% 给输出
  return {
    maxTokens,
    keepRecentMessages: 10,
    maxHistoryTokens: Math.floor(maxTokens * 0.2), // 消息历史占 20%
    maxVaultTokens: Math.floor(maxTokens * 0.06), // Vault 占 6%
    maxNovelDataTokens: Math.floor(maxTokens * 0.12), // 设定占 12%
  };
}

/** 支持的 Provider 列表 */
export const PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
    defaultBase: "https://api.openai.com/v1",
    supportsImage: true,
    imageModels: ["dall-e-3", "dall-e-2"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    models: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-8"],
    defaultBase: "https://api.anthropic.com",
    supportsImage: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultBase: "https://api.deepseek.com/v1",
    supportsImage: false,
  },
  {
    id: "qwen",
    name: "通义千问",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
    defaultBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    supportsImage: true,
    imageModels: ["wanx-v1"],
  },
  {
    id: "stepfun",
    name: "阶跃星辰",
    models: ["step-3.7-flash", "step-3.5-flash", "step-2-16k"],
    defaultBase: "https://api.stepfun.com/step_plan/v1",
    supportsImage: false,
  },
  {
    id: "custom",
    name: "自定义（OpenAI 兼容）",
    models: [],
    defaultBase: "",
    supportsImage: false,
  },
] as const;

/** 默认配置（fallback 到环境变量） */
export const DEFAULT_SETTINGS: AppSettings = {
  version: 2,
  creationTool: {
    provider: "stepfun",
    model: "step-3.7-flash",
    apiKey: "", // 空 = 使用 .env.local
    apiBase: "https://api.stepfun.com/step_plan/v1",
  },
  chatAgent: {
    provider: "stepfun",
    model: "step-3.7-flash",
    apiKey: "",
    apiBase: "https://api.stepfun.com/step_plan/v1",
  },
  coverGeneration: {
    provider: "custom",
    model: "agnes-image-2.1-flash",
    apiKey: "",
    apiBase: "https://apihub.agnes-ai.com/v1",
  },
  piAgent: {
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKey: "",
    apiBase: "https://api.anthropic.com",
    contextWindow: 200_000,
  },
  updatedAt: new Date().toISOString(),
};

/**
 * 获取实际使用的模型配置
 * 优先级：用户设置 > 环境变量 > 默认值
 */
export function resolveModelConfig(
  userConfig: ModelProviderConfig,
  envFallbacks: { apiKey?: string; apiBase?: string; model?: string },
): { apiKey: string; apiBase: string; model: string } {
  return {
    apiKey: userConfig.apiKey || envFallbacks.apiKey || "",
    apiBase: userConfig.apiBase || envFallbacks.apiBase || "",
    model: userConfig.model || envFallbacks.model || "",
  };
}
