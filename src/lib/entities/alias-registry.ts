/**
 * 实体别名对账 —— 让「同一个人」只有一条实体记录。
 *
 * 背景：upsertEntity 此前只按 id 去重。AI 从不同章节抽取同一个人时给的名字往往
 * 不一样（「林墨」「林公子」「墨少爷」「Lin Mo」），每次都没带 id，于是一路
 * 新建，实体表里堆出一串影子实体。它们各自带着片面的 summary 和 last_chapter，
 * 之后又被当成不同的人注入 prompt —— 模型看到的人物关系就散了。
 *
 * 这里在落库前做一次对账：先按 id，再按归一化后的正式名，最后按别名表。
 * 认定为同一实体就合并别名、不新建。
 *
 * 纯函数，不碰存储 —— 便于单测，也避免与 local/store 形成 import 环。
 */

/** 实体 metadata 里存放别名的键。 */
export const ALIAS_METADATA_KEY = "aliases";

/**
 * 名字归一化：去空白、转小写、去掉常见修饰性后缀与全角标点。
 * 只做保守处理 —— 宁可漏合并（多一条实体，用户能手动并），
 * 也不能错合并（把两个角色并成一个，正文事实就串了）。
 */
export function normalizeEntityName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[·・．.,，、「」『』（）()【】[\]"'"']/g, "");
}

interface AliasCandidate {
  id: string;
  name: string;
  type?: string;
  metadata?: Record<string, unknown>;
}

/** 从 metadata 里读出别名列表（容错：不是数组或含非字符串项时跳过）。 */
export function readAliases(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.[ALIAS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

/** 合并别名：去重、剔除与正式名重复的、限长，保持稳定顺序。 */
export function mergeAliases(existing: string[], incoming: string[], canonicalName: string, max = 24): string[] {
  const canonical = normalizeEntityName(canonicalName);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of [...existing, ...incoming]) {
    const key = normalizeEntityName(alias);
    if (!key || key === canonical || seen.has(key)) continue;
    seen.add(key);
    out.push(alias.trim());
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 在已有实体里找出与 (name, aliases) 指同一对象的那条。
 *
 * 匹配顺序（先严后松）：
 *   1. 正式名归一化后相同；
 *   2. 待写入的名字命中某条已有实体的别名；
 *   3. 待写入的别名命中某条已有实体的正式名或别名。
 *
 * type 给定时必须一致 —— 同名的人物和地点（如「昆仑」）不能并到一起。
 */
export function findEntityByIdentity(
  rows: readonly AliasCandidate[],
  name: string,
  aliases: readonly string[] = [],
  type?: string,
): AliasCandidate | null {
  const target = normalizeEntityName(name);
  if (!target) return null;
  const incoming = new Set(aliases.map(normalizeEntityName).filter(Boolean));
  const typeOk = (row: AliasCandidate) => !type || !row.type || row.type === type;

  const byName = rows.find((row) => typeOk(row) && normalizeEntityName(row.name) === target);
  if (byName) return byName;

  const byExistingAlias = rows.find(
    (row) => typeOk(row) && readAliases(row.metadata).some((alias) => normalizeEntityName(alias) === target),
  );
  if (byExistingAlias) return byExistingAlias;

  if (incoming.size === 0) return null;
  return (
    rows.find((row) => {
      if (!typeOk(row)) return false;
      if (incoming.has(normalizeEntityName(row.name))) return true;
      return readAliases(row.metadata).some((alias) => incoming.has(normalizeEntityName(alias)));
    }) ?? null
  );
}
