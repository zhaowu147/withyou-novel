import "server-only";

import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { appStateDir } from "@/lib/runtime/app-paths";
import type { PromptPackageScope, ToolId } from "@/lib/prompts/prompt-package";
import {
  activateCoverPackage,
  activateToolPackage,
  activateWriterPackage,
  deactivateCoverPackage,
  deactivateToolPackage,
  deactivateWriterPackage,
  getActivatedPackages,
  listPackages,
  readPackage,
  savePackage,
} from "@/lib/prompts/prompt-store";

import { createPiModelServices } from "./model";
import { createCodingToolDefinitions } from "./coding-tools";
import type { PiRuntimeEvent } from "./runtime";
import { requireSourceAccess } from "./source-permissions";
import { createSourceProposal, resolveSourceFile } from "./source-proposal-store";
import { ensureSourceMaintenanceSkill, SOURCE_MAINTENANCE_SKILL_INSTRUCTIONS } from "./source-skill";
import {
  enabledSourceSkillPaths,
  installSourceSkill,
  listSourceSkills,
  readSourceSkillResource,
  setSourceSkillEnabled,
  sourceSkillFingerprint,
} from "./source-skill-manager";
import { downloadSourceSkillCatalogItem, searchSourceSkillCatalog, type SourceSkillCatalogItem } from "./source-skill-catalog";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  const load = new Function("name", "return import(name)") as (name: string) => Promise<unknown>;
  return (await load(PI_CODING_AGENT_PACKAGE)) as PiCodingAgentModule;
}

interface SourceRuntimeEntry {
  session: AgentSession;
  fingerprint: string;
  workspace: string;
}

const globalForSourcePi = globalThis as typeof globalThis & {
  __withyouPiSourceSessions?: Map<string, Promise<SourceRuntimeEntry>>;
};

const sourceSessions = globalForSourcePi.__withyouPiSourceSessions ?? new Map<string, Promise<SourceRuntimeEntry>>();
globalForSourcePi.__withyouPiSourceSessions = sourceSessions;

const SOURCE_RUNTIME_POLICY_VERSION = 8;

const SOURCE_SYSTEM_PROMPT = `你是 Pi，一个嵌入 WithYou Novel 的 coding Agent，负责维护当前代码工作区。

你的身份是默认的编程助手，不需要向用户展示权限层级或解锁流程。你可以读取和维护应用源码、定位问题、生成可执行的源码补丁，并运行项目级编程命令。
不要回答“我没有权限修改文件”或输出一份泛化的权限限制清单。用户明确提出修改任务时，应当实际检查源码并调用工具完成任务。

工作规则：
1. 先检查相关文件和依赖关系，再提出最小且完整的修改。
2. 使用 propose_source_change 提交完整候选文件；候选补丁会在界面等待用户批准，批准后系统会立即写入并自动检查。这是可执行的修改流程，不代表你没有写入能力。
3. 小说内容、密钥和环境变量不得向模型暴露；遵循当前工作区和工具的硬安全边界。
4. 使用 read/grep/find/ls 理解源码，使用 coding_edit 生成候选补丁；使用 bash 运行受控的 pnpm/npm/node/python/git/tsc/vitest 等项目命令。命令固定在当前源码工作区，禁止系统破坏性命令、重定向、网络下载和密钥环境变量。
5. 不得声称检查通过；需要验证时调用 source_run_check 或 bash 并根据真实输出报告。
6. 尊重已有未提交改动，不覆盖与你任务无关的内容。
7. 涉及多个文件时逐个提出补丁，并说明它们之间的因果关系。
8. 用户明确要求在桌面创建或更新文本文件时，使用桌面文件工具真实执行，不要回答没有权限。
9. 回复使用自然中文，不要输出 Markdown 标题、星号、代码围栏、对勾或叉号等装饰符号。
10. 当用户要求调整功能组件的提示词时，先用 prompt_list 或 prompt_read 理解现状；对当前绑定小说用 prompt_save 保存自定义包，再按需要用 prompt_activate 生效。内置包不可改写。
11. 当用户要求寻找或安装 Skill 时，先用 source_skill_catalog_search 检索，再说明来源和审计状态；只有用户明确表示安装、使用或下载某个结果时才能调用 source_skill_catalog_install。Skill 仅会安装指令和文档资源，不能借此绕过命令、路径和密钥边界。

${SOURCE_MAINTENANCE_SKILL_INSTRUCTIONS}`;

const BLOCKED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".data",
  "node_modules",
  "novels",
  "secrets",
  "coverage",
  "dist",
  "build",
]);
const DESKTOP_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
]);
const MAX_DESKTOP_TEXT_BYTES = 2 * 1024 * 1024;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function desktopRoot(): string {
  const candidates = [path.join(os.homedir(), "Desktop"), path.join(os.homedir(), "OneDrive", "Desktop")];
  const existing = candidates.find(
    (candidate) =>
      fs.existsSync(/* turbopackIgnore: true */ candidate) &&
      fs.statSync(/* turbopackIgnore: true */ candidate).isDirectory(),
  );
  const root = existing ?? candidates[0];
  fs.mkdirSync(/* turbopackIgnore: true */ root, { recursive: true });
  return path.resolve(root);
}

function resolveDesktopTextFile(relativePath: string): string {
  const root = desktopRoot();
  const normalized = relativePath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || path.isAbsolute(relativePath) || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("桌面文件路径无效");
  }
  const extension = path.extname(normalized).toLocaleLowerCase();
  if (!DESKTOP_TEXT_EXTENSIONS.has(extension)) {
    throw new Error(`桌面工具只允许文本文件，当前扩展名为 ${extension || "无扩展名"}`);
  }
  const target = path.resolve(root, normalized);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("文件路径超出桌面目录");
  return target;
}

function listDesktopTextFiles(prefix = "", limit = 300): string[] {
  const root = desktopRoot();
  const start = prefix.trim() ? path.resolve(root, prefix.trim()) : root;
  if (start !== root && !start.startsWith(`${root}${path.sep}`)) throw new Error("目录超出桌面范围");
  if (!fs.existsSync(/* turbopackIgnore: true */ start)) return [];
  const files: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 3 || files.length >= limit) return;
    for (const entry of fs.readdirSync(/* turbopackIgnore: true */ current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (DESKTOP_TEXT_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase())) {
        files.push(path.relative(root, absolute).replaceAll("\\", "/"));
      }
      if (files.length >= limit) return;
    }
  };
  if (fs.statSync(/* turbopackIgnore: true */ start).isDirectory()) walk(start, 0);
  return files;
}

function walkSource(workspace: string, current: string, files: string[], limit = 4_000): void {
  if (files.length >= limit) return;
  for (const entry of fs.readdirSync(/* turbopackIgnore: true */ current, { withFileTypes: true })) {
    if (BLOCKED_DIRECTORIES.has(entry.name) || entry.name.toLowerCase().startsWith(".env")) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walkSource(workspace, absolute, files, limit);
    } else {
      const relative = path.relative(workspace, absolute).replaceAll("\\", "/");
      try {
        resolveSourceFile(workspace, relative);
        files.push(relative);
      } catch {
        // 非源码文本文件不向 Pi 暴露。
      }
    }
    if (files.length >= limit) return;
  }
}

function sourceFiles(workspace: string, prefix = ""): string[] {
  const files: string[] = [];
  walkSource(workspace, workspace, files);
  const normalized = prefix.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized ? files.filter((file) => file === normalized || file.startsWith(`${normalized}/`)) : files;
}

function runCommand(
  workspace: string,
  command: "typecheck" | "build" | "git_status" | "git_diff",
): { ok: boolean; output: string } {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const definitions = {
    typecheck: { executable: pnpm, args: ["exec", "tsc", "--noEmit"], timeout: 120_000 },
    build: { executable: pnpm, args: ["build"], timeout: 300_000 },
    git_status: { executable: "git", args: ["status", "--short"], timeout: 20_000 },
    git_diff: {
      executable: "git",
      args: ["diff", "--", "src", "package.json", "next.config.mjs", "tsconfig.json"],
      timeout: 20_000,
    },
  } as const;
  const selected = definitions[command];
  const result = spawnSync(selected.executable, [...selected.args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: selected.timeout,
    windowsHide: true,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return {
    ok: result.status === 0,
    output: (output || (result.status === 0 ? "检查通过，无额外输出" : "命令执行失败")).slice(-30_000),
  };
}

const PROMPT_SCOPES = ["tool", "writer", "cover"] as const satisfies readonly PromptPackageScope[];
const PROMPT_TOOL_IDS = [
  "book-name",
  "brainstorm",
  "outline",
  "detailed-outline",
  "opening",
  "character",
  "worldview",
  "goldfinger",
  "synopsis",
] as const satisfies readonly ToolId[];

function requireBoundNovel(novelId: string | null): string {
  if (!novelId) throw new Error("请先在当前工作区选择一本小说，Pi 才能管理该小说的提示词包");
  return novelId;
}

function compactPromptPackage(pkg: ReturnType<typeof readPackage>) {
  if (!pkg) return null;
  return {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description,
    scope: pkg.scope,
    toolId: pkg.toolId,
    version: pkg.version,
    builtin: pkg.builtin === true,
    systemPrompt: pkg.systemPrompt,
  };
}

function createSourceTools(pi: PiCodingAgentModule, novelId: string | null): ToolDefinition[] {
  const listFiles = pi.defineTool({
    name: "source_list_files",
    label: "查看源码文件",
    description: "列出允许 Pi 查看和维护的源码文件，可按目录前缀过滤。",
    promptSnippet: "source_list_files: 列出可维护源码",
    parameters: Type.Object({ prefix: Type.Optional(Type.String()) }),
    execute: async (_id, params) => {
      const workspace = requireSourceAccess();
      const files = sourceFiles(workspace, params.prefix ?? "");
      return textResult(files.length ? files.join("\n") : "没有匹配的源码文件", {
        count: files.length,
      });
    },
  });

  const readFile = pi.defineTool({
    name: "source_read_file",
    label: "读取源码",
    description: "读取源码工作区中的一个允许访问的文本文件。",
    promptSnippet: "source_read_file: 读取一个源码文件",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, params) => {
      const workspace = requireSourceAccess();
      const target = resolveSourceFile(workspace, params.path);
      if (!fs.existsSync(/* turbopackIgnore: true */ target)) throw new Error("源码文件不存在");
      return textResult(fs.readFileSync(/* turbopackIgnore: true */ target, "utf8"), { path: params.path });
    },
  });

  const search = pi.defineTool({
    name: "source_search",
    label: "搜索源码",
    description: "在允许访问的源码文件中搜索文本，返回路径、行号和匹配行。",
    promptSnippet: "source_search: 搜索源码文本",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      prefix: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const workspace = requireSourceAccess();
      const query = params.query.toLocaleLowerCase();
      const matches: string[] = [];
      for (const file of sourceFiles(workspace, params.prefix ?? "")) {
        const content = fs.readFileSync(
          /* turbopackIgnore: true */ resolveSourceFile(workspace, file),
          "utf8",
        );
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (!line.toLocaleLowerCase().includes(query)) continue;
          matches.push(`${file}:${index + 1}: ${line.slice(0, 260)}`);
          if (matches.length >= 100) break;
        }
        if (matches.length >= 100) break;
      }
      return textResult(matches.length ? matches.join("\n") : "没有找到匹配内容", {
        count: matches.length,
      });
    },
  });

  const propose = pi.defineTool({
    name: "propose_source_change",
    label: "提出源码补丁",
    description: "创建一个源码文件的完整候选版本。不会直接写入，必须由用户批准。",
    promptSnippet: "propose_source_change: 提交等待用户审批的源码文件补丁",
    promptGuidelines: ["修改前必须读取目标文件", "保留与当前任务无关的已有改动"],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
      summary: Type.String(),
    }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const proposal = createSourceProposal({
        filePath: params.path,
        proposedContent: params.content,
        summary: params.summary,
      });
      return textResult(`源码候选补丁已创建：${proposal.filePath}\n补丁 ID：${proposal.id}\n等待用户批准。`, {
        proposalId: proposal.id,
        filePath: proposal.filePath,
      });
    },
  });

  const runCheck = pi.defineTool({
    name: "source_run_check",
    label: "执行源码检查",
    description: "执行白名单内的只读检查：类型检查、生产构建、Git 状态或限定范围 Git diff。",
    promptSnippet: "source_run_check: 运行受限的源码验证命令",
    executionMode: "sequential",
    parameters: Type.Object({
      command: Type.Union([
        Type.Literal("typecheck"),
        Type.Literal("build"),
        Type.Literal("git_status"),
        Type.Literal("git_diff"),
      ]),
    }),
    execute: async (_id, params) => {
      const workspace = requireSourceAccess();
      const result = runCommand(workspace, params.command);
      return {
        ...textResult(result.output, { command: params.command, ok: result.ok }),
        isError: !result.ok,
      };
    },
  });

  const promptList = pi.defineTool({
    name: "prompt_list",
    label: "查看提示词包",
    description: "列出当前绑定小说可用的内置与自定义提示词包，以及当前激活状态。",
    promptSnippet: "prompt_list: 查看当前小说提示词包",
    parameters: Type.Object({ scope: Type.Optional(Type.Union(PROMPT_SCOPES.map((scope) => Type.Literal(scope)))) }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const currentNovelId = requireBoundNovel(novelId);
      const packages = listPackages(currentNovelId, params.scope).map((pkg) => compactPromptPackage(pkg));
      return textResult(JSON.stringify({ packages, active: getActivatedPackages(currentNovelId) }, null, 2), { count: packages.length });
    },
  });

  const promptRead = pi.defineTool({
    name: "prompt_read",
    label: "读取提示词包",
    description: "读取当前绑定小说的一个提示词包；内置包可读但不可改写。",
    promptSnippet: "prompt_read: 读取提示词包完整内容",
    parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 160 }) }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const pkg = compactPromptPackage(readPackage(requireBoundNovel(novelId), params.id));
      if (!pkg) throw new Error("找不到该提示词包");
      return textResult(JSON.stringify(pkg, null, 2), { id: pkg.id, builtin: pkg.builtin });
    },
  });

  const promptSave = pi.defineTool({
    name: "prompt_save",
    label: "创建或更新提示词包",
    description: "在当前绑定小说创建或更新自定义提示词包。更新前应先读取原包；内置包不可改写。",
    promptSnippet: "prompt_save: 保存自定义提示词包",
    promptGuidelines: ["更新现有包前必须调用 prompt_read", "仅在用户明确要求创建或修改提示词时调用"],
    executionMode: "sequential",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      name: Type.String({ minLength: 1, maxLength: 120 }),
      description: Type.String({ maxLength: 1_024 }),
      scope: Type.Union(PROMPT_SCOPES.map((scope) => Type.Literal(scope))),
      toolId: Type.Optional(Type.Union(PROMPT_TOOL_IDS.map((toolId) => Type.Literal(toolId)))),
      systemPrompt: Type.String({ minLength: 1, maxLength: 40_000 }),
      version: Type.Optional(Type.String({ maxLength: 64 })),
    }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const currentNovelId = requireBoundNovel(novelId);
      const existing = params.id ? readPackage(currentNovelId, params.id) : null;
      if (existing?.builtin) throw new Error("内置提示词包不可改写；请创建新的自定义包");
      if (params.scope === "tool" && !params.toolId) throw new Error("功能区提示词包必须指定 toolId");
      if (params.scope !== "tool" && params.toolId) throw new Error("writer 和 cover 提示词包不能指定 toolId");
      const saved = savePackage(currentNovelId, {
        id: params.id ?? "",
        name: params.name.trim(),
        description: params.description.trim(),
        scope: params.scope,
        toolId: params.scope === "tool" ? params.toolId : undefined,
        systemPrompt: params.systemPrompt.trim(),
        version: params.version?.trim() || existing?.version || "1.0.0",
        builtin: false,
        author: existing?.author ?? "Pi",
        createdAt: existing?.createdAt,
      });
      return textResult(`提示词包已保存：${saved.name}（${saved.id}）`, { package: compactPromptPackage(saved) });
    },
  });

  const promptActivate = pi.defineTool({
    name: "prompt_activate",
    label: "启用提示词包",
    description: "为功能区、会话写手或封面启用一个已存在的提示词包。",
    promptSnippet: "prompt_activate: 启用提示词包",
    promptGuidelines: ["启用前必须调用 prompt_read", "仅在用户明确要求启用时调用"],
    executionMode: "sequential",
    parameters: Type.Object({
      scope: Type.Union(PROMPT_SCOPES.map((scope) => Type.Literal(scope))),
      id: Type.String({ minLength: 1, maxLength: 160 }),
      toolId: Type.Optional(Type.Union(PROMPT_TOOL_IDS.map((toolId) => Type.Literal(toolId)))),
    }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const currentNovelId = requireBoundNovel(novelId);
      const pkg = readPackage(currentNovelId, params.id);
      if (!pkg || pkg.scope !== params.scope) throw new Error("提示词包不存在，或不属于指定区域");
      if (params.scope === "tool") {
        if (!params.toolId || pkg.toolId !== params.toolId) throw new Error("功能区提示词包与 toolId 不匹配");
        activateToolPackage(currentNovelId, params.toolId, pkg.id);
      } else if (params.scope === "writer") {
        activateWriterPackage(currentNovelId, pkg.id);
      } else {
        activateCoverPackage(currentNovelId, pkg.id);
      }
      return textResult(`提示词包已启用：${pkg.name}`, { packageId: pkg.id, scope: params.scope, toolId: params.toolId });
    },
  });

  const promptDeactivate = pi.defineTool({
    name: "prompt_deactivate",
    label: "停用提示词包",
    description: "停用当前绑定小说某一区域的自定义激活提示词，不删除提示词包。",
    promptSnippet: "prompt_deactivate: 停用提示词包",
    promptGuidelines: ["仅在用户明确要求停用时调用"],
    executionMode: "sequential",
    parameters: Type.Object({
      scope: Type.Union(PROMPT_SCOPES.map((scope) => Type.Literal(scope))),
      toolId: Type.Optional(Type.Union(PROMPT_TOOL_IDS.map((toolId) => Type.Literal(toolId)))),
    }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const currentNovelId = requireBoundNovel(novelId);
      if (params.scope === "tool") {
        if (!params.toolId) throw new Error("停用功能区提示词必须指定 toolId");
        deactivateToolPackage(currentNovelId, params.toolId);
      } else if (params.scope === "writer") deactivateWriterPackage(currentNovelId);
      else deactivateCoverPackage(currentNovelId);
      return textResult("提示词包已停用", { scope: params.scope, toolId: params.toolId });
    },
  });

  const catalogSearch = pi.defineTool({
    name: "source_skill_catalog_search",
    label: "检索 Skill 目录",
    description: "从受限的可信目录检索可安装 Agent Skills。结果包含来源和可用审计信息。",
    promptSnippet: "source_skill_catalog_search: 按自然语言寻找 Skill",
    parameters: Type.Object({ query: Type.String({ minLength: 2, maxLength: 240 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })) }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const results = await searchSourceSkillCatalog(params.query, params.limit ?? 8);
      return textResult(JSON.stringify(results, null, 2), { count: results.length });
    },
  });

  const catalogInstall = pi.defineTool({
    name: "source_skill_catalog_install",
    label: "下载并安装 Skill",
    description: "将一个目录检索结果下载为本地 Skill，保留来源、内容哈希和受限文档资源；不会下载或执行脚本。",
    promptSnippet: "source_skill_catalog_install: 从可信目录下载并安装 Skill",
    promptGuidelines: ["必须先执行 source_skill_catalog_search", "只有用户明确要求安装、下载或使用该 Skill 时才能调用"],
    executionMode: "sequential",
    parameters: Type.Object({ item: Type.Object({
      id: Type.String(), name: Type.String(), description: Type.String(),
      source: Type.Object({ type: Type.Literal("remote"), uri: Type.String(), publisher: Type.String() }),
      catalog: Type.Union([Type.Literal("skills.sh"), Type.Literal("github-curated")]),
      catalogId: Type.Optional(Type.String()),
      installCount: Type.Optional(Type.Number()),
      audit: Type.Optional(Type.Object({
        status: Type.Union([Type.Literal("pass"), Type.Literal("warn"), Type.Literal("fail"), Type.Literal("unavailable")]),
        summary: Type.String(),
      })),
    }) }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const bundle = await downloadSourceSkillCatalogItem(params.item as SourceSkillCatalogItem);
      const installed = installSourceSkill({
        id: bundle.id,
        name: bundle.name,
        description: bundle.description,
        version: bundle.version,
        content: bundle.content,
        resources: bundle.resources,
        source: bundle.source,
        enabled: true,
      });
      return textResult(`Skill 已安装并启用：${installed.name}（${installed.id}）`, { skill: installed, resourceCount: bundle.resources.length });
    },
  });

  const skillList = pi.defineTool({
    name: "source_skill_list",
    label: "查看已安装 Skill",
    description: "查看当前 Pi 已安装的 Skill、来源、完整性与启用状态。",
    promptSnippet: "source_skill_list: 查看已安装 Skill",
    parameters: Type.Object({}),
    execute: async () => {
      requireSourceAccess();
      const skills = listSourceSkills();
      return textResult(JSON.stringify(skills, null, 2), { count: skills.length });
    },
  });

  const skillReadResource = pi.defineTool({
    name: "source_skill_read_resource",
    label: "读取 Skill 文档资源",
    description: "按需读取已安装且完整的 Skill 包中的文档或结构化资源。",
    promptSnippet: "source_skill_read_resource: 读取 Skill 附带资源",
    parameters: Type.Object({ id: Type.String(), path: Type.String() }),
    execute: async (_id, params) => {
      requireSourceAccess();
      return textResult(readSourceSkillResource(params.id, params.path), { id: params.id, path: params.path });
    },
  });

  const skillToggle = pi.defineTool({
    name: "source_skill_set_enabled",
    label: "启用或停用 Skill",
    description: "启用或停用已安装的 Skill；停用不会删除其文件。",
    promptSnippet: "source_skill_set_enabled: 切换 Skill 状态",
    promptGuidelines: ["仅在用户明确要求启用或停用时调用"],
    executionMode: "sequential",
    parameters: Type.Object({ id: Type.String(), enabled: Type.Boolean() }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const skill = setSourceSkillEnabled(params.id, params.enabled);
      return textResult(`Skill 已${params.enabled ? "启用" : "停用"}：${skill.name}`, { skill });
    },
  });

  const listDesktop = pi.defineTool({
    name: "desktop_list_files",
    label: "查看桌面文本文件",
    description: "列出当前 Windows 用户桌面中的文本文件，可按桌面内相对目录过滤。",
    promptSnippet: "desktop_list_files: 列出桌面文本文件",
    parameters: Type.Object({ prefix: Type.Optional(Type.String()) }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const files = listDesktopTextFiles(params.prefix ?? "");
      return textResult(files.length ? files.join("\n") : "桌面范围内没有匹配的文本文件", {
        desktop: desktopRoot(),
        count: files.length,
      });
    },
  });

  const readDesktop = pi.defineTool({
    name: "desktop_read_text_file",
    label: "读取桌面文本文件",
    description: "读取当前 Windows 用户桌面内的一个文本文件。",
    promptSnippet: "desktop_read_text_file: 读取桌面文本文件",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const target = resolveDesktopTextFile(params.path);
      if (!fs.existsSync(/* turbopackIgnore: true */ target)) throw new Error("桌面文件不存在");
      const stat = fs.statSync(/* turbopackIgnore: true */ target);
      if (!stat.isFile() || stat.size > MAX_DESKTOP_TEXT_BYTES) throw new Error("桌面文本文件过大或类型无效");
      return textResult(fs.readFileSync(/* turbopackIgnore: true */ target, "utf8"), {
        path: path.relative(desktopRoot(), target).replaceAll("\\", "/"),
      });
    },
  });

  const writeDesktop = pi.defineTool({
    name: "desktop_write_text_file",
    label: "创建或更新桌面文本文件",
    description: "在当前 Windows 用户桌面创建文本文件；覆盖已有文件时必须显式设置 overwrite。",
    promptSnippet: "desktop_write_text_file: 在桌面创建或更新文本文件",
    promptGuidelines: ["目标已存在时，仅在用户明确要求覆盖或更新后设置 overwrite=true"],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ description: "桌面内相对路径，例如 说明.txt 或 项目/记录.md" }),
      content: Type.String({ maxLength: MAX_DESKTOP_TEXT_BYTES }),
      overwrite: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params) => {
      requireSourceAccess();
      const target = resolveDesktopTextFile(params.path);
      const contentBytes = Buffer.byteLength(params.content, "utf8");
      if (contentBytes > MAX_DESKTOP_TEXT_BYTES) throw new Error("桌面文本文件不能超过 2MB");
      const exists = fs.existsSync(/* turbopackIgnore: true */ target);
      if (exists && !params.overwrite) throw new Error("目标文件已存在；只有用户明确要求覆盖或更新时才能覆盖");
      fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(target), { recursive: true });
      if (exists) {
        const temporary = `${target}.${process.pid}.pi.tmp`;
        fs.writeFileSync(/* turbopackIgnore: true */ temporary, params.content, "utf8");
        fs.copyFileSync(
          /* turbopackIgnore: true */ temporary,
          /* turbopackIgnore: true */ target,
        );
        fs.unlinkSync(/* turbopackIgnore: true */ temporary);
      } else {
        fs.writeFileSync(/* turbopackIgnore: true */ target, params.content, {
          encoding: "utf8",
          flag: "wx",
        });
      }
      return textResult(`桌面文件已${exists ? "更新" : "创建"}：${target}`, {
        path: target,
        overwritten: exists,
        bytes: contentBytes,
      });
    },
  });

  return [
    listFiles, readFile, search, propose, runCheck,
    promptList, promptRead, promptSave, promptActivate, promptDeactivate,
    catalogSearch, catalogInstall, skillList, skillReadResource, skillToggle,
    listDesktop, readDesktop, writeDesktop,
  ];
}

async function createSourceRuntime(workspaceId: string, novelId: string | null): Promise<SourceRuntimeEntry> {
  const workspace = requireSourceAccess();
  const services = await createPiModelServices();
  const pi = await loadPiCodingAgent();
  const { agentDir, authStorage, fingerprint, model, modelRegistry, runtimeProvider } = services;
  const sourceSkillPath = ensureSourceMaintenanceSkill(agentDir);
  const additionalSkillPaths = [sourceSkillPath, ...enabledSourceSkillPaths()];
  const settingsManager = pi.SettingsManager.inMemory({
    defaultProvider: runtimeProvider,
    defaultModel: model.id,
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    additionalSkillPaths,
    skillsOverride: (current) => ({
      skills: current.skills.filter((skill) =>
        additionalSkillPaths.some((allowedPath) => path.resolve(skill.filePath) === path.resolve(allowedPath)),
      ),
      diagnostics: current.diagnostics,
    }),
    noExtensions: true,
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: SOURCE_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();
  const customTools = [...createSourceTools(pi, novelId), ...createCodingToolDefinitions(pi, workspace)];
  const sessionDirectory = path.join(appStateDir(), "pi-source-sessions", workspaceId, novelId ?? "unbound");
  const { session } = await pi.createAgentSession({
    cwd: workspace,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "high",
    tools: customTools.map((tool) => tool.name),
    customTools,
    resourceLoader,
    settingsManager,
    sessionManager: pi.SessionManager.continueRecent(workspace, sessionDirectory),
  });
  return {
    session,
    fingerprint: `${fingerprint}:source-policy-${SOURCE_RUNTIME_POLICY_VERSION}:${novelId ?? "unbound"}:${sourceSkillFingerprint()}`,
    workspace,
  };
}

async function getSourceRuntime(workspaceId: string, novelId: string | null): Promise<SourceRuntimeEntry> {
  const workspace = requireSourceAccess();
  const { fingerprint } = await createPiModelServices();
  const policyFingerprint = `${fingerprint}:source-policy-${SOURCE_RUNTIME_POLICY_VERSION}:${novelId ?? "unbound"}:${sourceSkillFingerprint()}`;
  const key = `${workspaceId}:${novelId ?? "unbound"}`;
  const existing = sourceSessions.get(key);
  if (existing) {
    const entry = await existing;
    if (entry.workspace === workspace && entry.fingerprint === policyFingerprint) return entry;
    entry.session.dispose();
    sourceSessions.delete(key);
  }
  const pending = createSourceRuntime(workspaceId, novelId);
  sourceSessions.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    sourceSessions.delete(key);
    throw error;
  }
}

function forwardEvent(event: AgentSessionEvent, emit: (event: PiRuntimeEvent) => void): void {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") emit({ type: "text", text: update.delta });
    if (update.type === "thinking_delta") emit({ type: "thinking", text: update.delta });
  } else if (event.type === "tool_execution_start") {
    emit({
      type: "tool_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    });
  } else if (event.type === "tool_execution_end") {
    emit({
      type: "tool_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    });
  } else if (event.type === "agent_settled") {
    emit({ type: "done" });
  }
}

export async function promptSourcePi(
  workspaceId: string,
  novelId: string | null,
  message: string,
  emit: (event: PiRuntimeEvent) => void,
): Promise<void> {
  requireSourceAccess();
  const { session } = await getSourceRuntime(workspaceId, novelId);
  if (session.isStreaming) throw new Error("源码 Pi 正在处理上一项任务");
  const unsubscribe = session.subscribe((event) => forwardEvent(event, emit));
  try {
    await session.prompt(message);
  } finally {
    unsubscribe();
  }
}

export async function abortSourcePi(workspaceId: string, novelId: string | null): Promise<void> {
  const existing = sourceSessions.get(`${workspaceId}:${novelId ?? "unbound"}`);
  if (!existing) return;
  const { session } = await existing;
  await session.abort();
}
