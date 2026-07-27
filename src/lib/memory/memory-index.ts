/**
 * 小说记忆的可重建 SQLite FTS5 索引。
 *
 * JSON 记忆库仍是事实源；此数据库损坏、缺失或运行时不支持时均可安全降级。
 */
import "server-only";

import { projectDir } from "@/lib/local/paths";
import type { NovelMemory } from "@/lib/memory/novel-memory";

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

export interface MemoryTextSearchHit {
  memoryId: string;
  rank: number;
  score: number;
  source: "fts5" | "like";
}

const INDEX_DIR = "vault/.index";
const INDEX_FILE = "memory-index.sqlite";
const runtimeRequire = createRequire(import.meta.url);

function databaseConstructor(): typeof NodeDatabaseSync {
  return runtimeRequire("node:" + "sqlite").DatabaseSync as typeof NodeDatabaseSync;
}

export function memoryIndexPath(novelId: string): string {
  return path.join(projectDir(novelId), INDEX_DIR, INDEX_FILE);
}

function fingerprint(memories: NovelMemory[]): string {
  const state = memories
    .map((memory) => `${memory.id}:${memory.updated_at}:${memory.status}`)
    .sort()
    .join("|");
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function openIndex(novelId: string): NodeDatabaseSync {
  const filePath = memoryIndexPath(novelId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new (databaseConstructor())(filePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_documents (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      content TEXT NOT NULL,
      entities TEXT NOT NULL,
      keywords TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_path TEXT,
      source_chapter INTEGER,
      chapter_start INTEGER,
      chapter_end INTEGER,
      importance TEXT NOT NULL,
      confidence REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_id UNINDEXED,
      content,
      entities,
      keywords,
      tokenize = 'unicode61'
    );
  `);
  return database;
}

function isolateCorruptIndex(novelId: string): void {
  const filePath = memoryIndexPath(novelId);
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${filePath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const target = `${source}.corrupt.${Date.now()}`;
    try {
      fs.renameSync(source, target);
    } catch {
      // 无法隔离时保留原文件，调用方继续走 JSON 降级。
    }
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) return;
  const corruptFiles = fs
    .readdirSync(dir)
    .filter((name) => name.includes(".corrupt."))
    .sort()
    .reverse();
  for (const stale of corruptFiles.slice(6)) {
    try {
      fs.rmSync(path.join(dir, stale), { force: true });
    } catch {
      // 清理失败不影响索引重建。
    }
  }
}

function rebuildIndex(database: NodeDatabaseSync, memories: NovelMemory[], stateHash: string): void {
  const insertDocument = database.prepare(`
    INSERT INTO memory_documents (
      id, tier, kind, status, content, entities, keywords, source_type,
      source_path, source_chapter, chapter_start, chapter_end, importance,
      confidence, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = database.prepare(`
    INSERT INTO memory_fts (memory_id, content, entities, keywords)
    VALUES (?, ?, ?, ?)
  `);
  const upsertMeta = database.prepare(`
    INSERT INTO index_meta (key, value) VALUES ('memory_fingerprint', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM memory_fts; DELETE FROM memory_documents;");
    for (const memory of memories) {
      const entities = memory.entities.join(" ");
      const keywords = memory.keywords.join(" ");
      insertDocument.run(
        memory.id,
        memory.tier,
        memory.kind,
        memory.status,
        memory.content,
        entities,
        keywords,
        memory.source.type,
        memory.source.path ?? null,
        memory.source.chapter ?? null,
        memory.chapter_start ?? null,
        memory.chapter_end ?? null,
        memory.importance,
        memory.confidence,
        memory.updated_at,
      );
      insertFts.run(memory.id, memory.content, entities, keywords);
    }
    upsertMeta.run(stateHash);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function syncOpenIndex(database: NodeDatabaseSync, memories: NovelMemory[]): void {
  const stateHash = fingerprint(memories);
  const row = database.prepare("SELECT value FROM index_meta WHERE key = 'memory_fingerprint'").get() as
    | { value?: string }
    | undefined;
  if (row?.value === stateHash) return;
  rebuildIndex(database, memories, stateHash);
}

/**
 * 同步索引。首次失败会隔离数据库并重建一次；再次失败则返回 false。
 */
export function syncMemoryIndex(novelId: string, memories: NovelMemory[]): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    let database: NodeDatabaseSync | null = null;
    try {
      database = openIndex(novelId);
      syncOpenIndex(database, memories);
      database.close();
      return true;
    } catch {
      try {
        database?.close();
      } catch {
        // ignore
      }
      if (attempt === 0) isolateCorruptIndex(novelId);
    }
  }
  return false;
}

function searchTerms(query: string): string[] {
  const raw = query.toLowerCase().match(/[\u4e00-\u9fff]{2,8}|[a-z0-9_-]{2,}/g) ?? [];
  return Array.from(new Set(raw)).slice(0, 24);
}

function ftsExpression(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function normalizeBm25(value: number): number {
  return 1 / (1 + Math.abs(value));
}

function searchLike(database: NodeDatabaseSync, terms: string[], limit: number): MemoryTextSearchHit[] {
  if (!terms.length) return [];
  const clauses = terms.map(() => "(content LIKE ? OR entities LIKE ? OR keywords LIKE ?)").join(" OR ");
  const parameters = terms.flatMap((term) => {
    const pattern = `%${term}%`;
    return [pattern, pattern, pattern];
  });
  const rows = database
    .prepare(`
      SELECT id
      FROM memory_documents
      WHERE status = 'active' AND (${clauses})
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .all(...parameters, limit) as Array<{ id: string }>;
  return rows.map((row, index) => ({
    memoryId: row.id,
    rank: index + 1,
    score: 1 / (index + 1),
    source: "like",
  }));
}

export function searchMemoryIndex(input: {
  novelId: string;
  memories: NovelMemory[];
  query: string;
  limit?: number;
}): MemoryTextSearchHit[] {
  const terms = searchTerms(input.query);
  if (!terms.length) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!syncMemoryIndex(input.novelId, input.memories)) return [];
    let database: NodeDatabaseSync | null = null;
    try {
      database = openIndex(input.novelId);
      const limit = Math.max(1, Math.min(100, input.limit ?? 40));
      const rows = database
        .prepare(`
          SELECT memory_fts.memory_id AS memoryId, bm25(memory_fts, 0.0, 1.0, 2.0, 1.5) AS bm25Rank
          FROM memory_fts
          JOIN memory_documents ON memory_documents.id = memory_fts.memory_id
          WHERE memory_fts MATCH ? AND memory_documents.status = 'active'
          ORDER BY bm25Rank
          LIMIT ?
        `)
        .all(ftsExpression(terms), limit) as Array<{
        memoryId: string;
        bm25Rank: number;
      }>;
      const hits: MemoryTextSearchHit[] = rows.map((row, index) => ({
        memoryId: row.memoryId,
        rank: index + 1,
        score: normalizeBm25(row.bm25Rank),
        source: "fts5" as const,
      }));
      const seen = new Set(hits.map((hit) => hit.memoryId));
      for (const fallback of searchLike(database, terms, limit)) {
        if (seen.has(fallback.memoryId)) continue;
        hits.push({ ...fallback, rank: hits.length + 1 });
        if (hits.length >= limit) break;
      }
      database.close();
      return hits;
    } catch {
      try {
        database?.close();
      } catch {
        // ignore
      }
      if (attempt === 0) isolateCorruptIndex(input.novelId);
    }
  }
  return [];
}

export function isRebuildableMemoryIndexPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  return normalized.startsWith("vault/.index/") || normalized.includes("/vault/.index/");
}
