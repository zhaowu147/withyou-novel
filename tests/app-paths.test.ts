import { type DataRootProbe, repoRootCandidate, resolveDataRootInfo } from "../src/lib/runtime/app-paths";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-approot-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeDir(...segments: string[]): string {
  const dir = path.join(tmp, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造一个"开发仓库"锚点：package.json(name=withyou-novel) + src/ */
function makeRepo(name: string, packageName = "withyou-novel"): string {
  const root = makeDir(name);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageName }), "utf8");
  return root;
}

/** standalone 产物形状：有 package.json 但没有 src/ */
function makeStandalone(name: string): string {
  const root = makeDir(name);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "withyou-novel" }), "utf8");
  return root;
}

/** 让所有探测点都落空，只保留被测的那一个 */
function probe(overrides: DataRootProbe): DataRootProbe {
  return {
    explicit: null,
    cwd: path.join(tmp, "__nowhere__"),
    entryDir: null,
    moduleDir: null,
    appDataDir: path.join(tmp, "appdata"),
    ...overrides,
  };
}

test("WITHYOU_DATA_DIR 优先于其他一切候选", () => {
  const repo = makeRepo("repo-a");
  const info = resolveDataRootInfo(
    probe({ explicit: path.join(tmp, "explicit"), cwd: repo, appDataDir: path.join(tmp, "appdata") }),
  );
  assert.equal(info.source, "env:WITHYOU_DATA_DIR");
  assert.equal(info.root, path.join(tmp, "explicit"));
});

test("从 cwd 命中仓库锚点（保持现有开发行为）", () => {
  const repo = makeRepo("repo-b");
  const info = resolveDataRootInfo(probe({ cwd: repo }));
  assert.equal(info.source, "repo:cwd");
  assert.equal(info.root, repo);
});

test("从 cwd 的深层子目录向上回溯到仓库根", () => {
  const repo = makeRepo("repo-c");
  const deep = makeDir("repo-c", "src", "app", "api", "novels");
  const info = resolveDataRootInfo(probe({ cwd: deep }));
  assert.equal(info.source, "repo:cwd");
  assert.equal(info.root, repo);
});

test("cwd 不可用时退回入口脚本目录（双击启动的关键分支）", () => {
  const repo = makeRepo("repo-d");
  const entry = makeDir("repo-d", "node_modules", "next", "dist", "bin");
  const info = resolveDataRootInfo(probe({ cwd: path.join(tmp, "__nowhere__"), entryDir: entry }));
  assert.equal(info.source, "repo:module");
  assert.equal(info.root, repo);
});

test("入口目录也不可用时退回模块目录", () => {
  const repo = makeRepo("repo-e");
  const moduleDir = makeDir("repo-e", ".next", "server", "chunks");
  const info = resolveDataRootInfo(probe({ entryDir: null, moduleDir }));
  assert.equal(info.source, "repo:module");
  assert.equal(info.root, repo);
});

test("package.json 的 name 不匹配时不算仓库根", () => {
  const other = makeRepo("repo-f", "some-other-project");
  const appdata = path.join(tmp, "appdata");
  const info = resolveDataRootInfo(probe({ cwd: other, appDataDir: appdata }));
  assert.equal(info.source, "os-app-data");
  assert.equal(info.root, appdata);
});

test("standalone 产物（无 src/）不会被误判成仓库根，数据不会写进程序目录", () => {
  const standalone = makeStandalone("standalone-a");
  const appdata = path.join(tmp, "appdata");
  const info = resolveDataRootInfo(probe({ cwd: standalone, appDataDir: appdata }));
  assert.equal(info.source, "os-app-data");
  assert.equal(info.root, appdata);
});

test("全部候选落空时退回操作系统用户数据目录", () => {
  const appdata = path.join(tmp, "appdata-fallback");
  const info = resolveDataRootInfo(probe({ appDataDir: appdata }));
  assert.equal(info.source, "os-app-data");
  assert.equal(info.root, appdata);
});

test("选中的根还没数据、而另一个候选里有数据时，报告为 stranded", () => {
  const repo = makeRepo("repo-g");
  fs.mkdirSync(path.join(repo, "novels", "某本小说"), { recursive: true });
  const explicit = makeDir("explicit-empty");
  const info = resolveDataRootInfo(probe({ explicit, cwd: repo }));
  assert.equal(info.root, explicit);
  assert.deepEqual(info.strandedCandidates, [repo]);
});

test("选中的根本身就有数据时不报 stranded", () => {
  const repo = makeRepo("repo-h");
  fs.mkdirSync(path.join(repo, "novels"), { recursive: true });
  const info = resolveDataRootInfo(probe({ cwd: repo }));
  assert.equal(info.root, repo);
  assert.deepEqual(info.strandedCandidates, []);
});

test("settings.json 与 .data 也算数据，用于 stranded 判定", () => {
  for (const marker of [".data", "settings.json"] as const) {
    const repo = makeRepo(`repo-marker-${marker.replace(/\W/g, "")}`);
    if (marker === ".data") fs.mkdirSync(path.join(repo, ".data"), { recursive: true });
    else fs.writeFileSync(path.join(repo, "settings.json"), "{}", "utf8");
    const explicit = makeDir(`explicit-${marker.replace(/\W/g, "")}`);
    const info = resolveDataRootInfo(probe({ explicit, cwd: repo }));
    assert.deepEqual(info.strandedCandidates, [repo], `marker ${marker}`);
  }
});

test("同一个仓库根不会因为 cwd 与入口目录都命中而重复出现", () => {
  const repo = makeRepo("repo-i");
  const entry = makeDir("repo-i", "node_modules", "next", "dist", "bin");
  fs.mkdirSync(path.join(repo, "novels"), { recursive: true });
  const explicit = makeDir("explicit-dedupe");
  const info = resolveDataRootInfo(probe({ explicit, cwd: repo, entryDir: entry }));
  assert.deepEqual(info.strandedCandidates, [repo]);
});

test("repoRootCandidate 与数据根解析用同一套锚点规则", () => {
  const repo = makeRepo("repo-j");
  const deep = makeDir("repo-j", "src", "lib");
  assert.equal(repoRootCandidate(probe({ cwd: deep })), repo);
  assert.equal(repoRootCandidate(probe({ cwd: makeStandalone("standalone-b") })), null);
});

test("向上回溯有层数上限，不会一路走到文件系统根", () => {
  const repo = makeRepo("repo-k");
  const tooDeep = makeDir("repo-k", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j");
  assert.equal(repoRootCandidate(probe({ cwd: tooDeep })), null);
  assert.equal(repoRootCandidate(probe({ cwd: path.join(repo, "a", "b") })), repo);
});
