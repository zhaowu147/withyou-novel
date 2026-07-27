"use client";

import { create } from "zustand";

import type { NovelData } from "@/types/novel";

/**
 * 文件树元数据 — 追踪每个字段的修改时间和依赖关系
 *
 * 用于健康检查：检测上游字段被修改后，下游字段是否过期
 */

/** 单个字段的元数据 */
export interface FieldMeta {
  /** 最后修改时间戳 */
  lastModified: number;
  /** 写入时依赖的上游字段及其时间戳 */
  basedOn: Record<string, number>;
}

/** 工具 → 它写入的字段 */
export const TOOL_WRITES: Record<string, keyof NovelData> = {
  outline: "outline",
  "detailed-outline": "detailedOutline",
  character: "characters",
  worldview: "worldview",
  opening: "opening",
  goldfinger: "goldfinger",
  "book-name": "novelName",
  synopsis: "synopsis",
  brainstorm: "brainstorm",
};

/** 工具 → 它依赖的上游字段 */
export const TOOL_DEPENDS: Record<string, (keyof NovelData)[]> = {
  character: ["worldview", "chapters"],
  outline: ["brainstorm", "worldview", "characters", "goldfinger", "chapters"],
  "detailed-outline": ["outline", "characters", "worldview", "chapters"],
  opening: ["detailedOutline", "outline", "characters", "worldview", "goldfinger", "chapters"],
  goldfinger: ["worldview", "characters", "chapters"],
  synopsis: ["outline", "characters", "chapters"],
  brainstorm: [],
  "book-name": ["brainstorm", "outline"],
  worldview: ["brainstorm", "chapters"],
};

interface FileTreeMetaState {
  workspaceId: string | null;
  /** 每个 NovelData 字段的元数据 */
  fields: Partial<Record<keyof NovelData, FieldMeta>>;

  /** 记录字段写入（工具确认写入文件树时调用） */
  recordWrite: (
    field: keyof NovelData,
    basedOnFields: (keyof NovelData)[],
    currentMeta: Partial<Record<keyof NovelData, FieldMeta>>,
  ) => void;

  /** 批量更新（从外部加载状态时） */
  setAll: (meta: Partial<Record<keyof NovelData, FieldMeta>>) => void;

  /** 重置 */
  reset: () => void;
  activateWorkspace: (workspaceId: string | null) => void;
}

const FILE_TREE_META_KEY = "withyou-file-tree-meta-v2";

function loadWorkspaceMeta(): Record<string, Partial<Record<keyof NovelData, FieldMeta>>> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(FILE_TREE_META_KEY) || "{}");
  } catch {
    return {};
  }
}

function persistWorkspaceMeta(workspaceId: string | null, fields: Partial<Record<keyof NovelData, FieldMeta>>): void {
  if (typeof window === "undefined" || !workspaceId) return;
  try {
    const all = loadWorkspaceMeta();
    all[workspaceId] = fields;
    localStorage.setItem(FILE_TREE_META_KEY, JSON.stringify(all));
  } catch {
    // 元数据写入失败不应影响正文，但绝不能回退到其他会话的数据。
  }
}

export const useFileTreeMetaStore = create<FileTreeMetaState>((set, get) => ({
  workspaceId: null,
  fields: {},

  recordWrite: (field, basedOnFields, currentMeta) => {
    const now = Date.now();
    const basedOn: Record<string, number> = {};
    for (const dep of basedOnFields) {
      const depMeta = currentMeta[dep] || get().fields[dep];
      if (depMeta) {
        basedOn[dep] = depMeta.lastModified;
      }
    }
    set((prev) => {
      const fields = {
        ...prev.fields,
        [field]: { lastModified: now, basedOn },
      };
      persistWorkspaceMeta(prev.workspaceId, fields);
      return { fields };
    });
  },

  setAll: (meta) => {
    persistWorkspaceMeta(get().workspaceId, meta);
    set({ fields: meta });
  },

  reset: () => {
    persistWorkspaceMeta(get().workspaceId, {});
    set({ fields: {} });
  },

  activateWorkspace: (workspaceId) => {
    persistWorkspaceMeta(get().workspaceId, get().fields);
    const fields = workspaceId ? (loadWorkspaceMeta()[workspaceId] ?? {}) : {};
    set({ workspaceId, fields });
  },
}));

// ─── 健康检查 ───

export type HealthStatus = "ok" | "stale" | "missing";

export interface FieldHealth {
  status: HealthStatus;
  /** 哪些上游被修改了 */
  staleUpstreams: string[];
}

/**
 * 检查某个字段的健康状态
 *
 * @param field - 要检查的字段
 * @param meta - 元数据快照
 * @returns 健康状态 + 过期的上游列表
 */
export function checkFieldHealth(
  field: keyof NovelData,
  meta: Partial<Record<keyof NovelData, FieldMeta>>,
): FieldHealth {
  const fieldMeta = meta[field];
  if (!fieldMeta) return { status: "missing", staleUpstreams: [] };

  const staleUpstreams: string[] = [];
  for (const [upstream, recordedTime] of Object.entries(fieldMeta.basedOn)) {
    const upstreamMeta = meta[upstream as keyof NovelData];
    if (upstreamMeta && upstreamMeta.lastModified > recordedTime) {
      staleUpstreams.push(upstream);
    }
  }

  return {
    status: staleUpstreams.length > 0 ? "stale" : "ok",
    staleUpstreams,
  };
}

/**
 * 检查某个工具的上游是否有过期
 *
 * @param toolId - 工具 ID
 * @param meta - 元数据快照
 * @returns 过期的上游字段列表
 */
export function checkToolUpstreams(toolId: string, meta: Partial<Record<keyof NovelData, FieldMeta>>): string[] {
  const deps = TOOL_DEPENDS[toolId] || [];
  const stale: string[] = [];
  for (const dep of deps) {
    const depMeta = meta[dep];
    if (!depMeta) continue; // 上游未生成，不警告
    // 检查上游自己是否过期（递归一层）
    const health = checkFieldHealth(dep, meta);
    if (health.status === "stale") {
      stale.push(dep as string);
    }
  }
  return stale;
}
