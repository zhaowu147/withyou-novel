/**
 * 板块协作逻辑 — 文件系统为唯一真相源
 *
 * 核心原则:
 * 1. 文件系统是唯一真相源
 * 2. 前端状态从文件系统同步
 * 3. 工具写入后通知前端刷新
 * 4. Chat路由始终从文件系统读取
 *
 * ⚠️ 现状：本模块的 sync* 函数仅被 /api/sync 使用，而 /api/sync 当前
 * 无任何前端调用者（全库检索为空），疑似死代码。改动前请确认是否仍需保留；
 * 若确认废弃，应连同 src/app/api/sync 一并删除。字段↔文件路径已改为从
 * @/lib/novel/field-map 派生，保证与其余读写路径一致。
 */

import { fieldFilePaths } from "@/lib/novel/field-map";
import { novelFS } from "@/lib/novel-fs";

// ─── 文件变更事件 ───

export type FileChangeEvent = {
  novelId: string;
  path: string;
  action: "create" | "update" | "delete";
  timestamp: number;
};

// 简单的事件总线
const listeners: Array<(event: FileChangeEvent) => void> = [];

export function onFileChange(listener: (event: FileChangeEvent) => void) {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function emitFileChange(event: FileChangeEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error("[collaboration] listener error:", e);
    }
  }
}

// ─── 工具写入封装 ───

/**
 * 工具写入文件并触发变更通知
 */
export function writeWithNotify(
  novelId: string,
  path: string,
  content: string,
  action: "create" | "update" = "update",
): void {
  novelFS.writeFile(novelId, path, content);
  emitFileChange({
    novelId,
    path,
    action,
    timestamp: Date.now(),
  });
}

// ─── 前端状态同步 ───

export interface NovelSettings {
  outline?: string;
  characters?: string;
  worldview?: string;
  totalChapters?: number;
}

/**
 * 从文件系统同步设定到前端状态
 */
export function syncSettingsFromFileSystem(novelId: string): NovelSettings {
  const settings: NovelSettings = {};
  const paths = fieldFilePaths();

  const readField = (key: "outline" | "characters" | "worldview") => {
    const filePath = paths[key];
    if (!filePath) return;
    try {
      const value = novelFS.readFile(novelId, filePath);
      if (value) settings[key] = value;
    } catch {
      /* 旧项目可能尚未生成对应文件 */
    }
  };

  readField("outline");
  readField("characters");
  readField("worldview");

  // 注：totalChapters 不在文件树里，而存于 vault meta（getNovel().metadata）。
  // 旧代码尝试从从未创建的「设定/项目信息.md」解析总章数，恒为空，已移除。
  // 如需总章数，调用方应改从 @/lib/local/store 的 getNovel(novelId).metadata 读取。

  return settings;
}

// ─── 章节列表同步 ───

export interface ChapterInfo {
  number: number;
  title: string;
  path: string;
}

/**
 * 从文件系统获取章节列表
 */
export function syncChaptersFromFileSystem(novelId: string): ChapterInfo[] {
  try {
    const files = novelFS.listAllFiles(novelId).filter((f: string) => f.startsWith("正文/"));
    return files
      .map((f: string) => {
        const match = f.match(/正文\/第(\d+)章[：:]?\s*(.*)\.md/);
        return {
          number: match ? parseInt(match[1], 10) : 0,
          title: match ? match[2] || `第${match[1]}章` : f.replace("正文/", ""),
          path: f,
        };
      })
      .sort((a: ChapterInfo, b: ChapterInfo) => a.number - b.number);
  } catch {
    return [];
  }
}

// ─── 实体/伏笔同步 ───

export function syncEntitiesFromFileSystem(novelId: string): Array<{ name: string; type: string; summary: string }> {
  try {
    const characters = novelFS.readFile(novelId, "设定/角色/角色设定.md");
    if (!characters) return [];

    // 简单解析人物设定
    const entities: Array<{ name: string; type: string; summary: string }> = [];
    const lines = characters.split("\n");
    let currentEntity: { name: string; type: string; summary: string } | null = null;

    for (const line of lines) {
      const nameMatch = line.match(/^#{1,3}\s+(.+)/);
      if (nameMatch) {
        if (currentEntity) entities.push(currentEntity);
        currentEntity = {
          name: nameMatch[1].trim(),
          type: "character",
          summary: "",
        };
      } else if (currentEntity && line.trim()) {
        currentEntity.summary += `${line.trim()} `;
      }
    }
    if (currentEntity) entities.push(currentEntity);

    return entities.map((e) => ({
      ...e,
      summary: e.summary.slice(0, 200),
    }));
  } catch {
    return [];
  }
}

// ─── 协作状态管理 ───

export interface CollaborationState {
  novelId: string;
  lastSync: number;
  settings: NovelSettings;
  chapters: ChapterInfo[];
  entities: Array<{ name: string; type: string; summary: string }>;
}

/**
 * 创建完整的协作状态
 */
export function createCollaborationState(novelId: string): CollaborationState {
  return {
    novelId,
    lastSync: Date.now(),
    settings: syncSettingsFromFileSystem(novelId),
    chapters: syncChaptersFromFileSystem(novelId),
    entities: syncEntitiesFromFileSystem(novelId),
  };
}

/**
 * 刷新协作状态（仅更新变更部分）
 */
export function refreshCollaborationState(state: CollaborationState, changedPath?: string): CollaborationState {
  const now = Date.now();

  // 如果指定了变更路径，只更新相关部分
  if (changedPath) {
    const updates: Partial<CollaborationState> = { lastSync: now };

    if (changedPath.startsWith("设定/")) {
      updates.settings = syncSettingsFromFileSystem(state.novelId);
    }
    if (changedPath.startsWith("正文/")) {
      updates.chapters = syncChaptersFromFileSystem(state.novelId);
    }
    if (changedPath === "设定/角色/角色设定.md") {
      updates.entities = syncEntitiesFromFileSystem(state.novelId);
    }

    return { ...state, ...updates };
  }

  // 否则全量刷新
  return createCollaborationState(state.novelId);
}

export default {
  onFileChange,
  emitFileChange,
  writeWithNotify,
  syncSettingsFromFileSystem,
  syncChaptersFromFileSystem,
  syncEntitiesFromFileSystem,
  createCollaborationState,
  refreshCollaborationState,
};
