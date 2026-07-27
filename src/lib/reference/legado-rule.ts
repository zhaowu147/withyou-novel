/**
 * Legado「阅读」规则引擎 — 实用子集
 * 支持：class/id/tag + 索引 + @属性/@text/@html + ##正则替换
 * 不支持：@js: / java. / webView（此类书源自动跳过）
 */
import * as cheerio from "cheerio";

export type CheerioAPI = ReturnType<typeof cheerio.load>;
// cheerio 元素集合（避免依赖 domhandler 类型包）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CheerioEl = cheerio.Cheerio<any>;

const HAS_JS = /@js:|<js>|<\/js>|java\.|getSearchOpt\(|webView|cookie\./i;

export function hasUnsupportedJs(rule?: string | null): boolean {
  if (!rule) return false;
  return HAS_JS.test(rule);
}

export function sourceUsesJs(src: {
  searchUrl?: string;
  header?: string;
  ruleSearch?: Record<string, string | undefined>;
  ruleToc?: Record<string, string | undefined>;
  ruleContent?: Record<string, string | undefined>;
  ruleBookInfo?: Record<string, string | undefined>;
}): boolean {
  // header 里的 @js 可忽略（我们用默认 UA）；关键路径在 search/list
  const chunks: string[] = [];
  if (src.searchUrl) chunks.push(src.searchUrl);
  const rs = src.ruleSearch;
  if (rs?.bookList) chunks.push(rs.bookList);
  if (rs?.name) chunks.push(rs.name);
  if (rs?.bookUrl) chunks.push(rs.bookUrl);
  // toc/content 若全是 js，搜索仍可能有用；只挡搜索关键字段
  return chunks.some((c) => hasUnsupportedJs(c));
}

/** 去掉 #tag 后缀（阅读里用于分组/标记） */
export function cleanBaseUrl(url: string): string {
  if (!url) return "";
  let u = url.trim();
  const hashIdx = u.indexOf("#");
  if (hashIdx > 8) u = u.slice(0, hashIdx);
  if (!/^https?:\/\//i.test(u)) u = `https://${u.replace(/^\/+/, "")}`;
  return u.replace(/\/$/, "");
}

/** 解析 searchUrl: "path, {json}" 或纯 URL 模板 */
export function parseSearchUrlTemplate(
  searchUrl: string,
  base: string,
  key: string,
  page = 1,
): {
  url: string;
  method: "GET" | "POST";
  body?: string;
  charset?: string;
  headers?: Record<string, string>;
} {
  let raw = searchUrl.trim();
  let option: Record<string, unknown> = {};
  const m = raw.match(/^([\s\S]+?),\s*(\{[\s\S]*\})\s*$/);
  if (m) {
    raw = m[1].trim();
    try {
      option = JSON.parse(m[2]) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }

  const encoded = encodeURIComponent(key);
  let path = raw
    .replace(/\{\{key\}\}/g, encoded)
    .replace(/\{\{page\}\}/g, String(page))
    .replace(/\{\{page-1\}\}/g, String(Math.max(0, page - 1)))
    .replace(/\{\{\(page-1\)\*10\+1\}\}/g, String((page - 1) * 10 + 1))
    .replace(/\{\{java\.encodeURI\(key\)\}\}/g, encoded);

  if (path.startsWith("/")) path = `${base}${path}`;
  else if (!/^https?:\/\//i.test(path)) path = `${base}/${path}`;

  const method = String(option.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const charset = typeof option.charset === "string" ? option.charset : undefined;
  let body: string | undefined;
  if (method === "POST" && option.body) {
    body = String(option.body)
      .replace(/\{\{key\}\}/g, encoded)
      .replace(/\{\{page\}\}/g, String(page));
  }
  const headers: Record<string, string> = {};
  if (option.headers && typeof option.headers === "object") {
    Object.assign(headers, option.headers as Record<string, string>);
  }
  return { url: path, method, body, charset, headers };
}

/** 解析 header 字段（仅 JSON 对象，跳过 @js） */
export function parseHeaderField(header: string | undefined, base: string): Record<string, string> {
  const fallback = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    Referer: base,
  };
  if (!header?.trim() || hasUnsupportedJs(header)) return fallback;
  try {
    const j = JSON.parse(header.replace(/\{\{baseUrl\}\}/g, base)) as Record<string, unknown>;
    if (j && typeof j === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(j)) {
        if (typeof v === "string") out[k] = v.replace(/\{\{baseUrl\}\}/g, base);
      }
      if (!out["User-Agent"] && !out["user-agent"]) {
        out["User-Agent"] = fallback["User-Agent"];
      }
      return out;
    }
  } catch {
    /* fallthrough */
  }
  return fallback;
}

interface ParsedRule {
  selector: string;
  attr?: string;
  regex?: { pattern: string; repl: string };
  reverse?: boolean;
  excludeFirst?: boolean;
  index?: number | null;
}

function splitRegex(rule: string): { body: string; regex?: { pattern: string; repl: string } } {
  const idx = rule.indexOf("##");
  if (idx < 0) return { body: rule };
  const rest = rule.slice(idx + 2);
  const idx2 = rest.indexOf("##");
  if (idx2 >= 0) {
    return {
      body: rule.slice(0, idx),
      regex: { pattern: rest.slice(0, idx2), repl: rest.slice(idx2 + 2) },
    };
  }
  return { body: rule.slice(0, idx), regex: { pattern: rest, repl: "" } };
}

function toCssSelector(seg: string): {
  css: string;
  index?: number | null;
  reverse?: boolean;
  excludeFirst?: boolean;
} {
  let s = seg.trim();
  let reverse = false;
  let excludeFirst = false;
  let index: number | null = null;

  if (s.startsWith("-")) {
    reverse = true;
    s = s.slice(1);
  }
  if (s.endsWith("!0")) {
    excludeFirst = true;
    s = s.slice(0, -2);
  }

  const im = s.match(/\.(-?\d+)$/);
  if (im) {
    index = Number(im[1]);
    s = s.slice(0, -im[0].length);
  }

  s = s
    .replace(/^class\./, ".")
    .replace(/^id\./, "#")
    .replace(/^tag\./, "");

  if (s.includes(" ") && !s.includes(">") && !s.includes("[") && s.startsWith(".")) {
    s = `.${s.slice(1).split(/\s+/).filter(Boolean).join(".")}`;
  }

  if (!s) s = "*";
  return { css: s, index, reverse, excludeFirst };
}

function parseRule(rule: string): ParsedRule {
  const { body, regex } = splitRegex(rule.trim());
  let selector = body;
  let attr: string | undefined;
  const at = body.lastIndexOf("@");
  if (at >= 0) {
    selector = body.slice(0, at);
    attr = body.slice(at + 1).trim() || "text";
  }

  let reverse = false;
  let excludeFirst = false;
  let index: number | null = null;

  if (selector.includes("@")) {
    const parts = selector.split("@").filter(Boolean);
    const cssParts: string[] = [];
    for (const p of parts) {
      const t = toCssSelector(p);
      if (t.reverse) reverse = true;
      if (t.excludeFirst) excludeFirst = true;
      if (t.index !== null && t.index !== undefined) index = t.index;
      cssParts.push(t.css);
    }
    return { selector: cssParts.join(" "), attr, regex, reverse, excludeFirst, index };
  }

  const t = toCssSelector(selector);
  return {
    selector: t.css,
    attr,
    regex,
    reverse: t.reverse,
    excludeFirst: t.excludeFirst,
    index: t.index,
  };
}

function applyRegex(text: string, regex?: { pattern: string; repl: string }): string {
  if (!regex?.pattern) return text;
  // 限制正则模式长度和复杂度，防止 ReDoS
  if (regex.pattern.length > 200) return text;
  if (/\{[\d,]{5,}\}/.test(regex.pattern)) return text;
  try {
    return text.replace(new RegExp(regex.pattern, "g"), regex.repl ?? "");
  } catch {
    return text;
  }
}

function getAttr($el: CheerioEl, attr?: string): string {
  if (!attr || attr === "text") return $el.text().replace(/\s+/g, " ").trim();
  if (attr === "textNodes") {
    return $el
      .contents()
      .filter((_, n) => n.type === "text")
      .text()
      .replace(/\s+/g, " ")
      .trim();
  }
  if (attr === "html") {
    return ($el.html() || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  const v = $el.attr(attr) || $el.attr(attr.toLowerCase()) || "";
  return String(v).trim();
}

function empty($: CheerioAPI): CheerioEl {
  return $.root().find("__none_match__");
}

/** 选择元素列表 */
export function selectAll($: CheerioAPI, rule: string, root?: CheerioEl): CheerioEl {
  if (!rule?.trim() || hasUnsupportedJs(rule) || rule.trim().startsWith("$")) return empty($);

  const parsed = parseRule(rule);
  const ctx = root ?? $.root();
  let els = ctx.find(parsed.selector);
  if (parsed.excludeFirst && els.length > 1) els = els.slice(1);
  if (parsed.reverse) {
    const arr = els.toArray().reverse();
    els = $(arr);
  }
  if (parsed.index !== null && parsed.index !== undefined) {
    const arr = els.toArray();
    const i = parsed.index < 0 ? arr.length + parsed.index : parsed.index;
    if (i < 0 || i >= arr.length) return empty($);
    return $(arr[i]);
  }
  return els;
}

/** 取单个字符串字段 */
export function getString($: CheerioAPI, rule: string | undefined, root?: CheerioEl): string {
  if (!rule?.trim() || hasUnsupportedJs(rule) || rule.trim().startsWith("$")) return "";

  const { body, regex } = splitRegex(rule.trim());
  const alts = body
    .split("||")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const alt of alts) {
    const pr = parseRule(alt);
    let found = (root ?? $.root()).find(pr.selector);
    if (pr.excludeFirst && found.length > 1) found = found.slice(1);
    if (pr.index !== null && pr.index !== undefined) {
      const arr = found.toArray();
      const i = pr.index < 0 ? arr.length + pr.index : pr.index;
      if (i < 0 || i >= arr.length) continue;
      found = $(arr[i]);
    } else {
      found = found.first();
    }
    if (!found.length) continue;
    let text = getAttr(found, pr.attr || "text");
    text = applyRegex(text, regex ?? pr.regex);
    if (text) return text;
  }
  return "";
}

/** 列表：每个匹配元素 */
export function getElements($: CheerioAPI, listRule: string | undefined): CheerioEl[] {
  if (!listRule?.trim() || hasUnsupportedJs(listRule)) return [];

  let rule = listRule.trim();
  if (rule.includes("</js>")) {
    rule = (rule.split("</js>").pop() || "").trim();
    if (!rule || hasUnsupportedJs(rule)) return [];
  }

  for (const alt of rule.split("||").map((s) => s.trim())) {
    if (!alt || hasUnsupportedJs(alt) || alt.startsWith("$")) continue;
    const pr = parseRule(alt);
    let els = $.root().find(pr.selector);
    if (pr.excludeFirst && els.length > 1) els = els.slice(1);
    const arr = pr.reverse ? els.toArray().reverse() : els.toArray();
    if (arr.length) return arr.map((e) => $(e));
  }
  return [];
}

export function absUrl(base: string, href: string): string {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  try {
    return new URL(href, base.endsWith("/") ? base : `${base}/`).toString();
  } catch {
    return href;
  }
}

/** 简易 JSONPath：$.a.b[*] / JSon:$.data / data.list */
export function isJsonPath(rule?: string): boolean {
  if (!rule) return false;
  const t = rule.trim();
  return /^json\s*:/i.test(t) || t.startsWith("$") || t.startsWith("$.") || /^data[.[]/i.test(t);
}

/** 是否为 URL 模板（含 {{ }} 或纯路径，不应当 CSS 选择器） */
export function isUrlTemplate(rule?: string): boolean {
  if (!rule) return false;
  const t = rule.trim();
  if (t.includes("{{") && t.includes("}}")) return true;
  if (/^https?:\/\//i.test(t)) return true;
  // /novel/{{$.id}} 被拆掉后 /path?q= 也算
  if (t.startsWith("/") && (t.includes("?") || t.includes("{{") || /\/[a-z]/i.test(t))) {
    // 仍可能是 id.xxx CSS — 排除阅读 CSS 方言
    if (/^(id\.|class\.|tag\.|#|\.)/i.test(t)) return false;
    if (t.includes("@")) return false;
    return true;
  }
  return false;
}

/** 从 JSON 对象按路径取值：$.a.b / a.b / data */
export function jsonPick(obj: unknown, path: string): unknown {
  if (obj == null || !path) return undefined;
  let p = path.trim().replace(/^json\s*:/i, "");
  if (p.startsWith("$.")) p = p.slice(2);
  else if (p.startsWith("$")) p = p.slice(1);
  if (p.startsWith(".")) p = p.slice(1);
  p = p.split("##")[0].trim();
  // $..field 深度搜索第一匹配
  if (p.startsWith("..")) {
    const key = p.slice(2).split(/[.[]/)[0];
    const found = deepFind(obj, key);
    return found;
  }
  const parts = p.split(/\.|\[|\]/).filter((x) => x && x !== "*");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isNaN(idx)) cur = cur[idx];
      else cur = cur.map((item) => (item as Record<string, unknown>)?.[part]).filter((x) => x !== undefined);
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
}

function deepFind(obj: unknown, key: string): unknown {
  if (obj == null) return undefined;
  if (typeof obj === "object") {
    if (!Array.isArray(obj) && key in (obj as object)) return (obj as Record<string, unknown>)[key];
    for (const v of Object.values(obj as object)) {
      const f = deepFind(v, key);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}

/**
 * 展开 Legado 模板：`/novel/{{$.novelId}}/chapters` + JSON 上下文
 * 支持 {{$.a.b}} / {{a}} / {{baseUrl}}
 */
export function expandTemplate(tpl: string, ctx: unknown, extra?: Record<string, string>): string {
  if (!tpl) return "";
  // 去掉尾部 ,{ json options }
  let s = tpl.trim();
  const opt = s.match(/^([\s\S]+?),\s*(\{[\s\S]*\})\s*$/);
  if (opt) s = opt[1].trim();

  s = s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, raw: string) => {
    const key = String(raw).trim();
    if (extra && key in extra) return extra[key];
    if (key === "baseUrl" && extra?.baseUrl) return extra.baseUrl;
    const v = jsonPick(ctx, key);
    if (v == null) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  });
  return s;
}

export function jsonPathGet(data: unknown, path: string): unknown[] {
  let p = path.trim();
  p = p.replace(/^json\s*:/i, "").trim();
  if (p.startsWith("$.")) p = p.slice(2);
  else if (p.startsWith("$")) p = p.slice(1);
  if (p.startsWith(".")) p = p.slice(1);
  p = p.split("||")[0].trim();
  // 去掉 ##regex
  p = p.split("##")[0].trim();
  const parts = p.split(/\.|\[|\]/).filter((x) => x && x !== "*");
  let cur: unknown = data;
  for (const part of parts) {
    if (cur == null) return [];
    if (Array.isArray(cur)) {
      cur = cur.map((item) => (item as Record<string, unknown>)?.[part]).filter((x) => x !== undefined);
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else return [];
  }
  if (Array.isArray(cur)) return cur;
  if (cur == null) return [];
  return [cur];
}

export function loadHtml(html: string): CheerioAPI {
  return cheerio.load(html);
}
