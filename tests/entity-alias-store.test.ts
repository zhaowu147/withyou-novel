/**
 * upsertEntity 的别名对账落库测试（记忆隔离洞 3）。
 *
 * 旧行为：不带 id 就一路新建，AI 每换一个称呼（林墨 / 林公子 / 墨少爷）
 * 就多一条影子实体，之后被当成不同的人注入 prompt。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-alias-"));
process.env.NOVELS_BASE_DIR = path.join(tmpRoot, "novels");

let store: typeof import("../src/lib/local/store");
let ALIAS_METADATA_KEY: string;

before(async () => {
  store = await import("../src/lib/local/store");
  ({ ALIAS_METADATA_KEY } = await import("../src/lib/entities/alias-registry"));
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const aliasesOf = (entity: { metadata?: Record<string, unknown> }) =>
  (entity.metadata?.[ALIAS_METADATA_KEY] as string[] | undefined) ?? [];

test("同名重复写入只留一条（旧行为会变两条）", async () => {
  const id = "n-same";
  await store.upsertEntity({ novel_id: id, name: "林墨", type: "character", summary: "主角" });
  await store.upsertEntity({ novel_id: id, name: "林墨", type: "character", summary: "主角，剑修" });

  const rows = store.listEntities(id);
  assert.equal(rows.length, 1, "应合并为一条");
  assert.equal(rows[0].summary, "主角，剑修", "后写的字段覆盖");
});

test("换称呼时按别名并入同一条，并把旧正式名收进别名表", async () => {
  const id = "n-alias";
  await store.upsertEntity({ novel_id: id, name: "林墨", type: "character" });
  await store.upsertEntity({
    novel_id: id,
    name: "墨少爷",
    type: "character",
    metadata: { [ALIAS_METADATA_KEY]: ["林墨"] },
  });

  const rows = store.listEntities(id);
  assert.equal(rows.length, 1, "别名命中，不应新建");
  assert.equal(rows[0].name, "墨少爷", "正式名更新为最新称呼");
  assert.ok(aliasesOf(rows[0]).includes("林墨"), "旧正式名应收进别名表，保持可追溯");
});

test("后续用旧称呼再写，仍能命中同一条", async () => {
  const id = "n-alias-back";
  await store.upsertEntity({ novel_id: id, name: "林墨", type: "character" });
  await store.upsertEntity({
    novel_id: id,
    name: "墨少爷",
    type: "character",
    metadata: { [ALIAS_METADATA_KEY]: ["林墨"] },
  });
  await store.upsertEntity({ novel_id: id, name: "林墨", type: "character", summary: "回到旧称呼" });

  const rows = store.listEntities(id);
  assert.equal(rows.length, 1, "旧称呼已在别名表里，应命中而非新建");
  assert.equal(rows[0].summary, "回到旧称呼");
});

test("类型不同不合并：同名的人物与地点各自独立", async () => {
  const id = "n-type";
  await store.upsertEntity({ novel_id: id, name: "昆仑", type: "character" });
  await store.upsertEntity({ novel_id: id, name: "昆仑", type: "location" });

  assert.equal(store.listEntities(id).length, 2, "人物「昆仑」与地点「昆仑」不是一个东西");
});

test("显式 id 优先于别名对账：改名走的是更新而不是并表", async () => {
  const id = "n-rename";
  const created = await store.upsertEntity({ novel_id: id, name: "旧名", type: "character" });
  const renamed = await store.upsertEntity({
    novel_id: id,
    id: created.id,
    name: "新名",
    type: "character",
  });

  assert.equal(renamed.id, created.id);
  assert.equal(store.listEntities(id).length, 1);
  assert.equal(renamed.name, "新名");
});

test("认不出来就新建：不同角色不会被误并", async () => {
  const id = "n-distinct";
  await store.upsertEntity({ novel_id: id, name: "林墨", type: "character" });
  await store.upsertEntity({ novel_id: id, name: "苏清欢", type: "character" });

  assert.equal(store.listEntities(id).length, 2);
});

test("别名表不重复收录正式名自身", async () => {
  const id = "n-selfalias";
  const row = await store.upsertEntity({
    novel_id: id,
    name: "林墨",
    type: "character",
    metadata: { [ALIAS_METADATA_KEY]: ["林墨", "林 墨"] },
  });
  assert.deepEqual(aliasesOf(row), [], "与正式名归一化后相同的别名应被剔除");
});
