/**
 * 提示词包存储层
 *
 * 存储位置：novels/<novelId>/prompts/
 * 三个板块独立存储，互不干扰
 */

import "server-only";

import { novelsRoot } from "@/lib/runtime/app-paths";

import type { PromptPackage, PromptPackageScope, ToolId } from "./prompt-package";
import { generatePackageId, getBuiltinPackages } from "./prompt-package";
import * as fs from "node:fs";
import * as path from "node:path";

const PROMPTS_DIR = "prompts";

/** 获取项目提示词目录 */
function getPromptsDir(novelId: string): string {
  return path.join(novelsRoot(), novelId, PROMPTS_DIR);
}

/** 确保目录存在 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 获取板块子目录 */
function getScopeDir(novelId: string, scope: PromptPackageScope): string {
  const dir = path.join(getPromptsDir(novelId), scope);
  ensureDir(dir);
  return dir;
}

/** 获取工具子目录（仅scope=tool时） */
function _getToolDir(novelId: string, toolId: ToolId): string {
  const dir = path.join(getScopeDir(novelId, "tool"), toolId);
  ensureDir(dir);
  return dir;
}

// ─── 读取 ───

/** 读取单个提示词包 */
export function readPackage(novelId: string, packageId: string): PromptPackage | null {
  // 先查内置
  const builtin = getBuiltinPackages().find((p) => p.id === packageId);
  if (builtin) return builtin;

  // 查自定义
  const promptsDir = getPromptsDir(novelId);
  const filePath = path.join(promptsDir, `${packageId}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as PromptPackage;
  } catch {
    return null;
  }
}

/** 获取所有提示词包（内置+自定义） */
export function listPackages(novelId: string, scope?: PromptPackageScope): PromptPackage[] {
  const builtin = scope ? getBuiltinPackages().filter((p) => p.scope === scope) : getBuiltinPackages();

  const custom = listCustomPackages(novelId, scope);

  return [...builtin, ...custom];
}

/** 获取自定义提示词包 */
export function listCustomPackages(novelId: string, scope?: PromptPackageScope): PromptPackage[] {
  const promptsDir = getPromptsDir(novelId);
  if (!fs.existsSync(promptsDir)) return [];

  const packages: PromptPackage[] = [];
  const files = fs.readdirSync(promptsDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(promptsDir, file), "utf-8");
      const pkg = JSON.parse(raw) as PromptPackage;
      if (!scope || pkg.scope === scope) {
        packages.push(pkg);
      }
    } catch {
      // skip malformed
    }
  }

  return packages;
}

/** 按工具获取提示词包 */
export function listPackagesByTool(novelId: string, toolId: ToolId): PromptPackage[] {
  const builtin = getBuiltinPackages().filter((p) => p.scope === "tool" && p.toolId === toolId);
  const custom = listCustomPackages(novelId, "tool").filter((p) => p.toolId === toolId);
  return [...builtin, ...custom];
}

// ─── 写入 ───

/** 保存提示词包 */
export function savePackage(novelId: string, pkg: PromptPackage): PromptPackage {
  const promptsDir = getPromptsDir(novelId);
  ensureDir(promptsDir);

  const now = new Date().toISOString();
  const toSave: PromptPackage = {
    ...pkg,
    id: pkg.id || generatePackageId(),
    updatedAt: now,
    createdAt: pkg.createdAt || now,
  };

  const filePath = path.join(promptsDir, `${toSave.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), "utf-8");

  return toSave;
}

/** 删除提示词包 */
export function deletePackage(novelId: string, packageId: string): boolean {
  const promptsDir = getPromptsDir(novelId);
  const filePath = path.join(promptsDir, `${packageId}.json`);

  if (!fs.existsSync(filePath)) return false;

  fs.unlinkSync(filePath);
  return true;
}

// ─── 激活状态 ───

const ACTIVATION_FILE = "active_prompts.json";

interface ActivationState {
  tool: Partial<Record<ToolId, string>>;
  writer: string | null;
  cover: string | null;
}

/** 读取激活状态 */
export function readActivationState(novelId: string): ActivationState {
  const filePath = path.join(getPromptsDir(novelId), ACTIVATION_FILE);
  if (!fs.existsSync(filePath)) {
    return { tool: {}, writer: null, cover: null };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ActivationState;
  } catch {
    return { tool: {}, writer: null, cover: null };
  }
}

/** 保存激活状态 */
export function saveActivationState(novelId: string, state: ActivationState): void {
  const promptsDir = getPromptsDir(novelId);
  ensureDir(promptsDir);

  const filePath = path.join(promptsDir, ACTIVATION_FILE);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/** 激活功能区提示词包 */
export function activateToolPackage(novelId: string, toolId: ToolId, packageId: string): void {
  const state = readActivationState(novelId);
  state.tool[toolId] = packageId;
  saveActivationState(novelId, state);
}

/** 激活会话写手提示词包 */
export function activateWriterPackage(novelId: string, packageId: string): void {
  const state = readActivationState(novelId);
  state.writer = packageId;
  saveActivationState(novelId, state);
}

/** 激活封面生成提示词包 */
export function activateCoverPackage(novelId: string, packageId: string): void {
  const state = readActivationState(novelId);
  state.cover = packageId;
  saveActivationState(novelId, state);
}

/** 停用功能区提示词包 */
export function deactivateToolPackage(novelId: string, toolId: ToolId): void {
  const state = readActivationState(novelId);
  delete state.tool[toolId];
  saveActivationState(novelId, state);
}

/** 停用会话写手提示词包 */
export function deactivateWriterPackage(novelId: string): void {
  const state = readActivationState(novelId);
  state.writer = null;
  saveActivationState(novelId, state);
}

/** 停用封面生成提示词包 */
export function deactivateCoverPackage(novelId: string): void {
  const state = readActivationState(novelId);
  state.cover = null;
  saveActivationState(novelId, state);
}

/** 获取已激活的提示词包 */
export function getActivatedPackages(novelId: string): {
  tool: Partial<Record<ToolId, PromptPackage | null>>;
  writer: PromptPackage | null;
  cover: PromptPackage | null;
} {
  const state = readActivationState(novelId);

  const toolPackages: Partial<Record<ToolId, PromptPackage | null>> = {};
  for (const [toolId, packageId] of Object.entries(state.tool)) {
    if (packageId) {
      toolPackages[toolId as ToolId] = readPackage(novelId, packageId);
    }
  }

  return {
    tool: toolPackages,
    writer: state.writer ? readPackage(novelId, state.writer) : null,
    cover: state.cover ? readPackage(novelId, state.cover) : null,
  };
}

/** 获取已激活的功能区提示词包 */
export function getActivatedToolPackage(novelId: string, toolId: ToolId): PromptPackage | null {
  const state = readActivationState(novelId);
  const packageId = state.tool[toolId];
  if (!packageId) return null;
  const pkg = readPackage(novelId, packageId);
  if (pkg?.scope !== "tool" || pkg.toolId !== toolId) return null;
  return pkg;
}

/** 获取已激活的会话写手提示词包 */
export function getActivatedWriterPackage(novelId: string): PromptPackage | null {
  const state = readActivationState(novelId);
  if (!state.writer) return null;
  const pkg = readPackage(novelId, state.writer);
  return pkg?.scope === "writer" ? pkg : null;
}

/** 获取已激活的封面生成提示词包 */
export function getActivatedCoverPackage(novelId: string): PromptPackage | null {
  const state = readActivationState(novelId);
  if (!state.cover) return null;
  const pkg = readPackage(novelId, state.cover);
  return pkg?.scope === "cover" ? pkg : null;
}
