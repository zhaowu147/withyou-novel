"use client";

import { useEffect, useMemo, useState } from "react";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  SemanticConstraint,
  SemanticContract,
  SemanticContractEditableFields,
} from "@/lib/semantic-alignment/types";

interface SemanticContractCardProps {
  contract: SemanticContract;
  history?: SemanticContract[];
  busy?: boolean;
  onUpdate: (fields: SemanticContractEditableFields) => void | Promise<void>;
  onConfirm: (saveAsLongTerm: boolean) => void | Promise<void>;
  onReparse: () => void | Promise<void>;
  onReject: () => void | Promise<void>;
}

function editable(contract: SemanticContract): SemanticContractEditableFields {
  return {
    taskSummary: contract.taskSummary,
    intendedOutcome: contract.intendedOutcome,
    excludedScope: contract.excludedScope,
    interpretations: contract.interpretations.map((item) => ({ ...item })),
    constraints: contract.constraints.map((item) => ({ ...item })),
    assumptions: contract.assumptions.map((item) => ({ ...item })),
    ambiguities: contract.ambiguities.map((item) => ({ ...item, possibleMeanings: [...item.possibleMeanings] })),
    plannedDecisions: contract.plannedDecisions.map((item) => ({ ...item })),
  };
}

const CONSTRAINT_LABELS: Record<SemanticConstraint["type"], string> = {
  must: "必须",
  must_not: "禁止",
  preserve: "保留",
  prefer: "偏好",
  avoid: "避免",
};

export function SemanticContractCard({
  contract,
  history = [],
  busy = false,
  onUpdate,
  onConfirm,
  onReparse,
  onReject,
}: SemanticContractCardProps) {
  const [draft, setDraft] = useState(() => editable(contract));
  const [saveAsLongTerm, setSaveAsLongTerm] = useState(false);
  const [showReferences, setShowReferences] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => setDraft(editable(contract)), [contract]);

  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(editable(contract)), [contract, draft]);
  const unresolved = contract.ambiguities.some((item) => item.requiresUserInput && !item.selectedMeaning);
  const highRiskAssumption = contract.assumptions.some(
    (item) => !item.confirmed && (item.riskLevel === "high" || item.riskLevel === "critical"),
  );
  const blocked = contract.confirmationMode === "blocked" || unresolved || highRiskAssumption;

  return (
    <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-4 text-amber-600" />
            语义契约 · v{contract.version}
          </div>
          <p className="mt-1 text-muted-foreground text-xs">
            {contract.confirmationMode === "blocked"
              ? "存在阻断项，正式任务不会执行"
              : "请确认 AI 准备如何理解这次任务；这不是对最终内容的确认"}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-[10px] ${
            contract.riskLevel === "high" || contract.riskLevel === "critical"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {contract.riskLevel} risk
        </span>
      </div>

      <div className="mt-4 space-y-4">
        {contract.blockingReasons && contract.blockingReasons.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-xs">
            <div className="font-medium">项目事实冲突</div>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {contract.blockingReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <span className="font-medium text-xs">任务理解</span>
          <Textarea
            aria-label="任务理解"
            className="mt-1 min-h-16 text-xs"
            value={draft.taskSummary}
            onChange={(event) => setDraft((current) => ({ ...current, taskSummary: event.target.value }))}
          />
        </div>
        <div>
          <span className="font-medium text-xs">希望达到的结果</span>
          <Textarea
            aria-label="希望达到的结果"
            className="mt-1 min-h-16 text-xs"
            value={draft.intendedOutcome}
            onChange={(event) => setDraft((current) => ({ ...current, intendedOutcome: event.target.value }))}
          />
        </div>

        {draft.interpretations.length > 0 && (
          <div className="space-y-2">
            <div className="font-medium text-xs">关键语义</div>
            {draft.interpretations.map((item, index) => (
              <div key={item.id} className="rounded-lg border bg-background/70 p-2">
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>“{item.sourceExpression}”</span>
                  <button
                    type="button"
                    title="删除这项模型解释"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        interpretations: current.interpretations.filter((_, itemIndex) => itemIndex !== index),
                      }))
                    }
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
                <Textarea
                  className="mt-1 min-h-14 text-xs"
                  value={item.interpretedMeaning}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      interpretations: current.interpretations.map((entry, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...entry,
                              interpretedMeaning: event.target.value,
                              editedByUser: true,
                              requiresConfirmation: false,
                            }
                          : entry,
                      ),
                    }))
                  }
                />
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-xs">必须保留与禁止事项</span>
            <button
              type="button"
              className="flex items-center gap-1 text-[11px] text-primary"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  constraints: [
                    ...current.constraints,
                    {
                      id: `user-${Date.now()}`,
                      type: "must",
                      description: "",
                      source: "current_user_input",
                      priority: 100,
                    },
                  ],
                }))
              }
            >
              <Plus className="size-3" /> 添加约束
            </button>
          </div>
          {draft.constraints.map((item, index) => (
            <div key={item.id} className="flex items-start gap-2">
              <select
                className="h-8 rounded-md border bg-background px-1 text-[11px]"
                value={item.type}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    constraints: current.constraints.map((entry, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...entry,
                            type: event.target.value as SemanticConstraint["type"],
                            priority: ["must", "must_not", "preserve"].includes(event.target.value) ? 100 : 60,
                          }
                        : entry,
                    ),
                  }))
                }
              >
                {Object.entries(CONSTRAINT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Textarea
                className="min-h-12 flex-1 text-xs"
                value={item.description}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    constraints: current.constraints.map((entry, itemIndex) =>
                      itemIndex === index ? { ...entry, description: event.target.value } : entry,
                    ),
                  }))
                }
              />
              <button
                type="button"
                className="mt-2 text-muted-foreground"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    constraints: current.constraints.filter((_, itemIndex) => itemIndex !== index),
                  }))
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>

        {draft.plannedDecisions.length > 0 && (
          <div>
            <div className="font-medium text-xs">准备采用的方向</div>
            <ul className="mt-1 space-y-1 text-xs">
              {draft.plannedDecisions.map((item) => (
                <li key={item.id} className="rounded-md bg-background/70 px-2 py-1.5">
                  {item.decision}
                </li>
              ))}
            </ul>
          </div>
        )}

        {draft.ambiguities.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1 font-medium text-xs text-amber-700">
              <AlertTriangle className="size-3.5" /> 不确定性
            </div>
            {draft.ambiguities.map((item, index) => (
              <div key={item.id} className="rounded-lg border border-amber-500/20 bg-background/70 p-2 text-xs">
                <div>{item.expression}</div>
                <select
                  className="mt-2 h-8 w-full rounded-md border bg-background px-2 text-xs"
                  value={item.selectedMeaning ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      ambiguities: current.ambiguities.map((entry, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...entry,
                              selectedMeaning: event.target.value || undefined,
                              selectionReason: event.target.value ? "用户在语义契约中选择" : undefined,
                            }
                          : entry,
                      ),
                    }))
                  }
                >
                  <option value="">请选择解释</option>
                  {item.possibleMeanings.map((meaning) => (
                    <option key={meaning} value={meaning}>
                      {meaning}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}

        {draft.assumptions.length > 0 && (
          <div className="space-y-2">
            <div className="font-medium text-xs">模型假设</div>
            {draft.assumptions.map((item, index) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-3 rounded-md bg-background/70 p-2 text-xs"
              >
                <span>
                  {item.description}
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">{item.impactIfWrong}</span>
                </span>
                <Switch
                  size="sm"
                  checked={item.confirmed}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({
                      ...current,
                      assumptions: current.assumptions.map((entry, itemIndex) =>
                        itemIndex === index ? { ...entry, confirmed: checked } : entry,
                      ),
                    }))
                  }
                  aria-label="确认模型假设"
                />
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <button
            type="button"
            className="flex items-center justify-between rounded-md border bg-background px-2 py-1.5"
            onClick={() => setShowReferences((current) => !current)}
          >
            <span className="flex items-center gap-1">
              <FileText className="size-3" /> 引用文件 {contract.sourceReferences.length}
            </span>
            <ChevronDown className={`size-3 transition-transform ${showReferences ? "rotate-180" : ""}`} />
          </button>
          <button
            type="button"
            className="flex items-center justify-between rounded-md border bg-background px-2 py-1.5"
            onClick={() => setShowHistory((current) => !current)}
          >
            <span>版本记录 {history.length}</span>
            <ChevronDown className={`size-3 transition-transform ${showHistory ? "rotate-180" : ""}`} />
          </button>
        </div>
        {showReferences && (
          <div className="max-h-32 overflow-y-auto rounded-md border bg-background p-2 text-[10px] text-muted-foreground">
            {contract.sourceReferences.map((reference) => (
              <div key={reference.path}>
                {reference.path} · {reference.contentHash?.slice(0, 10)}
              </div>
            ))}
          </div>
        )}
        {showHistory && (
          <div className="max-h-32 overflow-y-auto rounded-md border bg-background p-2 text-[10px] text-muted-foreground">
            {history.map((version) => (
              <div key={version.version}>
                v{version.version} · {version.status} · 修改记录 {version.userEdits.length}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-4 rounded-md border bg-background/70 p-2 text-xs">
          <span>将确认后的硬约束保存为项目长期规则</span>
          <Switch
            size="sm"
            checked={saveAsLongTerm}
            onCheckedChange={setSaveAsLongTerm}
            aria-label="保存为项目长期规则"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {changed && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void onUpdate(draft)}>
            {busy ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Check className="mr-1 size-3" />}
            保存修改
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy || changed || blocked}
          onClick={() => void onConfirm(saveAsLongTerm)}
          title={blocked ? "请先解决高风险歧义或假设" : undefined}
        >
          {busy ? <Loader2 className="mr-1 size-3 animate-spin" /> : <ShieldCheck className="mr-1 size-3" />}
          确认并继续
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onReparse()}>
          <RotateCcw className="mr-1 size-3" /> 重新解析
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onReject()}>
          取消任务
        </Button>
      </div>
    </section>
  );
}
