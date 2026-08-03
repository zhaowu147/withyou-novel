import "server-only";

import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import { Type } from "typebox";

import { getCodingEnvironmentStatus, installCodingEnvironment } from "./coding-environment";
import { getPiExecutionBackend, type PiExecutionBackend } from "./execution-backend";
import { createSourceProposal, decideSourceProposal } from "./source-proposal-store";
import { installSourceSkill } from "./source-skill-manager";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const BLOCKED_SEGMENTS = new Set([".git", ".data", "node_modules", "coverage", "dist", "build", "secrets"]);
const MAX_OUTPUT = 30_000;
const MAX_GITHUB_SKILL_BYTES = 64 * 1024;
const MAX_GITHUB_API_OUTPUT = MAX_GITHUB_SKILL_BYTES * 2;
const MAX_COMMAND = 2_000;
const ALLOWED_COMMANDS = new Set([
  "pnpm",
  "pnpm.cmd",
  "npm",
  "npm.cmd",
  "corepack",
  "corepack.cmd",
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
  "cargo.exe",
  "go",
  "go.exe",
  "pip",
  "pip.exe",
  "uv",
  "uv.exe",
  "poetry",
  "poetry.exe",
  "bun",
  "bun.exe",
  "deno",
  "deno.exe",
  "dotnet",
  "java",
  "javac",
  "mvn",
  "mvn.cmd",
  "gradle",
  "gradle.bat",
  "ruby",
  "php",
  "composer",
  "make",
  "cmake",
]);
const BLOCKED_COMMANDS =
  /(?:^|\s)(?:del|erase|rm|rmdir|format|shutdown|reg|regsvr32|takeown|icacls|powershell|pwsh|cmd|winget|curl|wget|Invoke-WebRequest)(?:\s|$)/i;

type CodingPiModule = typeof import("@earendil-works/pi-coding-agent");
// biome-ignore lint/suspicious/noExplicitAny: Pi SDK tools intentionally have heterogeneous parameter schemas.
type AnyToolDefinition = ToolDefinition<any, any, any>;
type ProgramResult = { exitCode: number | null; output: string };

function safePath(root: string, candidate: string): string {
  const normalized = candidate.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (
    !normalized ||
    segments.some((segment) => BLOCKED_SEGMENTS.has(segment) || segment.toLowerCase().startsWith(".env"))
  ) {
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
    /[|<>;`\n\r]|\$\(|\b(?:git\s+(?:reset|clean|push|checkout|commit))\b|\b(?:node|python|py)\s+(?:-e|-c)\b|\b(?:npx|pnpm\s+dlx)\b/i.test(
      trimmed,
    )
  ) {
    throw new Error("该命令包含被禁止的系统、重定向或破坏性操作");
  }
  const executable = trimmed.split(/\s+/, 1)[0].toLowerCase();
  if (!ALLOWED_COMMANDS.has(executable))
    throw new Error(`仅允许运行受控开发命令：${[...ALLOWED_COMMANDS].slice(0, 8).join(", ")} 等`);
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

export function validateGitHubSkillPath(input: string): string {
  const normalized = input.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized ||
    !/(^|\/)SKILL\.md$/i.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("GitHub Skill 路径必须是仓库内的 SKILL.md 路径");
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

function redactProgramOutput(output: string, limit = MAX_OUTPUT): string {
  return output
    .replace(/(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]+/gi, "[已隐藏]")
    .replace(/https?:\/\/[^/\s@]+@/gi, "https://[已隐藏]@")
    .slice(-limit);
}

function killProcessTree(child: ReturnType<PiExecutionBackend["spawn"]>, backend: PiExecutionBackend): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    backend.spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGKILL");
  }
}

function runCommand(
  root: string,
  command: string,
  options: Parameters<NonNullable<BashOperations["exec"]>>[2],
  backend: PiExecutionBackend,
): Promise<{ exitCode: number | null }> {
  validateCodingCommand(command);
  const timeout = Math.min(Math.max(options.timeout ?? 120_000, 1_000), 10 * 60_000);
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  return new Promise((resolve) => {
    const child = backend.spawn(shell, args, {
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
      killProcessTree(child, backend);
      finish(null);
    }, timeout);
    options.signal?.addEventListener(
      "abort",
      () => {
        killProcessTree(child, backend);
        finish(null);
      },
      { once: true },
    );
  });
}

function runProgram(
  root: string,
  executable: string,
  args: string[],
  timeout = 30_000,
  maxOutput = MAX_OUTPUT,
  backend: PiExecutionBackend,
): Promise<ProgramResult> {
  return new Promise((resolve) => {
    const child = backend.spawn(executable, args, {
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
      resolve({ exitCode, output: redactProgramOutput(output, maxOutput) });
    };
    const onData = (data: Buffer) => {
      if (output.length < maxOutput) output += data.toString("utf8").slice(0, maxOutput - output.length);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      output += error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    const timer = setTimeout(() => {
      killProcessTree(child, backend);
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
    description: "像 coding agent 一样按精确文本替换编辑源码；修改会立即写入，并保留可回滚检查点和真实类型检查结果。",
    promptSnippet: "coding_edit: 用精确替换直接应用可回滚源码编辑",
    promptGuidelines: ["先用 read 读取目标文件", "每次只修改一个文件", "修改后根据自动检查结果继续修复或报告"],
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
      const proposal = createSourceProposal({
        filePath: relativePath(root, target),
        proposedContent: content,
        summary: params.summary,
      });
      const applied = decideSourceProposal(proposal.id, "apply");
      return {
        content: [
          {
            type: "text" as const,
            text: `源码已应用：${applied.filePath}\n检查点 ID：${applied.id}\n自动检查：${applied.validation?.ok ? "通过" : "失败"}\n${applied.validation?.output ?? "未运行检查"}`,
          },
        ],
        details: { proposalId: applied.id, filePath: applied.filePath, validation: applied.validation },
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

function githubSkillId(repository: string, skillPath: string): string {
  const readable =
    `${repository}-${skillPath.replace(/(^|\/)SKILL\.md$/i, "").replace(/[^A-Za-z0-9]+/g, "-")}`
      .toLowerCase()
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "github-skill";
  const hash = createHash("sha256").update(`${repository}/${skillPath}`, "utf8").digest("hex").slice(0, 8);
  return `${readable}-${hash}`;
}

function repositoryFromSearchResult(value: unknown): string | null {
  if (typeof value === "string") return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : null;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["nameWithOwner", "fullName"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) return candidate;
  }
  const owner = record.owner;
  const name = record.name;
  if (
    owner &&
    typeof owner === "object" &&
    typeof (owner as Record<string, unknown>).login === "string" &&
    typeof name === "string"
  ) {
    return `${(owner as Record<string, string>).login}/${name}`;
  }
  return null;
}

function decodeGitHubFile(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GitHub 没有返回可解析的文件内容");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("GitHub 返回的 Skill 文件格式无效");
  const record = parsed as Record<string, unknown>;
  if (record.encoding !== "base64" || typeof record.content !== "string")
    throw new Error("GitHub 返回的文件不是可读取的文本内容");
  const content = Buffer.from(record.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (!content.trim() || Buffer.byteLength(content, "utf8") > MAX_GITHUB_SKILL_BYTES) {
    throw new Error("Skill 文件为空或超过 64KB 安全上限");
  }
  return content;
}

function createEnvironmentTools(pi: CodingPiModule, root: string, backend: PiExecutionBackend): AnyToolDefinition[] {
  const status = pi.defineTool({
    name: "coding_environment_status",
    label: "检查编程环境",
    description: "检查当前机器的 Node、Git、Python、包管理器和当前项目依赖状态。",
    promptSnippet: "coding_environment_status: 检查开发环境与项目依赖",
    executionMode: "sequential",
    parameters: Type.Object({}),
    execute: async () => {
      const environment = getCodingEnvironmentStatus(root, backend);
      return toolText(JSON.stringify(environment, null, 2), { ready: environment.ready });
    },
  });

  const prepare = pi.defineTool({
    name: "coding_environment_prepare",
    label: "准备编程环境和依赖",
    description: "自动安装缺失的受支持开发工具、项目依赖和 Python 虚拟环境；在 Windows 上优先使用 winget。",
    promptSnippet: "coding_environment_prepare: 自动准备开发环境、项目依赖和 Python 虚拟环境",
    promptGuidelines: [
      "当用户要求运行、构建或安装项目但依赖缺失时直接调用",
      "必须根据真实结果说明已完成项和仍需处理项",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      tools: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("node"),
            Type.Literal("git"),
            Type.Literal("python"),
            Type.Literal("java"),
            Type.Literal("dotnet"),
            Type.Literal("go"),
            Type.Literal("rust"),
          ]),
          { maxItems: 7 },
        ),
      ),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { tools?: Array<"node" | "git" | "python" | "java" | "dotnet" | "go" | "rust"> };
      const result = installCodingEnvironment(root, params.tools, backend);
      const response = {
        ready: result.status.ready,
        tools: result.status.tools.map(({ name, available, version, minimum, error }) => ({
          name,
          available,
          version,
          minimum,
          error,
        })),
        project: result.status.project,
        attempted: result.attempted,
        output: result.output.map((entry) => redactProgramOutput(entry, 8_000)),
        requiresUserAction: result.requiresUserAction,
      };
      return toolText(JSON.stringify(response, null, 2), {
        ready: response.ready,
        attempted: response.attempted.length,
      });
    },
  });

  return [status, prepare];
}

function createGitTools(pi: CodingPiModule, root: string, backend: PiExecutionBackend): AnyToolDefinition[] {
  const run = (executable: string, args: string[], timeout = 30_000, maxOutput = MAX_OUTPUT) =>
    runProgram(root, executable, args, timeout, maxOutput, backend);
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
        run("git", ["status", "--short", "--branch"]),
        run("git", ["remote", "-v"]),
      ]);
      return toolText(
        `Git 状态：\n${programText(status, "工作区没有改动")}\n\n远端：\n${programText(remotes, "未配置远端")}`,
      );
    },
  });

  const commit = pi.defineTool({
    name: "git_commit",
    label: "提交指定 Git 文件",
    description: "仅在用户明确要求提交时，暂存指定的工作区文件并创建一次 Git 提交；绝不使用 git add -A。",
    promptSnippet: "git_commit: 仅提交用户明确指定的任务文件",
    promptGuidelines: [
      "仅在用户明确要求提交时调用",
      "先检查 git_repository_status",
      "只传入当前任务相关的明确文件路径",
    ],
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
      const stagedBefore = await run("git", ["diff", "--cached", "--name-only"]);
      const alreadyStaged = programText(stagedBefore, "")
        .split(/\r?\n/)
        .map((candidate) => candidate.trim().replaceAll("\\", "/"))
        .filter(Boolean);
      const unrelatedStaged = alreadyStaged.filter((candidate) => !paths.includes(candidate));
      if (unrelatedStaged.length > 0) {
        throw new Error(`暂存区已有不属于本次任务的文件，已拒绝提交：${unrelatedStaged.join(", ")}`);
      }
      const staged = await run("git", ["add", "--", ...paths]);
      programText(staged, "已暂存指定文件");
      const result = await run("git", ["commit", "-m", message], 90_000);
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
      const result = await run("git", ["push"], 120_000);
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
      const result = await run("gh", ["auth", "status", "--hostname", "github.com"]);
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
      const result = await run("gh", [
        "search",
        "repos",
        validateSearchQuery(params.query),
        "--limit",
        String(params.limit ?? 5),
        "--json",
        "fullName,description,url,stargazersCount,visibility",
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
      const result = await run("gh", [
        "search",
        "code",
        validateSearchQuery(params.query),
        "--limit",
        String(params.limit ?? 5),
        "--json",
        "path,repository,url,textMatches",
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
      const result = await run("gh", [
        "repo",
        "view",
        validateGitHubRepository(params.repository),
        "--json",
        "nameWithOwner,description,url,defaultBranchRef,isPrivate,viewerPermission",
      ]);
      return toolText(programText(result, "仓库信息为空"));
    },
  });

  const searchSkills = pi.defineTool({
    name: "github_skill_search",
    label: "搜索 GitHub Skill",
    description: "在 GitHub 的任意行业仓库中搜索 SKILL.md。搜索不受小说、编程或其他行业白名单限制。",
    promptSnippet: "github_skill_search: 从 GitHub 搜索任意领域的 Agent Skill",
    promptGuidelines: [
      "用户提出任何领域的 Skill 需求时直接搜索",
      "先返回候选来源和路径；用户明确要求使用或安装后才调用 github_skill_install",
    ],
    executionMode: "sequential",
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })) }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { query: string; limit?: number };
      const query = validateSearchQuery(params.query);
      const result = await run("gh", [
        "search",
        "code",
        query,
        "--filename",
        "SKILL.md",
        "--limit",
        String(params.limit ?? 8),
        "--json",
        "path,repository,url,textMatches",
      ]);
      const raw = programText(result, "[]");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("GitHub Skill 搜索结果格式无效");
      }
      const skills = Array.isArray(parsed)
        ? parsed.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const record = entry as Record<string, unknown>;
            const repository = repositoryFromSearchResult(record.repository);
            const path = typeof record.path === "string" ? record.path : null;
            if (!repository || !path) return [];
            try {
              const skillPath = validateGitHubSkillPath(path);
              const textMatches = Array.isArray(record.textMatches) ? record.textMatches : [];
              const preview = textMatches
                .flatMap((match) =>
                  match && typeof match === "object" && typeof (match as Record<string, unknown>).fragment === "string"
                    ? [(match as Record<string, string>).fragment.slice(0, 400)]
                    : [],
                )
                .at(0);
              return [
                { repository, path: skillPath, url: typeof record.url === "string" ? record.url : undefined, preview },
              ];
            } catch {
              return [];
            }
          })
        : [];
      return toolText(JSON.stringify({ query, skills }, null, 2), { count: skills.length });
    },
  });

  const readSkill = pi.defineTool({
    name: "github_skill_read",
    label: "读取 GitHub Skill",
    description: "读取 GitHub 仓库中任意行业 Skill 的 SKILL.md 内容，仅用于理解，不会安装或执行。",
    promptSnippet: "github_skill_read: 读取 GitHub Skill 的说明内容",
    executionMode: "sequential",
    parameters: Type.Object({ repository: Type.String(), path: Type.String() }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { repository: string; path: string };
      const repository = validateGitHubRepository(params.repository);
      const skillPath = validateGitHubSkillPath(params.path);
      const result = await run(
        "gh",
        ["api", `repos/${repository}/contents/${skillPath}`],
        30_000,
        MAX_GITHUB_API_OUTPUT,
      );
      const content = decodeGitHubFile(programText(result, ""));
      return toolText(content, { repository, path: skillPath, bytes: Buffer.byteLength(content, "utf8") });
    },
  });

  const installSkill = pi.defineTool({
    name: "github_skill_install",
    label: "安装 GitHub Skill",
    description: "将用户明确要求使用的 GitHub SKILL.md 安装到 Pi 的本地 Skill 目录；只保存说明文档，不执行仓库脚本。",
    promptSnippet: "github_skill_install: 安装用户明确要求使用的 GitHub Skill",
    promptGuidelines: [
      "必须先搜索或读取目标 Skill",
      "仅在用户明确要求安装、下载或使用时调用",
      "安装后说明该 Skill 会在下一项任务开始时生效",
    ],
    executionMode: "sequential",
    parameters: Type.Object({ repository: Type.String(), path: Type.String() }),
    execute: async (_id, rawParams) => {
      const params = rawParams as { repository: string; path: string };
      const repository = validateGitHubRepository(params.repository);
      const skillPath = validateGitHubSkillPath(params.path);
      const result = await run(
        "gh",
        ["api", `repos/${repository}/contents/${skillPath}`],
        30_000,
        MAX_GITHUB_API_OUTPUT,
      );
      const content = decodeGitHubFile(programText(result, ""));
      const installed = installSourceSkill({
        id: githubSkillId(repository, skillPath),
        content,
        source: {
          type: "remote",
          uri: `https://github.com/${repository}/blob/HEAD/${skillPath}`,
          publisher: repository,
        },
        enabled: true,
      });
      return toolText(`Skill 已安装并启用：${installed.name}（${installed.id}）。它会从下一项 Pi 任务开始加载。`, {
        skill: installed,
        repository,
        path: skillPath,
      });
    },
  });

  return [
    repositoryStatus,
    commit,
    push,
    connectionStatus,
    searchRepositories,
    searchCode,
    repositoryView,
    searchSkills,
    readSkill,
    installSkill,
  ];
}

export function createCodingToolDefinitions(
  pi: CodingPiModule,
  root: string,
  options: { executionBackend?: PiExecutionBackend } = {},
): AnyToolDefinition[] {
  const backend = options.executionBackend ?? getPiExecutionBackend();
  const safeRead = {
    readFile: async (absolute: string) => fs.promises.readFile(safePath(root, relativePath(root, absolute))),
    access: async (absolute: string) =>
      fs.promises.access(safePath(root, relativePath(root, absolute)), fs.constants.R_OK),
  };
  const safeGrep = {
    isDirectory: (absolute: string) => fs.statSync(safePath(root, relativePath(root, absolute))).isDirectory(),
    readFile: (absolute: string) => fs.readFileSync(safePath(root, relativePath(root, absolute)), "utf8"),
  };
  const safeFind = {
    exists: (absolute: string) => fs.existsSync(safePath(root, relativePath(root, absolute))),
    glob: (pattern: string, _cwd: string, options: { ignore: string[]; limit: number }) =>
      walkFiles(root)
        .filter(
          (file) =>
            minimatch(file, pattern, { dot: false }) && !options.ignore.some((ignore) => minimatch(file, ignore)),
        )
        .slice(0, options.limit),
  };
  const safeLs = {
    exists: (absolute: string) => fs.existsSync(safePath(root, relativePath(root, absolute))),
    stat: (absolute: string) => fs.statSync(safePath(root, relativePath(root, absolute))),
    readdir: (absolute: string) => fs.readdirSync(safePath(root, relativePath(root, absolute))),
  };
  const bashOperations: BashOperations = {
    exec: (command, _cwd, options) => runCommand(root, command, options, backend),
  };
  return [
    pi.createReadToolDefinition(root, { operations: safeRead }),
    pi.createGrepToolDefinition(root, { operations: safeGrep }),
    pi.createFindToolDefinition(root, { operations: safeFind }),
    pi.createLsToolDefinition(root, { operations: safeLs }),
    pi.createBashToolDefinition(root, { operations: bashOperations }),
    createEditTool(pi, root),
    ...createEnvironmentTools(pi, root, backend),
    ...createGitTools(pi, root, backend),
  ];
}
