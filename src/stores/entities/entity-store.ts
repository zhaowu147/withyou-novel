"use client";

import { create } from "zustand";

import type { NovelEntityCard } from "@/lib/ai/storage-types";
import { workspaceFetch } from "@/lib/workspaces/client";

interface EntityStore {
  novelId: string | null;
  cards: NovelEntityCard[];
  loading: boolean;
  /** 请求版本号：每次 setNovel 递增，防止旧请求覆盖新数据 */
  loadVersion: number;
  setNovel: (id: string | null) => void;
  load: (novelId: string) => Promise<void>;
  create: (card: Omit<NovelEntityCard, "id" | "novel_id">) => Promise<NovelEntityCard | null>;
  update: (id: string, patch: Partial<NovelEntityCard>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

async function parseJson(res: Response) {
  const j = await res.json();
  return j?.data ?? j;
}

export const useEntityStore = create<EntityStore>((set, get) => ({
  novelId: null,
  cards: [],
  loading: false,
  loadVersion: 0,

  setNovel: (id) => {
    // 递增版本号，使正在进行的旧 load 请求失效
    const newVersion = get().loadVersion + 1;
    set({ novelId: id, cards: [], loadVersion: newVersion });
  },

  load: async (novelId) => {
    const version = get().loadVersion;
    set({ loading: true });
    try {
      const res = await workspaceFetch(`/api/entities?novel_id=${encodeURIComponent(novelId)}`);
      // 如果在请求期间 novelId 已切换，丢弃结果
      if (get().loadVersion !== version) return;
      if (!res.ok) {
        set({ loading: false });
        return;
      }
      const data = await parseJson(res);
      if (get().loadVersion !== version) return;
      set({ novelId, cards: data.entities ?? [], loading: false });
    } catch {
      if (get().loadVersion === version) {
        set({ loading: false });
      }
    }
  },

  create: async (card) => {
    const novelId = get().novelId;
    if (!novelId) return null;
    const res = await workspaceFetch("/api/entities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...card, novel_id: novelId }),
    });
    if (!res.ok) return null;
    const data = await parseJson(res);
    const created = data.entity as NovelEntityCard | undefined;
    // 仅当 novelId 未变化时才更新 cards
    if (created && get().novelId === novelId) {
      set({ cards: [...get().cards, created] });
    }
    return created ?? null;
  },

  update: async (id, patch) => {
    const novelId = get().novelId;
    const res = await workspaceFetch(`/api/entities/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...patch, novel_id: novelId }),
    });
    if (!res.ok) return;
    if (get().novelId !== novelId) return;
    const data = await parseJson(res);
    const updated = data.entity as NovelEntityCard | undefined;
    if (updated) {
      set({ cards: get().cards.map((c) => (c.id === id ? updated : c)) });
    }
  },

  remove: async (id) => {
    const novelId = get().novelId;
    const q = novelId ? `?novel_id=${encodeURIComponent(novelId)}` : "";
    const res = await workspaceFetch(`/api/entities/${id}${q}`, { method: "DELETE" });
    if (!res.ok) return;
    if (get().novelId !== novelId) return;
    set({ cards: get().cards.filter((c) => c.id !== id) });
  },

  refresh: async () => {
    const id = get().novelId;
    if (id) await get().load(id);
  },
}));
