import "server-only";

import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";

import { createSourceProposal } from "./source-proposal-store";

const BLOCKED_SEGMENTS = new Set([".git", ".data", "node_modules", "coverage", "dist", "build", "secrets"]);
const MAX_OUTPUT = 30_000;
const MAX_COMMAND = 2_000;
const ALLOWED_COMMANDS = new Set([
  "pnpm",
  "pnpm.cmd",
  "npm",
  "npm.cmd",
  "npx",
  "npx.cmd",
  "node",
  "python",
  "python.exe",
  "py",
  "git",
  "tsc",
  "tsc.cmd",
  "vitest",
  "vitest.cmd",
  "next",
  "next.cmd",
  "yarn",
  "yarn.cmd",
  "cargo",
  "go",
]);
const BLOCKED_COMMANDS = /(?:^|\s)(?:del|erase|rm|rmdir|format|shutdown|reg|regsvr32|takeown|icacls|powershell|pwsh|cmd|winget|curl|wget|Invoke-WebRequest)(?:\s|$)/i;

type CodingPiModule = typeof import("@earendil-works/pi-coding-agent");
type AnyToolDefinition = ToolDefinition<any, any, any>;

function safePath(root: string, candidate: string): string {
  const normalized = candidate.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (!normalized || segments.some((segment) => BLOCKED_SEGMENTS.has(segment) || segment.toLowerCase().startsWith(".env"))) {
    throw new Error("该路径不允许由 Pi 访问");
  }
  const resolved = path.resolve(root, normalized);
  const rootPath = path.resolve(root);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) throw new Error("路径超出源码工作区");
  const existingTarget = fs.existsSync(resolved) ? fs.realpathSync(resolved) : fs.realpathSync(path.dirname(resolved));
  if (existingTarget !== rootPath && !existingTarget.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error("路径通过符号链接超出源码工作区");
  }
  return resolved;
}

function relativePath(root: string, absolute: string): string {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function sanitizeEnvironment(): NodeJS.ProcessEnv {
  const env = { NODE_ENV: process.env.NODE_ENV ?? "production" } as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || /(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PRIVATE)/i.test(key)) continue;
    env[key] = value;
  }
  env.PI_CODING_AGENT = "1";
  return env;
}

export function validateCodingCommand(command: string): void {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_COMMAND) throw new Error("命令为空或超过长度限制");
  if (
    BLOCKED_COMMANDS.test(trimmed) ||
    /[|<>;`\n\r]|\$\(|\b(?:git\s+(?:reset|clean|push|checkout))\b|\b(?:node|python|py)\s+(?:-e|-c)\b|\b(?:npx|pnpm\s+dlx)\b/i.test(trimmed)
  ) {
    throw new Error("该命令包含被禁止的系统、重定向或破坏性操作");
  }
  const executable = trimmed.split(/\s+/, 1)[0].toLowerCase();
  if (!ALLOWED_COMMANDS.has(executable)) throw new Error(`仅允许运行受控开发命令：${[...ALLOWED_COMMANDS].slice(0, 8).join(", ")} 等`);
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

function runCommand(root: string, command: string, options: Parameters<NonNullable<BashOperations["exec"]>>[2]): Promise<{ exitCode: number | null }> {
  validateCodingCommand(command);
  const timeout = Math.min(Math.max(options.timeout ?? 120_000, 1_000), 10 * 60_000);
  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      cwd: root,
      env: (() => {
        const env = sanitizeEnvironment();
        for (const [key, value] of Object.entries(options.env ?? {})) {
          if (value && !/(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PRIVATE)/i.test(key)) env[key] = value;
        }
        return env;
      })(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let outputSize = 0;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode });
    };
    const onData = (data: Buffer) => {
      if (outputSize >= MAX_OUTPUT) return;
      const remaining = MAX_OUTPUT - outputSize;
      const chunk = data.subarray(0, remaining);
      outputSize += chunk.length;
      options.onData(chunk);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(null);
    }, timeout);
    options.signal?.addEventListener("abort", () => {
      killProcessTree(child);
      finish(null);
    }, { once: true });
  });
}

function walkFiles(root: string, current = root, output: string[] = [], limit = 2_000): string[] {
  if (output.length >= limit) return output;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (BLOCKED_SEGMENTS.has(entry.name) || entry.name.toLowerCase().startsWith(".env")) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, absolute, output, limit);
    else output.push(relativePath(root, absolute));
    if (output.length >= limit) break;
  }
  return output;
}

function createEditTool(pi: CodingPiModule, root: string): AnyToolDefinition {
  return pi.defineTool({
    name: "coding_edit",
    label: "提出代码编辑",
    description: "像 coding agent 一样按精确文本替换编辑源码；编辑结果会生成候选补丁，不会绕过用户审批直接写盘。",
    promptSnippet: "coding_edit: 用精确替换创建源码候选补丁",
    promptGuidelines: ["先用 read 读取目标文件", "每次只修改一个文件", "修改需要用户批准后才会落盘"],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String(),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
      summary: Type.String(),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { path: string; edits: Array<{ oldText: string; newText: string }>; summary: string };
      const target = safePath(root, params.path);
      if (!fs.existsSync(target)) throw new Error("目标文件不存在，请先读取并确认路径");
      let content = fs.readFileSync(target, "utf8");
      for (const edit of params.edits) {
        const occurrences = content.split(edit.oldText).length - 1;
        if (occurrences !== 1) throw new Error(`旧文本必须恰好匹配一次，当前匹配 ${occurrences} 次`);
        content = content.replace(edit.oldText, edit.newText);
      }
      const proposal = createSourceProposal({ filePath: relativePath(root, target), proposedContent: content, summary: params.summary });
      return {
        content: [{ type: "text" as const, text: `候选代码补丁已创建：${proposal.filePath}\n补丁 ID：${proposal.id}\n等待用户批准。` }],
        details: { proposalId: proposal.id, filePath: proposal.filePath },
      };
    },
  });
}

export function createCodingToolDefinitions(pi: CodingPiModule, root: string): AnyToolDefinition[] {
  const safeRead = {
    readFile: async (absolute: string) => fs.promises.readFile(safePath(root, relativePath(root, absolute))),
    access: async (absolute: string) => fs.promises.access(safePath(root, relativePath(root, absolute)), fs.constants.R_OK),
  };
  const safeGrep = {
    isDirectory: (absolute: string) => fs.statSync(safePath(root, relativePath(root, absolute))).isDirectory(),
    readFile: (absolute: string) => fs.readFileSync(safePath(root, relativePath(root, absolute)), "utf8"),
  };
  const safeFind = {
    exists: (absolute: string) => fs.existsSync(safePath(root, relativePath(root, absolute))),
    glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) =>
      walkFiles(root).filter((file) => minimatch(file, pattern, { dot: false }) && !options.ignore.some((ignore) => minimatch(file, ignore))).slice(0, options.limit),
  };
  const safeLs = {
    exists: (absolute: string) => fs.existsSync(safePath(root, relativePath(root, absolute))),
    stat: (absolute: string) => fs.statSync(safePath(root, relativePath(root, absolute))),
    readdir: (absolute: string) => fs.readdirSync(safePath(root, relativePath(root, absolute))),
  };
  const bashOperations: BashOperations = {
    exec: (command, cwd, options) => runCommand(root, command, options),
  };
  return [
    pi.createReadToolDefinition(root, { operations: safeRead }),
    pi.createGrepToolDefinition(root, { operations: safeGrep }),
    pi.createFindToolDefinition(root, { operations: safeFind }),
    pi.createLsToolDefinition(root, { operations: safeLs }),
    pi.createBashToolDefinition(root, { operations: bashOperations }),
    createEditTool(pi, root),
  ];
}
