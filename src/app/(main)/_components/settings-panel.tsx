"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { Eye, EyeOff, HardDrive, Loader2, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { refreshCompressionConfig } from "@/hooks/use-compression-config";
import { type AppSettings, DEFAULT_SETTINGS, type ModelProviderConfig, PROVIDERS } from "@/lib/settings/settings-store";
import { workspaceFetch } from "@/lib/workspaces/client";

interface ModelConfigSectionProps {
  title: string;
  icon: string;
  description: string;
  value: ModelProviderConfig;
  onChange: (config: ModelProviderConfig) => void;
  showImageModels?: boolean;
}

function ModelConfigSection({ title, icon, description, value, onChange, showImageModels }: ModelConfigSectionProps) {
  const [showKey, setShowKey] = useState(false);
  const modelListId = useId();
  const provider = PROVIDERS.find((p) => p.id === value.provider);
  const availableProviders = showImageModels
    ? PROVIDERS.filter((item) => item.id === "custom" || item.supportsImage)
    : PROVIDERS;
  const availableModels = showImageModels
    ? [...(((provider as any)?.imageModels as string[] | undefined) ?? [])]
    : (provider?.models ?? []);

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div>
        <h3 className="flex items-center gap-2 font-semibold text-sm">
          <span>{icon}</span> {title}
        </h3>
        <p className="mt-1 text-muted-foreground text-xs">{description}</p>
      </div>

      {/* Provider */}
      <div className="space-y-1.5">
        <Label className="text-xs">Provider</Label>
        <Select
          value={value.provider}
          onValueChange={(p) => {
            const prov = PROVIDERS.find((pr) => pr.id === p);
            const imageModels = ((prov as any)?.imageModels as string[] | undefined) ?? [];
            onChange({
              ...value,
              provider: p,
              model: showImageModels ? (imageModels[0] ?? "") : (prov?.models[0] ?? ""),
              apiBase: prov?.defaultBase ?? "",
            });
          }}
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableProviders.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Model */}
      <div className="space-y-1.5">
        <Label className="text-xs">模型</Label>
        <Input
          className="h-9 text-sm"
          list={availableModels.length > 0 ? modelListId : undefined}
          placeholder="输入模型名称"
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
        {availableModels.length > 0 ? (
          <datalist id={modelListId}>
            {availableModels.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        ) : null}
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <Label className="text-xs">API Key</Label>
        <div className="relative">
          <Input
            className="h-9 pr-9 text-sm"
            type={showKey ? "text" : "password"}
            placeholder="sk-...（留空则使用环境变量默认值）"
            value={value.apiKey}
            onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      {/* API Base */}
      <div className="space-y-1.5">
        <Label className="text-xs">API Base URL</Label>
        <Input
          className="h-9 text-sm"
          placeholder={provider?.defaultBase || "https://..."}
          value={value.apiBase ?? ""}
          onChange={(e) => onChange({ ...value, apiBase: e.target.value })}
        />
      </div>

      {/* 上下文窗口 */}
      <div className="space-y-1.5">
        <Label className="text-xs">上下文窗口（tokens）</Label>
        <Input
          className="h-9 text-sm"
          type="number"
          placeholder="如：128000、200000、1000000"
          value={value.contextWindow ?? ""}
          onChange={(e) => onChange({ ...value, contextWindow: e.target.value ? Number(e.target.value) : undefined })}
        />
        <p className="text-muted-foreground text-xs">请查阅模型文档填写，用于动态计算压缩策略</p>
      </div>
    </div>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 加载设置
  useEffect(() => {
    workspaceFetch("/api/settings")
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data) {
          setSettings(json.data);
        }
      })
      .catch(() => toast.error("加载设置失败"))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // 保存时如果 apiKey 包含 ***（脱敏），不提交，保持原值
      const toSave = { ...settings };
      const res = await workspaceFetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toSave),
      });
      const json = await res.json();
      if (json.success) {
        toast.success("设置已保存");
        refreshCompressionConfig(); // 刷新压缩配置缓存
      } else {
        toast.error(json.error || "保存失败");
      }
    } catch {
      toast.error("保存失败");
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const handleReset = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    toast.info("已恢复默认值，点击保存生效");
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="font-semibold text-sm">⚙️ 模型设置</span>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer text-muted-foreground text-xs hover:text-foreground"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-6 overflow-y-auto p-4">
        <ModelConfigSection
          title="创作工具模型"
          icon="📝"
          description="用于书名、脑洞、大纲、细纲、人设、世界观等 10 个创作工具"
          value={settings.creationTool}
          onChange={(config) => setSettings((s) => ({ ...s, creationTool: config }))}
        />

        <ModelConfigSection
          title="对话写作模型"
          icon="💬"
          description="用于中栏对话区的写作 Agent（章节生成、修改、对话）"
          value={settings.chatAgent}
          onChange={(config) => setSettings((s) => ({ ...s, chatAgent: config }))}
        />

        <ModelConfigSection
          title="封面生成模型"
          icon="🖼️"
          description="用于 AI 封面图片生成"
          value={settings.coverGeneration}
          onChange={(config) => setSettings((s) => ({ ...s, coverGeneration: config }))}
          showImageModels
        />

        <ModelConfigSection
          title="Pi 项目 Agent"
          icon="π"
          description="仅供 Pi 使用，负责跨文件理解、项目整理、审查和经你批准后的文件修改"
          value={settings.piAgent}
          onChange={(config) => setSettings((s) => ({ ...s, piAgent: config }))}
        />

        <section className="rounded-xl border bg-muted/20 p-4">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <ShieldCheck className="size-4 text-emerald-600" />
            数据与权限边界
          </div>
          <div className="mt-3 space-y-3 text-muted-foreground text-xs leading-5">
            <div className="flex gap-2">
              <HardDrive className="mt-0.5 size-3.5 shrink-0" />
              <p>小说正文、设定、会话草稿与模型配置保存在本机。API Key 在界面中脱敏显示，不会写入小说正文或提示词。</p>
            </div>
            <p>
              调用模型时，只会把当前功能所需的文件树内容与本次输入发送给你配置的模型服务商；封面、功能区、写作会话和 Pi
              使用彼此独立的模型路由。
            </p>
            <p>
              Pi 默认只能读取当前作品。修改作品文件需要逐项确认；修改应用源码属于最高权限，并要求单独授权和可回滚提案。
            </p>
          </div>
        </section>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 gap-2 border-t p-4">
        <Button variant="outline" size="sm" onClick={handleReset} className="flex-1">
          <RotateCcw className="mr-1.5 size-3.5" />
          恢复默认
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving} className="flex-1">
          {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Save className="mr-1.5 size-3.5" />}
          保存设置
        </Button>
      </div>
    </div>
  );
}
