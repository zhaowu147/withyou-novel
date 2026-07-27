import * as fs from "node:fs";
import * as path from "node:path";

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function normalizeProjectId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.length > 120 ||
    path.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    /[\\/:*?"<>|]/.test(normalized) ||
    [...normalized].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(normalized) ||
    WINDOWS_RESERVED_NAME.test(normalized)
  ) {
    throw new Error("invalid novel id");
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function nearestExistingAncestor(candidate: string): string {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function resolveProjectPath(baseDir: string, projectId: string, relativePath = "."): string {
  const safeProjectId = normalizeProjectId(projectId);
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath) || relativePath.includes("\0")) {
    throw new Error("路径穿越检测：禁止访问项目目录外的文件");
  }

  const root = path.resolve(baseDir);
  const projectRoot = path.resolve(root, safeProjectId);
  const target = path.resolve(projectRoot, relativePath);
  if (!isWithin(root, projectRoot) || !isWithin(projectRoot, target)) {
    throw new Error("路径穿越检测：禁止访问项目目录外的文件");
  }

  if (fs.existsSync(root)) {
    const realRoot = fs.realpathSync.native(root);
    const existingAncestor = nearestExistingAncestor(target);
    const realAncestor = fs.realpathSync.native(existingAncestor);
    if (!isWithin(realRoot, realAncestor)) {
      throw new Error("路径穿越检测：禁止通过链接访问项目目录外的文件");
    }
  }
  return target;
}
