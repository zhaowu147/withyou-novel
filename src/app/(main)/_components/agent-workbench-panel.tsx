"use client";

import { useCallback, useState } from "react";

import { BrainCircuit, Check, Database, SearchCheck, X } from "lucide-react";
import { toast } from "sonner";

import { actOnSemanticContract, createSemanticContract, updateSemanticContract } from "@/lib/semantic-alignment/client";
import type { SemanticContractEditableFields, SemanticContractEnvelope } from "@/lib/semantic-alignment/types";
import { readableApiError, workspaceFetch } from "@/lib/workspaces/client";

import { SemanticContractCard } from "./semantic-contract-card";

type WorkbenchAgentId = "planner" | "reviewer" | "memory";
type ReviewerFocus = "all" | "lore" | "pacing" | "continuity";

interface AgentTrace {
  files: Array<{ path: string; reason: string; chars: number }>;
  memories: Array<{ id: string; tier: string; kind: string; source: string }>;
  tools: Array<{ name: string; summary: string; startedAt: string; error?: string }>;
}

interface MemoryCandidate {
  id: string;
  tier: "canonical" | "long" | "short";
  kind: string;
  content: string;
  importance: string;
  confidence: number;
  source: { path?: string; excerpt?: string };
}

const AGENTS: Array<{
  id: WorkbenchAgentId;
  name: string;
  description: string;
  placeholder: string;
  icon: typeof BrainCircuit;
}> = [
  {
    id: "planner",
    name: "剧情规划",
    description: "读取已有设定与正文，规划总纲、卷纲和章节推进。",
    placeholder: "例如：检查现有大纲，规划下一卷的核心冲突与章节推进……",
    icon: BrainCircuit,
  },
  {
    id: "reviewer",
    name: "审稿检查",
    description: "根据正文证据检查逻辑、人物状态、节奏和伏笔。",
    placeholder: "例如：审查最近六章的人物动机与设定冲突，按严重程度列出问题……",
    icon: SearchCheck,
  },
  {
    id: "memory",
    name: "记忆整理",
    description: "提出规范、长期和短期记忆候选，确认前不会进入召回。",
    placeholder: "例如：整理最近章节里需要持续记住的人物状态、关系变化和未完成事件……",
    icon: Database,
  },
];

const TIER_LABELS: Record<MemoryCandidate["tier"], string> = {
  canonical: "规范",
  long: "长期",
  short: "短期",
};

export function AgentWorkbenchPanel({ novelId, onClose }: { novelId: string; onClose: () => void }) {
  const [agentId, setAgentId] = useState<WorkbenchAgentId>("planner");
  const [reviewerFocus, setReviewerFocus] = useState<ReviewerFocus>("all");
  const [objective, setObjective] = useState("");
  const [running, setRunning] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [progress, setProgress] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [trace, setTrace] = useState<AgentTrace | null>(null);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [semanticEnvelope, setSemanticEnvelope] = useState<SemanticContractEnvelope | null>(null);
  const [semanticBusy, setSemanticBusy] = useState(false);
  const selectedAgent = AGENTS.find((agent) => agent.id === agentId) ?? AGENTS[0];

  const loadCandidates = useCallback(
    async (targetRunId: string) => {
      if (!novelId) return;
      const response = await workspaceFetch(`/api/novels/${encodeURIComponent(novelId)}/memories?status=candidate`);
      if (!response.ok) throw new Error(await readableApiError(response, "记忆候选读取失败"));
      const payload = await response.json();
      const rows = Array.isArray(payload.data) ? (payload.data as MemoryCandidate[]) : [];
      setCandidates(rows.filter((memory) => memory.source?.path?.startsWith(`agent-run/${targetRunId}`)));
    },
    [novelId],
  );

  const selectAgent = (nextAgentId: WorkbenchAgentId) => {
    if (running) return;
    setAgentId(nextAgentId);
    setObjective("");
    setRunId(null);
    setOutput("");
    setTrace(null);
    setCandidates([]);
    setSemanticEnvelope(null);
  };

  const runAgent = async (semanticContract?: { id: string; version: number }) => {
    const task = objective.trim();
    if (!task || !novelId || running || (!semanticContract && semanticBusy)) return;
    if (!semanticContract) {
      setSemanticBusy(true);
      try {
        const next = await createSemanticContract({
          novelId,
          taskKind: "writer",
          userInput: task,
        });
        setSemanticEnvelope(next);
        if (next.contract.status === "confirmed") {
          await runAgent({ id: next.contract.id, version: next.contract.version });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "语义解析失败");
      } finally {
        setSemanticBusy(false);
      }
      return;
    }
    setRunning(true);
    setProgressText("正在启动 Agent 任务…");
    setProgress(0);
    setRunId(null);
    setOutput("");
    setTrace(null);
    setCandidates([]);
    try {
      const response = await workspaceFetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          novelId,
          agentId,
          objective: task,
          stream: true,
          reviewerFocus: agentId === "reviewer" ? reviewerFocus : undefined,
          semanticContractId: semanticContract.id,
          semanticContractVersion: semanticContract.version,
        }),
      });
      if (!response.ok) throw new Error(await readableApiError(response, `${selectedAgent.name}运行失败`));
      if (!response.body) throw new Error("Agent 没有返回进度流");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completedRunId = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const records = buffer.split("\n\n");
        buffer = records.pop() ?? "";
        for (const record of records) {
          const line = record.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as {
            type?: string;
            text?: string;
            progress?: number;
            runId?: string;
            output?: string;
            trace?: AgentTrace;
            message?: string;
          };
          if (event.type === "agent_progress") {
            setProgressText(event.text ?? "正在处理任务…");
            if (typeof event.progress === "number") setProgress(event.progress);
          } else if (event.type === "result") {
            completedRunId = event.runId ?? "";
            setRunId(event.runId ?? null);
            setOutput(event.output ?? "");
            setTrace(event.trace ?? null);
          } else if (event.type === "error") {
            throw new Error(event.message || `${selectedAgent.name}运行失败`);
          }
        }
      }
      if (!completedRunId) throw new Error("Agent 没有返回运行记录");
      setProgress(100);
      setProgressText("Agent 任务已完成");
      if (agentId === "memory") await loadCandidates(completedRunId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Agent 运行失败");
    } finally {
      setRunning(false);
    }
  };

  const handleSemanticUpdate = async (fields: SemanticContractEditableFields) => {
    if (!semanticEnvelope) return;
    setSemanticBusy(true);
    try {
      setSemanticEnvelope(
        await updateSemanticContract({
          novelId,
          contractId: semanticEnvelope.contract.id,
          version: semanticEnvelope.contract.version,
          fields,
        }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存语义修改失败");
    } finally {
      setSemanticBusy(false);
    }
  };

  const handleSemanticAction = async (action: "confirm" | "reject" | "reparse", saveAsLongTerm = false) => {
    if (!semanticEnvelope) return;
    setSemanticBusy(true);
    try {
      const next = await actOnSemanticContract({
        novelId,
        contractId: semanticEnvelope.contract.id,
        version: semanticEnvelope.contract.version,
        action,
        saveAsLongTerm,
      });
      if (action === "reject") {
        setSemanticEnvelope(null);
      } else {
        setSemanticEnvelope(next);
      }
      if (action === "confirm") {
        setSemanticEnvelope(null);
        await runAgent({ id: next.contract.id, version: next.contract.version });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "语义契约操作失败");
    } finally {
      setSemanticBusy(false);
    }
  };

  const decideCandidates = async (memoryIds: string[], decision: "approve" | "reject") => {
    if (!runId || !memoryIds.length || deciding) return;
    setDeciding(memoryIds.length === 1 ? memoryIds[0] : decision);
    try {
      const response = await workspaceFetch(`/api/novels/${encodeURIComponent(novelId)}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, memoryIds, decision }),
      });
      if (!response.ok) throw new Error(await readableApiError(response, "候选审批失败"));
      const decided = new Set(memoryIds);
      setCandidates((current) => current.filter((candidate) => !decided.has(candidate.id)));
      toast.success(decision === "approve" ? "记忆候选已批准" : "记忆候选已拒绝");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "候选审批失败");
    } finally {
      setDeciding(null);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div>
          <div className="font-semibold text-sm">Agent 工作台</div>
          <div className="text-[11px] text-foreground/65">显式选择任务，不与写作会话串线</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-foreground/65 transition-colors hover:bg-accent hover:text-foreground"
          aria-label="关闭 Agent 工作台"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="grid grid-cols-3 border-b">
        {AGENTS.map((agent) => {
          const Icon = agent.icon;
          const active = agent.id === agentId;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => selectAgent(agent.id)}
              className={`flex items-center justify-center gap-1.5 border-b-2 px-2 py-3 text-xs transition-colors ${
                active
                  ? "border-emerald-500 bg-emerald-500/5 font-medium text-foreground"
                  : "border-transparent text-foreground/65 hover:bg-accent hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5" />
              {agent.name}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <p className="text-foreground/75 text-xs leading-5">{selectedAgent.description}</p>
          <textarea
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder={selectedAgent.placeholder}
            className="mt-3 min-h-28 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm leading-6 outline-none transition-shadow focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15"
          />
          {agentId === "reviewer" && (
            <label className="mt-2 block text-xs text-foreground/70">
              审查视角
              <select
                value={reviewerFocus}
                onChange={(event) => setReviewerFocus(event.target.value as ReviewerFocus)}
                className="mt-1 h-9 w-full rounded-lg border bg-background px-2 text-sm text-foreground outline-none focus:border-emerald-500"
              >
                <option value="all">综合审查</option>
                <option value="lore">设定与世界观</option>
                <option value="pacing">网文节奏与爽点</option>
                <option value="continuity">时间线、因果与伏笔</option>
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => void runAgent()}
            disabled={!objective.trim() || !novelId || running || semanticBusy || semanticEnvelope !== null}
            className="mt-2 flex h-9 w-full items-center justify-center rounded-lg bg-emerald-600 font-medium text-sm text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {running ? `${progressText || "正在处理…"} ${progress}%` : `运行${selectedAgent.name} Agent`}
          </button>
        </div>

        {semanticEnvelope && (
          <SemanticContractCard
            contract={semanticEnvelope.contract}
            history={semanticEnvelope.history}
            busy={semanticBusy || running}
            onUpdate={handleSemanticUpdate}
            onConfirm={(saveAsLongTerm) => handleSemanticAction("confirm", saveAsLongTerm)}
            onReparse={() => handleSemanticAction("reparse")}
            onReject={() => handleSemanticAction("reject")}
          />
        )}

        {output && (
          <div className="rounded-xl border bg-background p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium text-xs">Agent 结果</span>
              {runId && <span className="text-[10px] text-foreground/55">运行记录 {runId.slice(0, 8)}</span>}
            </div>
            <div className="whitespace-pre-wrap text-sm leading-6">{output}</div>
          </div>
        )}

        {trace && (
          <details className="rounded-xl border bg-background p-3">
            <summary className="cursor-pointer select-none font-medium text-xs">
              本次证据 · {trace.files.length} 个文件 · {trace.memories.length} 条记忆 · {trace.tools.length} 次工具
            </summary>
            <div className="mt-3 space-y-3 border-t pt-3 text-xs">
              {trace.files.length > 0 && (
                <div>
                  <div className="mb-1 font-medium">读取文件</div>
                  {trace.files.map((file) => (
                    <div key={file.path} className="flex justify-between gap-3 py-1 text-foreground/70">
                      <span className="truncate">{file.path}</span>
                      <span className="shrink-0">{file.chars.toLocaleString()} 字符</span>
                    </div>
                  ))}
                </div>
              )}
              <div>
                <div className="mb-1 font-medium">工具轨迹</div>
                {trace.tools.map((tool) => (
                  <div
                    key={`${tool.name}-${tool.startedAt}`}
                    className={`py-1 ${tool.error ? "text-red-600" : "text-foreground/70"}`}
                  >
                    {tool.error ? `失败：${tool.name} · ${tool.error}` : tool.summary}
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}

        {agentId === "memory" && runId && (
          <div className="rounded-xl border bg-background p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-xs">待审批记忆</div>
                <div className="mt-0.5 text-[11px] text-foreground/60">批准前不会参与后续写作召回</div>
              </div>
              {candidates.length > 0 && (
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={Boolean(deciding)}
                    onClick={() =>
                      void decideCandidates(
                        candidates.map((item) => item.id),
                        "reject",
                      )
                    }
                    className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-45"
                  >
                    全部拒绝
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(deciding)}
                    onClick={() =>
                      void decideCandidates(
                        candidates.map((item) => item.id),
                        "approve",
                      )
                    }
                    className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:opacity-45"
                  >
                    全部批准
                  </button>
                </div>
              )}
            </div>
            {candidates.length === 0 ? (
              <div className="mt-3 rounded-lg bg-muted/50 px-3 py-4 text-center text-foreground/60 text-xs">
                当前运行没有待审批候选
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {candidates.map((candidate) => (
                  <div key={candidate.id} className="rounded-lg border p-3">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700">
                        {TIER_LABELS[candidate.tier]}
                      </span>
                      <span>{candidate.kind}</span>
                      <span className="ml-auto text-foreground/55">{Math.round(candidate.confidence * 100)}%</span>
                    </div>
                    <p className="mt-2 text-sm leading-5">{candidate.content}</p>
                    {candidate.source.excerpt && (
                      <p className="mt-2 border-l-2 pl-2 text-foreground/60 text-xs leading-5">
                        {candidate.source.excerpt}
                      </p>
                    )}
                    <div className="mt-3 flex justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={Boolean(deciding)}
                        onClick={() => void decideCandidates([candidate.id], "reject")}
                        className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-45"
                      >
                        拒绝
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(deciding)}
                        onClick={() => void decideCandidates([candidate.id], "approve")}
                        className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:opacity-45"
                      >
                        <Check className="size-3" />
                        批准
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
