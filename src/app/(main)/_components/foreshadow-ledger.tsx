"use client";

import { useCallback, useEffect, useState } from "react";

import { Ban, Bookmark, BookmarkCheck, ChevronDown, ChevronRight, Plus } from "lucide-react";

import type { NovelForeshadow } from "@/lib/ai/storage-types";
import { workspaceFetch } from "@/lib/workspaces/client";
import { useForeshadowStore } from "@/stores/foreshadows/foreshadow-store";

const STATE_OPTIONS: Array<{ value: NovelForeshadow["state"]; label: string; color: string }> = [
  { value: "planted", label: "埋下", color: "bg-blue-500/15 text-blue-600" },
  { value: "activated", label: "激活", color: "bg-yellow-500/15 text-yellow-600" },
  { value: "resolved", label: "回收", color: "bg-green-500/15 text-green-600" },
  { value: "abandoned", label: "废弃", color: "bg-muted text-muted-foreground" },
];

interface Props {
  novelId: string | null;
  onClose?: () => void;
}

export function ForeshadowLedger({ novelId, onClose }: Props) {
  const { items, loading, setNovel, load, create, update, remove } = useForeshadowStore();
  const [editing, setEditing] = useState<Partial<NovelForeshadow> | null>(null);

  useEffect(() => {
    setNovel(novelId);
    if (novelId) {
      load(novelId);
    }
  }, [novelId, setNovel, load]);

  const handleSubmit = useCallback(async () => {
    if (!editing) return;
    if (editing.id) {
      await update(editing.id, editing);
    } else {
      await create(editing as Omit<NovelForeshadow, "id" | "novel_id">);
    }
    setEditing(null);
  }, [editing, create, update]);

  const planted = items.filter((f) => f.state === "planted");
  const activated = items.filter((f) => f.state === "activated");

  return (
    <div className="flex h-full flex-col border-l">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="font-semibold text-sm">伏笔账本</span>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              if (!novelId) return;
              const text = prompt("粘贴要扫描的文本(可选, 留空则用最近 AI 回复)");
              if (text === null) return;
              const mode = prompt("模式: scan(扫描) / suggest(建议) / resolve(回收)", "scan") as
                | "scan"
                | "suggest"
                | "resolve";
              if (!["scan", "suggest", "resolve"].includes(mode)) return;
              try {
                const res = await workspaceFetch("/api/foreshadows/scan", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ text: text || "", novelId, mode }),
                });
                const json = await res.json();
                if (json.success) {
                  load(novelId);
                  alert(`伏笔${mode}完成`);
                }
              } catch (e) {
                alert(`扫描失败: ${e instanceof Error ? e.message : "未知错误"}`);
              }
            }}
            className="flex cursor-pointer items-center gap-1 text-blue-500 text-xs hover:text-blue-400"
            title="AI 扫描伏笔"
          >
            <Bookmark size={14} /> AI 扫描
          </button>
          <button
            onClick={() =>
              setEditing({
                description: "",
                state: "planted",
                plant_chapter: undefined,
                target_resolve_chapter: undefined,
              })
            }
            className="flex cursor-pointer items-center gap-1 text-[#2D9F5A] text-xs hover:text-[#2D9F5A]/80"
          >
            <Plus size={14} /> 新增
          </button>
          {onClose && (
            <button onClick={onClose} className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
              关闭
            </button>
          )}
        </div>
      </div>

      <div className="flex shrink-0 gap-3 border-b px-3 py-2 text-[10px] text-muted-foreground">
        <span>埋下 {planted.length}</span>
        <span>待收 {activated.length}</span>
        <span>共计 {items.length}</span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {loading && <div className="animate-pulse text-muted-foreground text-xs">加载中...</div>}
        {!loading && items.length === 0 && (
          <div className="text-muted-foreground/50 text-xs italic">
            暂无伏笔. 可通过 &quot;扫描伏笔&quot; 按钮自动识别.
          </div>
        )}

        {items.map((fs) => (
          <FsRow
            key={fs.id}
            fs={fs}
            onEdit={() => setEditing(fs)}
            onDelete={() => fs.id && remove(fs.id)}
            onUpdate={update}
          />
        ))}

        {editing && (
          <div className="mt-3 space-y-2 rounded-lg border bg-card p-3">
            <textarea
              autoFocus
              value={editing.description || ""}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              placeholder="伏笔描述"
              rows={2}
              className="w-full resize-none rounded border bg-transparent px-2 py-1 text-xs"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                value={editing.plant_chapter ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, plant_chapter: e.target.value ? parseInt(e.target.value, 10) : undefined })
                }
                placeholder="埋章"
                className="rounded border bg-transparent px-2 py-1 text-xs"
              />
              <input
                type="number"
                value={editing.target_resolve_chapter ?? ""}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    target_resolve_chapter: e.target.value ? parseInt(e.target.value, 10) : undefined,
                  })
                }
                placeholder="预收章"
                className="rounded border bg-transparent px-2 py-1 text-xs"
              />
            </div>
            <div className="flex gap-1">
              {STATE_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setEditing({ ...editing, state: s.value })}
                  className={`cursor-pointer rounded px-2 py-0.5 text-[10px] ${
                    (editing.state || "planted") === s.value ? s.color : "bg-muted/50 text-muted-foreground"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSubmit}
                className="cursor-pointer rounded bg-[#2D9F5A] px-3 py-1 text-white text-xs hover:bg-[#238B4A]"
              >
                {editing.id ? "保存" : "创建"}
              </button>
              <button onClick={() => setEditing(null)} className="cursor-pointer rounded border px-3 py-1 text-xs">
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FsRow({
  fs,
  onEdit,
  onDelete,
  onUpdate,
}: {
  fs: NovelForeshadow;
  onEdit: () => void;
  onDelete: () => void;
  onUpdate: (id: string, patch: Partial<NovelForeshadow>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  const Icon =
    fs.state === "resolved"
      ? BookmarkCheck
      : fs.state === "activated"
        ? Bookmark
        : fs.state === "abandoned"
          ? Ban
          : Bookmark;
  const stateColor = STATE_OPTIONS.find((s) => s.value === fs.state)?.color || "";

  return (
    <div className="rounded-md border">
      <div
        className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/50"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={12} className="text-[#2D9F5A]" />
        <span className="flex-1 truncate">{fs.description}</span>
        <span className={`rounded px-1 text-[9px] ${stateColor}`}>
          {STATE_OPTIONS.find((s) => s.value === fs.state)?.label || fs.state}
        </span>
      </div>
      {open && (
        <div className="space-y-1 border-t px-3 pt-1 pb-2">
          <div className="flex gap-3 text-[10px] text-muted-foreground">
            {fs.plant_chapter ? <span>埋:第 {fs.plant_chapter} 章</span> : <span>埋:未标</span>}
            {fs.target_resolve_chapter ? <span>预收:第 {fs.target_resolve_chapter} 章</span> : null}
            {fs.actual_resolve_chapter ? <span>实收:第 {fs.actual_resolve_chapter} 章</span> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {fs.state !== "activated" && (
              <button
                onClick={() => fs.id && onUpdate(fs.id, { state: "activated" })}
                className="cursor-pointer text-[10px] text-yellow-600 hover:text-yellow-700"
              >
                激活
              </button>
            )}
            {fs.state !== "resolved" && (
              <button
                onClick={() =>
                  fs.id && onUpdate(fs.id, { state: "resolved", actual_resolve_chapter: fs.actual_resolve_chapter })
                }
                className="cursor-pointer text-[10px] text-green-600 hover:text-green-700"
              >
                回收
              </button>
            )}
            <button onClick={onEdit} className="cursor-pointer text-[#2D9F5A] text-[10px] hover:text-[#238B4A]">
              编辑
            </button>
            <button onClick={onDelete} className="cursor-pointer text-[10px] text-red-500 hover:text-red-600">
              删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
