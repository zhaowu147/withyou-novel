/**
 * 书源搜索 / 目录 / 正文 执行引擎
 */
import "server-only";

import {
  absUrl,
  cleanBaseUrl,
  expandTemplate,
  getElements,
  getString,
  hasUnsupportedJs,
  isJsonPath,
  isUrlTemplate,
  jsonPathGet,
  jsonPick,
  loadHtml,
  parseHeaderField,
  parseSearchUrlTemplate,
  sourceUsesJs,
} from "./legado-rule";
import { findSourceByName, listRunnableSources } from "./sources";
import type { BookSource, ChapterHit, ContentHit, SearchHit } from "./types";

const UA_FALLBACK =
  "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

/** 字段取值：JSON path / 模板 / 简单 key */
function pickFromItem(item: unknown, rule?: string): string {
  if (!rule || !item || typeof item !== "object") return "";
  const r = rule.trim();
  if (!r || hasUnsupportedJs(r)) return "";
  // 模板
  if (r.includes("{{")) {
    return expandTemplate(r, item).replace(/\n+/g, " ").trim();
  }
  if (isJsonPath(r) || r.includes(".") || r.startsWith("$")) {
    const v = jsonPick(item, r);
    return v != null && typeof v !== "object" ? String(v) : v != null ? JSON.stringify(v) : "";
  }
  const o = item as Record<string, unknown>;
  if (r in o) return o[r] != null ? String(o[r]) : "";
  return "";
}

function stripJsSuffix(rule?: string): string {
  if (!rule) return "";
  // path@js:... → path
  const i = rule.search(/@js:|<js>/i);
  if (i >= 0) return rule.slice(0, i).trim();
  return rule.trim();
}

async function fetchText(
  url: string,
  opts: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    charset?: string;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      "User-Agent": UA_FALLBACK,
      Accept: "text/html,application/json,application/xhtml+xml,*/*",
      ...opts.headers,
    },
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    redirect: "follow",
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const charset = (opts.charset || "").toLowerCase();
  if (charset.includes("gb") || charset === "gbk" || charset === "gb2312") {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
  const head = buf.subarray(0, 1024).toString("latin1");
  if (/charset\s*=\s*["']?gb/i.test(head)) {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      /* fallthrough */
    }
  }
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

function tryParseJson(text: string): unknown | null {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function searchOneSource(src: BookSource, key: string): Promise<SearchHit[]> {
  if (!src.searchUrl || sourceUsesJs(src as never)) return [];
  const base = cleanBaseUrl(src.bookSourceUrl || "");
  if (!base) return [];

  const tpl = parseSearchUrlTemplate(src.searchUrl, base, key, 1);
  if (hasUnsupportedJs(tpl.url)) return [];

  const headers = {
    ...parseHeaderField(src.header, base),
    ...tpl.headers,
  };

  let text: string;
  try {
    text = await fetchText(tpl.url, {
      method: tpl.method,
      headers,
      body: tpl.body,
      charset: tpl.charset,
      timeoutMs: 10_000,
    });
  } catch {
    return [];
  }

  const rs = src.ruleSearch || {};
  const hits: SearchHit[] = [];

  // JSON 书源
  const json = tryParseJson(text);
  if (json && rs.bookList && isJsonPath(String(rs.bookList))) {
    const items = jsonPathGet(json, String(rs.bookList));
    for (const item of items.slice(0, 20)) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const title = pickFromItem(item, rs.name) || String(o.name || o.title || o.bookName || o.novelName || "");
      const author = pickFromItem(item, rs.author) || String(o.author || o.authorName || o.author_name || "");
      let bookUrl =
        pickFromItem(item, rs.bookUrl) || String(o.bookUrl || o.url || o.novelId || o.novel_id || o.id || "");
      // bookUrl 规则是模板：/novel/{{$.novelId}}
      if (rs.bookUrl && (isUrlTemplate(rs.bookUrl) || rs.bookUrl.includes("{{"))) {
        bookUrl = expandTemplate(rs.bookUrl, item, { baseUrl: base });
      }
      if (!title || !bookUrl) continue;
      if (!/^https?:/i.test(bookUrl) && !bookUrl.startsWith("/")) bookUrl = `/${bookUrl}`;
      bookUrl = absUrl(base, bookUrl);
      hits.push({
        title: title.trim(),
        author: author.trim() || "未知",
        url: bookUrl,
        cover: pickFromItem(item, rs.coverUrl) || (typeof o.cover === "string" ? o.cover : undefined),
        intro: pickFromItem(item, rs.intro) || undefined,
        source: src.bookSourceName,
        sourceUrl: base,
        lastChapter: pickFromItem(item, rs.lastChapter) || undefined,
      });
    }
    return hits;
  }

  // HTML + CSS
  const $ = loadHtml(text);
  const listRule = rs.bookList || "";
  if (hasUnsupportedJs(listRule) || isJsonPath(listRule) || isUrlTemplate(listRule)) return [];

  const els = getElements($, listRule);
  for (const el of els.slice(0, 25)) {
    const title = getString($, rs.name, el);
    const author = getString($, rs.author, el);
    let bookUrl = getString($, rs.bookUrl, el);
    if (!title || !bookUrl) continue;
    bookUrl = absUrl(tpl.url, bookUrl);
    const cover = getString($, rs.coverUrl, el);
    hits.push({
      title: title.trim(),
      author: (author || "未知").trim(),
      url: bookUrl,
      cover: cover ? absUrl(base, cover) : undefined,
      intro: getString($, rs.intro, el) || undefined,
      source: src.bookSourceName,
      sourceUrl: base,
      lastChapter: getString($, rs.lastChapter, el) || undefined,
    });
  }
  return hits;
}

/** 并行搜多个书源，合并去重 */
export async function searchBooks(
  q: string,
  opts?: { concurrency?: number; limitSources?: number },
): Promise<{
  results: SearchHit[];
  tried: number;
  ok: number;
  stats: { total: number; runnable: number };
}> {
  const limit = opts?.limitSources ?? 48;
  const concurrency = opts?.concurrency ?? 10;
  const sources = await listRunnableSources(limit);

  let ok = 0;
  let tried = 0;
  const all: SearchHit[] = [];
  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    tried += batch.length;
    const settled = await Promise.allSettled(batch.map((s) => searchOneSource(s, q)));
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value.length) {
        ok++;
        all.push(...r.value);
      }
    }
    if (all.length >= 30) break;
  }

  const seen = new Set<string>();
  const results: SearchHit[] = [];
  for (const h of all) {
    const k = `${h.title}::${h.author}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    results.push(h);
    if (results.length >= 60) break;
  }

  const { loadBookSources } = await import("./sources");
  const st = await loadBookSources();
  return {
    results,
    tried,
    ok,
    stats: { total: st.all.length, runnable: st.runnable.length },
  };
}

export async function loadChapters(
  bookUrl: string,
  sourceName?: string,
): Promise<{ title: string; author: string; chapters: ChapterHit[]; source?: string }> {
  let src: BookSource | undefined = sourceName ? await findSourceByName(sourceName) : undefined;
  if (!src) {
    const list = await listRunnableSources(200);
    try {
      const host = new URL(bookUrl).host;
      src = list.find((s) => cleanBaseUrl(s.bookSourceUrl || "").includes(host));
    } catch {
      /* ignore */
    }
  }
  if (!src) {
    return loadChaptersGeneric(bookUrl);
  }

  const base = cleanBaseUrl(src.bookSourceUrl || "");
  const headers = parseHeaderField(src.header, base);
  let text: string;
  try {
    text = await fetchText(bookUrl, { headers, timeoutMs: 12_000 });
  } catch {
    return { title: "", author: "", chapters: [] };
  }

  const bi = src.ruleBookInfo || {};
  let json: unknown | null = tryParseJson(text);

  // init 规则：$.data 作为详情上下文
  let infoCtx: unknown = json;
  if (json && bi.init && isJsonPath(bi.init)) {
    const inited = jsonPick(json, bi.init);
    if (inited != null) infoCtx = inited;
  }

  // tocUrl：URL 模板（如 /novel/{{$.novelId}}/chapters?readNum=1）
  // 禁止当 CSS 选择器解析
  if (bi.tocUrl && !hasUnsupportedJs(bi.tocUrl)) {
    let tocPath = "";
    if (isUrlTemplate(bi.tocUrl) || bi.tocUrl.includes("{{")) {
      // 上下文：详情 JSON + 从 bookUrl 抽 id
      const idFromUrl = bookUrl.match(/\/novel\/(\d+)/)?.[1] || bookUrl.match(/\/(\d+)(?:\?|$)/)?.[1];
      const ctx =
        infoCtx && typeof infoCtx === "object"
          ? { ...(infoCtx as object), novelId: (infoCtx as { novelId?: string }).novelId || idFromUrl }
          : { novelId: idFromUrl };
      tocPath = expandTemplate(bi.tocUrl, ctx, { baseUrl: base });
      // 模板未展开干净时（仍含 {{）→ 用 id 硬拼常见路径
      if (tocPath.includes("{{") && idFromUrl) {
        tocPath = `/novel/${idFromUrl}/chapters?readNum=1`;
      }
    } else if (!isJsonPath(bi.tocUrl) && !bi.tocUrl.includes("@")) {
      // 普通相对路径字符串
      tocPath = bi.tocUrl.trim().split(",{")[0].trim();
    } else if (!isUrlTemplate(bi.tocUrl) && !isJsonPath(bi.tocUrl)) {
      // 旧 HTML 规则：从页面抽 toc 链接
      const $info = loadHtml(text);
      tocPath = getString($info, bi.tocUrl);
    }

    if (tocPath && !tocPath.includes("{{")) {
      const tocAbs = absUrl(bookUrl.startsWith("http") ? bookUrl : base, tocPath);
      try {
        text = await fetchText(tocAbs, { headers, timeoutMs: 12_000 });
        bookUrl = tocAbs;
        json = tryParseJson(text);
      } catch {
        /* keep original */
      }
    }
  }

  // ── JSON 目录 ──
  const toc = src.ruleToc || {};
  if (json && toc.chapterList && isJsonPath(toc.chapterList)) {
    const items = jsonPathGet(json, toc.chapterList);
    const chapters: ChapterHit[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const ct = pickFromItem(item, toc.chapterName) || String((item as { chapterName?: string }).chapterName || "");
      const cuRaw = stripJsSuffix(toc.chapterUrl);
      let cu = "";
      if (cuRaw && (isUrlTemplate(cuRaw) || cuRaw.includes("{{"))) {
        cu = expandTemplate(cuRaw, item, { baseUrl: base });
      } else if (cuRaw && isJsonPath(cuRaw)) {
        cu = pickFromItem(item, cuRaw);
      } else if (cuRaw) {
        cu = pickFromItem(item, cuRaw);
      }
      // AES@js 解密我们做不了：若只有密文 path，跳过该章或标为不可读
      if (!ct) continue;
      if (!cu || cu.includes("{{")) {
        // 仍给占位，避免空目录；read 时会失败并提示
        const id = (item as { chapterId?: string; id?: string }).chapterId || (item as { id?: string }).id;
        if (id) cu = String(id);
        else continue;
      }
      chapters.push({ title: ct.trim(), url: absUrl(bookUrl, cu) });
    }
    const title = pickFromItem(infoCtx, bi.name) || pickFromItem(json, bi.name) || "";
    const author = pickFromItem(infoCtx, bi.author) || pickFromItem(json, bi.author) || "";
    if (chapters.length) {
      return { title, author, chapters, source: src.bookSourceName };
    }
  }

  // ── HTML 目录 ──
  const $ = loadHtml(text);
  const title = getString($, bi.name) || ($("title").text() || "").split(/[_|-]/)[0].trim() || "";
  const author = getString($, bi.author) || "";

  const chapters: ChapterHit[] = [];
  if (
    toc.chapterList &&
    !hasUnsupportedJs(toc.chapterList) &&
    !isJsonPath(toc.chapterList) &&
    !isUrlTemplate(toc.chapterList)
  ) {
    const els = getElements($, toc.chapterList);
    for (const el of els) {
      const ct = getString($, toc.chapterName || "text", el) || el.text().trim();
      let cu = getString($, stripJsSuffix(toc.chapterUrl) || "href", el);
      if (!cu) cu = el.attr("href") || el.find("a").attr("href") || "";
      if (!ct || !cu) continue;
      chapters.push({ title: ct.trim(), url: absUrl(bookUrl, cu) });
    }
  }

  if (!chapters.length) {
    const generic = await loadChaptersGeneric(bookUrl, text);
    return { ...generic, source: src.bookSourceName };
  }

  return { title, author, chapters, source: src.bookSourceName };
}

async function loadChaptersGeneric(
  bookUrl: string,
  html?: string,
): Promise<{
  title: string;
  author: string;
  chapters: ChapterHit[];
}> {
  const text =
    html ||
    (await fetchText(bookUrl, {
      headers: { "User-Agent": UA_FALLBACK },
      timeoutMs: 12_000,
    }).catch(() => ""));
  if (!text) return { title: "", author: "", chapters: [] };
  const $ = loadHtml(text);
  const title = ($("title").text() || "").split(/[_|-]/)[0].trim();
  const chapters: ChapterHit[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    const t = $(a).text().replace(/\s+/g, " ").trim();
    if (!t || t.length > 60) return;
    if (!/第?\s*\d+\s*章|chapter|\.html|\.htm|\/\d+/i.test(`${t} ${href}`)) return;
    if (/登录|注册|首页|书架|排行/i.test(t)) return;
    const u = absUrl(bookUrl, href);
    if (seen.has(u)) return;
    seen.add(u);
    chapters.push({ title: t, url: u });
  });
  return { title, author: "", chapters: chapters.slice(0, 500) };
}

export async function readChapter(chapterUrl: string, sourceName?: string): Promise<ContentHit> {
  let src: BookSource | undefined = sourceName ? await findSourceByName(sourceName) : undefined;
  if (!src) {
    const list = await listRunnableSources(200);
    try {
      const host = new URL(chapterUrl).host;
      src = list.find((s) => cleanBaseUrl(s.bookSourceUrl || "").includes(host));
    } catch {
      /* */
    }
  }

  const base = src ? cleanBaseUrl(src.bookSourceUrl || "") : chapterUrl;
  const headers = src ? parseHeaderField(src.header, base) : { "User-Agent": UA_FALLBACK };

  let text: string;
  try {
    text = await fetchText(chapterUrl, { headers, timeoutMs: 15_000 });
  } catch (e) {
    return {
      title: "",
      content: `加载失败: ${e instanceof Error ? e.message : String(e)}`,
      prev: null,
      next: null,
    };
  }

  if (src?.ruleContent?.content && !hasUnsupportedJs(src.ruleContent.content)) {
    const $ = loadHtml(text);
    const rc = src.ruleContent;
    let content = getString($, rc.content);
    if (rc.replaceRegex && !hasUnsupportedJs(rc.replaceRegex)) {
      // ##pat##repl
      const m = rc.replaceRegex.match(/^##([\s\S]*?)##([\s\S]*)$/);
      if (m) {
        try {
          // 限制正则模式长度和复杂度，防止 ReDoS
          const pattern = m[1];
          if (pattern.length <= 200 && !/\{[\d,]{5,}\}/.test(pattern)) {
            content = content.replace(new RegExp(pattern, "g"), m[2]);
          }
        } catch {
          /* invalid regex, skip */
        }
      }
    }
    const title = getString($, rc.title) || ($("title").text() || "").split(/[_|-]/)[0].trim();
    let next: string | null = null;
    let prev: string | null = null;
    if (rc.nextContentUrl && !hasUnsupportedJs(rc.nextContentUrl)) {
      const n = getString($, rc.nextContentUrl);
      if (n) next = absUrl(chapterUrl, n);
    }
    // 通用翻页
    if (!next) {
      const n = $('a:contains("下一章"), a:contains("下一页")').first().attr("href");
      if (n) next = absUrl(chapterUrl, n);
    }
    if (!prev) {
      const p = $('a:contains("上一章"), a:contains("上一页")').first().attr("href");
      if (p) prev = absUrl(chapterUrl, p);
    }
    return {
      title,
      content: content || "（规则未提取到正文，可能是该源需要 JS）",
      prev,
      next,
      source: src.bookSourceName,
    };
  }

  // 通用正文
  const $ = loadHtml(text);
  const title = ($("title").text() || "").split(/[_|-]/)[0].trim();
  const candidates = ["#content", "#chaptercontent", ".content", "#nr", "#txtcontent", ".m-post", "article"];
  let content = "";
  for (const sel of candidates) {
    const el = $(sel).first();
    if (el.length && (el.text() || "").length > 80) {
      content =
        el
          .html()
          ?.replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .trim() || "";
      if (content.length > 80) break;
    }
  }
  const next = $('a:contains("下一章")').first().attr("href");
  const prev = $('a:contains("上一章")').first().attr("href");
  return {
    title,
    content: content || "未能解析正文",
    prev: prev ? absUrl(chapterUrl, prev) : null,
    next: next ? absUrl(chapterUrl, next) : null,
  };
}
