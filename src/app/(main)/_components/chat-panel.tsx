"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Bot } from "lucide-react";

import { buildToolTakeoverMessage } from "@/lib/agents/session-context";
import { type ConversationMessage, getConversation, renderConversationCheckpoint } from "@/lib/ai/conversations";
import { consumeSse } from "@/lib/ai/sse-client";
import { actOnSemanticContract, createSemanticContract, updateSemanticContract } from "@/lib/semantic-alignment/client";
import type { SemanticContractEditableFields, SemanticContractEnvelope } from "@/lib/semantic-alignment/types";
import { countWords } from "@/lib/utils/words";
import { readableApiError, workspaceFetch } from "@/lib/workspaces/client";
import { useEntityStore } from "@/stores/entities/entity-store";
import { useForeshadowStore } from "@/stores/foreshadows/foreshadow-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useSessionOwnerStore } from "@/stores/session-owner";
import { useWorkspaceStatusStore } from "@/stores/workspace-status";
import type { NovelData } from "@/types/novel";

import { SemanticContractCard } from "./semantic-contract-card";

interface ChatPanelProps {
  novelData: NovelData;
  onUpdate: (updates: Partial<NovelData>) => void;
  conversationId: string | null;
  onMessagesChange: (messages: ConversationMessage[]) => void;
  onSaveChapter: (chapterNum: number, title: string, content: string) => void;
  pendingChapterWrite: number | null;
  onChapterWritten: () => void;
  toolContext: string | null;
  /** 确认写入文件树后的回调（工具 Agent 退场，写作 Agent 回归） */
  onToolConfirmed?: (finalContent: string) => void;
}

type PendingSemanticAction =
  | { kind: "chat"; messages: ConversationMessage[] }
  | { kind: "chapter"; num: number; message: string; messages: ConversationMessage[] };

interface ChatSseEvent extends Record<string, unknown> {
  type?: string;
  content?: string;
  message?: string;
  name?: string;
  args?: Record<string, unknown>;
  agentId?: string;
  agentName?: string;
  compression?: string[];
  novelId?: string;
  result?: string;
  phase?: string;
  text?: string;
  success?: boolean;
  validation?: {
    passed?: boolean;
    violatedConstraints?: Array<{ description?: string; evidence?: string }>;
    unverifiedConstraints?: Array<{ reason?: string }>;
  };
}

function toolDisplayName(name: string): string {
  const labels: Record<string, string> = {
    project_list_files: "项目文件树",
    project_read_file: "项目文件",
    project_search: "项目搜索结果",
    memory_recall: "相关长短期记忆",
    read_chapter_range: "相关章节正文",
    get_entities: "实体卡片",
    get_foreshadows: "伏笔记录",
    get_timeline: "故事时间线",
    get_story_graph: "故事图谱知识",
    agent_done: "证据核对完成",
  };
  return labels[name] ?? name;
}

export function ChatPanel({
  novelData,
  onUpdate,
  conversationId,
  onMessagesChange,
  onSaveChapter,
  pendingChapterWrite,
  onChapterWritten,
  onToolConfirmed,
}: ChatPanelProps) {
  const sessionOwner = useSessionOwnerStore((s) => s.owner);
  const toolSessionCtx = useSessionOwnerStore((s) => s.toolContext);
  const takeoverRevision = useSessionOwnerStore((s) => s.takeoverRevision);
  const setToolSessionMessages = useSessionOwnerStore((s) => s.setToolMessages);
  const releaseSession = useSessionOwnerStore((s) => s.release);
  const setWorkspaceTool = usePreferencesStore((state) => state.setWorkspaceTool);
  const saveStatus = useWorkspaceStatusStore((state) => state.saveStatus);

  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      role: "assistant",
      content: "你好！我是 AI 写作助手。我们从确定小说的基本信息开始 —— 你想写什么题材？",
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [agentProgress, setAgentProgress] = useState<string | null>(null);
  const [semanticEnvelope, setSemanticEnvelope] = useState<SemanticContractEnvelope | null>(null);
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [pendingSemanticAction, setPendingSemanticAction] = useState<PendingSemanticAction | null>(null);
  const [semanticValidationNotice, setSemanticValidationNotice] = useState<string | null>(null);
  const [generatedChapter, setGeneratedChapter] = useState<{ num: number; content: string } | null>(null);
  const [_pendingCall, setPendingCall] = useState<{ num: number; msg: string; msgs: ConversationMessage[] } | null>(
    null,
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const hasUserMessages = messages.some((message) => message.role === "user");
  const chapterCount = Object.keys(novelData.chapters ?? {}).length;
  const projectWordCount = Object.values(novelData.chapters ?? {}).reduce(
    (total, chapter) => total + countWords(chapter),
    0,
  );
  const projectPhase = chapterCount
    ? `正文创作 · ${chapterCount} 章`
    : novelData.detailedOutline
      ? "细纲已就绪"
      : novelData.outline
        ? "大纲已就绪"
        : novelData.characters
          ? "角色设定阶段"
          : novelData.worldview
            ? "世界观搭建阶段"
            : "尚未立项";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 切换会话或 Agent 所有权：写作历史与工具精修历史分开恢复。
  useEffect(() => {
    requestGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setAgentProgress(null);
    setPendingCall(null);
    setInput("");
    setSemanticEnvelope(null);
    setPendingSemanticAction(null);
    setSemanticValidationNotice(null);
    if (sessionOwner !== "writing" && toolSessionCtx) {
      const storedToolMessages = useSessionOwnerStore.getState().toolMessages;
      const takeoverMessages =
        storedToolMessages.length > 0
          ? storedToolMessages
          : [
              {
                id: `tool-takeover:${takeoverRevision}`,
                role: "assistant" as const,
                content: buildToolTakeoverMessage(toolSessionCtx),
                timestamp: Date.now(),
              },
            ];
      setMessages(takeoverMessages);
      if (storedToolMessages.length === 0) {
        setToolSessionMessages(takeoverMessages);
      }
      setGeneratedChapter(null);
      return;
    }
    if (!conversationId) {
      setMessages([
        {
          role: "assistant",
          content: "你好！我是 AI 写作助手。我们从确定小说的基本信息开始 —— 你想写什么题材？",
          timestamp: Date.now(),
        },
      ]);
      setGeneratedChapter(null);
      return;
    }
    const conv = getConversation(conversationId);
    if (conv && conv.messages.length > 0) {
      setMessages(conv.messages);
    } else {
      setMessages([
        {
          role: "assistant",
          content: "你好！我是 AI 写作助手。我们从确定小说的基本信息开始 —— 你想写什么题材？",
          timestamp: Date.now(),
        },
      ]);
    }
    setGeneratedChapter(null);
  }, [conversationId, sessionOwner, takeoverRevision, toolSessionCtx, setToolSessionMessages]);

  const commitMessages = useCallback(
    (next: ConversationMessage[]) => {
      setMessages(next);
      if (sessionOwner !== "writing" && toolSessionCtx) {
        setToolSessionMessages(next);
      } else {
        onMessagesChange(next);
      }
    },
    [onMessagesChange, sessionOwner, setToolSessionMessages, toolSessionCtx],
  );

  // 自动触发章节写入（从文件树"AI 写入"按钮）
  useEffect(() => {
    if (pendingChapterWrite === null || loading) return;
    const num = pendingChapterWrite;
    const chapterPlan = novelData.detailedOutline || novelData.outline;
    const outline = chapterPlan ? `本章规划依据：${chapterPlan.slice(0, 1200)}` : "";
    const characters = novelData.characters ? `已确认角色：${novelData.characters.slice(0, 800)}` : "";
    const autoMsg = `请帮我写第 ${num} 章正文。\n${outline}\n${characters}\n要求：以本章场景完整和既有细纲为准，节奏紧凑，必须承接上一章未完成动作，不得复写已经发生的事件，不得提前兑现后续终局。`;
    const userMsg = { role: "user" as const, content: autoMsg, timestamp: Date.now() };
    const updated = [...messages, userMsg];
    commitMessages(updated);
    onChapterWritten();
    void beginSemanticAlignment({ kind: "chapter", num, message: autoMsg, messages: updated });
  }, [pendingChapterWrite]);

  const callWriteChapter = async (
    num: number,
    autoMsg: string,
    _updated: ConversationMessage[],
    semanticContract: { id: string; version: number },
  ) => {
    const generation = ++requestGenerationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setAgentProgress("正在启动 Agent");
    // 占位 AI 消息
    const aiPlaceholder = { role: "assistant" as const, content: "", timestamp: Date.now() };
    setMessages((prev) => [...prev, aiPlaceholder]);

    try {
      // 流式正文(SSE) — 使用 /api/chat 走 Agent 系统
      const res = await workspaceFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: autoMsg }],
          novelId: novelData.novelId,
          semanticContractId: semanticContract.id,
          semanticContractVersion: semanticContract.version,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error(await readableApiError(res, "无法启动写作 Agent"));

      let aiContent = "";
      let placeholderIdx = -1;
      await consumeSse<ChatSseEvent>(res.body, {
        signal: controller.signal,
        isActive: () => requestGenerationRef.current === generation,
        onEvent: async (payload) => {
          if ((payload.type === "chunk" || payload.type === "token") && payload.content) {
            aiContent += payload.content;
            const cleaned = cleanMarkdown(aiContent);
            setMessages((prev) => {
              const copy = [...prev];
              if (placeholderIdx === -1) {
                placeholderIdx = copy.length - 1;
                copy[placeholderIdx] = { role: "assistant", content: cleaned, timestamp: Date.now() };
              } else if (copy[placeholderIdx] && copy[placeholderIdx].role === "assistant") {
                copy[placeholderIdx] = { ...copy[placeholderIdx], content: cleaned };
              }
              return copy;
            });
          } else if (payload.type === "agent_info") {
            console.debug("[chat] agent:", payload.agentName, payload.compression);
          } else if (payload.type === "agent_progress") {
            setAgentProgress(
              payload.text ||
                (payload.phase === "tool_completed" && payload.name
                  ? `已读取：${toolDisplayName(payload.name)}`
                  : payload.phase === "protocol_retry"
                    ? "正在纠正证据读取流程"
                    : "正在整理结果"),
            );
          } else if (payload.type === "sync_required") {
            // 工具写入后，同步文件系统状态
            if (payload.novelId) {
              const syncRes = await workspaceFetch(`/api/sync?novelId=${encodeURIComponent(payload.novelId)}`);
              if (syncRes.ok) {
                const syncData = await syncRes.json();
                if (syncData.success && syncData.data?.settings) {
                  onUpdate(syncData.data.settings);
                }
              }
            }
          } else if (payload.type === "done") {
            const cleaned = cleanMarkdown(aiContent);
            setGeneratedChapter({ num, content: cleaned });
          } else if (payload.type === "semantic_validation" && payload.validation) {
            const violations = payload.validation.violatedConstraints ?? [];
            const unverified = payload.validation.unverifiedConstraints ?? [];
            setSemanticValidationNotice(
              payload.validation.passed
                ? `语义验证通过 · 契约 v${semanticContract.version}`
                : `语义验证未通过：${
                    violations
                      .map((item) => `${item.description || "约束偏离"}（${item.evidence || "无证据"}）`)
                      .join("；") || unverified.map((item) => item.reason || "存在未验证约束").join("；")
                  }`,
            );
          } else if (payload.type === "error") {
            throw new Error(payload.message || "stream error");
          }
        },
      });
    } catch (e: unknown) {
      if (!controller.signal.aborted && requestGenerationRef.current === generation) {
        const msg = e instanceof Error ? e.message : "请求失败";
        setMessages((prev) => [...prev, { role: "assistant", content: `发生错误：${msg}`, timestamp: Date.now() }]);
      }
    } finally {
      if (requestGenerationRef.current === generation) {
        abortRef.current = null;
        setLoading(false);
        setAgentProgress(null);
      }
    }
  };

  // ─── 实体识别 ───
  const handleEnrichEntities = useCallback(async () => {
    if (!novelData.novelId) return;
    const lastAi = [...messages].reverse().find((m) => m.role === "assistant" && m.content.length > 50);
    if (!lastAi) return;
    try {
      const res = await workspaceFetch("/api/entities/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: lastAi.content, novelId: novelData.novelId }),
      });
      const json = await res.json();
      if (json.success && json.data?.savedCount > 0) {
        useEntityStore.getState().load(novelData.novelId);
      }
    } catch (e) {
      console.error("[chat-panel] enrich entities failed", e);
    }
  }, [messages, novelData.novelId]);

  // ─── 伏笔扫描 ───
  const handleScanForeshadows = useCallback(
    async (mode: "scan" | "suggest" | "resolve") => {
      if (!novelData.novelId) return;
      const lastAi = [...messages].reverse().find((m) => m.role === "assistant" && m.content.length > 50);
      if (!lastAi) return;
      try {
        const res = await workspaceFetch("/api/foreshadows/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: lastAi.content, novelId: novelData.novelId, mode }),
        });
        const json = await res.json();
        if (json.success) {
          useForeshadowStore.getState().load(novelData.novelId);
        }
      } catch (e) {
        console.error("[chat-panel] scan foreshadows failed", e);
      }
    },
    [messages, novelData.novelId],
  );

  // 清洗 AI 输出中的 markdown 符号
  const cleanMarkdown = (text: string): string => {
    return (
      text
        // 先处理 fenced code block:保留内容,剥掉围栏(代码块里可能是正文)
        .replace(/```[\s\S]*?```/g, (m) => m.replace(/^```\w*\n?/, "").replace(/\n?```$/, ""))
        // inline 标记
        .replace(/\*\*(.+?)\*\*/g, "$1") // **bold**
        .replace(/\*(.+?)\*/g, "$1") // *italic**
        .replace(/`(.+?)`/g, "$1") // `inline`
        // heading → plain text
        .replace(/^#+\s+/gm, "")
        // list marker → plain text
        .replace(/^-\s+/gm, "• ")
        // link → text only
        .replace(/\[(.+?)\]\(.+?\)/g, "$1")
        // 清理多余空行(保留最多一个)
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    );
  };

  // 解析章节存入指令：匹配"存入第X章"/"第X章存下来"/"save chapter X"等
  const parseChapterSave = (text: string): number | null => {
    const m =
      text.match(/(?:存入|存|保存|save)\s*(?:第?\s*(\d+)\s*章|chapter\s*(\d+))/i) ||
      text.match(/第\s*(\d+)\s*章\s*(?:存|保存|save)/i);
    if (m) return parseInt(m[1] || m[2], 10);
    return null;
  };

  const executeChatMessages = async (
    updated: ConversationMessage[],
    semanticContract: { id: string; version: number },
  ) => {
    setLoading(true);
    setAgentProgress("正在启动 Agent");
    const generation = ++requestGenerationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // 占位 AI 消息（流式追加）
    const aiPlaceholder = { role: "assistant" as const, content: "", timestamp: Date.now() };
    const withPlaceholder: ConversationMessage[] = [...updated, aiPlaceholder];
    setMessages(withPlaceholder);

    try {
      // 流式消费 SSE — 使用 /api/chat 走 Agent 系统
      // 工具模式下传递工具的 system prompt，让 API 使用工具 Agent 而非写作 Agent
      const isToolMode = sessionOwner !== "writing" && toolSessionCtx;
      const checkpoint = conversationId ? getConversation(conversationId)?.checkpoint : null;
      const requestBody: Record<string, unknown> = {
        messages: updated.map((m) => ({ role: m.role, content: m.content })),
        novelId: novelData.novelId,
        semanticContractId: semanticContract.id,
        semanticContractVersion: semanticContract.version,
      };
      if (checkpoint) requestBody.checkpoint = renderConversationCheckpoint(checkpoint);
      if (isToolMode && toolSessionCtx) {
        requestBody.toolId = toolSessionCtx.toolId;
      }

      const res = await workspaceFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error(await readableApiError(res, "无法启动写作 Agent"));

      let aiContent = "";
      const latestAiIdx = withPlaceholder.length - 1;
      await consumeSse<ChatSseEvent>(res.body, {
        signal: controller.signal,
        isActive: () => requestGenerationRef.current === generation,
        onEvent: (payload) => {
          if ((payload.type === "chunk" || payload.type === "token") && payload.content) {
            aiContent += payload.content;
            const cleaned = cleanMarkdown(aiContent);
            setMessages((prev) => {
              const copy = [...prev];
              if (copy[latestAiIdx] && copy[latestAiIdx].role === "assistant") {
                copy[latestAiIdx] = { ...copy[latestAiIdx], content: cleaned };
              } else {
                copy.push({ role: "assistant", content: cleaned, timestamp: Date.now() });
              }
              return copy;
            });
          } else if (payload.type === "agent_info") {
            console.debug("[chat] agent:", payload.agentName, payload.compression);
          } else if (payload.type === "agent_progress") {
            setAgentProgress(
              payload.text ||
                (payload.phase === "tool_completed" && payload.name
                  ? `已读取：${toolDisplayName(payload.name)}`
                  : payload.phase === "protocol_retry"
                    ? "正在纠正证据读取流程"
                    : "正在整理结果"),
            );
          } else if (payload.type === "tool_call") {
            console.debug("[chat] tool_call", payload.name, payload.args);
          } else if (payload.type === "tool_result") {
            console.debug("[chat] tool_result", payload.name, payload.result?.slice(0, 100));
          } else if (payload.type === "semantic_validation" && payload.validation) {
            const violations = payload.validation.violatedConstraints ?? [];
            const unverified = payload.validation.unverifiedConstraints ?? [];
            setSemanticValidationNotice(
              payload.validation.passed
                ? `语义验证通过 · 契约 v${semanticContract.version}`
                : `语义验证未通过：${
                    violations
                      .map((item) => `${item.description || "约束偏离"}（${item.evidence || "无证据"}）`)
                      .join("；") || unverified.map((item) => item.reason || "存在未验证约束").join("；")
                  }`,
            );
          } else if (payload.type === "done") {
            const cleaned = cleanMarkdown(aiContent);
            const final: ConversationMessage[] = [
              ...updated,
              { role: "assistant" as const, content: cleaned, timestamp: Date.now() },
            ];
            commitMessages(final);
          } else if (payload.type === "error") {
            throw new Error(payload.message || "stream error");
          }
        },
      });
    } catch (e: unknown) {
      if (!controller.signal.aborted && requestGenerationRef.current === generation) {
        const msg = e instanceof Error ? e.message : "请求失败";
        const errMsg: ConversationMessage = { role: "assistant", content: `发生错误：${msg}`, timestamp: Date.now() };
        const final: ConversationMessage[] = [...updated, errMsg];
        commitMessages(final);
      }
    } finally {
      if (requestGenerationRef.current === generation) {
        abortRef.current = null;
        setLoading(false);
        setAgentProgress(null);
      }
    }
  };

  const executeSemanticAction = async (
    action: PendingSemanticAction,
    semanticContract: { id: string; version: number },
  ) => {
    setSemanticEnvelope(null);
    setPendingSemanticAction(null);
    setSemanticValidationNotice(null);
    if (action.kind === "chapter") {
      await callWriteChapter(action.num, action.message, action.messages, semanticContract);
      return;
    }
    await executeChatMessages(action.messages, semanticContract);
  };

  const beginSemanticAlignment = async (action: PendingSemanticAction) => {
    if (!novelData.novelId) {
      const errorMessage: ConversationMessage = {
        role: "assistant",
        content: "当前会话尚未绑定小说，无法建立语义契约。",
        timestamp: Date.now(),
      };
      commitMessages([...action.messages, errorMessage]);
      return;
    }
    setSemanticBusy(true);
    setSemanticEnvelope(null);
    setPendingSemanticAction(action);
    try {
      const latestUser = [...action.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const next = await createSemanticContract({
        novelId: novelData.novelId,
        taskKind: sessionOwner === "writing" ? "writer" : "tool_refinement",
        toolId: sessionOwner === "writing" ? undefined : toolSessionCtx?.toolId,
        userInput: latestUser,
      });
      setSemanticEnvelope(next);
      if (next.contract.status === "confirmed") {
        await executeSemanticAction(action, { id: next.contract.id, version: next.contract.version });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "语义解析失败";
      commitMessages([
        ...action.messages,
        { role: "assistant", content: `语义对齐失败：${message}`, timestamp: Date.now() },
      ]);
      setPendingSemanticAction(null);
    } finally {
      setSemanticBusy(false);
    }
  };

  const handleSemanticUpdate = async (fields: SemanticContractEditableFields) => {
    if (!novelData.novelId || !semanticEnvelope) return;
    setSemanticBusy(true);
    try {
      setSemanticEnvelope(
        await updateSemanticContract({
          novelId: novelData.novelId,
          contractId: semanticEnvelope.contract.id,
          version: semanticEnvelope.contract.version,
          fields,
        }),
      );
    } catch (error) {
      setSemanticValidationNotice(error instanceof Error ? error.message : "保存语义修改失败");
    } finally {
      setSemanticBusy(false);
    }
  };

  const handleSemanticAction = async (action: "confirm" | "reject" | "reparse", saveAsLongTerm = false) => {
    if (!novelData.novelId || !semanticEnvelope) return;
    setSemanticBusy(true);
    try {
      const next = await actOnSemanticContract({
        novelId: novelData.novelId,
        contractId: semanticEnvelope.contract.id,
        version: semanticEnvelope.contract.version,
        action,
        saveAsLongTerm,
      });
      if (action === "reject") {
        setSemanticEnvelope(null);
        setPendingSemanticAction(null);
        return;
      }
      setSemanticEnvelope(next);
      if (action === "confirm" && pendingSemanticAction) {
        await executeSemanticAction(pendingSemanticAction, {
          id: next.contract.id,
          version: next.contract.version,
        });
      }
    } catch (error) {
      setSemanticValidationNotice(error instanceof Error ? error.message : "语义契约操作失败");
    } finally {
      setSemanticBusy(false);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading || semanticBusy || semanticEnvelope) return;
    setInput("");

    const saveToChapter = parseChapterSave(text);
    if (saveToChapter !== null) {
      const lastAi = [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.content.length > 50);
      if (lastAi) {
        const title = `第${saveToChapter}章`;
        onSaveChapter(saveToChapter, title, lastAi.content);
        commitMessages([
          ...messages,
          { role: "user", content: text, timestamp: Date.now() },
          {
            role: "assistant",
            content: `已将上文存入「${title}」。点左侧文件树第 ${saveToChapter} 章查看。`,
            timestamp: Date.now(),
          },
        ]);
        return;
      }
    }

    const updated: ConversationMessage[] = [...messages, { role: "user", content: text, timestamp: Date.now() }];
    commitMessages(updated);
    await beginSemanticAlignment({ kind: "chat", messages: updated });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center justify-between border-b bg-background/80 px-5">
        <div className="min-w-0">
          <div className="truncate font-semibold text-sm">{novelData.novelName || "我的作品"}</div>
          <div className="text-[11px] text-muted-foreground">{projectPhase}</div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>{projectWordCount.toLocaleString()} 字</span>
          <span className="flex items-center gap-1">
            <span
              className={`size-1.5 rounded-full ${
                loading || saveStatus === "saving"
                  ? "animate-pulse bg-amber-500"
                  : saveStatus === "error"
                    ? "bg-red-500"
                    : "bg-emerald-500"
              }`}
            />
            {loading
              ? "正在生成"
              : saveStatus === "saving"
                ? "正在保存"
                : saveStatus === "error"
                  ? "保存失败"
                  : saveStatus === "saved"
                    ? "已保存"
                    : "会话已隔离"}
          </span>
        </div>
      </header>
      {/* Messages */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
        {messages.map((msg, i) => (
          <div key={i} className={`flex items-start gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border bg-background">
                <Bot className="size-4" />
              </span>
            )}
            <div className="max-w-[86%] whitespace-pre-wrap rounded-xl bg-muted px-3 py-2 text-sm leading-6">
              {msg.content}
            </div>
          </div>
        ))}
        {!hasUserMessages && sessionOwner === "writing" && (
          <div className="mx-auto mt-8 max-w-xl rounded-xl border bg-background p-5 shadow-xs">
            <div className="font-semibold text-sm">
              {novelData.novelId ? "继续推进这部作品" : "从这里开始一部新作品"}
            </div>
            <p className="mt-1 text-muted-foreground text-xs leading-5">
              {novelData.novelId
                ? "AI 会以当前文件树为事实来源。你也可以从左侧创作工具继续完善设定。"
                : "可以先描述题材和核心脑洞，也可以在右侧直接导入已有小说。"}
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {[
                novelData.outline ? "检查现有大纲缺口" : "帮我梳理核心脑洞",
                novelData.characters ? "检查角色关系与动机" : "先设计核心角色",
                chapterCount ? "继续规划下一章" : "规划从大纲到正文的步骤",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setInput(suggestion)}
                  className="rounded-lg border px-3 py-2 text-left text-muted-foreground text-xs leading-5 transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground"
                >
                  {suggestion}
                </button>
              ))}
            </div>
            {!novelData.novelId && conversationId && (
              <div className="mt-4 border-t pt-4">
                <div className="mb-2 font-medium text-[11px] text-muted-foreground">首次使用建议</div>
                <div className="flex flex-wrap gap-2">
                  {[
                    { label: "1. 配置模型", tool: "settings" },
                    { label: "2. 创建角色", tool: "character" },
                    { label: "3. 生成大纲", tool: "outline" },
                  ].map((item) => (
                    <button
                      key={item.tool}
                      type="button"
                      onClick={() => {
                        setWorkspaceTool(item.tool);
                        window.history.replaceState(
                          null,
                          "",
                          `/studio/session/${encodeURIComponent(conversationId)}/tools/${item.tool}`,
                        );
                      }}
                      className="rounded-full border px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {semanticEnvelope && (
          <SemanticContractCard
            contract={semanticEnvelope.contract}
            history={semanticEnvelope.history}
            busy={semanticBusy || loading}
            onUpdate={handleSemanticUpdate}
            onConfirm={(saveAsLongTerm) => handleSemanticAction("confirm", saveAsLongTerm)}
            onReparse={() => handleSemanticAction("reparse")}
            onReject={() => handleSemanticAction("reject")}
          />
        )}
        {semanticValidationNotice && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              semanticValidationNotice.startsWith("语义验证通过")
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700"
                : "border-destructive/30 bg-destructive/5 text-destructive"
            }`}
          >
            {semanticValidationNotice}
          </div>
        )}
        {loading && (
          <div className="flex items-start justify-start gap-3">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border bg-background">
              <Bot className="size-4" />
            </span>
            <div className="max-w-[86%] rounded-xl bg-muted px-3 py-2 text-sm leading-6">
              <span className="animate-pulse">{agentProgress || "思考中..."}</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />

        {/* 章节写入按钮（有生成内容时显示） */}
        {generatedChapter && !loading && sessionOwner === "writing" && (
          <div className="flex items-center justify-between border-white/5 border-t bg-green-500/5 px-4 py-2">
            <span className="text-muted-foreground text-xs">
              已生成 第 {generatedChapter.num} 章（{countWords(generatedChapter.content)} 字）
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleEnrichEntities}
                className="cursor-pointer rounded-md border border-white/10 px-2 py-1 text-muted-foreground text-xs hover:text-foreground"
                title="识别文本中的实体"
              >
                识别实体
              </button>
              <button
                onClick={() => handleScanForeshadows("scan")}
                className="cursor-pointer rounded-md border border-white/10 px-2 py-1 text-muted-foreground text-xs hover:text-foreground"
                title="扫描伏笔"
              >
                扫描伏笔
              </button>
              <button
                onClick={() => {
                  onSaveChapter(generatedChapter.num, `第${generatedChapter.num}章`, generatedChapter.content);
                  setGeneratedChapter(null);
                }}
                className="cursor-pointer rounded-md bg-[#2D9F5A] px-3 py-1 font-medium text-white text-xs hover:bg-[#238B4A]"
              >
                存入第 {generatedChapter.num} 章
              </button>
            </div>
          </div>
        )}

        {/* 工具 Agent 模式：确认写入文件树按钮 */}
        {sessionOwner !== "writing" && !loading && (
          <div className="flex items-center justify-between border-white/5 border-t bg-blue-500/5 px-4 py-2">
            <span className="text-muted-foreground text-xs">🔧 {sessionOwner} 模式 — 修改满意后确认写入文件树</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  // 取消：工具退场；所有权 effect 会从持久化会话恢复写作历史。
                  releaseSession();
                }}
                className="cursor-pointer rounded-md border border-white/10 px-2 py-1 text-muted-foreground text-xs hover:text-foreground"
              >
                取消
              </button>
              <button
                onClick={() => {
                  // 优先取精修后的最后回复；尚未修改时直接写入原始工具产出。
                  const lastAi = [...messages]
                    .reverse()
                    .find(
                      (message) =>
                        message.role === "assistant" &&
                        !message.id?.startsWith("tool-takeover:") &&
                        message.content.length > 20,
                    );
                  const finalContent = lastAi?.content || toolSessionCtx?.toolOutput;
                  if (finalContent) {
                    onToolConfirmed?.(finalContent);
                  }
                  releaseSession();
                }}
                className="cursor-pointer rounded-md bg-[#2D9F5A] px-3 py-1 font-medium text-white text-xs hover:bg-[#238B4A]"
              >
                ✅ 确认写入文件树
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t p-4">
        <div className="relative mx-auto max-w-2xl">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend(); // 内部自带 try/catch，此处有意不等待
              }
            }}
            placeholder="告诉 AI 你想写什么..."
            disabled={semanticBusy || semanticEnvelope !== null}
            className="h-10 w-full rounded-lg border border-input bg-transparent pr-10 pl-3 text-sm outline-none focus:border-[#2D9F5A] focus:ring-2 focus:ring-[#2D9F5A]/20"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || loading || semanticBusy || semanticEnvelope !== null}
            aria-label="发送消息"
            className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer p-1 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="black"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 2 11 13" />
              <path d="m22 2-7 20-4-9-9-4z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
