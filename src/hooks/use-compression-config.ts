/**
 * useCompressionConfig — 获取当前模型的动态压缩配置
 *
 * 启动时从 /api/settings/compression 读取，缓存在内存中。
 * 设置变更后需要刷新。
 */

import { useEffect, useState } from "react";

import type { CompressionConfig } from "@/lib/ai/context-compressor";

interface CompressionInfo {
  model: string;
  contextWindow: number;
  compression: CompressionConfig;
}

const DEFAULT_INFO: CompressionInfo = {
  model: "step-3.7-flash",
  contextWindow: 256_000,
  compression: {
    maxTokens: 230_400,
    keepRecentMessages: 10,
    maxHistoryTokens: 46_080,
    maxVaultTokens: 13_824,
    maxNovelDataTokens: 27_648,
  },
};

let cachedInfo: CompressionInfo | null = null;

export function useCompressionConfig(): CompressionInfo {
  const [info, setInfo] = useState<CompressionInfo>(cachedInfo ?? DEFAULT_INFO);

  useEffect(() => {
    if (cachedInfo) return;

    fetch("/api/settings/compression")
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data) {
          cachedInfo = json.data;
          setInfo(json.data);
        }
      })
      .catch(() => {
        /* 用默认值 */
      });
  }, []);

  return info;
}

/** 强制刷新缓存（设置变更后调用） */
export function refreshCompressionConfig() {
  cachedInfo = null;
}
