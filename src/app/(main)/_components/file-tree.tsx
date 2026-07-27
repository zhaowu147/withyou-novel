"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ChevronDown, ChevronRight, Download, FileText, Folder, FolderOpen, Hash, Upload } from "lucide-react";
import { toast } from "sonner";

import { FIELD_MAP } from "@/lib/novel/field-map";
import { novelDataChapters } from "@/lib/novel/import-parser";
import { readableApiError, workspaceFetch } from "@/lib/workspaces/client";
import type { NovelData } from "@/types/novel";

interface ChapterInfo {
  number: number;
  title: string;
  path: string;
  wordCount: number;
  updatedAt: string;
}

interface TreeNode {
  name: string;
  children?: TreeNode[];
  onClick?: () => void;
  wordCount?: number;
  hasContent?: boolean;
}

interface FileTreeProps {
  novelName?: string;
  novelId?: string;
  totalChapters?: number;
  onItemClick?: (name: string) => void;
  selectedItem?: string | null;
  novelData?: NovelData;
  onImportClick?: () => void;
}

/** 字数简短显示 */
function w(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface TreeItemProps {
  node: TreeNode;
  depth?: number;
  onItemClick?: (name: string) => void;
  selectedItem?: string | null;
  defaultOpen?: boolean;
}

function TreeItem({ node, depth = 0, onItemClick, selectedItem, defaultOpen = false }: TreeItemProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedItem != null && node.name.startsWith(selectedItem);

  return (
    <div>
      <button
        type="button"
        className={`flex w-full cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm hover:bg-muted ${
          isSelected ? "bg-muted" : ""
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (node.onClick) node.onClick();
          else if (hasChildren) setOpen(!open);
        }}
      >
        {hasChildren ? (
          open ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )
        ) : (
          <FileText
            className={`size-3.5 shrink-0 ${node.hasContent ? "text-[#2D9F5A]" : "text-muted-foreground/40"}`}
          />
        )}
        {hasChildren ? (
          open ? (
            <FolderOpen className="size-3.5 shrink-0 text-[#2D9F5A]" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-[#2D9F5A]" />
          )
        ) : node.wordCount ? (
          <Hash className="size-3 shrink-0 text-muted-foreground/50" />
        ) : null}
        <span className={`truncate ${node.hasContent ? "" : "text-muted-foreground/50"}`}>{node.name}</span>
        {node.hasContent && node.wordCount != null && (
          <span className="ml-auto shrink-0 text-muted-foreground text-xs">{w(node.wordCount)}</span>
        )}
      </button>
      {hasChildren && open && (
        <div>
          {node.children?.map((child) => (
            <TreeItem
              key={child.name}
              node={child}
              depth={depth + 1}
              onItemClick={onItemClick}
              selectedItem={selectedItem}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  novelName = "我的作品",
  novelId,
  totalChapters = 300,
  onItemClick,
  selectedItem,
  novelData,
  onImportClick,
}: FileTreeProps) {
  const [realChapters, setRealChapters] = useState<ChapterInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const exportBackup = useCallback(async () => {
    if (!novelId) return;
    try {
      const response = await workspaceFetch(`/api/novels/${encodeURIComponent(novelId)}/backup`);
      if (!response.ok) throw new Error(await readableApiError(response, "导出备份失败"));
      const payload = await response.json();
      const backup = payload?.data ?? payload;
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${novelName ?? "novel"}-${new Date().toISOString().slice(0, 10)}.withyou.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success("项目备份已导出");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出备份失败");
    }
  }, [novelId, novelName]);

  const restoreBackup = useCallback(
    async (file: File) => {
      if (!novelId) return;
      try {
        const backup = JSON.parse(await file.text());
        if (!window.confirm("恢复会覆盖备份中同名文件。系统会先创建恢复点，是否继续？")) return;
        const response = await workspaceFetch(`/api/novels/${encodeURIComponent(novelId)}/backup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(backup),
        });
        if (!response.ok) throw new Error(await readableApiError(response, "恢复备份失败"));
        toast.success("恢复完成，正在重新载入工作区");
        window.location.reload();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "备份文件无法读取");
      }
    },
    [novelId],
  );

  // 文件树健康状态（已移除 — 文件树数据为用户确认后的权威数据）

  // 加载真实章节数据
  useEffect(() => {
    if (!novelId) {
      setRealChapters([]);
      return;
    }
    let cancelled = false;
    setLoading(true);

    workspaceFetch(`/api/novels/${encodeURIComponent(novelId)}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const project = json?.data ?? json;
        if (Array.isArray(project?.chapters)) {
          setRealChapters(
            project.chapters.map((chapter: { number: number; title: string; content?: string }) => ({
              number: chapter.number,
              title: chapter.title,
              path: "",
              wordCount: (chapter.content || "").replace(/\s/g, "").length,
              updatedAt: "",
            })),
          );
        }
      })
      .catch(() => {
        /* 静默失败 */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [novelId]);

  const visibleChapters = useMemo(() => {
    const merged = new Map<number, ChapterInfo>();
    for (const chapter of realChapters) merged.set(chapter.number, chapter);
    for (const chapter of novelDataChapters(novelData?.chapters ?? {})) {
      merged.set(chapter.number, {
        number: chapter.number,
        title: chapter.title,
        path: "",
        wordCount: chapter.wordCount,
        updatedAt: "",
      });
    }
    return [...merged.values()].sort((a, b) => a.number - b.number);
  }, [novelData?.chapters, realChapters]);

  // 计算哪些 range 有内容(用于自动展开)
  const expandedRangeSet = useCallback(() => {
    const s = new Set<string>();
    for (const ch of visibleChapters) {
      const start = Math.floor((ch.number - 1) / 50) * 50 + 1;
      s.add(`${start}-${Math.min(start + 49, totalChapters)}`);
    }
    return s;
  }, [visibleChapters, totalChapters]);

  const _ranges = expandedRangeSet();

  // 构建章节节点
  const buildChapters = (): TreeNode[] => {
    if (!visibleChapters.length) {
      return [
        {
          name: "尚无章节",
          hasContent: false,
        },
      ];
    }
    const nodes: TreeNode[] = [];
    for (let i = 1; i <= totalChapters; i += 50) {
      const rangeEnd = Math.min(i + 49, totalChapters);
      const rangeName = `${i}-${rangeEnd}`;
      const hasContent = visibleChapters.some((ch) => ch.number >= i && ch.number <= rangeEnd);
      const children: TreeNode[] = [];

      for (let j = i; j <= rangeEnd; j++) {
        const real = visibleChapters.find((ch) => ch.number === j);
        children.push({
          name: real ? `第${j}章 ${real.title}` : `第${j}章`,
          onClick: () => onItemClick?.(`第${j}章`),
          hasContent: !!real,
          wordCount: real?.wordCount,
        });
      }

      nodes.push({
        name: rangeName + (hasContent ? ` ●` : ""),
        children,
        // 标记 range 是否有已保存章节
      });
    }
    return nodes;
  };

  const tree: TreeNode[] = [
    {
      name: novelName,
      children: [
        // 创作节点从 field-map 单一真相源派生（仅含有文件的字段，排除书名）。顺序即 FIELD_MAP 声明顺序。
        ...FIELD_MAP.filter((entry) => entry.filePath).map((entry) => ({
          name: entry.label,
          onClick: () => onItemClick?.(entry.label),
          hasContent: !!novelData?.[entry.field],
        })),
        {
          name: `章节 ${loading ? "(加载…)" : visibleChapters.length ? `[${visibleChapters.length}章有内容]` : "[暂无]"}`,
          children: buildChapters(),
        },
      ],
    },
  ];

  const hasDraftContent = Boolean(
    novelData &&
      (novelData.brainstorm ||
        novelData.outline ||
        novelData.detailedOutline ||
        novelData.characters ||
        novelData.worldview ||
        novelData.goldfinger ||
        novelData.synopsis ||
        novelData.opening ||
        novelData.foreshadowing ||
        Object.keys(novelData.chapters ?? {}).length),
  );

  if (!novelId && !hasDraftContent) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/40">
          <FolderOpen className="size-5 text-muted-foreground" />
        </div>
        <div className="mt-3 font-medium text-sm">这是一个全新工作区</div>
        <p className="mt-1 max-w-52 text-muted-foreground text-xs leading-5">
          生成内容后，文件树会在这里自动建立。也可以导入你已经写好的小说。
        </p>
        {onImportClick && (
          <button
            type="button"
            onClick={onImportClick}
            className="mt-4 flex items-center gap-2 rounded-md border px-3 py-2 font-medium text-xs hover:bg-accent"
          >
            <Upload className="size-3.5" />
            导入已有小说
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto py-3">
      <div className="mx-3 mb-3 border-b pb-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate font-semibold text-sm">{novelName}</div>
          {novelId && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={exportBackup}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="导出项目备份"
              >
                <Download className="size-3.5" />
              </button>
              <label
                className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="从备份恢复"
              >
                <Upload className="size-3.5" />
                <input
                  type="file"
                  accept=".json,.withyou.json,application/json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void restoreBackup(file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {novelId ? `${visibleChapters.length} 个章节 · 本地项目` : "草稿工作区 · 尚未立项"}
        </div>
      </div>
      {onImportClick && (
        <button
          type="button"
          onClick={onImportClick}
          className="mx-2 mb-3 flex w-[calc(100%-1rem)] items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
        >
          <Upload className="size-3.5" />
          导入已有小说
        </button>
      )}
      {tree.map((node) => (
        <TreeItem
          key={node.name}
          node={node}
          onItemClick={onItemClick}
          selectedItem={selectedItem}
          defaultOpen={node.name === novelName}
        />
      ))}
    </div>
  );
}
