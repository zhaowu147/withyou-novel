"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Code2,
  Eye,
  FilePenLine,
  FolderPen,
  GripVertical,
  Loader2,
  LockKeyhole,
  Send,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { getActiveConversationId, getConversation } from "@/lib/ai/conversations";
import type { PiFileProposal } from "@/lib/pi/proposal-store";
import type { PiSourceProposal } from "@/lib/pi/source-proposal-store";
import { readableApiError, workspaceFetch } from "@/lib/workspaces/client";

type AccessLevel = "observer" | "project" | "source";
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

export function PiDock() {
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [novelId, setNovelId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("project");
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [activities, setActivities] = useState<PiToolActivity[]>([]);
  const [proposals, setProposals] = useState<DisplayProposal[]>([]);
  const [expandedProposal, setExpandedProposal] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<SourceAccessStatus | null>(null);
  const [sourceGrantToken, setSourceGrantToken] = useState("");
  const [showUnlock, setShowUnlock] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [dockPosition, setDockPosition] = useState<DockPosition | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  const dockButtonRef = useRef<HTMLButtonElement | null>(null);
  const dockDragRef = useRef<DockDragState | null>(null);
  const suppressDockClickRef = useRef(false);
  const scopeRef = useRef("project:unbound");
  const snapshotRef = useRef<PiWorkspaceState>({ input: "", messages: [], activities: [] });
  const requestGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);

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

  const switchPiScope = useCallback((nextWorkspaceId: string | null, nextLevel: AccessLevel) => {
    savePiWorkspaceState(scopeRef.current, snapshotRef.current);
    const nextScope = nextLevel === "source" ? "source" : `${nextLevel}:${nextWorkspaceId ?? "unbound"}`;
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
      setAccessLevel("project");
      switchPiScope(next.workspaceId, "project");
    }
    setWorkspaceId(next.workspaceId);
    setNovelId(next.novelId);
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
      if (sourceGrantToken) headers.set("x-withyou-source-grant", sourceGrantToken);
      return workspaceFetch(input, { ...init, headers });
    },
    [sourceGrantToken],
  );

  const loadSourceStatus = useCallback(async () => {
    const response = await sourceFetch("/api/pi/source/permissions");
    const json = await response.json();
    if (response.ok && json.success) setSourceStatus(json.data);
  }, [sourceFetch]);

  const loadProposals = useCallback(async () => {
    if (accessLevel === "observer") {
      setProposals([]);
      return;
    }
    if (accessLevel === "project" && !novelId) {
      setProposals([]);
      return;
    }
    const url =
      accessLevel === "source"
        ? "/api/pi/source/proposals"
        : `/api/pi/proposals?novelId=${encodeURIComponent(novelId ?? "")}`;
    const response = await (accessLevel === "source" ? sourceFetch(url) : workspaceFetch(url));
    const json = await response.json();
    if (response.ok && json.success) setProposals(json.data);
  }, [accessLevel, novelId, sourceFetch]);

  useEffect(() => {
    if (open) {
      void loadSourceStatus();
      void loadProposals();
    }
  }, [loadProposals, loadSourceStatus, open]);

  const switchLevel = useCallback(
    (level: AccessLevel) => {
      if (running) {
        requestGenerationRef.current += 1;
        requestAbortRef.current?.abort();
        requestAbortRef.current = null;
        assistantIdRef.current = null;
        setRunning(false);
        if (accessLevel === "source") {
          void sourceFetch("/api/pi/source", { method: "DELETE" });
        } else {
          const query = novelId ? `?novelId=${encodeURIComponent(novelId)}` : "";
          void workspaceFetch(`/api/pi${query}`, { method: "DELETE" });
        }
      }
      if (level === "source" && sourceStatus && !sourceStatus.unlocked) {
        setShowUnlock(true);
        return;
      }
      setAccessLevel(level);
      switchPiScope(workspaceId, level);
    },
    [accessLevel, novelId, running, sourceFetch, sourceStatus, switchPiScope, workspaceId],
  );

  const unlockSource = useCallback(async () => {
    setUnlocking(true);
    try {
      const response = await workspaceFetch("/api/pi/source/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation, durationMinutes: 30 }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.error || "解锁失败");
      const { grantToken, ...status } = json.data as SourceAccessStatus & { grantToken: string };
      setSourceGrantToken(grantToken);
      setSourceStatus(status);
      setShowUnlock(false);
      setConfirmation("");
      setAccessLevel("source");
      switchPiScope(workspaceId, "source");
      toast.success("源码维护权限已解锁 30 分钟");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "解锁失败");
    } finally {
      setUnlocking(false);
    }
  }, [confirmation, switchPiScope, workspaceId]);

  const lockSource = useCallback(async () => {
    await sourceFetch("/api/pi/source/permissions", { method: "DELETE" });
    setSourceGrantToken("");
    setAccessLevel("project");
    switchPiScope(workspaceId, "project");
    await loadSourceStatus();
    toast.info("源码维护权限已锁定");
  }, [loadSourceStatus, sourceFetch, switchPiScope, workspaceId]);

  const pendingCount = useMemo(() => proposals.filter((proposal) => proposal.status === "pending").length, [proposals]);

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
    if (accessLevel === "source" && sourceStatus && !sourceStatus.unlocked) {
      setShowUnlock(true);
      return;
    }

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
      const url = accessLevel === "source" ? "/api/pi/source" : "/api/pi";
      const response = await (accessLevel === "source" ? sourceFetch : workspaceFetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accessLevel === "source" ? { message } : { novelId, message, accessLevel }),
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
  }, [accessLevel, appendAssistant, input, loadProposals, novelId, running, sourceFetch, sourceStatus?.unlocked]);

  const stop = useCallback(async () => {
    requestGenerationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    assistantIdRef.current = null;
    if (accessLevel === "source") {
      await sourceFetch("/api/pi/source", { method: "DELETE" });
    } else {
      const query = novelId ? `?novelId=${encodeURIComponent(novelId)}` : "";
      await workspaceFetch(`/api/pi${query}`, { method: "DELETE" });
    }
    setRunning(false);
  }, [accessLevel, novelId, sourceFetch]);

  const decide = useCallback(
    async (proposalId: string, decision: "apply" | "reject" | "rollback") => {
      if (accessLevel !== "source" && !novelId) return;
      const url = accessLevel === "source" ? "/api/pi/source/proposals" : "/api/pi/proposals";
      const response = await (accessLevel === "source" ? sourceFetch : workspaceFetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accessLevel === "source" ? { proposalId, decision } : { novelId, proposalId, decision }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        toast.error(typeof json.error === "string" ? json.error : json.error?.message || "审批失败");
        await loadProposals();
        return;
      }
      toast.success(
        decision === "apply"
          ? accessLevel === "source"
            ? "源码补丁已应用并完成自动类型检查"
            : "已应用 Pi 的候选改动"
          : decision === "rollback"
            ? "源码补丁已回滚"
            : "已拒绝候选改动",
      );
      if (accessLevel === "project") {
        window.dispatchEvent(new CustomEvent("pi-files-changed", { detail: { novelId } }));
      }
      await loadProposals();
    },
    [accessLevel, loadProposals, novelId, sourceFetch],
  );

  return (
    <>
      <button
        ref={dockButtonRef}
        type="button"
        aria-label="Pi 项目管家，可拖动"
        title="拖动调整位置，点击打开 Pi"
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
        {accessLevel === "source" ? "Pi · 源码维护" : "Pi · 项目管家"}
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
                  {accessLevel === "source" ? "Pi · 源码维护者" : "Pi · 项目管家"}
                </div>
                <p className="mt-1 text-muted-foreground text-xs">
                  {accessLevel === "source"
                    ? sourceStatus?.workspace
                      ? `源码工作区：${sourceStatus.workspace}`
                      : "源码工作区不可用"
                    : novelId
                      ? `当前项目：${novelId}`
                      : "尚未选择小说项目"}
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md p-2 hover:bg-accent">
                <X className="size-4" />
              </button>
            </header>

            <div className="border-b px-5 py-3">
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => switchLevel("observer")}
                  className={`rounded-lg border p-2 text-left transition ${
                    accessLevel === "observer" ? "border-foreground bg-accent" : "hover:bg-accent/60"
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-medium text-xs">
                    <Eye className="size-3.5" />
                    一级 · 观察
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">只读分析</p>
                </button>
                <button
                  type="button"
                  onClick={() => switchLevel("project")}
                  className={`rounded-lg border p-2 text-left transition ${
                    accessLevel === "project" ? "border-foreground bg-accent" : "hover:bg-accent/60"
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-medium text-xs">
                    <FolderPen className="size-3.5" />
                    二级 · 项目
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">小说候选改动</p>
                </button>
                <button
                  type="button"
                  disabled={sourceStatus?.available === false}
                  onClick={() => switchLevel("source")}
                  className={`rounded-lg border p-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    accessLevel === "source" ? "border-red-500 bg-red-500/10" : "hover:bg-accent/60"
                  }`}
                  title={sourceStatus?.reason}
                >
                  <div className="flex items-center gap-1.5 font-medium text-xs">
                    {sourceStatus?.unlocked ? (
                      <ShieldCheck className="size-3.5 text-red-500" />
                    ) : (
                      <LockKeyhole className="size-3.5" />
                    )}
                    三级 · 源码
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {sourceStatus?.testMode ? "测试中已开放" : sourceStatus?.unlocked ? "临时已解锁" : "最高权限"}
                  </p>
                </button>
              </div>
              {accessLevel === "source" && sourceStatus?.unlocked && (
                <div className="mt-2 flex items-center justify-between rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-700 dark:text-red-300">
                  {sourceStatus.testMode ? (
                    <span>本地验收模式：三级源码权限持续开放</span>
                  ) : (
                    <>
                      <span>
                        权限到期：
                        {sourceStatus.expiresAt
                          ? new Date(sourceStatus.expiresAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "未知"}
                      </span>
                      <button type="button" onClick={() => void lockSource()} className="font-medium hover:underline">
                        立即锁定
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-5">
              {showUnlock && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
                  <div className="flex items-center gap-2 font-semibold text-red-700 text-sm dark:text-red-300">
                    <Code2 className="size-4" />
                    解锁源码维护权限
                  </div>
                  <p className="mt-2 text-muted-foreground text-xs leading-5">
                    Pi 将能读取源码、提出补丁并运行白名单检查。补丁仍需你逐项批准，权限 30
                    分钟后自动失效。请输入下方授权语句：
                  </p>
                  <code className="mt-2 block rounded bg-background px-2 py-1.5 text-xs">授权 Pi 修改源码</code>
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder="输入授权语句"
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowUnlock(false);
                        setConfirmation("");
                      }}
                      className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => void unlockSource()}
                      disabled={unlocking || confirmation !== "授权 Pi 修改源码"}
                      className="rounded-md bg-red-600 px-3 py-1.5 text-white text-xs disabled:opacity-40"
                    >
                      {unlocking ? "正在解锁…" : "解锁 30 分钟"}
                    </button>
                  </div>
                </div>
              )}

              {messages.length === 0 && (
                <div className="rounded-xl border bg-muted/30 p-4">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <Sparkles className="size-4" />
                    {accessLevel === "source"
                      ? "源码维护会话与创作记忆完全隔离"
                      : accessLevel === "observer"
                        ? "观察者模式只读项目"
                        : "我可以理解和整理整个项目"}
                  </div>
                  <p className="mt-2 text-muted-foreground text-xs leading-5">
                    {accessLevel === "source"
                      ? "Pi 可以定位源码问题、提出文件补丁、运行类型检查或构建，也可以按你的明确要求在桌面创建和更新文本文件。源码补丁仍需逐项批准。"
                      : accessLevel === "observer"
                        ? "Pi 可以读取、检索和审查当前小说，但没有提出文件修改的工具。"
                        : "让我检查设定冲突、整理文件、跨章节追踪人物，或提出文件修改。所有写入都会先形成候选改动，只有你批准后才会落盘。"}
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
                      {activity.name}
                    </div>
                  ))}
                </div>
              )}

              {proposals.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <FilePenLine className="size-4" />
                    {accessLevel === "source" ? "源码候选补丁" : "候选改动"}
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
                                  className={`rounded-md px-3 py-1.5 text-white text-xs ${
                                    accessLevel === "source" ? "bg-red-600" : "bg-foreground"
                                  }`}
                                >
                                  {accessLevel === "source" ? "批准、写入并检查" : "批准并写入"}
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
                                  {accessLevel === "source" && proposal.status === "applied" && (
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
                    accessLevel === "source"
                      ? "交给 Pi 一个源码维护任务…"
                      : novelId
                        ? "交给 Pi 一个项目级任务…"
                        : "先和 Pi 讨论这本书的准备工作…"
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
                    className={`rounded-lg p-2 text-white disabled:opacity-40 ${
                      accessLevel === "source" ? "bg-red-600" : "bg-foreground"
                    }`}
                  >
                    <Send className="size-4" />
                  </button>
                )}
              </div>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                {accessLevel === "source"
                  ? "最高权限会话 · 桌面文本可执行 · 源码补丁需批准 · 自动保留检查点"
                  : accessLevel === "observer"
                    ? "一级权限 · 只读当前小说项目"
                    : "二级权限 · 小说文件修改需经你批准"}
              </p>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}
