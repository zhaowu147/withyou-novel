/**
 * 存储相关类型 — 无 Node API，客户端可安全 import type / import
 */

export interface NovelMeta {
  id: string;
  user_id: string;
  title: string;
  genre: string | null;
  summary: string | null;
  total_chapters: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface NovelEntityCard {
  id?: string;
  novel_id?: string;
  name: string;
  type: "character" | "location" | "item" | "faction" | "event" | "other";
  importance: "high" | "mid" | "low";
  active_state: "active" | "cooling" | "resolved" | "abandoned";
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface NovelForeshadow {
  id?: string;
  novel_id?: string;
  description: string;
  plant_chapter?: number;
  target_resolve_chapter?: number;
  actual_resolve_chapter?: number;
  state: "planted" | "activated" | "dormant" | "resolved" | "abandoned";
  related_entity_ids?: string[];
}

export interface ChapterFileRecord {
  id?: string;
  novel_id?: string;
  number: number;
  title: string;
  content: string;
  word_count: number;
  is_final: boolean;
  updated_at?: string;
}

export interface ChapterBackupRecord {
  id?: string;
  chapter_file_id?: string;
  content: string;
  word_count: number;
  reason: string;
  created_at?: string;
}
