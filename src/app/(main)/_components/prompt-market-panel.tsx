"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ArrowLeft, Check, Loader2, Pencil, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PromptPackage, PromptPackageScope, ToolId } from "@/lib/prompts/prompt-package";
import { workspaceFetch } from "@/lib/workspaces/client";
import { usePromptActivationStore } from "@/stores/prompts/prompt-activation-store";

interface PromptMarketPanelProps {
  novelId: string;
  currentTool?: ToolId | null;
}

const TOOL_OPTIONS: Array<{ id: ToolId; label: string }> = [
  { id: "book-name", label: "书名" },
  { id: "brainstorm", label: "脑洞" },
  { id: "character", label: "人物" },
  { id: "worldview", label: "世界观" },
  { id: "outline", label: "大纲" },
  { id: "detailed-outline", label: "细纲" },
  { id: "opening", label: "黄金开篇" },
  { id: "goldfinger", label: "金手指" },
  { id: "synopsis", label: "简介" },
];

const TOOL_IDS = new Set<ToolId>(TOOL_OPTIONS.map((item) => item.id));

function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && TOOL_IDS.has(value as ToolId);
}

interface PromptDraft {
  name: string;
  description: string;
  systemPrompt: string;
}

export function PromptMarketPanel({ novelId, currentTool }: PromptMarketPanelProps) {
  const [activeTab, setActiveTab] = useState<PromptPackageScope>("tool");
  const [selectedTool, setSelectedTool] = useState<ToolId>(isToolId(currentTool) ? currentTool : "outline");
  const [packages, setPackages] = useState<PromptPackage[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<PromptPackage | null>(null);
  const [draft, setDraft] = useState<PromptDraft>({
    name: "",
    description: "",
    systemPrompt: "",
  });

  const {
    activatedToolPackages,
    activatedWriterPackage,
    activatedCoverPackage,
    setNovel,
    loadActivation,
    activateToolPackage,
    activateWriterPackage,
    activateCoverPackage,
    deactivateToolPackage,
    deactivateWriterPackage,
    deactivateCoverPackage,
  } = usePromptActivationStore();

  useEffect(() => {
    if (isToolId(currentTool)) setSelectedTool(currentTool);
  }, [currentTool]);

  const loadPackages = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        scope: activeTab,
      });
      if (novelId) params.set("novel_id", novelId);
      if (activeTab === "tool") params.set("toolId", selectedTool);

      const res = await workspaceFetch(`/api/prompts?${params}`);
      if (!res.ok) throw new Error("提示词列表加载失败");
      const data = await res.json();
      setPackages(data.packages || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提示词列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [activeTab, novelId, selectedTool]);

  useEffect(() => {
    void loadPackages();
    if (novelId) {
      void loadActivation(novelId);
    } else {
      setNovel(null);
    }
  }, [loadActivation, loadPackages, novelId, setNovel]);

  const activePackage = useMemo(() => {
    if (activeTab === "tool") return activatedToolPackages[selectedTool] || null;
    if (activeTab === "writer") return activatedWriterPackage;
    return activatedCoverPackage;
  }, [activeTab, activatedCoverPackage, activatedToolPackages, activatedWriterPackage, selectedTool]);

  const handleActivate = async (pkg: PromptPackage, notify = true) => {
    if (!novelId) {
      toast.error("请先创建或选择小说项目");
      return;
    }

    try {
      if (pkg.scope === "tool" && pkg.toolId) await activateToolPackage(pkg.toolId, pkg);
      if (pkg.scope === "writer") await activateWriterPackage(pkg);
      if (pkg.scope === "cover") await activateCoverPackage(pkg);
      if (notify) toast.success(`已应用「${pkg.name}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提示词应用失败");
      if (!notify) throw error;
    }
  };

  const handleRestoreDefault = async () => {
    if (!activePackage) return;

    try {
      if (activeTab === "tool") await deactivateToolPackage(selectedTool);
      if (activeTab === "writer") await deactivateWriterPackage();
      if (activeTab === "cover") await deactivateCoverPackage();
      toast.success("已恢复默认提示词");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "恢复默认失败");
    }
  };

  const openDetails = (pkg: PromptPackage) => {
    setSelectedPackage(pkg);
    setDraft({
      name: pkg.name,
      description: pkg.description,
      systemPrompt: pkg.systemPrompt,
    });
  };

  const handleSave = async () => {
    if (!selectedPackage) return;
    if (!novelId) {
      toast.error("请先创建或选择小说项目");
      return;
    }
    if (!draft.name.trim() || !draft.systemPrompt.trim()) {
      toast.error("名称和提示词内容不能为空");
      return;
    }

    setSaving(true);
    try {
      const isBuiltin = Boolean(selectedPackage.builtin);
      const res = await workspaceFetch("/api/prompts", {
        method: isBuiltin ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          novel_id: novelId,
          ...(isBuiltin ? {} : { id: selectedPackage.id }),
          name: draft.name.trim(),
          description: draft.description.trim(),
          scope: selectedPackage.scope,
          toolId: selectedPackage.toolId,
          systemPrompt: draft.systemPrompt.trim(),
          author: selectedPackage.author,
          version: selectedPackage.version,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.package) {
        throw new Error(data.error || "提示词保存失败");
      }

      const saved = data.package as PromptPackage;
      await handleActivate(saved, false);
      setSelectedPackage(saved);
      setDraft({
        name: saved.name,
        description: saved.description,
        systemPrompt: saved.systemPrompt,
      });
      await loadPackages();
      await loadActivation(novelId);
      toast.success(isBuiltin ? "已创建项目副本并应用" : "已保存并应用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提示词保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (selectedPackage) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <Button variant="ghost" size="icon" onClick={() => setSelectedPackage(null)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="truncate font-semibold text-sm">提示词详情</div>
            <div className="text-[11px] text-muted-foreground">
              {selectedPackage.builtin ? "编辑后会创建本项目专属副本" : "修改仅影响当前小说项目"}
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <label className="block space-y-1.5" htmlFor="prompt-name">
            <span className="font-medium text-xs">名称</span>
            <Input
              id="prompt-name"
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
          </label>
          <label className="block space-y-1.5" htmlFor="prompt-description">
            <span className="font-medium text-xs">说明</span>
            <Textarea
              id="prompt-description"
              className="min-h-20"
              value={draft.description}
              onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
            />
          </label>
          <label className="block space-y-1.5" htmlFor="prompt-system-content">
            <span className="font-medium text-xs">系统提示词</span>
            <Textarea
              id="prompt-system-content"
              className="min-h-80 font-mono text-xs leading-5"
              value={draft.systemPrompt}
              onChange={(event) => setDraft((prev) => ({ ...prev, systemPrompt: event.target.value }))}
            />
          </label>
        </div>

        <div className="flex shrink-0 gap-2 border-t p-4">
          <Button className="flex-1" onClick={handleSave} disabled={saving || !novelId}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            保存并应用
          </Button>
          <Button variant="outline" onClick={handleRestoreDefault} disabled={!activePackage || saving}>
            <RotateCcw className="mr-2 h-4 w-4" />
            恢复默认
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b">
        {(
          [
            ["tool", "功能区"],
            ["writer", "会话写手"],
            ["cover", "封面生成"],
          ] as Array<[PromptPackageScope, string]>
        ).map(([scope, label]) => (
          <button
            type="button"
            key={scope}
            className={`px-4 py-2 font-medium text-sm ${
              activeTab === scope ? "border-primary border-b-2 text-primary" : "text-muted-foreground"
            }`}
            onClick={() => {
              setActiveTab(scope);
              setSelectedPackage(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "tool" && (
        <div className="shrink-0 border-b p-3">
          <div className="mb-2 text-[11px] text-muted-foreground">选择要配置的功能</div>
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none"
            value={selectedTool}
            onChange={(event) => {
              setSelectedTool(event.target.value as ToolId);
              setSelectedPackage(null);
            }}
          >
            {TOOL_OPTIONS.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-2">
        <div className="min-w-0 text-xs">
          {activePackage ? (
            <span className="flex items-center gap-1.5 truncate text-primary">
              <Check className="h-3.5 w-3.5 shrink-0" />
              当前应用：{activePackage.name}
            </span>
          ) : (
            <span className="text-muted-foreground">当前使用系统默认提示词</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="ml-2 h-7 shrink-0 px-2 text-xs"
          onClick={handleRestoreDefault}
          disabled={!activePackage}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          恢复默认
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中
          </div>
        ) : packages.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground text-sm">该板块暂无可用提示词</div>
        ) : (
          packages.map((pkg) => {
            const activated = activePackage?.id === pkg.id;
            return (
              <div
                key={pkg.id}
                className={`rounded-lg border p-3 transition-colors hover:bg-muted/30 ${
                  activated ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="font-medium text-sm hover:underline"
                        onClick={() => openDetails(pkg)}
                      >
                        {pkg.name}
                      </button>
                      {pkg.builtin && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">内置</span>}
                      {activated && (
                        <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                          已应用
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-muted-foreground text-xs">{pkg.description}</p>
                  </div>
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:bg-muted"
                    aria-label={`编辑${pkg.name}`}
                    onClick={() => openDetails(pkg)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    className="h-7 flex-1 text-xs"
                    variant={activated ? "secondary" : "default"}
                    disabled={activated}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleActivate(pkg);
                    }}
                  >
                    {activated ? "已应用" : "应用"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 flex-1 text-xs"
                    disabled={!activePackage}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleRestoreDefault();
                    }}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    恢复默认
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
