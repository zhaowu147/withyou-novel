"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "sonner";

import {
  bindConversationNovel,
  type ConversationMessage,
  createConversation,
  emptyDraft,
  getActiveConversationId,
  getAllConversations,
  getConversation,
  setActiveConversationId,
  updateConversationDraft,
  updateConversationWorkspaceLease,
  updateMessages,
} from "@/lib/ai/conversations";
import { agentWorkbenchRolloutEnabled } from "@/lib/features/agent-rollout";
import { decodeChapterRecord } from "@/lib/novel/import-parser";
import { PROMPT_TEMPLATES } from "@/lib/tools/prompt-templates";
import { TOOL_WORKFLOWS } from "@/lib/tools/workflow";
import { countWords } from "@/lib/utils/words";
import { setActiveWorkspaceCredentials, workspaceFetch } from "@/lib/workspaces/client";
import { useEntityStore } from "@/stores/entities/entity-store";
import { TOOL_DEPENDS, useFileTreeMetaStore } from "@/stores/file-tree-meta";
import { useForeshadowStore } from "@/stores/foreshadows/foreshadow-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { type ToolId, type ToolSessionContext, useSessionOwnerStore } from "@/stores/session-owner";
import { useWorkspaceStatusStore } from "@/stores/workspace-status";
import type { NovelData } from "@/types/novel";
import { FILE_FIELDS, INITIAL_NOVEL_DATA } from "@/types/novel";

import { AgentWorkbenchPanel } from "./agent-workbench-panel";
import { BookAnalysisPanel } from "./book-analysis-panel";
import { ChatPanel } from "./chat-panel";
import { CoverPanel } from "./cover-panel";
import { EntityCardManager } from "./entity-card-manager";
import { FileTree } from "./file-tree";
import { ForeshadowLedger } from "./foreshadow-ledger";
import { NovelImportDialog, type NovelImportRequest } from "./novel-import-dialog";
import { PromptMarketPanel } from "./prompt-market-panel";
import { SettingsPanel } from "./settings-panel";
import { StatsPanel } from "./stats-panel";
import { StoryGraph3D } from "./story-graph-3d";
import { ToolPanel } from "./tool-panel";

interface WorkspaceProps {
  initialConversationId?: string | null;
  initialToolId?: string | null;
}

export function Workspace({ initialConversationId = null, initialToolId = null }: WorkspaceProps = {}) {
  const [data, setData] = useState<NovelData>(INITIAL_NOVEL_DATA);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const conversationIdRef = useRef<string | null>(null);
  const novelIdRef = useRef<string | null>(null);
  const dataRef = useRef<NovelData>(INITIAL_NOVEL_DATA);
  const [novelId, setNovelId] = useState<string | null>(null);
  const agentWorkbenchEnabled = agentWorkbenchRolloutEnabled(initialConversationId || "new-conversation");

  const workspaceTool = usePreferencesStore((s) => s.workspaceTool);
  const setWorkspaceTool = usePreferencesStore((s) => s.setWorkspaceTool);
  const fileTreeMeta = useFileTreeMetaStore((s) => s.fields);
  const recordFileWrite = useFileTreeMetaStore((s) => s.recordWrite);
  const activateFileTreeMeta = useFileTreeMetaStore((s) => s.activateWorkspace);
  const activateSessionOwner = useSessionOwnerStore((s) => s.activateWorkspace);
  const activateWorkspaceStatus = useWorkspaceStatusStore((s) => s.activateWorkspace);
  const setSaveStatus = useWorkspaceStatusStore((s) => s.setSaveStatus);

  const handleUpdate = useCallback((updates: Partial<NovelData>) => {
    setData((prev) => {
      const next = { ...prev, ...updates };
      // 同步回当前对话的 draft（确保切换时能恢复）
      const cid = conversationIdRef.current;
      if (cid) {
        updateConversationDraft(cid, {
          novelName: next.novelName,
          totalChapters: next.totalChapters,
          brainstorm: next.brainstorm,
          outline: next.outline,
          detailedOutline: next.detailedOutline,
          characters: next.characters,
          worldview: next.worldview,
          goldfinger: next.goldfinger,
          synopsis: next.synopsis,
          opening: next.opening,
          foreshadowing: next.foreshadowing,
          chapters: next.chapters,
        });
      }
      return next;
    });
  }, []);

  const handleItemClick = useCallback((name: string) => {
    setSelectedItem((prev) => (prev === name ? null : name));
    setEditing(false);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedItem(null);
    setEditing(false);
  }, []);

  const handleCloseTool = useCallback(() => {
    setWorkspaceTool(null);
  }, [setWorkspaceTool]);

  // 工具面板 → 存入文件树字段
  const handleSaveToField = useCallback(
    (field: keyof NovelData, value: string, sourceToolId?: ToolId) => {
      handleUpdate({ [field]: value } as Partial<NovelData>);
      recordFileWrite(field, sourceToolId ? (TOOL_DEPENDS[sourceToolId] ?? []) : [], fileTreeMeta);
    },
    [fileTreeMeta, handleUpdate, recordFileWrite],
  );

  // 当前激活工具 → taskType(传给 chat route 触发 slim context 注入)
  const toolToTaskType = useCallback((): NovelData["taskType"] => {
    switch (workspaceTool) {
      case "book-name":
      case "brainstorm":
      case "synopsis":
        return "refine";
      case "outline":
      case "detailed-outline":
        return "volume_outline";
      case "opening":
        return "write_chapter";
      case "character":
      case "goldfinger":
        return "entity_enrich";
      case "worldview":
        return "volume_outline";
      case "entities":
        return "entity_enrich";
      case "foreshadow":
        return "refine";
      case "book-analysis":
        return "logic_check";
      default:
        return undefined;
    }
  }, [workspaceTool]);

  // 对话产出的章节正文 → 存入文件树
  const handleSaveChapter = useCallback(
    (chapterNum: number, title: string, content: string) => {
      const key = `第${chapterNum}章`;
      setData((prev) => ({
        ...prev,
        chapters: { ...prev.chapters, [key]: JSON.stringify({ title, content }) },
      }));
      // 章节写入后异步分化规范/长期/短期记忆，静默失败不影响主流程
      if (novelId) {
        workspaceFetch(`/api/novels/${encodeURIComponent(novelId)}/auto-track`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chapterText: content, chapterNum }),
        }).catch(() => {
          /* 静默失败 */
        });
      }
    },
    [novelId],
  );

  // 文件树章节点击 "AI 写入" → 触发对话写本章
  const [pendingChapterWrite, setPendingChapterWrite] = useState<number | null>(null);
  const triggerChapterWrite = useCallback(
    (chapterNum: number) => {
      setPendingChapterWrite(chapterNum);
      // 自动关闭工具面板回到对话
      setWorkspaceTool(null);
    },
    [setWorkspaceTool],
  );

  // ─── hydration：只恢复「当前对话」绑定的草稿，绝不灌入最新一本小说 ───
  const [hydrated, setHydrated] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const switchingRef = useRef(false);
  const switchVersionRef = useRef(0);
  const switchAbortRef = useRef<AbortController | null>(null);

  const handleNovelImport = useCallback(
    async (request: NovelImportRequest) => {
      let targetId = novelId;
      if (!targetId) {
        const createResponse = await workspaceFetch("/api/novels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: request.title,
            total_chapters: request.chapters.length,
          }),
        });
        const createJson = await createResponse.json();
        const created = createJson?.data ?? createJson;
        if (!createResponse.ok || !created?.id) {
          throw new Error(createJson?.error?.message || "创建小说项目失败");
        }
        targetId = created.id as string;
        setNovelId(targetId);
        if (conversationId) {
          bindConversationNovel(conversationId, targetId);
          window.dispatchEvent(new CustomEvent("workspace-activated"));
          window.dispatchEvent(new CustomEvent("conversations-changed"));
        }
      }

      const response = await workspaceFetch(`/api/novels/${encodeURIComponent(targetId)}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error?.message || "导入失败");
      }
      const result = json.data as {
        chapters: Array<{ number: number; title: string; content: string }>;
        skipped: number;
        totalChapters: number;
      };
      const merged = { ...data.chapters };
      for (const chapter of result.chapters) {
        merged[`第${chapter.number}章`] = JSON.stringify({
          title: chapter.title,
          content: chapter.content,
        });
      }
      const nextTotal = Object.keys(data.chapters).length
        ? Math.max(data.totalChapters, result.totalChapters)
        : result.totalChapters;
      handleUpdate({
        novelName: request.title,
        novelId: targetId,
        totalChapters: nextTotal,
        chapters: merged,
      });
      recordFileWrite("chapters", [], fileTreeMeta);

      if (request.analyze) {
        const analysisResponse = await workspaceFetch("/api/graph/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ novelId: targetId, action: "refresh" }),
        });
        const analysisJson = await analysisResponse.json();
        if (!analysisResponse.ok || !analysisJson.success) {
          toast.warning("章节已导入，但人物与事件识别失败，可稍后在故事图谱中重新识别");
        } else {
          toast.success(`已导入 ${result.chapters.length} 章，并更新人物与事件知识`);
        }
      } else {
        toast.success(`已导入 ${result.chapters.length} 章${result.skipped ? `，跳过 ${result.skipped} 章` : ""}`);
      }
    },
    [conversationId, data.chapters, data.totalChapters, fileTreeMeta, handleUpdate, novelId, recordFileWrite],
  );

  // 同步 conversationId 到 ref，供 handleUpdate 闭包使用
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    novelIdRef.current = novelId;
  }, [novelId]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // ─── 会话所有权：工具 Agent 接管中栏对话区 ───
  const takeoverSession = useSessionOwnerStore((s) => s.takeover);
  const activeToolSessionContext = useSessionOwnerStore((s) => s.toolContext);

  /**
   * 工具面板调用：将工具输出"应用到对话区"
   * 工具 Agent 接管中栏，用户可以在对话区迭代修改
   */
  const handleToolApplyToChat = useCallback(
    (toolId: ToolId, userInput: string, toolOutput: string) => {
      const ctx: ToolSessionContext = {
        toolId,
        userInput,
        toolOutput,
      };

      takeoverSession(ctx, conversationId);
    },
    [takeoverSession, conversationId],
  );

  /**
   * 工具 Agent 确认写入文件树后的回调
   * 将最终内容存入对应的 NovelData 字段
   */
  const handleToolConfirmed = useCallback(
    (toolId: ToolId, finalContent: string) => {
      const field = TOOL_WORKFLOWS[toolId].outputField;
      if (field) {
        handleSaveToField(field, finalContent, toolId);
      }

      setWorkspaceTool(null);
    },
    [handleSaveToField, setWorkspaceTool],
  );

  const handleActiveToolConfirmed = useCallback(
    (finalContent: string) => {
      if (!activeToolSessionContext) return;
      handleToolConfirmed(activeToolSessionContext.toolId, finalContent);
    },
    [activeToolSessionContext, handleToolConfirmed],
  );

  const applyConversation = useCallback(
    async (id: string | null, options?: { preserveWorkspaceTool?: boolean }) => {
      const version = ++switchVersionRef.current;
      switchingRef.current = true;
      activateWorkspaceStatus(id);
      switchAbortRef.current?.abort();
      const controller = new AbortController();
      switchAbortRef.current = controller;

      const previousId = conversationIdRef.current;
      const previousData = dataRef.current;
      if (previousId) {
        updateConversationDraft(previousId, {
          novelName: previousData.novelName,
          totalChapters: previousData.totalChapters,
          brainstorm: previousData.brainstorm,
          outline: previousData.outline,
          detailedOutline: previousData.detailedOutline,
          characters: previousData.characters,
          worldview: previousData.worldview,
          goldfinger: previousData.goldfinger,
          synopsis: previousData.synopsis,
          opening: previousData.opening,
          foreshadowing: previousData.foreshadowing,
          chapters: previousData.chapters,
        });
      }

      // 先同步清空全部项目级状态，再尝试加载目标会话。失败时保持空白，绝不回退到旧项目。
      conversationIdRef.current = id;
      novelIdRef.current = null;
      dataRef.current = { ...INITIAL_NOVEL_DATA };
      setConversationId(id);
      setNovelId(null);
      setData({ ...INITIAL_NOVEL_DATA });
      setActiveConversationId(id);
      setActiveWorkspaceCredentials(null);
      activateFileTreeMeta(id);
      activateSessionOwner(id);
      useEntityStore.getState().setNovel(null);
      useForeshadowStore.getState().setNovel(null);
      setSelectedItem(null);
      setEditing(false);
      setEditBuffer("");
      setPendingChapterWrite(null);
      if (!options?.preserveWorkspaceTool) {
        setWorkspaceTool(null);
      }

      if (!id) {
        if (switchVersionRef.current === version) switchingRef.current = false;
        return;
      }

      const conv = getConversation(id);
      if (!conv) {
        if (switchVersionRef.current === version) switchingRef.current = false;
        return;
      }

      try {
        let activationResponse = await fetch("/api/workspaces/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: id,
            novelId: conv.novelId,
            lease: conv.workspaceLease ?? null,
          }),
          signal: controller.signal,
        });
        let activationJson = await activationResponse.json();
        if (!activationResponse.ok && activationJson?.error?.code === "WORKSPACE_LEASE_INVALID") {
          activationResponse = await fetch("/api/workspaces/activate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspaceId: id,
              novelId: conv.novelId,
              recoverLease: true,
            }),
            signal: controller.signal,
          });
          activationJson = await activationResponse.json();
          if (activationResponse.ok && activationJson.success) {
            toast.warning("工作区凭证已安全恢复；原作品绑定保持不变");
          }
        }
        if (!activationResponse.ok || !activationJson.success) {
          const message = activationJson?.error?.message ?? "工作区所有权校验失败，已保持空白状态";
          throw new Error(message);
        }
        if (switchVersionRef.current !== version || controller.signal.aborted) return;
        const lease = activationJson.data.lease as string;
        let boundNovelId = typeof activationJson.data.novelId === "string" ? activationJson.data.novelId : null;
        updateConversationWorkspaceLease(id, lease);
        if (boundNovelId && conv.novelId !== boundNovelId) {
          bindConversationNovel(id, boundNovelId);
          window.dispatchEvent(new CustomEvent("conversations-changed"));
        }
        setActiveWorkspaceCredentials({ workspaceId: id, lease, novelId: boundNovelId });
        window.dispatchEvent(new CustomEvent("workspace-activated"));

        const draft = conv.draft ?? emptyDraft();
        // 一会话一作品：会话首次激活就建立隔离的磁盘项目和记忆库。
        // 不能等用户确定书名后才创建，否则此之前功能区看到的是浏览器草稿，
        // 服务端 Agent 没有 novelId，无法真正回读文件树。
        if (!boundNovelId) {
          const createResponse = await workspaceFetch("/api/novels", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: draft.novelName || INITIAL_NOVEL_DATA.novelName,
              total_chapters: draft.totalChapters || INITIAL_NOVEL_DATA.totalChapters,
            }),
            signal: controller.signal,
          });
          const createJson = await createResponse.json();
          const created = createJson?.data ?? createJson;
          if (!createResponse.ok || !created?.id) {
            throw new Error(createJson?.error?.message ?? "初始化会话知识库失败");
          }
          boundNovelId = created.id as string;
          bindConversationNovel(id, boundNovelId);
          setActiveWorkspaceCredentials({ workspaceId: id, lease, novelId: boundNovelId });
          window.dispatchEvent(new CustomEvent("workspace-activated"));
          window.dispatchEvent(new CustomEvent("conversations-changed"));
        }

        const draftData: NovelData = {
          novelName: draft.novelName,
          totalChapters: draft.totalChapters,
          brainstorm: draft.brainstorm,
          outline: draft.outline,
          detailedOutline: draft.detailedOutline,
          characters: draft.characters,
          worldview: draft.worldview,
          goldfinger: draft.goldfinger,
          synopsis: draft.synopsis,
          opening: draft.opening,
          foreshadowing: draft.foreshadowing,
          chapters: draft.chapters ?? {},
          novelId: boundNovelId ?? undefined,
        };
        novelIdRef.current = boundNovelId;
        dataRef.current = draftData;
        setNovelId(boundNovelId);
        setData(draftData);

        if (!boundNovelId) return;
        const response = await workspaceFetch(`/api/novels/${encodeURIComponent(boundNovelId)}`, {
          signal: controller.signal,
        });
        const json = await response.json();
        if (!response.ok) throw new Error(json?.error?.message ?? "项目读取失败");
        if (switchVersionRef.current !== version || controller.signal.aborted) return;
        const full = json?.data ?? json;
        if (!full || typeof full !== "object" || !full.id) return;

        const chapters: Record<string, string> = {};
        if (Array.isArray(full.chapters)) {
          for (const chapter of full.chapters as Array<{ number: number; title: string; content: string }>) {
            chapters[`第${chapter.number}章`] = JSON.stringify({
              title: chapter.title,
              content: chapter.content,
            });
          }
        }
        const meta = (full.metadata ?? {}) as Record<string, string>;
        const next: NovelData = {
          novelName: full.title || draft.novelName,
          totalChapters: full.total_chapters || draft.totalChapters,
          brainstorm: meta.brainstorm ?? draft.brainstorm,
          outline: meta.outline ?? draft.outline,
          detailedOutline: meta.detailedOutline ?? draft.detailedOutline,
          characters: meta.characters ?? draft.characters,
          worldview: meta.worldview ?? draft.worldview,
          goldfinger: meta.goldfinger ?? draft.goldfinger,
          synopsis: meta.synopsis ?? draft.synopsis,
          opening: meta.opening ?? draft.opening,
          foreshadowing: meta.foreshadowing ?? draft.foreshadowing,
          chapters: Object.keys(chapters).length ? chapters : (draft.chapters ?? {}),
          novelId: full.id,
        };
        dataRef.current = next;
        setData(next);
        updateConversationDraft(id, next);
      } catch (error) {
        if (controller.signal.aborted || switchVersionRef.current !== version) return;
        setActiveWorkspaceCredentials(null);
        setNovelId(null);
        novelIdRef.current = null;
        setData({ ...INITIAL_NOVEL_DATA });
        dataRef.current = { ...INITIAL_NOVEL_DATA };
        toast.error(error instanceof Error ? error.message : "工作区切换失败，已进入安全空白状态");
      } finally {
        if (switchVersionRef.current === version) switchingRef.current = false;
      }
    },
    [activateFileTreeMeta, activateSessionOwner, activateWorkspaceStatus, setWorkspaceTool],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    // 清理旧的全局共享快取（它是串线元凶）
    try {
      localStorage.removeItem("withyou_novel");
    } catch {
      /* ignore */
    }

    const active = initialConversationId ?? getActiveConversationId();
    const all = getAllConversations();
    let startId = active && all.some((c) => c.id === active) ? active : (all[0]?.id ?? null);
    if (!startId) {
      startId = createConversation("(新对话)").id;
    }
    setWorkspaceTool(initialToolId);
    void applyConversation(startId, { preserveWorkspaceTool: Boolean(initialToolId) }).finally(() => setHydrated(true));
  }, [applyConversation, initialConversationId, initialToolId, setWorkspaceTool]);

  // ─── 防抖持久化：只写入「当前对话」草稿 + 绑定小说 ───
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hydrated || switchingRef.current) return;
    if (!conversationId) return;

    updateConversationDraft(conversationId, {
      novelName: data.novelName,
      totalChapters: data.totalChapters,
      brainstorm: data.brainstorm,
      outline: data.outline,
      detailedOutline: data.detailedOutline,
      characters: data.characters,
      worldview: data.worldview,
      goldfinger: data.goldfinger,
      synopsis: data.synopsis,
      opening: data.opening,
      foreshadowing: data.foreshadowing,
      chapters: data.chapters,
    });

    const tid = setTimeout(async () => {
      const targetConversationId = conversationId;
      setSaveStatus(targetConversationId, "saving");
      // 书名确定且尚未绑定 → 为本对话新建独立小说目录
      let boundId = novelId;
      const named = data.novelName && data.novelName !== "我的作品" && data.novelName !== "未命名作品";

      if (!boundId && named) {
        try {
          const r = await workspaceFetch("/api/novels", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: data.novelName,
              total_chapters: data.totalChapters || 300,
            }),
          });
          const json = await r.json();
          const created = json?.data ?? json;
          if (created?.id) {
            if (conversationIdRef.current !== targetConversationId) return;
            boundId = created.id as string;
            setNovelId(boundId);
            bindConversationNovel(conversationId, boundId);
            setData((prev) => ({ ...prev, novelId: boundId! }));
            window.dispatchEvent(new CustomEvent("workspace-activated"));
            window.dispatchEvent(new CustomEvent("conversations-changed"));
          }
        } catch {
          setSaveStatus(targetConversationId, "error");
          return;
        }
      }

      if (!boundId) {
        setSaveStatus(targetConversationId, "saved");
        return;
      }

      const contentArr = Object.entries(data.chapters || {}).map(([key, val]) => {
        const num = parseInt(key.replace(/[^0-9]/g, ""), 10) || 1;
        try {
          const obj = JSON.parse(val);
          return { number: num, title: obj.title || key, content: obj.content || val };
        } catch {
          return { number: num, title: key, content: val };
        }
      });
      try {
        const response = await workspaceFetch(`/api/novels/${encodeURIComponent(boundId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: data.novelName,
            total_chapters: data.totalChapters,
            metadata: {
              brainstorm: data.brainstorm || "",
              outline: data.outline || "",
              detailedOutline: data.detailedOutline || "",
              characters: data.characters || "",
              worldview: data.worldview || "",
              goldfinger: data.goldfinger || "",
              synopsis: data.synopsis || "",
              opening: data.opening || "",
              foreshadowing: data.foreshadowing || "",
            },
            content_json: contentArr,
          }),
        });
        if (!response.ok) throw new Error("save failed");
        setSaveStatus(targetConversationId, "saved");
      } catch {
        setSaveStatus(targetConversationId, "error");
        toast.error("自动保存失败，内容仍保留在当前会话草稿中");
      }
    }, 1200);

    return () => clearTimeout(tid);
  }, [data, novelId, conversationId, hydrated, setSaveStatus]);

  // 监听 sidebar：新对话 / 切换对话
  useEffect(() => {
    const onNew = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      void applyConversation(id);
    };
    const onSelect = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      void applyConversation(id);
    };
    window.addEventListener("new-conversation", onNew);
    window.addEventListener("select-conversation", onSelect);
    return () => {
      window.removeEventListener("new-conversation", onNew);
      window.removeEventListener("select-conversation", onSelect);
    };
  }, [applyConversation]);

  const handleMessagesChange = useCallback(
    (msgs: ConversationMessage[]) => {
      if (!conversationId) return;
      updateMessages(conversationId, msgs);
      window.dispatchEvent(new CustomEvent("conversations-changed"));
    },
    [conversationId],
  );

  const [realChapterContent, setRealChapterContent] = useState<string | null>(null);

  // 当选择章节时,尝试从文件系统加载真实内容
  useEffect(() => {
    if (!selectedItem?.startsWith("第") || !selectedItem.endsWith("章")) {
      setRealChapterContent(null);
      return;
    }
    if (!novelId) {
      setRealChapterContent(null);
      return;
    }
    const m = selectedItem.match(/第(\d+)章/);
    if (!m) return;
    const num = parseInt(m[1], 10);

    workspaceFetch(`/api/local-novels/${encodeURIComponent(novelId)}/chapters/${num}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data?.content) {
          setRealChapterContent(json.data.content);
        } else {
          setRealChapterContent(null);
        }
      })
      .catch(() => setRealChapterContent(null));
  }, [selectedItem, novelId]);

  const getItemContent = (item: string): string => {
    // 章节内容:优先从文件系统读取
    if (item.startsWith("第") && item.endsWith("章")) {
      if (realChapterContent != null) return realChapterContent;
      const stored = data.chapters[item];
      return stored ? decodeChapterRecord(item, stored).content : "";
    }
    const field = FILE_FIELDS[item];
    if (field) return data[field] as string;
    return "";
  };

  const handleSave = useCallback(async () => {
    if (!selectedItem) return;
    if (selectedItem.startsWith("第") && selectedItem.endsWith("章")) {
      // 保存到 localStorage(兼容)
      const current = data.chapters[selectedItem];
      const decoded = current ? decodeChapterRecord(selectedItem, current) : null;
      handleUpdate({
        chapters: {
          ...data.chapters,
          [selectedItem]: JSON.stringify({
            title: decoded?.title || selectedItem,
            content: editBuffer,
          }),
        },
      });
      recordFileWrite("chapters", [], fileTreeMeta);

      // 同步写入文件系统(如果小说已命名)
      if (novelId) {
        const m = selectedItem.match(/第(\d+)章/);
        if (m) {
          const num = parseInt(m[1], 10);
          workspaceFetch(`/api/local-novels/${encodeURIComponent(novelId)}/chapters/${num}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: editBuffer }),
          }).catch(() => {
            /* 静默失败 */
          });
        }
      }
    } else {
      const field = FILE_FIELDS[selectedItem];
      if (field && field !== "novelName") {
        handleUpdate({ [field]: editBuffer } as Partial<NovelData>);
        recordFileWrite(field, [], fileTreeMeta);
      }
    }
    setEditing(false);
  }, [selectedItem, editBuffer, data.chapters, fileTreeMeta, handleUpdate, novelId, recordFileWrite]);

  const handleStartEdit = useCallback(() => {
    if (selectedItem) {
      setEditBuffer(getItemContent(selectedItem));
      setEditing(true);
    }
  }, [selectedItem]);

  const showItemView = selectedItem !== null;
  const isChapter = selectedItem?.startsWith("第") && selectedItem.endsWith("章");

  // 模型设置（全屏面板，不走 prompt-templates）
  if (workspaceTool === "settings") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ flex: "6 1 0%" }}>
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>
        <div className="h-full overflow-y-auto border-l" style={{ flex: "4 1 0%" }}>
          <SettingsPanel onClose={handleCloseTool} />
        </div>
      </div>
    );
  }

  // 封面生成器（独立组件，不走 prompt-templates）
  if (workspaceTool === "cover") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ flex: "6 1 0%" }}>
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>
        <div className="h-full overflow-y-auto border-l" style={{ flex: "4 1 0%" }}>
          <CoverPanel onClose={handleCloseTool} />
        </div>
      </div>
    );
  }

  // 实体卡片管理器（P0）
  if (workspaceTool === "entities") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ flex: "6 1 0%" }}>
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>
        <div className="h-full overflow-y-auto" style={{ flex: "4 1 0%" }}>
          <EntityCardManager novelId={novelId} onClose={handleCloseTool} />
        </div>
      </div>
    );
  }

  // 伏笔账本（P0）
  if (workspaceTool === "foreshadow") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ flex: "6 1 0%" }}>
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>
        <div className="h-full overflow-y-auto" style={{ flex: "4 1 0%" }}>
          <ForeshadowLedger novelId={novelId} onClose={handleCloseTool} />
        </div>
      </div>
    );
  }

  // 核心 Agent 工作台：显式运行规划、审稿与记忆 Agent。
  if (workspaceTool === "agent-workbench" && agentWorkbenchEnabled) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ flex: "6 1 0%" }}>
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>
        <div className="h-full overflow-hidden border-l" style={{ flex: "4 1 0%" }}>
          <AgentWorkbenchPanel novelId={novelId || ""} onClose={handleCloseTool} />
        </div>
      </div>
    );
  }

  // AI拆书（P1）— 独立面板，不需要项目上下文
  if (workspaceTool === "book-analysis") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ flex: "6 1 0%" }}>
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>
        <div className="h-full overflow-y-auto" style={{ flex: "4 1 0%" }}>
          <BookAnalysisPanel onClose={handleCloseTool} />
        </div>
      </div>
    );
  }

  // 写作统计（P1）
  if (workspaceTool === "stats") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ flex: "6 1 0%" }}>
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>
        <div className="h-full overflow-y-auto" style={{ flex: "4 1 0%" }}>
          <StatsPanel
            onClose={handleCloseTool}
            totalChapters={data.totalChapters}
            outline={data.outline}
            characters={data.characters}
            worldview={data.worldview}
            chapters={data.chapters}
          />
        </div>
      </div>
    );
  }

  // 兼容旧的 story-map 会话状态，并统一进入新版全屏故事世界图谱。
  if (workspaceTool === "story-map") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <StoryGraph3D novelId={novelId || ""} onClose={handleCloseTool} />
      </div>
    );
  }

  // 提示词市场
  if (workspaceTool === "prompt-market") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        {/* 对话区域 - 60% */}
        <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ flex: "6 1 0%" }}>
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>
        {/* 提示词市场面板 - 40% */}
        <div className="h-full overflow-y-auto border-l" style={{ flex: "4 1 0%" }}>
          <PromptMarketPanel novelId={novelId || ""} />
        </div>
      </div>
    );
  }

  // 故事图谱（全屏3D可视化）
  if (workspaceTool === "story-graph") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <StoryGraph3D novelId={novelId || ""} onClose={handleCloseTool} />
      </div>
    );
  }

  // 工具模式：右侧替换为工具面板，对话区占 60%
  const activeTemplate = workspaceTool ? PROMPT_TEMPLATES[workspaceTool] : null;

  if (activeTemplate) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        {/* 对话区域 - 60% */}
        <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ flex: "6 1 0%" }}>
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>

        {/* 工具面板 - 40% */}
        <div className="h-full overflow-y-auto border-l" style={{ flex: "4 1 0%" }}>
          <ToolPanel
            template={activeTemplate}
            novelId={novelId || undefined}
            novelData={data}
            onClose={handleCloseTool}
            onSaveToField={handleSaveToField}
            onSelectTool={(toolId) => setWorkspaceTool(toolId)}
            onApplyToChat={(toolId, userInput, toolOutput) =>
              handleToolApplyToChat(toolId as ToolId, userInput, toolOutput)
            }
          />
        </div>
      </div>
    );
  }

  // 默认：对话 + 文件树 / 内容视图
  return (
    <>
      <NovelImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        existingChapterCount={Object.keys(data.chapters).length}
        onImport={handleNovelImport}
      />
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <ChatPanel
            novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
            onUpdate={handleUpdate}
            conversationId={conversationId}
            onMessagesChange={handleMessagesChange}
            onSaveChapter={handleSaveChapter}
            pendingChapterWrite={pendingChapterWrite}
            onChapterWritten={() => setPendingChapterWrite(null)}
            toolContext={workspaceTool}
            onToolConfirmed={handleActiveToolConfirmed}
          />
        </div>

        <div
          className={`h-full overflow-y-auto border-l transition-all duration-300 ${showItemView ? "w-[400px]" : "w-56"}`}
        >
          {showItemView && selectedItem ? (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
                <span className="font-semibold text-sm">{selectedItem}</span>
                {!editing && getItemContent(selectedItem) && (
                  <span className="mr-2 text-muted-foreground text-xs">
                    字数：{countWords(getItemContent(selectedItem))}
                  </span>
                )}
                <div className="flex items-center gap-2">
                  {editing ? (
                    <>
                      <button
                        onClick={handleSave}
                        className="cursor-pointer font-medium text-[#2D9F5A] text-xs hover:text-[#2D9F5A]/80"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setEditing(false)}
                        className="cursor-pointer text-muted-foreground text-xs hover:text-foreground"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={handleStartEdit}
                        className="cursor-pointer text-muted-foreground text-xs hover:text-foreground"
                      >
                        编辑
                      </button>
                      {/* 章节"AI 写入"按钮 */}
                      {isChapter && (
                        <button
                          onClick={() => {
                            const num = parseInt(selectedItem!.replace(/[^0-9]/g, ""), 10);
                            if (num) triggerChapterWrite(num);
                          }}
                          className="cursor-pointer font-medium text-[#2D9F5A] text-xs hover:text-[#2D9F5A]/80"
                        >
                          AI 写入
                        </button>
                      )}
                    </>
                  )}
                  <button
                    onClick={handleClose}
                    className="cursor-pointer text-muted-foreground text-xs hover:text-foreground"
                  >
                    关闭
                  </button>
                </div>
              </div>
              <div className="flex flex-1 flex-col overflow-y-auto whitespace-pre-wrap p-4 text-muted-foreground text-sm leading-relaxed">
                {editing ? (
                  <div className="flex flex-1 flex-col">
                    <textarea
                      value={editBuffer}
                      onChange={(e) => setEditBuffer(e.target.value)}
                      className="w-full flex-1 resize-none bg-transparent text-sm leading-relaxed outline-none"
                      placeholder="输入内容..."
                      autoFocus
                    />
                    <div className="mt-2 shrink-0 border-t pt-2 text-right text-muted-foreground text-xs">
                      字数：{countWords(editBuffer)}
                    </div>
                  </div>
                ) : (
                  <div>
                    {getItemContent(selectedItem) || (
                      <span className="text-muted-foreground/50 italic">
                        {isChapter
                          ? "暂无内容，通过对话生成章节后将自动填充。"
                          : "暂无内容，点击「编辑」添加或等待 AI 对话确认后自动填充。"}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <FileTree
              novelName={data.novelName}
              novelId={novelId || undefined}
              totalChapters={data.totalChapters}
              onItemClick={handleItemClick}
              selectedItem={selectedItem}
              novelData={{ ...data, novelId: novelId ?? undefined, taskType: toolToTaskType() }}
              onImportClick={() => setImportOpen(true)}
            />
          )}
        </div>
      </div>
    </>
  );
}
