"use client";

import { create } from "zustand";

import type { PromptPackage, ToolId } from "@/lib/prompts/prompt-package";
import { workspaceFetch } from "@/lib/workspaces/client";

/**
 * 提示词包激活状态管理
 *
 * 三个板块互不污染：
 * - 功能区：每个工具独立激活
 * - 会话写手：独立激活
 * - 封面生成：独立激活
 */

interface PromptActivationState {
  /** 当前小说ID */
  novelId: string | null;

  /** 功能区已激活的提示词包（每个工具独立） */
  activatedToolPackages: Partial<Record<ToolId, PromptPackage | null>>;

  /** 会话写手已激活的提示词包 */
  activatedWriterPackage: PromptPackage | null;

  /** 封面生成已激活的提示词包 */
  activatedCoverPackage: PromptPackage | null;

  /** 设置当前小说 */
  setNovel: (novelId: string | null) => void;

  /** 从服务端加载激活状态 */
  loadActivation: (novelId: string) => Promise<void>;

  /** 激活功能区提示词包 */
  activateToolPackage: (toolId: ToolId, pkg: PromptPackage) => Promise<void>;

  /** 激活会话写手提示词包 */
  activateWriterPackage: (pkg: PromptPackage) => Promise<void>;

  /** 激活封面生成提示词包 */
  activateCoverPackage: (pkg: PromptPackage) => Promise<void>;

  /** 停用功能区提示词包 */
  deactivateToolPackage: (toolId: ToolId) => Promise<void>;

  /** 停用会话写手提示词包 */
  deactivateWriterPackage: () => Promise<void>;

  /** 停用封面生成提示词包 */
  deactivateCoverPackage: () => Promise<void>;

  /** 获取已激活的功能区提示词包 */
  getActivatedToolPackage: (toolId: ToolId) => PromptPackage | null;

  /** 获取已激活的会话写手提示词包 */
  getActivatedWriterPackage: () => PromptPackage | null;

  /** 获取已激活的封面生成提示词包 */
  getActivatedCoverPackage: () => PromptPackage | null;
}

export const usePromptActivationStore = create<PromptActivationState>((set, get) => ({
  novelId: null,
  activatedToolPackages: {},
  activatedWriterPackage: null,
  activatedCoverPackage: null,

  setNovel: (novelId) => {
    set({
      novelId,
      activatedToolPackages: {},
      activatedWriterPackage: null,
      activatedCoverPackage: null,
    });
  },

  loadActivation: async (novelId) => {
    try {
      const res = await workspaceFetch(`/api/prompts/activation?novel_id=${encodeURIComponent(novelId)}`);
      if (!res.ok) return;

      const data = await res.json();
      set({
        novelId,
        activatedToolPackages: data.tool || {},
        activatedWriterPackage: data.writer || null,
        activatedCoverPackage: data.cover || null,
      });
    } catch {
      // ignore
    }
  },

  activateToolPackage: async (toolId, pkg) => {
    const novelId = get().novelId;
    if (!novelId) return;

    const res = await workspaceFetch("/api/prompts/activation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        novel_id: novelId,
        scope: "tool",
        toolId,
        package_id: pkg.id,
      }),
    });
    if (!res.ok) throw new Error("提示词应用失败");

    set((prev) => ({
      activatedToolPackages: {
        ...prev.activatedToolPackages,
        [toolId]: pkg,
      },
    }));
  },

  activateWriterPackage: async (pkg) => {
    const novelId = get().novelId;
    if (!novelId) return;

    const res = await workspaceFetch("/api/prompts/activation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        novel_id: novelId,
        scope: "writer",
        package_id: pkg.id,
      }),
    });
    if (!res.ok) throw new Error("提示词应用失败");
    set({ activatedWriterPackage: pkg });
  },

  activateCoverPackage: async (pkg) => {
    const novelId = get().novelId;
    if (!novelId) return;

    const res = await workspaceFetch("/api/prompts/activation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        novel_id: novelId,
        scope: "cover",
        package_id: pkg.id,
      }),
    });
    if (!res.ok) throw new Error("提示词应用失败");
    set({ activatedCoverPackage: pkg });
  },

  deactivateToolPackage: async (toolId) => {
    const novelId = get().novelId;
    if (!novelId) return;

    const res = await workspaceFetch("/api/prompts/activation", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        novel_id: novelId,
        scope: "tool",
        toolId,
      }),
    });
    if (!res.ok) throw new Error("恢复默认失败");

    set((prev) => {
      const newPackages = { ...prev.activatedToolPackages };
      delete newPackages[toolId];
      return { activatedToolPackages: newPackages };
    });
  },

  deactivateWriterPackage: async () => {
    const novelId = get().novelId;
    if (!novelId) return;

    const res = await workspaceFetch("/api/prompts/activation", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        novel_id: novelId,
        scope: "writer",
      }),
    });
    if (!res.ok) throw new Error("恢复默认失败");
    set({ activatedWriterPackage: null });
  },

  deactivateCoverPackage: async () => {
    const novelId = get().novelId;
    if (!novelId) return;

    const res = await workspaceFetch("/api/prompts/activation", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        novel_id: novelId,
        scope: "cover",
      }),
    });
    if (!res.ok) throw new Error("恢复默认失败");
    set({ activatedCoverPackage: null });
  },

  getActivatedToolPackage: (toolId) => {
    return get().activatedToolPackages[toolId] || null;
  },

  getActivatedWriterPackage: () => {
    return get().activatedWriterPackage;
  },

  getActivatedCoverPackage: () => {
    return get().activatedCoverPackage;
  },
}));
