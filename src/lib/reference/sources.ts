/**
 * 书源包加载与缓存
 * - 优先读本地磁盘（避开 Next.js 对 >2MB fetch 的 data cache 限制）
 * - 内存缓存 1h
 * - 默认 8 个远程包（用户指定）
 */
import "server-only";

import { cleanBaseUrl, sourceUsesJs } from "./legado-rule";
import type { BookSource } from "./types";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_SOURCE_PACKS = [
  "https://gcore.jsdelivr.net/gh/yuedu520/yuedu/250422.json",
  "https://gcore.jsdelivr.net/gh/yuedu520/yuedu/250410.json",
  "https://gcore.jsdelivr.net/gh/yuedu520/yuedu/250412.json",
  "https://gcore.jsdelivr.net/gh/yuedu520/yuedu/250415.json",
  "https://gcore.jsdelivr.net/gh/yuedu520/yuedu/250416.json",
  "https://gcore.jsdelivr.net/gh/yuedu520/yuedu/250424.json",
  "https://gcore.jsdelivr.net/gh/yuedu520/yuedu/2504241.json",
  "https://www.yckceo.com/yuedu/shuyuans/json/id/772.json",
] as const;

/** 本地优先目录：已下载的包 / 运行时落盘 */
const LOCAL_DIRS = [path.join("D:", "tmp", "book_sources"), path.join(process.cwd(), ".data", "book-sources")];

type Cache = {
  at: number;
  all: BookSource[];
  runnable: BookSource[];
};

let cache: Cache | null = null;
const TTL_MS = 60 * 60 * 1000;

function packFileName(url: string): string {
  // 772.json 或 250422.json
  const base = url.split("/").pop() || "pack.json";
  if (base.endsWith(".json")) return base;
  return `${createHash("sha1").update(url).digest("hex").slice(0, 12)}.json`;
}

function findLocalFile(url: string): string | null {
  const name = packFileName(url);
  for (const dir of LOCAL_DIRS) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function ensureCacheDir(): string {
  const dir = path.join(process.cwd(), ".data", "book-sources");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function parsePackJson(text: string, pack: string): BookSource[] {
  const data = JSON.parse(text) as unknown;
  if (!Array.isArray(data)) return [];
  return data
    .filter((x): x is BookSource => !!x && typeof x === "object" && !!(x as BookSource).bookSourceName)
    .map((s) => ({ ...s, _pack: pack }));
}

async function fetchPack(url: string): Promise<BookSource[]> {
  const name = packFileName(url);

  // 1) 本地文件（无 Next data cache、无 2MB 限制）
  const local = findLocalFile(url);
  if (local) {
    try {
      const text = readFileSync(local, "utf8");
      return parsePackJson(text, name);
    } catch (e) {
      console.warn(`[book-sources] local read fail ${local}:`, e instanceof Error ? e.message : e);
    }
  }

  // 2) 远程下载 — 用原生 fetch + cache:no-store，并落盘，下次走本地
  // 不传 next.revalidate，避免 Next Data Cache 写 >2MB 报错
  const res = await fetch(url, {
    headers: {
      "User-Agent": "withyou-novel/1.0",
      Accept: "application/json,text/plain,*/*",
    },
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`pack ${url} HTTP ${res.status}`);
  const text = await res.text();

  try {
    const dir = ensureCacheDir();
    writeFileSync(path.join(dir, name), text, "utf8");
  } catch (e) {
    console.warn("[book-sources] disk cache write fail:", e instanceof Error ? e.message : e);
  }

  return parsePackJson(text, name);
}

export async function loadBookSources(force = false): Promise<Cache> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;

  const results = await Promise.allSettled(DEFAULT_SOURCE_PACKS.map((u) => fetchPack(u)));
  const all: BookSource[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
    else console.warn("[book-sources] pack fail:", r.reason);
  }

  const map = new Map<string, BookSource>();
  for (const s of all) {
    const key = `${s.bookSourceName}::${cleanBaseUrl(s.bookSourceUrl || "")}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, s);
      continue;
    }
    const pw = prev.weight ?? 0;
    const sw = s.weight ?? 0;
    if (sw > pw || (sw === pw && (s.respondTime ?? 99999) < (prev.respondTime ?? 99999))) {
      map.set(key, s);
    }
  }
  const deduped = Array.from(map.values());

  // 优先：JSON API 源（更稳）+ 高 weight
  const runnable = deduped
    .filter((s) => s.enabled !== false)
    .filter((s) => (s.bookSourceType ?? 0) === 0)
    .filter((s) => !!s.searchUrl && !!s.ruleSearch?.bookList)
    .filter((s) => !sourceUsesJs(s as never))
    .sort((a, b) => {
      const aj = String(a.ruleSearch?.bookList || "").match(/^\$|^json/i) ? 1 : 0;
      const bj = String(b.ruleSearch?.bookList || "").match(/^\$|^json/i) ? 1 : 0;
      if (bj !== aj) return bj - aj;
      return (b.weight ?? 0) - (a.weight ?? 0) || (a.respondTime ?? 99999) - (b.respondTime ?? 99999);
    });

  cache = { at: Date.now(), all: deduped, runnable };
  const ok = results.filter((r) => r.status === "fulfilled").length;
  console.info(`[book-sources] packs ok=${ok}/${results.length} total=${deduped.length} runnable=${runnable.length}`);
  return cache;
}

export async function listRunnableSources(limit = 80): Promise<BookSource[]> {
  const { runnable } = await loadBookSources();
  return runnable.slice(0, limit);
}

export async function findSourceByName(name: string): Promise<BookSource | undefined> {
  const { all } = await loadBookSources();
  return all.find((s) => s.bookSourceName === name);
}

export async function getSourceStats() {
  const c = await loadBookSources();
  return {
    total: c.all.length,
    runnable: c.runnable.length,
    packs: DEFAULT_SOURCE_PACKS.length,
    cachedAt: c.at,
  };
}
