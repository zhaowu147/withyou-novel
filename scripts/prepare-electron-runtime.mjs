import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneSource = path.join(projectRoot, ".next", "standalone");
const staticSource = path.join(projectRoot, ".next", "static");
const serverChunksSource = path.join(projectRoot, ".next", "server", "chunks");
const publicSource = path.join(projectRoot, "public");
const buildRoot = path.join(projectRoot, ".electron-build");
const runtimeDestination = path.join(buildRoot, "standalone");

function assertDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label}不存在：${directory}`);
  }
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    errorOnExist: false,
  });
}

assertDirectory(standaloneSource, "Next standalone");
assertDirectory(staticSource, "Next static");
assertDirectory(serverChunksSource, "Next server chunks");
assertDirectory(publicSource, "public");

fs.mkdirSync(buildRoot, { recursive: true });
fs.rmSync(runtimeDestination, { recursive: true, force: true });
copyDirectory(standaloneSource, runtimeDestination);
copyDirectory(staticSource, path.join(runtimeDestination, ".next", "static"));
copyDirectory(serverChunksSource, path.join(runtimeDestination, ".next", "server", "chunks"));
copyDirectory(publicSource, path.join(runtimeDestination, "public"));

// pnpm 将 Next 的传递依赖放在 .pnpm/node_modules，而 Node 的生产运行时会从
// standalone/node_modules 向上解析。将这些已追踪依赖提升为实体目录，避免
// 安装后依赖开发机上的 pnpm junction。
const pnpmHoistedSource = path.join(runtimeDestination, "node_modules", ".pnpm", "node_modules");
if (fs.existsSync(pnpmHoistedSource)) {
  for (const entry of fs.readdirSync(pnpmHoistedSource, { withFileTypes: true })) {
    copyDirectory(
      path.join(pnpmHoistedSource, entry.name),
      path.join(runtimeDestination, "node_modules", entry.name),
    );
  }
}

const requiredFiles = [
  "server.js",
  "node_modules/next/package.json",
  "node_modules/@next/env/package.json",
  "node_modules/@swc/helpers/package.json",
  ".next/static",
  "public",
];

for (const relativePath of requiredFiles) {
  const target = path.join(runtimeDestination, relativePath);
  if (!fs.existsSync(target)) {
    throw new Error(`运行时缺少必要文件：${relativePath}`);
  }
}

const nodeModulesDirectory = path.join(runtimeDestination, "node_modules");
fs.rmSync(path.join(nodeModulesDirectory, ".pnpm"), { recursive: true, force: true });
const runtimeDependenciesDirectory = path.join(runtimeDestination, "runtime-deps");
fs.renameSync(nodeModulesDirectory, runtimeDependenciesDirectory);

const remainingLinks = [];
const pending = [runtimeDestination];
while (pending.length > 0) {
  const current = pending.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      remainingLinks.push(path.relative(runtimeDestination, absolute));
    } else if (stat.isDirectory()) {
      pending.push(absolute);
    }
  }
}

if (remainingLinks.length > 0) {
  throw new Error(`运行时仍包含外部链接：${remainingLinks.slice(0, 10).join(", ")}`);
}

console.log(`Electron 运行时已准备：${runtimeDestination}`);
