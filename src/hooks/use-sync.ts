/**
 * useSync — 文件系统同步 hook
 *
 * 监听 sync_required 事件，自动刷新前端状态
 */

import { useCallback } from "react";

import type { NovelData } from "@/types/novel";

interface SyncResult {
  settings: {
    outline?: string;
    characters?: string;
    worldview?: string;
    novelName?: string;
    totalChapters?: number;
  };
  chapters: Array<{
    number: number;
    title: string;
    path: string;
  }>;
  entities: Array<{
    name: string;
    type: string;
    summary: string;
  }>;
  syncedAt: number;
}

/**
 * 从文件系统同步状态
 */
export async function syncFromFileSystem(novelId: string): Promise<SyncResult | null> {
  try {
    const res = await fetch(`/api/sync?novelId=${encodeURIComponent(novelId)}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json.data;
  } catch {
    return null;
  }
}

/**
 * 处理 sync_required 事件
 */
export function useSyncHandler(onUpdate: (updates: Partial<NovelData>) => void) {
  const handleSync = useCallback(
    async (novelId: string) => {
      const result = await syncFromFileSystem(novelId);
      if (!result) return;

      // 更新设定
      const updates: Partial<NovelData> = {};
      if (result.settings.outline) updates.outline = result.settings.outline;
      if (result.settings.characters) updates.characters = result.settings.characters;
      if (result.settings.worldview) updates.worldview = result.settings.worldview;
      if (result.settings.novelName) updates.novelName = result.settings.novelName;
      if (result.settings.totalChapters) updates.totalChapters = result.settings.totalChapters;

      // 更新章节列表：将数组转为 Record<number, string> 格式
      if (result.chapters.length > 0) {
        const chaptersRecord: Record<string, string> = {};
        for (const ch of result.chapters) {
          chaptersRecord[String(ch.number)] = ch.title;
        }
        updates.chapters = chaptersRecord;
      }

      onUpdate(updates);
    },
    [onUpdate],
  );

  return { handleSync };
}

export default useSyncHandler;
