"use client";

import { create } from "zustand";

import type { ConversationMessage } from "@/lib/ai/conversations";

/**
 * 会话所有权管理
 *
 * 核心机制：中栏对话区同一时刻只有一个 Agent 持有。
 *  - 默认：writing Agent 持有
 *  - 工具介入：工具 Agent 接管，写作 Agent 挂起
 *  - 确认写入：工具 Agent 退出，写作 Agent 回归
 *
 * 持久化：存储到 localStorage，重启应用后恢复工具编辑状态
 */

const STORAGE_KEY = "withyou-session-owner-v2";

/** 工具 ID 类型 — 对应 sidebar-items.ts 中的 tool 字段 */
export type ToolId =
  | "book-name"
  | "brainstorm"
  | "outline"
  | "detailed-outline"
  | "opening"
  | "character"
  | "worldview"
  | "goldfinger"
  | "synopsis";

/** 工具 Agent 进场时携带的上下文 */
export interface ToolSessionContext {
  /** 工具 ID */
  toolId: ToolId;
  /** 用户在功能区输入的原始需求 */
  userInput: string;
  /** 工具在功能区生成的输出（待修改内容） */
  toolOutput: string;
}

interface SessionOwnerState {
  workspaceId: string | null;
  /** 当前持有中栏会话的 Agent 类型 */
  owner: "writing" | ToolId;
  /** 工具 Agent 进场时的上下文（owner=writing 时为 null） */
  toolContext: ToolSessionContext | null;
  /** 写作 Agent 的挂起会话 ID（工具退场后恢复） */
  suspendedWritingConversationId: string | null;
  /** 工具精修会话独立保存，绝不覆盖写作会话历史 */
  toolMessages: ConversationMessage[];
  /** 每次应用到精修都会递增，即使是同一个工具也会重新接管 */
  takeoverRevision: number;

  /** 工具 Agent 接管中栏会话 */
  takeover: (ctx: ToolSessionContext, currentWritingConversationId: string | null) => void;
  /** 保存当前工具精修会话 */
  setToolMessages: (messages: ConversationMessage[]) => void;
  /** 工具 Agent 退出，写作 Agent 回归 */
  release: () => void;
  /** 重置为初始状态 */
  reset: () => void;
  /** 原子切换到另一个会话自己的 Agent 所有权快照 */
  activateWorkspace: (workspaceId: string | null) => void;
}

interface PersistedOwnerSnapshot {
  owner: "writing" | ToolId;
  toolContext: ToolSessionContext | null;
  suspendedWritingConversationId: string | null;
  toolMessages: ConversationMessage[];
  takeoverRevision: number;
}

interface PersistedOwnerState {
  activeWorkspaceId: string | null;
  workspaces: Record<string, PersistedOwnerSnapshot>;
}

function emptySnapshot(): PersistedOwnerSnapshot {
  return {
    owner: "writing",
    toolContext: null,
    suspendedWritingConversationId: null,
    toolMessages: [],
    takeoverRevision: 0,
  };
}

function normalizeSnapshot(snapshot?: Partial<PersistedOwnerSnapshot> | null): PersistedOwnerSnapshot {
  if (!snapshot) return emptySnapshot();
  return {
    owner: snapshot.owner ?? "writing",
    toolContext: snapshot.toolContext ?? null,
    suspendedWritingConversationId: snapshot.suspendedWritingConversationId ?? null,
    toolMessages: Array.isArray(snapshot.toolMessages) ? snapshot.toolMessages : [],
    takeoverRevision: Number.isFinite(snapshot.takeoverRevision) ? Number(snapshot.takeoverRevision) : 0,
  };
}

function loadPersistedState(): PersistedOwnerState {
  if (typeof window === "undefined") return { activeWorkspaceId: null, workspaces: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { activeWorkspaceId: null, workspaces: {} };
    const parsed = JSON.parse(raw) as PersistedOwnerState;
    return {
      activeWorkspaceId: parsed.activeWorkspaceId ?? null,
      workspaces: Object.fromEntries(
        Object.entries(parsed.workspaces ?? {}).map(([workspaceId, snapshot]) => [
          workspaceId,
          normalizeSnapshot(snapshot),
        ]),
      ),
    };
  } catch {
    return { activeWorkspaceId: null, workspaces: {} };
  }
}

function persistWorkspace(workspaceId: string | null, snapshot: PersistedOwnerSnapshot) {
  if (typeof window === "undefined") return;
  try {
    const persisted = loadPersistedState();
    if (workspaceId) persisted.workspaces[workspaceId] = snapshot;
    persisted.activeWorkspaceId = workspaceId;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    /* quota exceeded, ignore */
  }
}

const persisted = loadPersistedState();
const initialSnapshot = normalizeSnapshot(
  persisted.activeWorkspaceId ? persisted.workspaces[persisted.activeWorkspaceId] : null,
);

export const useSessionOwnerStore = create<SessionOwnerState>((set, get) => ({
  workspaceId: persisted.activeWorkspaceId,
  owner: initialSnapshot.owner,
  toolContext: initialSnapshot.toolContext,
  suspendedWritingConversationId: initialSnapshot.suspendedWritingConversationId,
  toolMessages: initialSnapshot.toolMessages,
  takeoverRevision: initialSnapshot.takeoverRevision,

  takeover: (ctx, currentWritingConversationId) => {
    const current = get();
    const newState = {
      owner: ctx.toolId as "writing" | ToolId,
      toolContext: ctx,
      suspendedWritingConversationId: currentWritingConversationId,
      toolMessages: [] as ConversationMessage[],
      takeoverRevision: current.takeoverRevision + 1,
    };
    set(newState);
    persistWorkspace(get().workspaceId, newState);
  },

  setToolMessages: (messages) => {
    const current = get();
    const newState = {
      owner: current.owner,
      toolContext: current.toolContext,
      suspendedWritingConversationId: current.suspendedWritingConversationId,
      toolMessages: messages,
      takeoverRevision: current.takeoverRevision,
    };
    set({ toolMessages: messages });
    persistWorkspace(current.workspaceId, newState);
  },

  release: () => {
    const newState = {
      owner: "writing" as const,
      toolContext: null,
      suspendedWritingConversationId: null,
      toolMessages: [] as ConversationMessage[],
      takeoverRevision: get().takeoverRevision,
    };
    set(newState);
    persistWorkspace(get().workspaceId, newState);
  },

  reset: () => {
    const newState = {
      owner: "writing" as const,
      toolContext: null,
      suspendedWritingConversationId: null,
      toolMessages: [] as ConversationMessage[],
      takeoverRevision: get().takeoverRevision,
    };
    set(newState);
    persistWorkspace(get().workspaceId, newState);
  },

  activateWorkspace: (workspaceId) => {
    const current = get();
    persistWorkspace(current.workspaceId, {
      owner: current.owner,
      toolContext: current.toolContext,
      suspendedWritingConversationId: current.suspendedWritingConversationId,
      toolMessages: current.toolMessages,
      takeoverRevision: current.takeoverRevision,
    });
    const state = loadPersistedState();
    const snapshot = normalizeSnapshot(workspaceId ? state.workspaces[workspaceId] : null);
    set({ workspaceId, ...snapshot });
    persistWorkspace(workspaceId, snapshot);
  },
}));
