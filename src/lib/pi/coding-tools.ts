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
type ProgramResult = { exitCode: number | null; output: string };

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

export function validateGitHubRepository(repository: string): string {
  const normalized = repository.trim();
  const segments = normalized.split("/");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("GitHub 仓库必须使用 owner/repository 格式");
  }
  return normalized;
}

function validateSearchQuery(query: string): string {
  const normalized = query.trim();
  if (normalized.length < 2 || normalized.length > 240 || /[\r\n]/.test(normalized)) {
    throw new Error("检索词长度必须在 2 到 240 个字符之间，且不能包含换行");
  }
  return normalized;
}

function redactProgramOutput(output: string): string {
  return output
    .replace(/(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]+/gi, "[已隐藏]")
    .replace(/https?:\/\/[^/\s@]+@/gi, "https://[已隐藏]@")
    .slice(-MAX_OUTPUT);
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

function runProgram(root: string, executable: string, args: string[], timeout = 30_000): Promise<ProgramResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: sanitizeEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output: redactProgramOutput(output) });
    };
    const onData = (data: Buffer) => {
      if (output.length < MAX_OUTPUT) output += data.toString("utf8").slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      output += error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    const timer = setTimeout(() => {
      killProcessTree(child);
      output += "\n命令超时后已停止";
      finish(null);
    }, timeout);
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

function programText(result: ProgramResult, successFallback: string): string {
  const output = result.output.trim() || successFallback;
  if (result.exitCode === 0) return output;
  throw new Error(output || "命令执行失败");
}

function toolText(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function createGitTools(pi: CodingPiModule, root: string): AnyToolDefinition[] {
  const repositoryStatus = pi.defineTool({
    name: "git_repository_status",
    label: "检查 Git 仓库状态",
    description: "检查当前工作区的分支、改动和远端，不读取或暴露凭据。",
    promptSnippet: "git_repository_status: 检查当前 Git 分支、改动与远端",
    promptGuidelines: ["提交或推送前先检查状态", "尊重与当前任务无关的未提交改动"],
    executionMode: "sequential",
    parameters: Type.Object({}),
    execute: async () => {
      const [status, remotes] = await Promise.all([
        runProgram(root, "git", ["status", "--short", "--branch"]),
        runProgram(root, "git", ["remote", "-v"]),
      ]);
      return toolText(`Git 状态：\n${programText(status, "工作区没有改动")}\n\n远端：\n${programText(remotes, "未配置远端")}`);
    },
  });

  const commit = pi.defineTool({
    name: "git_commit",
    label: "提交指定 Git 文件",
    description: "仅在用户明确要求提交时，暂存指定的工作区文件并创建一次 Git 提交；绝不使用 git add -A。",
    promptSnippet: "git_commit: 仅提交用户明确指定的任务文件",
    promptGuidelines: ["仅在用户明确要求提交时调用", "先检查 git_repository_status", "只传入当前任务相关的明确文件路径"],
    executionMode: "sequential",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }),
      message: Type.String({ minLength: 1, maxLength: 240 }),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { paths: string[]; message: string };
      const message = params.message.trim();
      if (!message || /[\r\n]/.test(message)) throw new Error("提交说明不能为空且不能包含换行");
      const paths = [...new Set(params.paths.map((candidate) => relativePath(root, safePath(root, candidate))))];
      for (const candidate of paths) {
        if (!fs.existsSync(path.join(root, candidate))) throw new Error(`待提交文件不存在：${candidate}`);
      }
      const stagedBefore = await runProgram(root, "git", ["diff", "--cached", "--name-only"]);
      const alreadyStaged = programText(stagedBefore, "")
        .split(/\r?\n/)
        .map((candidate) => candidate.trim().replaceAll("\\", "/"))
        .filter(Boolean);
      const unrelatedStaged = alreadyStaged.filter((candidate) => !paths.includes(candidate));
      if (unrelatedStaged.length > 0) {
        throw new Error(`暂存区已有不属于本次任务的文件，已拒绝提交：${unrelatedStaged.join(", ")}`);
      }
      const staged = await runProgram(root, "git", ["add", "--", ...paths]);
      programText(staged, "已暂存指定文件");
      const result = await runProgram(root, "git", ["commit", "-m", message], 90_000);
      return toolText(programText(result, "已创建 Git 提交"));
    },
  });

  const push = pi.defineTool({
    name: "git_push",
    label: "推送 Git 提交",
    description: "仅在用户明确要求推送时，推送当前分支到已配置的远端；认证由操作系统凭据管理器处理，不向模型暴露。",
    promptSnippet: "git_push: 推送当前分支的提交",
    promptGuidelines: ["仅在用户明确要求推送时调用", "先检查 git_repository_status", "报告真实推送结果"],
    executionMode: "sequential",
    parameters: Type.Object({}),
    execute: async () => {
      const result = await runProgram(root, "git", ["push"], 120_000);
      return toolText(programText(result, "Git 推送完成"));
    },
  });

  const connectionStatus = pi.defineTool({
    name: "github_connection_status",
    label: "检查 GitHub 连接",
    description: "检查本机 GitHub CLI 是否已连接；不会返回令牌、认证头或凭据内容。",
    promptSnippet: "github_connection_status: 检查 GitHub CLI 连接状态",
    executionMode: "sequential",
    parameters: Type.Object({}),
    execute: async () => {
      const result = await runProgram(root, "gh", ["auth", "status", "--hostname", "github.com"]);
      if (result.exitCode !== 0) throw new Error("GitHub CLI 当前未连接，请在本机完成 GitHub 登录后再试");
      return toolText("GitHub CLI 已连接，可检索仓库和代码，也可通过 Git 推送当前工作区。");
    },
  });

  const searchRepositories = pi.defineTool({
    name: "github_search_repositories",
    label: "检索 GitHub 仓库",
    description: "使用已连接的 GitHub CLI 检索公开或当前账号可见的仓库，不需要用户手动打开浏览器。",
    promptSnippet: "github_search_repositories: 在 GitHub 中检索仓库",
    executionMode: "sequential",
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { query: string; limit?: number };
      const result = await runProgram(root, "gh", [
        "search", "repos", validateSearchQuery(params.query), "--limit", String(params.limit ?? 5),
        "--json", "fullName,description,url,stargazersCount,visibility",
      ]);
      return toolText(programText(result, "没有找到匹配的仓库"));
    },
  });

  const searchCode = pi.defineTool({
    name: "github_search_code",
    label: "检索 GitHub 代码",
    description: "在 GitHub 仓库代码中检索，返回文件路径、仓库和链接；不下载或执行远程代码。",
    promptSnippet: "github_search_code: 在 GitHub 检索代码",
    executionMode: "sequential",
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { query: string; limit?: number };
      const result = await runProgram(root, "gh", [
        "search", "code", validateSearchQuery(params.query), "--limit", String(params.limit ?? 5),
        "--json", "path,repository,url,textMatches",
      ]);
      return toolText(programText(result, "没有找到匹配的代码"));
    },
  });

  const repositoryView = pi.defineTool({
    name: "github_repository_view",
    label: "查看 GitHub 仓库",
    description: "查看指定 GitHub 仓库的基本信息和当前账号权限，不读取或修改远端内容。",
    promptSnippet: "github_repository_view: 查看 GitHub 仓库信息",
    executionMode: "sequential",
    parameters: Type.Object({ repository: Type.String() }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { repository: string };
      const result = await runProgram(root, "gh", [
        "repo", "view", validateGitHubRepository(params.repository), "--json",
        "nameWithOwner,description,url,defaultBranchRef,isPrivate,viewerPermission",
      ]);
      return toolText(programText(result, "仓库信息为空"));
    },
  });

  return [repositoryStatus, commit, push, connectionStatus, searchRepositories, searchCode, repositoryView];
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
    ...createGitTools(pi, root),
  ];
}
