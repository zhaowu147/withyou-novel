/**
 * json-db 数据安全回归测试。
 *
 * 核心断言：文件存在但损坏时，绝不静默返回空集合（旧行为会导致下一次写入
 * 用空覆盖、永久丢数据）。要么从 .bak 自愈，要么保留现场并抛错。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-jsondb-"));
// 让 vaultDir 落到临时目录：novelsRoot() 优先读 NOVELS_BASE_DIR。
process.env.NOVELS_BASE_DIR = path.join(tmpRoot, "novels");

let db: typeof import("../src/lib/local/json-db");
let vaultDir: (novelId: string) => string;

before(async () => {
  db = await import("../src/lib/local/json-db");
  ({ vaultDir } = await import("../src/lib/local/paths"));
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const NID = "testbook";
function collFile(name: string): string {
  return path.join(vaultDir(NID), `${name}.json`);
}
function corrupt(file: string, bytes = "{ this is not json") {
  fs.writeFileSync(file, bytes, "utf8");
}

test("写入后可原样读回", () => {
  db.writeCollection(NID, "roundtrip", [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(db.readCollection(NID, "roundtrip"), [{ id: "a" }, { id: "b" }]);
});

test("文件不存在 → 返回空数组（新项目正常态，不抛）", () => {
  assert.deepEqual(db.readCollection(NID, "does-not-exist"), []);
});

test("写入会为上一版生成 .bak", () => {
  db.writeCollection(NID, "withbak", [{ v: 1 }]);
  db.writeCollection(NID, "withbak", [{ v: 2 }]); // 第二次写入前应备份第一版
  const bak = `${collFile("withbak")}.bak`;
  assert.ok(fs.existsSync(bak), "应存在 .bak");
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, "utf8")), [{ v: 1 }]);
  assert.deepEqual(db.readCollection(NID, "withbak"), [{ v: 2 }]);
});

test("主文件损坏 + 有可用 .bak → 自愈返回 .bak 内容，且归档损坏副本、还原主文件", () => {
  db.writeCollection(NID, "heal", [{ ok: 1 }]); // 建主文件
  db.writeCollection(NID, "heal", [{ ok: 2 }]); // 产生 .bak(=[{ok:1}])，主文件=[{ok:2}]
  corrupt(collFile("heal")); // 主文件损坏
  const rows = db.readCollection<{ ok: number }>(NID, "heal");
  assert.deepEqual(rows, [{ ok: 1 }], "应返回 .bak 内容");
  // 主文件已被还原为可解析内容
  assert.deepEqual(JSON.parse(fs.readFileSync(collFile("heal"), "utf8")), [{ ok: 1 }]);
  // 损坏副本被归档
  const dir = vaultDir(NID);
  const archived = fs.readdirSync(dir).filter((n) => n.startsWith("heal.json.corrupt."));
  assert.ok(archived.length >= 1, "应有 .corrupt 归档");
});

test("主文件损坏 + 无 .bak → 抛 CollectionCorruptError，且主文件保持原样（不清零）", () => {
  const file = collFile("nobak");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  corrupt(file, "GARBAGE-NO-BAK");
  assert.throws(() => db.readCollection(NID, "nobak"), db.CollectionCorruptError);
  // 关键：主文件未被删除/覆盖，原始字节仍在，可人工恢复
  assert.equal(fs.readFileSync(file, "utf8"), "GARBAGE-NO-BAK");
});

test("主文件损坏 + .bak 也损坏 → 抛错，不静默返回空", () => {
  const file = collFile("bothbad");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  corrupt(file, "BAD-MAIN");
  corrupt(`${file}.bak`, "BAD-BAK");
  assert.throws(() => db.readCollection(NID, "bothbad"), db.CollectionCorruptError);
});

test("内容是合法 JSON 但不是数组（如 {}）→ 视为损坏，不静默返回空", () => {
  const file = collFile("notarray");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}", "utf8");
  assert.throws(() => db.readCollection(NID, "notarray"), db.CollectionCorruptError);
});

test("readJsonFile：缺失→fallback；正常→解析；损坏无bak→归档+fallback（不丢原始）", () => {
  const file = path.join(vaultDir(NID), "meta-x.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.deepEqual(db.readJsonFile(file, { d: true }), { d: true }, "缺失→fallback");

  db.writeJsonFile(file, { real: 1 });
  assert.deepEqual(db.readJsonFile(file, { d: true }), { real: 1 }, "正常→解析");

  fs.writeFileSync(file, "NOT-JSON", "utf8"); // 破坏（writeJsonFile 之前已产生 .bak={real:1}）
  fs.rmSync(`${file}.bak`, { force: true }); // 去掉 .bak，走归档+fallback 分支
  assert.deepEqual(db.readJsonFile(file, { d: true }), { d: true }, "损坏无bak→fallback");
  const archived = fs.readdirSync(vaultDir(NID)).filter((n) => n.startsWith("meta-x.json.corrupt."));
  assert.ok(archived.length >= 1, "损坏现场应被归档，原始不丢");
});

test("readJsonFile：损坏但有 .bak → 从 .bak 恢复", () => {
  const file = path.join(vaultDir(NID), "meta-y.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db.writeJsonFile(file, { gen: 1 });
  db.writeJsonFile(file, { gen: 2 }); // .bak = {gen:1}
  fs.writeFileSync(file, "CORRUPT", "utf8");
  assert.deepEqual(db.readJsonFile(file, { d: true }), { gen: 1 }, "应从 .bak 恢复");
});

test("updateCollection：并发 append 不丢写（read-modify-write 全程持锁）", async () => {
  const N = 12;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      db.updateCollection<{ n: number }>(NID, "concurrent", (rows) => {
        rows.push({ n: i });
        return rows;
      }),
    ),
  );
  const rows = db.readCollection<{ n: number }>(NID, "concurrent");
  assert.equal(rows.length, N, `并发 ${N} 次 append 后应有 ${N} 条（丢写会少于 ${N}）`);
  assert.deepEqual(
    rows.map((r) => r.n).sort((a, b) => a - b),
    Array.from({ length: N }, (_, i) => i),
  );
});

test("updateCollection：updater 返回 null → 跳过写入，文件不变", async () => {
  db.writeCollection(NID, "skipwrite", [{ keep: true }]);
  const mtimeBefore = fs.statSync(collFile("skipwrite")).mtimeMs;
  await db.updateCollection(NID, "skipwrite", () => null);
  assert.deepEqual(db.readCollection(NID, "skipwrite"), [{ keep: true }]);
  assert.equal(fs.statSync(collFile("skipwrite")).mtimeMs, mtimeBefore, "未写入，mtime 应不变");
});

test("updateCollection：操作结束后不残留 .lock（跨进程锁已释放）", async () => {
  await db.updateCollection<{ a: number }>(NID, "lockfree", (rows) => {
    rows.push({ a: 1 });
    return rows;
  });
  assert.ok(!fs.existsSync(`${collFile("lockfree")}.lock`), "锁目录应已释放");
});
