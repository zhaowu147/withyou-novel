/**
 * 小说持久化层 — 服务端 only（磁盘真源）
 * 客户端类型请 import from "@/lib/ai/storage-types"
 */
import "server-only";

import { LOCAL_USER_ID } from "@/lib/local/constants";
import * as local from "@/lib/local/store";
import type { NovelData } from "@/types/novel";

import type {
  ChapterBackupRecord,
  ChapterFileRecord,
  NovelEntityCard,
  NovelForeshadow,
  NovelMeta,
} from "./storage-types";

export type {
  ChapterBackupRecord,
  ChapterFileRecord,
  NovelEntityCard,
  NovelForeshadow,
  NovelMeta,
} from "./storage-types";

export interface StorageAdapter {
  loadCurrent(userId?: string): Promise<NovelData | null>;
  saveCurrent(userId: string, data: NovelData): Promise<NovelMeta | null>;
  loadChapters(novelId?: string): Promise<Record<string, string>>;
  saveChapter(novelId: string, chapterNum: number, title: string, content: string): Promise<void>;
  listEntities(novelId: string): Promise<NovelEntityCard[]>;
  upsertEntity(card: NovelEntityCard): Promise<NovelEntityCard | null>;
  deleteEntity(entityId: string, novelId?: string): Promise<void>;
  listForeshadows(novelId: string): Promise<NovelForeshadow[]>;
  upsertForeshadow(fs: NovelForeshadow): Promise<NovelForeshadow | null>;
  deleteForeshadow(fsId: string, novelId?: string): Promise<void>;
  loadChapterFile(novelId: string, num: number): Promise<ChapterFileRecord | null>;
  saveChapterFile(rec: ChapterFileRecord): Promise<ChapterFileRecord | null>;
  listBackups(chapterFileId: string): Promise<ChapterBackupRecord[]>;
}

/** 服务端磁盘适配器（真源） */
export function createDiskAdapter(defaultNovelId?: string): StorageAdapter {
  return {
    async loadCurrent() {
      const novels = local.listNovels();
      const novel = defaultNovelId ? local.getNovel(defaultNovelId) : (novels[0] ?? null);
      if (!novel) return null;
      const chapters: Record<string, string> = {};
      for (const ch of local.listChapterFiles(novel.id)) {
        chapters[`第${ch.number}章`] = JSON.stringify({
          title: ch.title,
          content: ch.content,
        });
      }
      const meta = (novel.metadata ?? {}) as Record<string, string>;
      return {
        novelName: novel.title,
        totalChapters: novel.total_chapters,
        brainstorm: meta.brainstorm ?? "",
        outline: meta.outline ?? "",
        detailedOutline: meta.detailedOutline ?? "",
        characters: meta.characters ?? "",
        worldview: meta.worldview ?? "",
        goldfinger: meta.goldfinger ?? "",
        synopsis: meta.synopsis ?? "",
        opening: meta.opening ?? "",
        foreshadowing: meta.foreshadowing ?? "",
        chapters,
      };
    },

    async saveCurrent(_userId, data) {
      const id = data.novelName || defaultNovelId || "default";
      const meta = local.saveNovelMeta(id, {
        title: data.novelName,
        total_chapters: data.totalChapters,
        metadata: {
          brainstorm: data.brainstorm ?? "",
          outline: data.outline ?? "",
          detailedOutline: data.detailedOutline ?? "",
          characters: data.characters ?? "",
          worldview: data.worldview ?? "",
          goldfinger: data.goldfinger ?? "",
          synopsis: data.synopsis ?? "",
          opening: data.opening ?? "",
          foreshadowing: data.foreshadowing ?? "",
        },
      });
      if (data.chapters) {
        for (const [key, val] of Object.entries(data.chapters)) {
          const num = parseInt(key.replace(/[^0-9]/g, ""), 10) || 1;
          let title = key;
          let content = val;
          try {
            const obj = JSON.parse(val);
            title = obj.title || key;
            content = obj.content || val;
          } catch {
            /* raw */
          }
          await local.saveChapterFile({
            novel_id: meta.id,
            number: num,
            title,
            content,
          });
        }
      }
      return meta;
    },

    async loadChapters(novelId?: string) {
      if (!novelId) return {};
      const result: Record<string, string> = {};
      for (const ch of local.listChapterFiles(novelId)) {
        result[`第${ch.number}章`] = JSON.stringify({
          title: ch.title,
          content: ch.content,
        });
      }
      return result;
    },

    async saveChapter(novelId, chapterNum, title, content) {
      await local.saveChapterFile({
        novel_id: novelId,
        number: chapterNum,
        title,
        content,
      });
    },

    async listEntities(novelId) {
      return local.listEntities(novelId) as NovelEntityCard[];
    },

    async upsertEntity(card) {
      if (!card.novel_id || !card.name) return null;
      return (await local.upsertEntity({
        ...card,
        novel_id: card.novel_id,
        name: card.name,
      })) as NovelEntityCard;
    },

    async deleteEntity(entityId, novelId) {
      if (!novelId) {
        for (const n of local.listNovels()) {
          if (local.listEntities(n.id).some((e) => e.id === entityId)) {
            await local.deleteEntity(n.id, entityId);
            return;
          }
        }
        return;
      }
      await local.deleteEntity(novelId, entityId);
    },

    async listForeshadows(novelId) {
      return local.listForeshadows(novelId) as NovelForeshadow[];
    },

    async upsertForeshadow(fs) {
      if (!fs.novel_id || !fs.description) return null;
      return (await local.upsertForeshadow({
        ...fs,
        novel_id: fs.novel_id,
        description: fs.description,
      })) as NovelForeshadow;
    },

    async deleteForeshadow(fsId, novelId) {
      if (!novelId) {
        for (const n of local.listNovels()) {
          if (local.listForeshadows(n.id).some((f) => f.id === fsId)) {
            await local.deleteForeshadow(n.id, fsId);
            return;
          }
        }
        return;
      }
      await local.deleteForeshadow(novelId, fsId);
    },

    async loadChapterFile(novelId, num) {
      return local.loadChapterFile(novelId, num) as ChapterFileRecord | null;
    },

    async saveChapterFile(rec) {
      if (!rec.novel_id) return null;
      return (await local.saveChapterFile({
        novel_id: rec.novel_id,
        number: rec.number,
        title: rec.title,
        content: rec.content,
        is_final: rec.is_final,
        id: rec.id,
      })) as ChapterFileRecord;
    },

    async listBackups() {
      return [];
    },
  };
}

export async function getLocalAdapter(): Promise<StorageAdapter> {
  return createDiskAdapter();
}

/** 纯磁盘适配器（本地模式默认） */
export const dualStorageAdapter: StorageAdapter = createDiskAdapter();

// 防止未用常量被 tree-shake 掉时丢失语义
void LOCAL_USER_ID;
