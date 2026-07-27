/**
 * 本地 Vault / 实体 / 章节 / 小说元数据
 * 落盘: novels/<novelId>/vault/*.json + 正文/（章节正文仍走 novel-fs）
 */
import "server-only";

import { ALIAS_METADATA_KEY, findEntityByIdentity, mergeAliases, readAliases } from "@/lib/entities/alias-registry";
import { novelFS } from "@/lib/novel-fs";

import { newId, nowIso, readCollection, readJsonFile, updateCollection, writeJsonFile } from "./json-db";
import { LOCAL_USER_ID, novelsBaseDir, projectDir, sanitizeNovelId, vaultDir } from "./paths";
import * as fs from "node:fs";
import * as path from "node:path";

export type ForeshadowState = "planted" | "activated" | "dormant" | "resolved" | "abandoned";

export interface LocalNovelMeta {
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

export interface LocalEntity {
  id: string;
  novel_id: string;
  user_id?: string;
  name: string;
  type: "character" | "location" | "item" | "faction" | "event" | "other";
  importance: "high" | "mid" | "low" | string;
  active_state: "active" | "cooling" | "resolved" | "abandoned" | string;
  summary: string;
  last_chapter?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface LocalForeshadow {
  id: string;
  novel_id: string;
  description: string;
  plant_chapter?: number;
  target_resolve_chapter?: number;
  actual_resolve_chapter?: number;
  activated_chapter?: number;
  state: ForeshadowState;
  related_entity_ids?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface LocalTimelineEvent {
  id: string;
  novel_id: string;
  entity_name?: string;
  chapter?: number;
  description: string;
  created_at: string;
}

export interface LocalSnapshot {
  id: string;
  novel_id: string;
  chapter: number;
  data: Record<string, unknown>;
  interval_type: "snapshot" | "archive";
  created_at: string;
}

export interface LocalChapterFile {
  id: string;
  novel_id: string;
  number: number;
  title: string;
  content: string;
  word_count: number;
  is_final: boolean;
  updated_at: string;
}

function metaPath(novelId: string) {
  return path.join(vaultDir(novelId), "meta.json");
}

function ensureProject(novelId: string, title?: string): LocalNovelMeta {
  const id = sanitizeNovelId(novelId);
  const dir = projectDir(id);
  if (!fs.existsSync(dir)) {
    novelFS.createProject(id);
  }
  const p = metaPath(id);
  if (!fs.existsSync(p)) {
    const now = nowIso();
    const meta: LocalNovelMeta = {
      id,
      user_id: LOCAL_USER_ID,
      title: title ?? id,
      genre: null,
      summary: null,
      total_chapters: 0,
      metadata: {},
      created_at: now,
      updated_at: now,
    };
    writeJsonFile(p, meta);
    return meta;
  }
  return readJsonFile<LocalNovelMeta>(p, {
    id,
    user_id: LOCAL_USER_ID,
    title: id,
    genre: null,
    summary: null,
    total_chapters: 0,
    metadata: {},
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

// ─── novels ───

export function listNovels(): LocalNovelMeta[] {
  const base = novelsBaseDir();
  if (!fs.existsSync(base)) return [];
  const out: LocalNovelMeta[] = [];
  for (const name of fs.readdirSync(base)) {
    const full = path.join(base, name);
    if (!fs.statSync(full).isDirectory()) continue;
    out.push(ensureProject(name));
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getNovel(novelId: string): LocalNovelMeta | null {
  try {
    return ensureProject(novelId);
  } catch {
    return null;
  }
}

export function saveNovelMeta(
  novelId: string,
  patch: Partial<LocalNovelMeta> & { title?: string; metadata?: Record<string, unknown> },
): LocalNovelMeta {
  const cur = ensureProject(novelId, patch.title);
  const next: LocalNovelMeta = {
    ...cur,
    ...patch,
    id: cur.id,
    user_id: LOCAL_USER_ID,
    metadata: { ...cur.metadata, ...(patch.metadata || {}) },
    updated_at: nowIso(),
  };
  writeJsonFile(metaPath(cur.id), next);
  return next;
}

// ─── entities ───

export function listEntities(novelId: string): LocalEntity[] {
  ensureProject(novelId);
  return readCollection<LocalEntity>(novelId, "entities");
}

/**
 * 落库前先做别名对账：没带 id 时，按归一化正式名 + 别名找出同一实体再合并，
 * 避免 AI 每换一个称呼就新建一条影子实体（详见 lib/entities/alias-registry.ts）。
 */
export async function upsertEntity(
  card: Partial<LocalEntity> & { novel_id: string; name: string },
): Promise<LocalEntity> {
  ensureProject(card.novel_id);
  const now = nowIso();
  const incomingAliases = readAliases(card.metadata);
  let result: LocalEntity | null = null;
  await updateCollection<LocalEntity>(card.novel_id, "entities", (rows) => {
    let idx = card.id ? rows.findIndex((r) => r.id === card.id) : -1;
    // 显式 id 优先；没有（或找不到）才走别名对账。
    if (idx < 0) {
      const matched = findEntityByIdentity(rows, card.name, incomingAliases, card.type);
      if (matched) idx = rows.findIndex((r) => r.id === matched.id);
    }
    if (idx >= 0) {
      const previous = rows[idx];
      // 换了称呼时，把旧正式名收进别名，保留可追溯性。
      const aliasPool = mergeAliases([...readAliases(previous.metadata), previous.name], incomingAliases, card.name);
      const updated: LocalEntity = {
        ...previous,
        ...card,
        id: previous.id,
        novel_id: card.novel_id,
        metadata: {
          ...(previous.metadata ?? {}),
          ...(card.metadata ?? {}),
          [ALIAS_METADATA_KEY]: aliasPool,
        },
        updated_at: now,
      };
      rows[idx] = updated;
      result = updated;
      return rows;
    }
    const created: LocalEntity = {
      id: card.id || newId(),
      novel_id: card.novel_id,
      user_id: LOCAL_USER_ID,
      name: card.name,
      type: (card.type as LocalEntity["type"]) || "character",
      importance: card.importance || "mid",
      active_state: card.active_state || "active",
      summary: card.summary || "",
      last_chapter: card.last_chapter,
      metadata: {
        ...(card.metadata ?? {}),
        [ALIAS_METADATA_KEY]: mergeAliases([], incomingAliases, card.name),
      },
      created_at: now,
      updated_at: now,
    };
    rows.push(created);
    result = created;
    return rows;
  });
  if (!result) throw new Error("[store] upsertEntity updater 未执行");
  return result;
}

export async function deleteEntity(novelId: string, entityId: string): Promise<void> {
  ensureProject(novelId);
  await updateCollection<LocalEntity>(novelId, "entities", (rows) => rows.filter((r) => r.id !== entityId));
}

export function getEntity(novelId: string, entityId: string): LocalEntity | null {
  return listEntities(novelId).find((r) => r.id === entityId) ?? null;
}

// ─── foreshadows ───

export function listForeshadows(novelId: string): LocalForeshadow[] {
  ensureProject(novelId);
  return readCollection<LocalForeshadow>(novelId, "foreshadows");
}

export async function upsertForeshadow(
  fsRow: Partial<LocalForeshadow> & { novel_id: string; description: string },
): Promise<LocalForeshadow> {
  ensureProject(fsRow.novel_id);
  const now = nowIso();
  let result: LocalForeshadow | null = null;
  await updateCollection<LocalForeshadow>(fsRow.novel_id, "foreshadows", (rows) => {
    const idx = fsRow.id ? rows.findIndex((r) => r.id === fsRow.id) : -1;
    if (idx >= 0) {
      const updated: LocalForeshadow = {
        ...rows[idx],
        ...fsRow,
        id: rows[idx].id,
        novel_id: fsRow.novel_id,
        updated_at: now,
      };
      rows[idx] = updated;
      result = updated;
      return rows;
    }
    const created: LocalForeshadow = {
      id: fsRow.id || newId(),
      novel_id: fsRow.novel_id,
      description: fsRow.description,
      plant_chapter: fsRow.plant_chapter,
      target_resolve_chapter: fsRow.target_resolve_chapter,
      actual_resolve_chapter: fsRow.actual_resolve_chapter,
      activated_chapter: fsRow.activated_chapter,
      state: fsRow.state || "planted",
      related_entity_ids: fsRow.related_entity_ids || [],
      created_at: now,
      updated_at: now,
    };
    rows.push(created);
    result = created;
    return rows;
  });
  if (!result) throw new Error("[store] upsertForeshadow updater 未执行");
  return result;
}

export async function deleteForeshadow(novelId: string, id: string): Promise<void> {
  ensureProject(novelId);
  await updateCollection<LocalForeshadow>(novelId, "foreshadows", (rows) => rows.filter((r) => r.id !== id));
}

export function listActiveForeshadows(novelId: string, limit = 10): LocalForeshadow[] {
  return listForeshadows(novelId)
    .filter((f) => f.state === "planted" || f.state === "activated")
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    .slice(0, limit);
}

export async function recycleDormant(novelId: string, currentChapter: number, window = 15): Promise<number> {
  ensureProject(novelId);
  let n = 0;
  await updateCollection<LocalForeshadow>(novelId, "foreshadows", (rows) => {
    for (const f of rows) {
      if (f.state === "planted" && f.plant_chapter != null && currentChapter - f.plant_chapter > window) {
        f.state = "dormant";
        f.updated_at = nowIso();
        n++;
      }
    }
    return n > 0 ? rows : null;
  });
  return n;
}

// ─── timeline ───

export function listTimeline(novelId: string, limit = 50): LocalTimelineEvent[] {
  ensureProject(novelId);
  return readCollection<LocalTimelineEvent>(novelId, "timeline")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export async function addTimelineEvent(
  novelId: string,
  input: { entityName?: string; chapter?: number; description: string },
): Promise<LocalTimelineEvent> {
  ensureProject(novelId);
  const ev: LocalTimelineEvent = {
    id: newId(),
    novel_id: novelId,
    entity_name: input.entityName,
    chapter: input.chapter,
    description: input.description,
    created_at: nowIso(),
  };
  await updateCollection<LocalTimelineEvent>(novelId, "timeline", (rows) => {
    rows.push(ev);
    return rows;
  });
  return ev;
}

export async function upsertTimelineEvent(
  novelId: string,
  input: {
    id?: string;
    entityName?: string;
    chapter?: number;
    description: string;
  },
): Promise<LocalTimelineEvent> {
  ensureProject(novelId);
  let result: LocalTimelineEvent | null = null;
  await updateCollection<LocalTimelineEvent>(novelId, "timeline", (rows) => {
    const index = input.id ? rows.findIndex((row) => row.id === input.id) : -1;
    if (index < 0) {
      const created: LocalTimelineEvent = {
        id: newId(),
        novel_id: novelId,
        entity_name: input.entityName,
        chapter: input.chapter,
        description: input.description,
        created_at: nowIso(),
      };
      rows.push(created);
      result = created;
      return rows;
    }
    const updated: LocalTimelineEvent = {
      ...rows[index],
      entity_name: input.entityName,
      chapter: input.chapter,
      description: input.description,
    };
    rows[index] = updated;
    result = updated;
    return rows;
  });
  if (!result) throw new Error("[store] upsertTimelineEvent updater 未执行");
  return result;
}

export async function deleteTimelineEvent(novelId: string, eventId: string): Promise<void> {
  ensureProject(novelId);
  await updateCollection<LocalTimelineEvent>(novelId, "timeline", (rows) => rows.filter((row) => row.id !== eventId));
}

// ─── snapshots ───

export function listSnapshots(novelId: string): LocalSnapshot[] {
  ensureProject(novelId);
  return readCollection<LocalSnapshot>(novelId, "snapshots").sort((a, b) => b.chapter - a.chapter);
}

export async function addSnapshot(
  novelId: string,
  chapter: number,
  data: Record<string, unknown>,
  interval_type: "snapshot" | "archive" = "snapshot",
): Promise<LocalSnapshot> {
  ensureProject(novelId);
  const snap: LocalSnapshot = {
    id: newId(),
    novel_id: novelId,
    chapter,
    data,
    interval_type,
    created_at: nowIso(),
  };
  await updateCollection<LocalSnapshot>(novelId, "snapshots", (rows) => {
    rows.push(snap);
    return rows;
  });
  return snap;
}

export function latestSnapshot(novelId: string): LocalSnapshot | null {
  return listSnapshots(novelId)[0] ?? null;
}

// ─── chapter_files（与 novel-fs 正文同步：优先 vault 索引，正文内容可读 正文/） ───

export function listChapterFiles(novelId: string): LocalChapterFile[] {
  ensureProject(novelId);
  const fromVault = readCollection<LocalChapterFile>(novelId, "chapter_files");
  if (fromVault.length) return fromVault.sort((a, b) => a.number - b.number);
  // 从 novel-fs 正文目录合成
  return novelFS.listChapters(novelId).map((c) => {
    const content = novelFS.readChapter(novelId, c.number) ?? "";
    return {
      id: `${novelId}-ch-${c.number}`,
      novel_id: novelId,
      number: c.number,
      title: c.title,
      content,
      word_count: content.length,
      is_final: false,
      updated_at: c.updatedAt.toISOString(),
    };
  });
}

export function loadChapterFile(novelId: string, num: number): LocalChapterFile | null {
  const rows = listChapterFiles(novelId);
  const hit = rows.find((r) => r.number === num);
  if (hit) return hit;
  const content = novelFS.readChapter(novelId, num);
  if (content == null) return null;
  return {
    id: `${novelId}-ch-${num}`,
    novel_id: novelId,
    number: num,
    title: `第${num}章`,
    content,
    word_count: content.length,
    is_final: false,
    updated_at: nowIso(),
  };
}

export async function saveChapterFile(rec: {
  novel_id: string;
  number: number;
  title: string;
  content: string;
  is_final?: boolean;
  id?: string;
}): Promise<LocalChapterFile> {
  ensureProject(rec.novel_id);
  // 写正文 md（novel-fs 有独立的文件，不与集合锁竞争）
  novelFS.writeChapter(rec.novel_id, rec.number, rec.title, rec.content);
  const now = nowIso();
  let row: LocalChapterFile | null = null;
  let maxNum = rec.number;
  await updateCollection<LocalChapterFile>(rec.novel_id, "chapter_files", (rows) => {
    const idx = rows.findIndex((r) => r.number === rec.number);
    const next: LocalChapterFile = {
      id: rec.id ?? (idx >= 0 ? rows[idx].id : newId()),
      novel_id: rec.novel_id,
      number: rec.number,
      title: rec.title,
      content: rec.content,
      word_count: rec.content.length,
      is_final: rec.is_final ?? false,
      updated_at: now,
    };
    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
    row = next;
    maxNum = Math.max(maxNum, ...rows.map((r) => r.number));
    return rows;
  });
  if (!row) throw new Error("[store] saveChapterFile updater 未执行");

  // 更新 meta total_chapters
  const meta = ensureProject(rec.novel_id);
  saveNovelMeta(rec.novel_id, { total_chapters: Math.max(meta.total_chapters, maxNum) });
  return row;
}

export function assembleVaultPrompt(novelId: string, cfg = { maxFs: 10, maxTl: 10 }) {
  const foreshadows = listActiveForeshadows(novelId, cfg.maxFs);
  const timeline = listTimeline(novelId, cfg.maxTl);
  return {
    activeForeshadows: foreshadows.map((f) => ({
      description: f.description,
      plant_chapter: f.plant_chapter,
      state: f.state,
    })),
    recentTimeline: timeline.map((t) => ({
      entity_name: t.entity_name,
      chapter: t.chapter,
      description: t.description,
    })),
  };
}
