#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { parse } from "yaml";
import { minimatch } from "minimatch";

const root = process.cwd();
const projectDir = join(root, ".project");
const json = process.argv.includes("--json");

function readYaml(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  return parse(readFileSync(file, "utf8")) ?? fallback;
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function gitRaw(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trimEnd();
  } catch {
    return "";
  }
}

function changedFiles() {
  const output = gitRaw(["status", "--porcelain=v1"]);
  return output
    ? output.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, ""))
    : [];
}

function activeChanges() {
  const dir = join(projectDir, "changes", "active");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readYaml(join(dir, entry.name, "change.yaml"), { id: entry.name }))
    .filter((change) => change.status !== "merged" && change.status !== "discarded");
}

const manifest = readYaml(join(projectDir, "manifest.yaml"));
const current = readYaml(join(projectDir, "current.yaml"));
const areaConfig = readYaml(join(projectDir, "areas.yaml"), { areas: [] });
const files = changedFiles();
const areas = (areaConfig.areas ?? []).map((area) => ({
  id: area.id,
  name: area.name,
  changed_files: files.filter((file) =>
    (area.paths ?? []).some((pattern) => minimatch(file, pattern, { dot: true })),
  ),
})).filter((area) => area.changed_files.length > 0);

const state = {
  project: manifest.name ?? manifest.project_id ?? "unknown",
  project_id: manifest.project_id ?? null,
  branch: git(["branch", "--show-current"]) || current.current_branch || "detached",
  commit: git(["rev-parse", "--short", "HEAD"]) || null,
  last_release: current.last_release ?? null,
  dirty_files: files,
  dirty_count: files.length,
  source_of_truth: manifest.source_of_truth ?? current.source_of_truth ?? "disk",
  active_changes: activeChanges(),
  deferred: current.deferred ?? [],
  mapped_areas: areas,
  recent_commits: git(["log", "-5", "--pretty=format:%h %s"]).split(/\r?\n/).filter(Boolean),
};
state.warning = state.dirty_count > 0 && state.active_changes.length === 0
  ? "Git辅助检测到文件变化，但磁盘上没有活动变更单；请确认是否需要建立大改动标记。"
  : null;

if (json) {
  console.log(JSON.stringify(state, null, 2));
} else {
  console.log(`项目：${state.project}`);
  console.log(`当前分支：${state.branch}`);
  console.log(`当前提交：${state.commit ?? "未知"}`);
  console.log(`最近发布：${state.last_release ?? "未记录"}`);
  console.log(`事实来源：${state.source_of_truth}`);
  console.log(`Git辅助检测文件：${state.dirty_count}`);
  console.log(`进行中变更：${state.active_changes.length}`);
  if (state.warning) console.log(`⚠️ ${state.warning}`);
  if (state.active_changes.length > 0) {
    for (const change of state.active_changes) {
      console.log(`  - ${change.id ?? "unknown"}: ${change.title ?? "未命名"} [${change.status ?? "active"}]`);
    }
  }
  if (state.mapped_areas.length > 0) {
    console.log("未提交修改涉及区域：");
    for (const area of state.mapped_areas) {
      console.log(`  - ${area.name} (${area.changed_files.length} 个文件)`);
    }
  }
  if (state.deferred.length > 0) {
    console.log("延期事项：");
    for (const item of state.deferred) console.log(`  - ${item}`);
  }
  console.log("最近提交：");
  for (const commit of state.recent_commits) console.log(`  ${commit}`);
}
