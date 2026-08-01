"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  FilePenLine,
  GripVertical,
  Loader2,
  Send,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { getActiveConversationId, getConversation } from "@/lib/ai/conversations";
import type { PiFileProposal } from "@/lib/pi/proposal-store";
import type { PiSourceProposal } from "@/lib/pi/source-proposal-store";
import { readableApiError, workspaceFetch } from "@/lib/workspaces/client";

type DisplayProposal = PiFileProposal | PiSourceProposal;

interface SourceAccessStatus {
  available: boolean;
  unlocked: boolean;
  workspace: string | null;
  expiresAt: string | null;
  testMode?: boolean;
  reason?: string;
}

interface PiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface PiToolActivity {
  id: string;
  name: string;
  status: "running" | "done" | "error";
}

interface DockPosition {
  x: number;
  y: number;
}

interface DockDragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

const PI_DOCK_POSITION_KEY = "withyou_pi_dock_position";
const PI_WORKSPACE_STATE_KEY = "withyou_pi_workspace_states_v2";
const DOCK_VIEWPORT_MARGIN = 8;

function currentWorkspace(): { workspaceId: string | null; novelId: string | null } {
  const conversationId = getActiveConversationId();
  if (!conversationId) return { workspaceId: null, novelId: null };
  return { workspaceId: conversationId, novelId: getConversation(conversationId)?.novelId ?? null };
}

interface PiWorkspaceState {
  input: string;
  messages: PiMessage[];
  activities: PiToolActivity[];
}

function loadPiWorkspaceState(scope: string): PiWorkspaceState {
  if (typeof window === "undefined") return { input: "", messages: [], activities: [] };
  try {
    const all = JSON.parse(localStorage.getItem(PI_WORKSPACE_STATE_KEY) || "{}") as Record<string, PiWorkspaceState>;
    return all[scope] ?? { input: "", messages: [], activities: [] };
  } catch {
    return { input: "", messages: [], activities: [] };
  }
}

function savePiWorkspaceState(scope: string, snapshot: PiWorkspaceState): void {
  if (typeof window === "undefined") return;
  try {
    const all = JSON.parse(localStorage.getItem(PI_WORKSPACE_STATE_KEY) || "{}") as Record<string, PiWorkspaceState>;
    all[scope] = snapshot;
    localStorage.setItem(PI_WORKSPACE_STATE_KEY, JSON.stringify(all));
  } catch {
    // Pi 展示记录保存失败时保持内存隔离，不回退读取其他工作区。
  }
}

function formatPiMessage(content: string): string {
  return content
    .replace(/^```[^\r\n]*\r?\n?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`\r\n]+)`/g, "$1")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[✅❌]/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

const PI_TOOL_LABELS: Record<string, string> = {
  coding_environment_status: "检查开发环境",
  coding_environment_prepare: "准备环境与依赖",
  github_skill_search: "搜索 GitHub Skill",
  github_skill_read: "读取 GitHub Skill",
  github_skill_install: "安装 GitHub Skill",
  github_search_repositories: "搜索 GitHub 仓库",
  github_search_code: "搜索 GitHub 代码",
  git_repository_status: "检查 Git 状态",
  git_commit: "创建 Git 提交",
  git_push: "推送 Git 提交",
};

function toolLabel(name: string): string {
  return PI_TOOL_LABELS[name] ?? name;
}

export function PiDock() {
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [activities, setActivities] = useState<PiToolActivity[]>([]);
  const [proposals, setProposals] = useState<DisplayProposal[]>([]);
  const [expandedProposal, setExpandedProposal] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<SourceAccessStatus | null>(null);
  const [dockPosition, setDockPosition] = useState<DockPosition | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  const dockButtonRef = useRef<HTMLButtonElement | null>(null);
  const dockDragRef = useRef<DockDragState | null>(null);
  const suppressDockClickRef = useRef(false);
  const scopeRef = useRef("project:unbound");
  const snapshotRef = useRef<PiWorkspaceState>({ input: "", messages: [], activities: [] });
  const requestGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);

  const clampDockPosition = useCallback((position: DockPosition): DockPosition => {
    const rect = dockButtonRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 180;
    const height = rect?.height ?? 36;
    return {
      x: Math.min(
        Math.max(DOCK_VIEWPORT_MARGIN, position.x),
        Math.max(DOCK_VIEWPORT_MARGIN, window.innerWidth - width - DOCK_VIEWPORT_MARGIN),
      ),
      y: Math.min(
        Math.max(DOCK_VIEWPORT_MARGIN, position.y),
        Math.max(DOCK_VIEWPORT_MARGIN, window.innerHeight - height - DOCK_VIEWPORT_MARGIN),
      ),
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const rect = dockButtonRef.current?.getBoundingClientRect();
      const fallback = {
        x: window.innerWidth - (rect?.width ?? 180) - 20,
        y: 16,
      };
      try {
        const saved = JSON.parse(window.localStorage.getItem(PI_DOCK_POSITION_KEY) ?? "null") as DockPosition | null;
        setDockPosition(
          saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
            ? clampDockPosition(saved)
            : clampDockPosition(fallback),
        );
      } catch {
        setDockPosition(clampDockPosition(fallback));
      }
    });

    const handleResize = () => {
      setDockPosition((current) => (current ? clampDockPosition(current) : current));
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
    };
  }, [clampDockPosition]);

  const handleDockPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    dockDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false,
    };
  }, []);

  const handleDockPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dockDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
      drag.moved = true;
      event.preventDefault();
      setDockPosition(clampDockPosition({ x: drag.originX + deltaX, y: drag.originY + deltaY }));
    },
    [clampDockPosition],
  );

  const finishDockDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dockDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    suppressDockClickRef.current = event.type !== "pointercancel" && drag.moved;
    dockDragRef.current = null;
    if (drag.moved) {
      setDockPosition((current) => {
        if (current) window.localStorage.setItem(PI_DOCK_POSITION_KEY, JSON.stringify(current));
        return current;
      });
    }
  }, []);

  useEffect(() => {
    snapshotRef.current = { input, messages, activities };
    savePiWorkspaceState(scopeRef.current, snapshotRef.current);
  }, [activities, input, messages]);

  const switchPiScope = useCallback((nextWorkspaceId: string | null) => {
    savePiWorkspaceState(scopeRef.current, snapshotRef.current);
    const nextScope = `coding:${nextWorkspaceId ?? "unbound"}`;
    scopeRef.current = nextScope;
    const snapshot = loadPiWorkspaceState(nextScope);
    snapshotRef.current = snapshot;
    setInput(snapshot.input);
    setMessages(snapshot.messages);
    setActivities(snapshot.activities);
    setProposals([]);
    setExpandedProposal(null);
  }, []);

  const refreshNovel = useCallback(() => {
    const next = currentWorkspace();
    if (next.workspaceId !== workspaceId) {
      requestGenerationRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      assistantIdRef.current = null;
      setRunning(false);
      switchPiScope(next.workspaceId);
    }
    setWorkspaceId(next.workspaceId);
  }, [switchPiScope, workspaceId]);

  useEffect(() => {
    refreshNovel();
    const events = ["conversations-changed", "select-conversation", "new-conversation", "workspace-activated"];
    for (const event of events) window.addEventListener(event, refreshNovel);
    return () => {
      for (const event of events) window.removeEventListener(event, refreshNovel);
    };
  }, [refreshNovel]);

  const sourceFetch = useCallback(
    (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      return workspaceFetch(input, { ...init, headers });
    },
    [],
  );

  const loadSourceStatus = useCallback(async () => {
    const response = await sourceFetch("/api/pi/source/permissions");
    const json = await response.json();
    if (response.ok && json.success) setSourceStatus(json.data);
  }, [sourceFetch]);

  const loadProposals = useCallback(async () => {
    const response = await sourceFetch("/api/pi/source/proposals");
    const json = await response.json();
    if (response.ok && json.success) setProposals(json.data);
  }, [sourceFetch]);

  useEffect(() => {
    if (open) {
      void loadSourceStatus();
      void loadProposals();
    }
  }, [loadProposals, loadSourceStatus, open]);

  const pendingCount = useMemo(() => proposals.filter((proposal) => proposal.status === "pending").length, [proposals]);
  const conversationUpdateKey = useMemo(
    () => [messages.at(-1)?.content, activities.at(-1)?.status, proposals.at(-1)?.status, running].join("\u0000"),
    [activities, messages, proposals, running],
  );

  useEffect(() => {
    if (!open) return;
    void conversationUpdateKey;
    const frame = window.requestAnimationFrame(() => {
      const conversation = conversationRef.current;
      if (conversation) conversation.scrollTop = conversation.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationUpdateKey, open]);

  const appendAssistant = useCallback((text: string, generation?: number) => {
    if (generation !== undefined && requestGenerationRef.current !== generation) return;
    const id = assistantIdRef.current;
    if (!id) return;
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, content: message.content + text } : message)),
    );
  }, []);

  const sendPrompt = useCallback(async () => {
    const message = input.trim();
    if (!message || running) return;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    assistantIdRef.current = assistantId;
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content: message },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setInput("");
    setRunning(true);
    setActivities([]);
    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;

    try {
      const response = await sourceFetch("/api/pi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(await readableApiError(response, "无法启动 Pi"));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const event = JSON.parse(dataLine.slice(6)) as {
            type: string;
            text?: string;
            toolCallId?: string;
            toolName?: string;
            isError?: boolean;
          };
          if (requestGenerationRef.current !== generation) return;
          if (event.type === "text" && event.text) appendAssistant(event.text, generation);
          if (event.type === "tool_start" && event.toolCallId && event.toolName) {
            const toolCallId = event.toolCallId;
            const toolName = event.toolName;
            setActivities((current) => [...current, { id: toolCallId, name: toolName, status: "running" }]);
          }
          if (event.type === "tool_end" && event.toolCallId) {
            setActivities((current) =>
              current.map((activity) =>
                activity.id === event.toolCallId ? { ...activity, status: event.isError ? "error" : "done" } : activity,
              ),
            );
          }
          if (event.type === "error") throw new Error(event.text ?? "Pi 运行失败");
        }
      }
      await loadProposals();
    } catch (error) {
      if (!controller.signal.aborted) {
        appendAssistant(`\n\n运行失败：${error instanceof Error ? error.message : "未知错误"}`, generation);
      }
    } finally {
      if (requestGenerationRef.current === generation) {
        assistantIdRef.current = null;
        requestAbortRef.current = null;
        setRunning(false);
      }
    }
  }, [appendAssistant, input, loadProposals, running, sourceFetch]);

  const stop = useCallback(async () => {
    requestGenerationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    assistantIdRef.current = null;
    await sourceFetch("/api/pi", { method: "DELETE" });
    setRunning(false);
  }, [sourceFetch]);

  const decide = useCallback(
    async (proposalId: string, decision: "apply" | "reject" | "rollback") => {
      const response = await sourceFetch("/api/pi/source/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId, decision }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        toast.error(typeof json.error === "string" ? json.error : json.error?.message || "审批失败");
        await loadProposals();
        return;
      }
      toast.success(
        decision === "apply"
          ? "代码补丁已应用并完成自动类型检查"
          : decision === "rollback"
            ? "源码补丁已回滚"
            : "已拒绝候选改动",
      );
      await loadProposals();
    },
    [loadProposals, sourceFetch],
  );

  return (
    <>
      <button
        ref={dockButtonRef}
        type="button"
        aria-label="Pi coding Agent，可拖动"
        title="拖动调整位置，点击打开 Pi coding Agent"
        onPointerDown={handleDockPointerDown}
        onPointerMove={handleDockPointerMove}
        onPointerUp={finishDockDrag}
        onPointerCancel={finishDockDrag}
        onClick={() => {
          if (suppressDockClickRef.current) {
            suppressDockClickRef.current = false;
            return;
          }
          setOpen(true);
        }}
        style={dockPosition ? { left: dockPosition.x, top: dockPosition.y } : undefined}
        className={`fixed z-40 flex h-9 touch-none select-none items-center gap-2 rounded-full border bg-background/95 px-3 font-medium text-xs shadow-sm backdrop-blur transition hover:bg-accent active:cursor-grabbing ${
          dockPosition ? "cursor-grab" : "top-4 right-5 cursor-grab"
        }`}
      >
        <GripVertical className="size-3 text-muted-foreground" aria-hidden="true" />
        <span className="relative flex size-5 items-center justify-center rounded-full bg-foreground text-background">
          π{pendingCount > 0 && <span className="absolute -top-1 -right-1 size-2 rounded-full bg-amber-500" />}
        </span>
        Pi · Coding Agent
        <span className={`size-1.5 rounded-full ${running ? "bg-amber-500" : "bg-emerald-500"}`} />
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="关闭 Pi 面板"
            className="absolute inset-0 bg-black/20"
            onClick={() => setOpen(false)}
          />
          <aside className="relative ml-auto flex h-full w-full max-w-[520px] flex-col border-l bg-background shadow-2xl">
            <header className="flex items-center justify-between border-b px-5 py-4">
              <div>
                <div className="flex items-center gap-2 font-semibold">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background">
                    π
                  </span>
                  Pi · Coding Agent
                </div>
                <p className="mt-1 text-muted-foreground text-xs">
                  {sourceStatus?.workspace ? `代码工作区：${sourceStatus.workspace}` : "代码工作区不可用"}
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md p-2 hover:bg-accent">
                <X className="size-4" />
              </button>
            </header>

            <div ref={conversationRef} className="flex-1 space-y-5 overflow-y-auto p-5">
              {messages.length === 0 && (
                <div className="rounded-xl border bg-muted/30 p-4">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <Sparkles className="size-4" />
                    Pi 可以直接处理当前工作区的任务
                  </div>
                  <p className="mt-2 text-muted-foreground text-xs leading-5">
                    Pi 会先读取并理解当前工作区，再执行所需步骤。缺少环境或依赖时会尝试准备；它也可处理任意领域的 GitHub 仓库、代码与 Skill。代码修改会自动保留检查点，可随时回滚。
                  </p>
                </div>
              )}

              {messages.map((message) => (
                <div key={message.id} className={`flex gap-3 ${message.role === "user" ? "justify-end" : ""}`}>
                  {message.role === "assistant" && (
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border">
                      <Bot className="size-4" />
                    </span>
                  )}
                  <div
                    className={`max-w-[86%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-6 ${
                      message.role === "user" ? "bg-foreground text-background" : "bg-muted"
                    }`}
                  >
                    {formatPiMessage(message.content) || (running ? "正在思考…" : "")}
                  </div>
                </div>
              ))}

              {activities.length > 0 && (
                <div className="space-y-1.5 rounded-lg border p-3">
                  <p className="font-medium text-muted-foreground text-xs">工具活动</p>
                  {activities.map((activity) => (
                    <div key={activity.id} className="flex items-center gap-2 text-xs">
                      {activity.status === "running" ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Check
                          className={`size-3 ${activity.status === "error" ? "text-red-500" : "text-emerald-500"}`}
                        />
                      )}
                      {toolLabel(activity.name)}
                    </div>
                  ))}
                </div>
              )}

              {proposals.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <FilePenLine className="size-4" />
                    代码更改记录
                    {pendingCount > 0 && (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-700">
                        {pendingCount} 待处理
                      </span>
                    )}
                  </div>
                  {proposals.slice(0, 10).map((proposal) => {
                    const expanded = expandedProposal === proposal.id;
                    return (
                      <div key={proposal.id} className="rounded-lg border">
                        <button
                          type="button"
                          onClick={() => setExpandedProposal(expanded ? null : proposal.id)}
                          className="flex w-full items-start justify-between gap-3 p-3 text-left"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium text-xs">{proposal.filePath}</p>
                            <p className="mt-1 text-muted-foreground text-xs">{proposal.summary}</p>
                          </div>
                          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                        </button>
                        {expanded && (
                          <div className="space-y-3 border-t p-3">
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <p className="mb-1 text-[11px] text-muted-foreground">当前内容</p>
                                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">
                                  {proposal.previousContent || "（新文件）"}
                                </pre>
                              </div>
                              <div>
                                <p className="mb-1 text-[11px] text-muted-foreground">Pi 提议</p>
                                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">
                                  {proposal.proposedContent}
                                </pre>
                              </div>
                            </div>
                            {proposal.status === "pending" ? (
                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => void decide(proposal.id, "reject")}
                                  className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
                                >
                                  拒绝
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void decide(proposal.id, "apply")}
                                  className="rounded-md bg-red-600 px-3 py-1.5 text-white text-xs"
                                >
                                  批准、写入并检查
                                </button>
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {"validation" in proposal && proposal.validation && (
                                  <div
                                    className={`rounded-md p-2 text-[11px] ${
                                      proposal.validation.ok
                                        ? "bg-emerald-500/10 text-emerald-700"
                                        : "bg-red-500/10 text-red-700"
                                    }`}
                                  >
                                    <p className="font-medium">
                                      {proposal.validation.ok ? "自动检查通过" : "自动检查失败"}
                                    </p>
                                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">
                                      {proposal.validation.output}
                                    </pre>
                                  </div>
                                )}
                                <div className="flex items-center justify-end gap-2">
                                  <span className="text-muted-foreground text-xs">状态：{proposal.status}</span>
                                  {proposal.status === "applied" && (
                                    <button
                                      type="button"
                                      onClick={() => void decide(proposal.id, "rollback")}
                                      className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                                    >
                                      <Undo2 className="size-3" />
                                      回滚
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              )}
            </div>

            <footer className="border-t p-4">
              <div className="flex items-end gap-2 rounded-xl border bg-background p-2">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendPrompt();
                    }
                  }}
                  disabled={running}
                  rows={2}
                  placeholder={
                    "交给 Pi 一个任务…"
                  }
                  className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none"
                />
                {running ? (
                  <button type="button" onClick={() => void stop()} className="rounded-lg border p-2 hover:bg-accent">
                    <CircleStop className="size-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void sendPrompt()}
                    disabled={!input.trim()}
                    className="rounded-lg bg-foreground p-2 text-white disabled:opacity-40"
                  >
                    <Send className="size-4" />
                  </button>
                )}
              </div>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                通用任务 · 自动准备环境 · Git 与 GitHub · 代码修改可回滚
              </p>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}
