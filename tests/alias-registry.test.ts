import {
  ALIAS_METADATA_KEY,
  findEntityByIdentity,
  mergeAliases,
  normalizeEntityName,
  readAliases,
} from "../src/lib/entities/alias-registry";
import assert from "node:assert/strict";
import { test } from "node:test";

const entity = (id: string, name: string, type?: string, aliases?: string[]) => ({
  id,
  name,
  type,
  metadata: aliases ? { [ALIAS_METADATA_KEY]: aliases } : undefined,
});

test("归一化：去空白（含全角）、转小写、去修饰标点", () => {
  assert.equal(normalizeEntityName("  林 墨  "), "林墨");
  assert.equal(normalizeEntityName("林　墨"), "林墨", "全角空格也要去掉");
  assert.equal(normalizeEntityName("Lin Mo"), "linmo");
  assert.equal(normalizeEntityName("「林墨」"), "林墨");
  assert.equal(normalizeEntityName("阿·尔"), "阿尔");
});

test("按正式名对账：同名同类判为同一实体", () => {
  const rows = [entity("e1", "林墨", "character"), entity("e2", "昆仑", "location")];
  assert.equal(findEntityByIdentity(rows, " 林墨 ", [], "character")?.id, "e1");
});

test("按已有别名对账：新名字命中旧实体的别名", () => {
  const rows = [entity("e1", "林墨", "character", ["林公子", "墨少爷"])];
  assert.equal(findEntityByIdentity(rows, "墨少爷", [], "character")?.id, "e1");
});

test("按待写入别名对账：新实体的别名命中旧实体的正式名", () => {
  const rows = [entity("e1", "林墨", "character")];
  assert.equal(findEntityByIdentity(rows, "墨少爷", ["林墨"], "character")?.id, "e1");
});

test("类型不同不合并：同名的人物与地点必须分开", () => {
  const rows = [entity("e1", "昆仑", "location")];
  assert.equal(findEntityByIdentity(rows, "昆仑", [], "character"), null);
  assert.equal(findEntityByIdentity(rows, "昆仑", [], "location")?.id, "e1");
});

test("类型缺省时不因类型而拒绝匹配（旧数据没写 type）", () => {
  const rows = [entity("e1", "林墨")];
  assert.equal(findEntityByIdentity(rows, "林墨", [], "character")?.id, "e1");
});

test("认不出来就返回 null —— 宁可多一条实体，也不能把两个人并成一个", () => {
  const rows = [entity("e1", "林墨", "character", ["林公子"])];
  assert.equal(findEntityByIdentity(rows, "苏清欢", [], "character"), null);
  assert.equal(findEntityByIdentity(rows, "", [], "character"), null, "空名字不匹配任何人");
});

test("mergeAliases：去重、剔除与正式名相同的、保持顺序", () => {
  const merged = mergeAliases(["林公子", "墨少爷"], ["墨少爷", "林墨", "小墨"], "林墨");
  assert.deepEqual(merged, ["林公子", "墨少爷", "小墨"]);
});

test("mergeAliases：归一化后相同的算重复（「林 公子」不再单列）", () => {
  assert.deepEqual(mergeAliases(["林公子"], ["林 公子"], "林墨"), ["林公子"]);
});

test("mergeAliases：限长，防止别名表被 AI 抽取撑爆", () => {
  const many = Array.from({ length: 50 }, (_, i) => `别名${i}`);
  assert.equal(mergeAliases([], many, "林墨", 24).length, 24);
});

test("readAliases 容错：字段缺失/不是数组/含非字符串都不炸", () => {
  assert.deepEqual(readAliases(undefined), []);
  assert.deepEqual(readAliases({}), []);
  assert.deepEqual(readAliases({ [ALIAS_METADATA_KEY]: "林公子" }), []);
  assert.deepEqual(readAliases({ [ALIAS_METADATA_KEY]: ["林公子", 42, "", "  ", null] }), ["林公子"]);
});
