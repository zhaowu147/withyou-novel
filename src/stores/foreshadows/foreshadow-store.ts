"use client";

import { create } from "zustand";

import type { NovelForeshadow } from "@/lib/ai/storage-types";
import { workspaceFetch } from "@/lib/workspaces/client";

interface ForeshadowStore {
  novelId: string | null;
  items: NovelForeshadow[];
  loading: boolean;
  /** 请求版本号：每次 setNovel 递增，防止旧请求覆盖新数据 */
  loadVersion: number;
  setNovel: (id: string | null) => void;
  load: (novelId: string) => Promise<void>;
  create: (fs: Omit<NovelForeshadow, "id" | "novel_id">) => Promise<NovelForeshadow | null>;
  update: (id: string, patch: Partial<NovelForeshadow>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

async function parseJson(res: Response) {
  const j = await res.json();
  return j?.data ?? j;
}

export const useForeshadowStore = create<ForeshadowStore>((set, get) => ({
  novelId: null,
  items: [],
  loading: false,
  loadVersion: 0,

  setNovel: (id) => {
    const newVersion = get().loadVersion + 1;
    set({ novelId: id, items: [], loadVersion: newVersion });
  },

  load: async (novelId) => {
    const version = get().loadVersion;
    set({ loading: true });
    try {
      const res = await workspaceFetch(`/api/foreshadows?novel_id=${encodeURIComponent(novelId)}`);
      if (get().loadVersion !== version) return;
      if (!res.ok) {
        set({ loading: false });
        return;
      }
      const data = await parseJson(res);
      if (get().loadVersion !== version) return;
      set({ novelId, items: data.foreshadows ?? [], loading: false });
    } catch {
      if (get().loadVersion === version) {
        set({ loading: false });
      }
    }
  },

  create: async (fs) => {
    const novelId = get().novelId;
    if (!novelId) return null;
    const res = await workspaceFetch("/api/foreshadows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fs, novel_id: novelId }),
    });
    if (!res.ok) return null;
    const data = await parseJson(res);
    const created = data.foreshadow as NovelForeshadow | undefined;
    if (created && get().novelId === novelId) {
      set({ items: [...get().items, created] });
    }
    return created ?? null;
  },

  update: async (id, patch) => {
    const novelId = get().novelId;
    const res = await workspaceFetch(`/api/foreshadows/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...patch, novel_id: novelId }),
    });
    if (!res.ok) return;
    if (get().novelId !== novelId) return;
    const data = await parseJson(res);
    const updated = data.foreshadow as NovelForeshadow | undefined;
    if (updated) {
      set({ items: get().items.map((f) => (f.id === id ? updated : f)) });
    }
  },

  remove: async (id) => {
    const novelId = get().novelId;
    const q = novelId ? `?novel_id=${encodeURIComponent(novelId)}` : "";
    const res = await workspaceFetch(`/api/foreshadows/${id}${q}`, { method: "DELETE" });
    if (!res.ok) return;
    if (get().novelId !== novelId) return;
    set({ items: get().items.filter((f) => f.id !== id) });
  },

  refresh: async () => {
    const id = get().novelId;
    if (id) await get().load(id);
  },
}));
