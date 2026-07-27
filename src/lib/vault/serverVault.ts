/**
 * Server-side vault — 纯本地 JSON
 */
import "server-only";

import { assembleVaultPrompt, recycleDormant } from "@/lib/local/store";

const DEFAULT_CFG = {
  dormantWindow: 15,
  maxActiveForeshadows: 10,
  timelineCompressKeep: 10,
};

export interface VaultPromptContext {
  activeForeshadows?: Array<{
    description: string;
    plant_chapter?: number;
    state: string;
  }>;
  recentTimeline?: Array<{
    entity_name?: string;
    chapter?: number;
    description: string;
  }>;
}

export async function assembleVaultContext(novelId: string): Promise<VaultPromptContext> {
  return assembleVaultPrompt(novelId, {
    maxFs: DEFAULT_CFG.maxActiveForeshadows,
    maxTl: DEFAULT_CFG.timelineCompressKeep,
  });
}

export async function recycleDormantForeshadows(
  novelId: string,
  currentChapter: number,
  dormantWindow = DEFAULT_CFG.dormantWindow,
): Promise<number> {
  return recycleDormant(novelId, currentChapter, dormantWindow);
}

export default { assembleVaultContext, recycleDormantForeshadows };
