"use client";

import { useCallback, useEffect, useState } from "react";

import { ChevronDown, ChevronRight, MapPin, Package, Plus, RefreshCw, Sparkles, Star, User, Users } from "lucide-react";

import type { NovelEntityCard } from "@/lib/ai/storage-types";
import { workspaceFetch } from "@/lib/workspaces/client";
import { useEntityStore } from "@/stores/entities/entity-store";

const TYPE_OPTIONS: Array<{ value: NovelEntityCard["type"]; label: string }> = [
  { value: "character", label: "角色" },
  { value: "location", label: "地点" },
  { value: "faction", label: "势力" },
  { value: "item", label: "物品" },
  { value: "event", label: "事件" },
  { value: "other", label: "其他" },
];

const STATE_OPTIONS: Array<{ value: NovelEntityCard["active_state"]; label: string }> = [
  { value: "active", label: "活跃" },
  { value: "cooling", label: "冷却" },
  { value: "resolved", label: "回收" },
  { value: "abandoned", label: "废弃" },
];

const IMPORTANCE_STAR: Record<NovelEntityCard["importance"], number> = { high: 3, mid: 2, low: 1 };

interface Props {
  novelId: string | null;
  onClose?: () => void;
}

export function EntityCardManager({ novelId, onClose }: Props) {
  const { cards, loading, setNovel, load, create, update, remove } = useEntityStore();
  const [editing, setEditing] = useState<Partial<NovelEntityCard> | null>(null);
  const [filter, setFilter] = useState<NovelEntityCard["type"] | "all">("all");

  useEffect(() => {
    setNovel(novelId);
    if (novelId) {
      load(novelId);
    }
  }, [novelId, setNovel, load]);

  const filtered = filter === "all" ? cards : cards.filter((c) => c.type === filter);

  const handleSubmit = useCallback(async () => {
    if (!editing) return;
    if (editing.id) {
      await update(editing.id, editing);
    } else {
      await create(editing as Omit<NovelEntityCard, "id" | "novel_id">);
    }
    setEditing(null);
  }, [editing, create, update]);

  return (
    <div className="flex h-full flex-col border-l">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="font-semibold text-sm">实体卡片</span>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              if (!novelId) return;
              const text = prompt("粘贴要识别的文本(可选, 留空则用最近 AI 回复)");
              if (text === null) return;
              try {
                const res = await workspaceFetch("/api/entities/enrich", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ text: text || "", novelId }),
                });
                const json = await res.json();
                if (json.success && json.data?.savedCount > 0) {
                  load(novelId);
                  alert(`已识别并写入 ${json.data.savedCount} 张实体卡`);
                } else {
                  alert("未识别到新实体");
                }
              } catch (e) {
                alert(`识别失败: ${e instanceof Error ? e.message : "未知错误"}`);
              }
            }}
            className="flex cursor-pointer items-center gap-1 text-blue-500 text-xs hover:text-blue-400"
            title="AI 识别实体"
          >
            <Sparkles size={14} /> AI 识别
          </button>
          <button
            onClick={async () => {
              if (!novelId) return;
              const chapter = prompt("当前章节号?");
              if (!chapter) return;
              try {
                const res = await workspaceFetch("/api/entities/lifecycle", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ novel_id: novelId, current_chapter: Number(chapter) }),
                });
                const json = await res.json();
                if (json.success && json.data) {
                  await load(novelId);
                  alert(`生命周期已更新: ${json.data.updated} 个实体状态变更`);
                }
              } catch (e) {
                alert(`更新失败: ${e instanceof Error ? e.message : "未知错误"}`);
              }
            }}
            className="flex cursor-pointer items-center gap-1 text-amber-500 text-xs hover:text-amber-400"
            title="刷新实体生命周期"
          >
            <RefreshCw size={14} /> 生命周期
          </button>
          <button
            onClick={() =>
              setEditing({ name: "", type: "character", importance: "mid", active_state: "active", summary: "" })
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

      <div className="flex shrink-0 flex-wrap gap-1 border-b px-3 py-2">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          全部({cards.length})
        </FilterChip>
        {TYPE_OPTIONS.map((t) => {
          const count = cards.filter((c) => c.type === t.value).length;
          return (
            <FilterChip key={t.value} active={filter === t.value} onClick={() => setFilter(t.value)}>
              {t.label}({count})
            </FilterChip>
          );
        })}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {loading && <div className="animate-pulse text-muted-foreground text-xs">加载中...</div>}
        {!loading && filtered.length === 0 && (
          <div className="text-muted-foreground/50 text-xs italic">
            暂无实体卡. 可通过 &quot;识别实体&quot; 按钮自动从大纲提取, 或手动添加.
          </div>
        )}

        {filtered.map((card) => (
          <EntityRow
            key={card.id}
            card={card}
            onEdit={() => setEditing(card)}
            onDelete={() => card.id && remove(card.id)}
          />
        ))}

        {editing && (
          <div className="mt-3 space-y-2 rounded-lg border bg-card p-3">
            <input
              autoFocus
              value={editing.name || ""}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="名称"
              className="w-full rounded border bg-transparent px-2 py-1 text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={editing.type || "character"}
                onChange={(e) => setEditing({ ...editing, type: e.target.value as NovelEntityCard["type"] })}
                className="rounded border bg-transparent px-2 py-1 text-xs"
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <select
                value={editing.active_state || "active"}
                onChange={(e) =>
                  setEditing({ ...editing, active_state: e.target.value as NovelEntityCard["active_state"] })
                }
                className="rounded border bg-transparent px-2 py-1 text-xs"
              >
                {STATE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1 text-muted-foreground text-xs">
              <Star size={12} />
              {[1, 2, 3].map((i) => (
                <button
                  key={i}
                  onClick={() => setEditing({ ...editing, importance: i === 3 ? "high" : i === 2 ? "mid" : "low" })}
                  className={`cursor-pointer ${
                    IMPORTANCE_STAR[editing.importance || "mid"] >= i ? "text-yellow-500" : "text-muted-foreground/30"
                  }`}
                >
                  ★
                </button>
              ))}
            </div>
            <textarea
              value={editing.summary || ""}
              onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
              placeholder="摘要 / 关键特征 / 动机"
              rows={3}
              className="w-full resize-none rounded border bg-transparent px-2 py-1 text-xs"
            />
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

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`cursor-pointer rounded-full px-2 py-0.5 text-[10px] ${active ? "bg-[#2D9F5A] text-white" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
    >
      {children}
    </button>
  );
}

function EntityRow({ card, onEdit, onDelete }: { card: NovelEntityCard; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const Icon =
    { character: User, location: MapPin, faction: Users, item: Package, event: Sparkles, other: User }[card.type] ||
    User;

  return (
    <div className="rounded-md border">
      <div
        className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/50"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={12} className="text-[#2D9F5A]" />
        <span className="flex-1 truncate font-medium">{card.name}</span>
        <span
          className={`rounded px-1 text-[9px] ${
            card.importance === "high"
              ? "bg-red-500/15 text-red-600"
              : card.importance === "mid"
                ? "bg-yellow-500/15 text-yellow-600"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {card.importance === "high" ? "高" : card.importance === "mid" ? "中" : "低"}
        </span>
        <span
          className={`rounded px-1 text-[9px] ${
            card.active_state === "active" ? "bg-green-500/15 text-green-600" : "bg-muted text-muted-foreground"
          }`}
        >
          {{ active: "活", cooling: "冷", resolved: "收", abandoned: "弃" }[card.active_state]}
        </span>
      </div>
      {open && (
        <div className="space-y-1 border-t px-3 pt-1 pb-2">
          {card.summary && <p className="text-[11px] text-muted-foreground leading-relaxed">{card.summary}</p>}
          <div className="flex gap-2">
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
