import "server-only";

import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { projectDir, sanitizeNovelId } from "@/lib/local/paths";
import { novelFS } from "@/lib/novel-fs";
import { appStateDir } from "@/lib/runtime/app-paths";

import { createPiModelServices } from "./model";
import { createPiProposal } from "./proposal-store";
import type { PiAccessLevel } from "./source-permissions";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PiRuntimeEvent {
  type: "text" | "thinking" | "tool_start" | "tool_end" | "done" | "error";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

interface RuntimeEntry {
  session: AgentSession;
  fingerprint: string;
}

const globalForPi = globalThis as typeof globalThis & {
  __withyouPiSessions?: Map<string, Promise<RuntimeEntry>>;
};
const sessions = globalForPi.__withyouPiSessions ?? new Map<string, Promise<RuntimeEntry>>();
globalForPi.__withyouPiSessions = sessions;

const PI_RUNTIME_POLICY_VERSION = 2;
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_WORKSPACE_DRAFT_PREFIX = "workspace-pi-";

type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  // Keep this lookup opaque to Turbopack; the dependency is ESM and loads at request time.
  const load = new Function("name", "return import(name)") as (name: string) => Promise<unknown>;
  return (await load(PI_CODING_AGENT_PACKAGE)) as PiCodingAgentModule;
}

const PI_SYSTEM_PROMPT = `你是 Pi，一个嵌入小说创作软件的全局项目 Agent。

你的工作对象只有当前小说项目。文件树是项目的事实来源与长期记忆。
你可以查看、检索和理解项目文件，帮助用户整理设定、检查跨文件一致性、规划修改。

权限规则：
1. 你不能直接写文件。需要修改时，必须调用 propose_file_change 创建候选改动，等待用户在界面批准。
2. 不得尝试访问小说项目之外的路径，也不得访问应用源码、密钥或系统文件。
3. 修改前必须先读取目标文件；跨文件任务先列出并读取真正相关的文件，避免无意义地加载整个项目。
4. 用户要求创作时，尊重已有设定、人物关系、时间线和大纲，不擅自覆盖已确认事实。
5. 清楚说明你读取了什么、发现了什么、提议改动什么。
6. 每次完成一项任务后，必须调用 pi_done 工具并给出简要说明。不得在调用 pi_done 前停止回应。`;

const PI_DRAFT_SYSTEM_PROMPT = `你是 Pi，一个嵌入小说创作软件的项目 Agent。

当前工作区尚未选择小说项目，但你仍可正常与用户讨论开书准备、需求梳理、创作流程和项目规划。
这是与其他工作区及三级源码会话隔离的草稿会话。当前没有小说文件可供读取或修改，不要谎称已经检查文件。
用户选中小说后，系统会切换到该小说专属会话并提供对应项目工具。
回复使用自然中文，不要输出 Markdown 标题、星号、代码围栏、对勾或叉号等装饰符号。`;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function listVisibleProjectFiles(novelId: string): string[] {
  return novelFS
    .listAllFiles(novelId)
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.startsWith("vault/"));
}

function createNovelTools(
  pi: PiCodingAgentModule,
  workspaceId: string,
  novelId: string,
  accessLevel: Exclude<PiAccessLevel, "source">,
): ToolDefinition[] {
  const listFiles = pi.defineTool({
    name: "project_list_files",
    label: "查看项目文件",
    description: "列出当前小说项目的文件树。可用 prefix 限制目录。",
    promptSnippet: "project_list_files: 列出当前小说项目文件",
    parameters: Type.Object({
      prefix: Type.Optional(Type.String({ description: "相对目录，例如 设定/角色" })),
    }),
    execute: async (_id, params) => {
      const prefix = (params.prefix ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
      const files = listVisibleProjectFiles(novelId).filter(
        (file) => !prefix || file === prefix || file.startsWith(`${prefix}/`),
      );
      return textResult(files.length ? files.join("\n") : "该范围内没有文件", { count: files.length });
    },
  });

  const readFile = pi.defineTool({
    name: "project_read_file",
    label: "读取项目文件",
    description: "读取当前小说项目中的一个文本文件。路径必须来自项目文件树。",
    promptSnippet: "project_read_file: 读取一个小说项目文件",
    parameters: Type.Object({
      path: Type.String({ description: "项目内相对路径" }),
    }),
    execute: async (_id, params) => {
      if (params.path.replaceAll("\\", "/").startsWith("vault/")) {
        throw new Error("不能读取应用内部 vault 数据");
      }
      return textResult(novelFS.readFile(novelId, params.path), { path: params.path });
    },
  });

  const searchProject = pi.defineTool({
    name: "project_search",
    label: "检索项目",
    description: "在当前小说项目的文本文件中搜索关键词，返回匹配文件与行号。",
    promptSnippet: "project_search: 在小说项目中检索关键词",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      prefix: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const prefix = (params.prefix ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
      const query = params.query.toLocaleLowerCase();
      const matches: string[] = [];
      for (const file of listVisibleProjectFiles(novelId)) {
        if (prefix && !file.startsWith(prefix)) continue;
        const content = novelFS.readFileSafe(novelId, file);
        if (content == null) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLocaleLowerCase().includes(query)) continue;
          matches.push(`${file}:${index + 1}: ${lines[index].slice(0, 240)}`);
          if (matches.length >= 80) break;
        }
        if (matches.length >= 80) break;
      }
      return textResult(matches.length ? matches.join("\n") : "没有找到匹配内容", {
        count: matches.length,
      });
    },
  });

  const proposeChange = pi.defineTool({
    name: "propose_file_change",
    label: "提出文件改动",
    description: "为当前小说项目中的文件创建完整内容候选版本。不会直接写入，必须由用户批准。",
    promptSnippet: "propose_file_change: 创建等待用户批准的文件候选改动",
    promptGuidelines: ["修改文件前先读取原文件", "每次候选改动只针对一个文件"],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ description: "项目内相对路径" }),
      content: Type.String({ description: "修改后的完整文件内容" }),
      summary: Type.String({ description: "简短说明修改目的与影响" }),
    }),
    execute: async (_id, params) => {
      const proposal = createPiProposal(workspaceId, novelId, {
        filePath: params.path,
        proposedContent: params.content,
        summary: params.summary,
      });
      return textResult(`候选改动已创建：${proposal.filePath}\n候选 ID：${proposal.id}\n等待用户在 Pi 面板中批准。`, {
        proposalId: proposal.id,
        filePath: proposal.filePath,
      });
    },
  });

  const piDone = pi.defineTool({
    name: "pi_done",
    label: "任务完成",
    description: "完成当前任务后必须调用此工具，告知用户任务已结束并给出摘要。",
    promptSnippet: "pi_done: 任务完成时必须调用",
    parameters: Type.Object({
      summary: Type.String({ description: "本次任务的完成摘要（50字以内）" }),
      nextSteps: Type.Optional(Type.String({ description: "建议的后续操作（可选）" })),
    }),
    execute: async (_id, params) => {
      const text = params.nextSteps ? `✓ ${params.summary}\n\n建议下一步：${params.nextSteps}` : `✓ ${params.summary}`;
      return textResult(text, { done: true, summary: params.summary });
    },
  });

  return accessLevel === "project"
    ? [listFiles, readFile, searchProject, proposeChange, piDone]
    : [listFiles, readFile, searchProject, piDone];
}

async function createRuntime(
  workspaceId: string,
  novelId: string,
  accessLevel: Exclude<PiAccessLevel, "source">,
): Promise<RuntimeEntry> {
  const safeNovelId = sanitizeNovelId(novelId);
  const isWorkspaceDraft = safeNovelId.startsWith(PI_WORKSPACE_DRAFT_PREFIX);
  if (!isWorkspaceDraft && !novelFS.projectExists(safeNovelId)) {
    throw new Error("小说项目不存在，请先创建或选择项目");
  }

  const services = await createPiModelServices();
  const { agentDir, authStorage, config, fingerprint, model, modelRegistry, runtimeProvider } = services;
  const pi = await loadPiCodingAgent();

  const cwd = isWorkspaceDraft
    ? path.join(appStateDir(), "pi-draft-workspaces", workspaceId, accessLevel)
    : projectDir(safeNovelId);
  if (isWorkspaceDraft) fs.mkdirSync(cwd, { recursive: true });
  const settingsManager = pi.SettingsManager.inMemory({
    defaultProvider: runtimeProvider,
    defaultModel: config.model,
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: isWorkspaceDraft
      ? `${PI_DRAFT_SYSTEM_PROMPT}\n\n当前权限层级：${accessLevel === "observer" ? "一级观察" : "二级项目"}。`
      : accessLevel === "observer"
        ? `${PI_SYSTEM_PROMPT}\n\n当前为观察者模式：你没有提出文件改动的工具，只能读取、检索、分析和给出建议。`
        : PI_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();

  const sessionsRoot = path.join(appStateDir(), "pi-sessions");
  const sessionDirectory = path.join(sessionsRoot, "scoped", workspaceId, safeNovelId);
  const legacyDirectory = path.join(sessionsRoot, safeNovelId);
  if (!isWorkspaceDraft && !fs.existsSync(sessionDirectory) && fs.existsSync(legacyDirectory)) {
    fs.mkdirSync(path.dirname(sessionDirectory), { recursive: true });
    fs.cpSync(legacyDirectory, sessionDirectory, { recursive: true, errorOnExist: false });
    fs.writeFileSync(
      path.join(sessionDirectory, ".migrated-from-legacy"),
      JSON.stringify({ workspaceId, novelId: safeNovelId, copiedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  }
  const customTools = isWorkspaceDraft ? [] : createNovelTools(pi, workspaceId, safeNovelId, accessLevel);
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "medium",
    tools: customTools.map((tool) => tool.name),
    customTools,
    resourceLoader,
    settingsManager,
    sessionManager: pi.SessionManager.continueRecent(cwd, sessionDirectory),
  });
  return {
    session,
    fingerprint: `${fingerprint}:${accessLevel}:policy-${PI_RUNTIME_POLICY_VERSION}`,
  };
}

async function getRuntime(
  workspaceId: string,
  novelId: string,
  accessLevel: Exclude<PiAccessLevel, "source">,
): Promise<RuntimeEntry> {
  const safeNovelId = sanitizeNovelId(novelId);
  const key = `${workspaceId}:${safeNovelId}:${accessLevel}`;
  const { fingerprint } = await createPiModelServices();
  const scopedFingerprint = `${fingerprint}:${accessLevel}:policy-${PI_RUNTIME_POLICY_VERSION}`;
  const existing = sessions.get(key);
  if (existing) {
    const entry = await existing;
    if (entry.fingerprint === scopedFingerprint) return entry;
    entry.session.dispose();
    sessions.delete(key);
  }
  const pending = createRuntime(workspaceId, safeNovelId, accessLevel);
  sessions.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    sessions.delete(key);
    throw error;
  }
}

function forwardEvent(event: AgentSessionEvent, emit: (event: PiRuntimeEvent) => void): void {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") emit({ type: "text", text: update.delta });
    if (update.type === "thinking_delta") emit({ type: "thinking", text: update.delta });
    return;
  }
  if (event.type === "tool_execution_start") {
    emit({
      type: "tool_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    emit({
      type: "tool_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    });
    return;
  }
}

export async function promptPi(
  workspaceId: string,
  novelId: string,
  message: string,
  emit: (event: PiRuntimeEvent) => void,
  accessLevel: Exclude<PiAccessLevel, "source"> = "project",
): Promise<void> {
  const { session } = await getRuntime(workspaceId, novelId, accessLevel);
  if (session.isStreaming) throw new Error("Pi 正在处理上一项任务");
  const unsubscribe = session.subscribe((event) => forwardEvent(event, emit));
  try {
    await session.prompt(message);
  } finally {
    unsubscribe();
  }
}

export async function abortPi(workspaceId: string, novelId: string): Promise<void> {
  const prefix = `${workspaceId}:${sanitizeNovelId(novelId)}:`;
  const matching = [...sessions.entries()].filter(([key]) => key.startsWith(prefix));
  await Promise.all(
    matching.map(async ([, existing]) => {
      const { session } = await existing;
      await session.abort();
    }),
  );
}
