/**
 * 对话历史 — localStorage
 * 每个对话绑定独立 novelId + 草稿设定，互不共享记忆
 */

import type { NovelData } from "@/types/novel";
import { INITIAL_NOVEL_DATA } from "@/types/novel";

export interface ConversationMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ConversationCheckpoint {
  coveredThroughMessageId: string;
  sourceChecksum: string;
  generatedAt: number;
  generationModel: "deterministic-structured-v1";
  userPreferences: string[];
  confirmedDecisions: string[];
  rejectedItems: string[];
  currentTask: string;
  unfinishedItems: string[];
  factChangeCandidates: string[];
  lastAgentCommitment: string;
}

/** 对话级草稿（未落盘或未绑定时用） */
export type ConversationDraft = Pick<
  NovelData,
  | "novelName"
  | "totalChapters"
  | "brainstorm"
  | "outline"
  | "detailedOutline"
  | "characters"
  | "worldview"
  | "goldfinger"
  | "synopsis"
  | "opening"
  | "foreshadowing"
  | "chapters"
>;

export interface Conversation {
  id: string;
  title: string;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
  /** 绑定的本地小说 id；null = 尚未立项 */
  novelId: string | null;
  /** 本对话工作区草稿（切换对话时恢复） */
  draft: ConversationDraft;
  /** 服务端工作区租约。只用于证明本会话对绑定作品的所有权。 */
  workspaceLease?: string | null;
  pinned?: boolean;
  archived?: boolean;
  checkpoint?: ConversationCheckpoint | null;
}

const KEY = "withyou_conversations";
const ACTIVE_KEY = "withyou_active_conversation";

export function emptyDraft(): ConversationDraft {
  return {
    novelName: INITIAL_NOVEL_DATA.novelName,
    totalChapters: INITIAL_NOVEL_DATA.totalChapters,
    brainstorm: "",
    outline: "",
    detailedOutline: "",
    characters: "",
    worldview: "",
    goldfinger: "",
    synopsis: "",
    opening: "",
    foreshadowing: "",
    chapters: {},
  };
}

function loadAll(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]") as Conversation[];
    // 兼容旧数据：补 novelId / draft
    return raw.map((c) => ({
      ...c,
      novelId: c.novelId ?? null,
      workspaceLease: c.workspaceLease ?? null,
      pinned: c.pinned ?? false,
      archived: c.archived ?? false,
      checkpoint: c.checkpoint ?? null,
      messages: (c.messages ?? []).map((message, index) => ({
        ...message,
        id: message.id ?? `${message.timestamp}:${index}`,
      })),
      draft: c.draft
        ? {
            novelName: c.draft.novelName ?? INITIAL_NOVEL_DATA.novelName,
            totalChapters: c.draft.totalChapters ?? 300,
            brainstorm: c.draft.brainstorm ?? "",
            outline: c.draft.outline ?? "",
            detailedOutline: c.draft.detailedOutline ?? "",
            characters: c.draft.characters ?? "",
            worldview: c.draft.worldview ?? "",
            goldfinger: c.draft.goldfinger ?? "",
            synopsis: c.draft.synopsis ?? "",
            opening: c.draft.opening ?? "",
            foreshadowing: c.draft.foreshadowing ?? "",
            chapters: c.draft.chapters ?? {},
          }
        : emptyDraft(),
    }));
  } catch {
    return [];
  }
}

function sourceChecksum(messages: ConversationMessage[]): string {
  let hash = 0x811c9dc5;
  for (const message of messages) {
    const source = `${message.id}|${message.role}|${message.content}`;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function compactLines(messages: ConversationMessage[], matcher: RegExp, limit = 6): string[] {
  return messages
    .filter((message) => matcher.test(message.content))
    .map((message) => message.content.replace(/\s+/g, " ").trim().slice(0, 240))
    .filter(Boolean)
    .slice(-limit);
}

function buildCheckpoint(messages: ConversationMessage[]): ConversationCheckpoint | null {
  const covered = messages.slice(0, -10);
  if (covered.length < 10) return null;
  const users = covered.filter((message) => message.role === "user");
  const assistants = covered.filter((message) => message.role === "assistant");
  const lastUser = users.at(-1)?.content.replace(/\s+/g, " ").trim().slice(0, 400) ?? "";
  return {
    coveredThroughMessageId: covered.at(-1)?.id ?? "",
    sourceChecksum: sourceChecksum(covered),
    generatedAt: Date.now(),
    generationModel: "deterministic-structured-v1",
    userPreferences: compactLines(
      users,
      /偏好|喜欢|希望|风格|不要太|保持|保留|控制|加强|减少|多一些|少一些|维持|注意|节奏|情感|写法|语气/i,
    ),
    confirmedDecisions: compactLines(assistants, /已确认|已保存|已创建|确定/i),
    rejectedItems: compactLines(users, /不要|不想|拒绝|取消|不行|太过|别这样|换掉|去掉|停止|避免|不好|不喜欢/i),
    currentTask: lastUser,
    unfinishedItems: compactLines([...users, ...assistants], /待处理|下一步|未完成|需要补充|请确认/i),
    factChangeCandidates: compactLines(users, /改成|设为|变更|调整为|新增/i),
    lastAgentCommitment: assistants.at(-1)?.content.replace(/\s+/g, " ").trim().slice(0, 400) ?? "",
  };
}

export function renderConversationCheckpoint(checkpoint: ConversationCheckpoint): string {
  return `[结构化会话检查点]\n${JSON.stringify(checkpoint)}`;
}

function saveAll(list: Conversation[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function createConversation(firstUserMessage = "(新对话)"): Conversation {
  const all = loadAll();
  const conv: Conversation = {
    id: crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: firstUserMessage.slice(0, 20) + (firstUserMessage.length > 20 ? "…" : ""),
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    novelId: null,
    draft: emptyDraft(),
    workspaceLease: null,
    pinned: false,
    archived: false,
    checkpoint: null,
  };
  all.unshift(conv);
  saveAll(all);
  setActiveConversationId(conv.id);
  return conv;
}

export function getAllConversations(): Conversation[] {
  return loadAll();
}

export function getConversation(id: string): Conversation | undefined {
  return loadAll().find((c) => c.id === id);
}

/**
 * 路由首次直达时，浏览器端可能先完成导航再完成 localStorage 写入。
 * 为了让工作区激活保持幂等，按路由 id 补建一个空会话，而不是静默放弃激活。
 */
export function ensureConversation(id: string): Conversation {
  const existing = getConversation(id);
  if (existing) return existing;
  const all = loadAll();
  const now = Date.now();
  const conversation: Conversation = {
    id,
    title: "(新对话)",
    messages: [],
    createdAt: now,
    updatedAt: now,
    novelId: null,
    draft: emptyDraft(),
    workspaceLease: null,
    pinned: false,
    archived: false,
    checkpoint: null,
  };
  all.unshift(conversation);
  saveAll(all);
  setActiveConversationId(id);
  return conversation;
}

export function appendMessage(id: string, msg: ConversationMessage): Conversation | undefined {
  const all = loadAll();
  const target = all.find((c) => c.id === id);
  if (!target) return undefined;
  target.messages.push(msg);
  target.updatedAt = Date.now();
  saveAll(all);
  return target;
}

export function updateMessages(id: string, messages: ConversationMessage[]): void {
  const all = loadAll();
  const target = all.find((c) => c.id === id);
  if (!target) return;
  target.messages = messages.map((message, index) => ({
    ...message,
    id: message.id ?? `${message.timestamp}:${index}`,
  }));
  const nextCheckpoint = buildCheckpoint(target.messages);
  if (nextCheckpoint) target.checkpoint = nextCheckpoint;
  target.updatedAt = Date.now();
  // 首条用户消息改标题
  if (target.title === "(新对话)") {
    const firstUser = messages.find((m) => m.role === "user" && m.content);
    if (firstUser) {
      target.title = firstUser.content.slice(0, 20) + (firstUser.content.length > 20 ? "…" : "");
    }
  }
  saveAll(all);
}

export function updateConversationDraft(id: string, draft: Partial<ConversationDraft>): void {
  const all = loadAll();
  const target = all.find((c) => c.id === id);
  if (!target) return;
  target.draft = { ...target.draft, ...draft };
  target.updatedAt = Date.now();
  saveAll(all);
}

export function bindConversationNovel(id: string, novelId: string): void {
  const all = loadAll();
  const target = all.find((c) => c.id === id);
  if (!target) return;
  target.novelId = novelId;
  target.updatedAt = Date.now();
  saveAll(all);
}

export function renameConversation(id: string, title: string): void {
  const nextTitle = title.trim().slice(0, 60);
  if (!nextTitle) return;
  const all = loadAll();
  const target = all.find((c) => c.id === id);
  if (!target) return;
  target.title = nextTitle;
  target.updatedAt = Date.now();
  saveAll(all);
}

export function setConversationPinned(id: string, pinned: boolean): void {
  const all = loadAll();
  const target = all.find((c) => c.id === id);
  if (!target) return;
  target.pinned = pinned;
  target.updatedAt = Date.now();
  saveAll(all);
}

export function setConversationArchived(id: string, archived: boolean): void {
  const all = loadAll();
  const target = all.find((c) => c.id === id);
  if (!target) return;
  target.archived = archived;
  target.updatedAt = Date.now();
  saveAll(all);
}

export function isMeaningfulConversation(conversation: Conversation): boolean {
  const draft = conversation.draft ?? emptyDraft();
  return Boolean(
    conversation.novelId ||
      conversation.messages.some((message) => message.role === "user" && message.content.trim()) ||
      draft.novelName !== INITIAL_NOVEL_DATA.novelName ||
      draft.brainstorm ||
      draft.outline ||
      draft.detailedOutline ||
      draft.characters ||
      draft.worldview ||
      draft.goldfinger ||
      draft.synopsis ||
      draft.opening ||
      draft.foreshadowing ||
      Object.keys(draft.chapters ?? {}).length,
  );
}

export function updateConversationWorkspaceLease(id: string, workspaceLease: string): void {
  const all = loadAll();
  const target = all.find((c) => c.id === id);
  if (!target) return;
  target.workspaceLease = workspaceLease;
  target.updatedAt = Date.now();
  saveAll(all);
}

export function deleteConversation(id: string): void {
  saveAll(loadAll().filter((c) => c.id !== id));
  if (getActiveConversationId() === id) {
    setActiveConversationId(null);
  }
}

export function clearAllConversations(): void {
  saveAll([]);
  setActiveConversationId(null);
}

export function getActiveConversationId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveConversationId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

/** 返回使用了指定 personaId 的对话列表 */
export function listPersonaSessions(personaId: string): Conversation[] {
  const tag = `[persona:${personaId}]`;
  return loadAll().filter((c) => c.messages.some((m) => m.content.includes(tag)));
}
