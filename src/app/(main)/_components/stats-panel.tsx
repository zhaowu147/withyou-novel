"use client";

import { BarChart3, X } from "lucide-react";

interface StatsPanelProps {
  onClose: () => void;
  totalChapters?: number;
  outline?: string;
  characters?: string;
  worldview?: string;
  chapters?: Record<string, string>;
}

export function StatsPanel({
  onClose,
  totalChapters = 300,
  outline,
  characters,
  worldview,
  chapters = {},
}: StatsPanelProps) {
  const writtenChapters = Object.keys(chapters).length;
  const hasOutline = !!(outline && outline.length > 50);
  const hasCharacters = !!(characters && characters.length > 20);
  const hasWorldview = !!(worldview && worldview.length > 20);
  const completionPercent = totalChapters > 0 ? Math.round((writtenChapters / totalChapters) * 100) : 0;

  // 计算总字数
  let totalWords = 0;
  for (const key of Object.keys(chapters)) {
    try {
      const parsed = JSON.parse(chapters[key]);
      totalWords += (parsed.content || "").length;
    } catch {
      /* skip */
    }
  }

  const avgWords = writtenChapters > 0 ? Math.round(totalWords / writtenChapters) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="flex items-center gap-2 font-semibold text-sm">
          <BarChart3 className="h-4 w-4" />
          写作统计
        </span>
        <button onClick={onClose} className="rounded p-0.5 hover:bg-muted/50">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* 进度 */}
        <div className="space-y-2">
          <div className="font-medium text-muted-foreground text-xs">完成进度</div>
          <div className="flex items-end gap-2">
            <span className="font-bold text-2xl">{writtenChapters}</span>
            <span className="mb-0.5 text-muted-foreground text-sm">/ {totalChapters} 章</span>
            <span className="mb-0.5 ml-auto text-[#2D9F5A] text-sm">{completionPercent}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-[#2D9F5A] transition-all"
              style={{ width: `${Math.max(completionPercent, 1)}%` }}
            />
          </div>
        </div>

        {/* 字数 */}
        <div className="grid grid-cols-2 gap-3">
          <StatsCard label="总字数" value={totalWords.toLocaleString()} />
          <StatsCard label="均章字数" value={avgWords.toLocaleString()} />
        </div>

        {/* 设定状态 */}
        <div className="space-y-2">
          <div className="font-medium text-muted-foreground text-xs">创作准备</div>
          <div className="space-y-1.5">
            <CheckItem label="大纲" done={hasOutline} />
            <CheckItem label="人物设定" done={hasCharacters} />
            <CheckItem label="世界观" done={hasWorldview} />
            <CheckItem label="已有正文" done={writtenChapters > 0} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatsCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/30 p-3">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="mt-1 font-bold text-lg">{value}</div>
    </div>
  );
}

function CheckItem({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <div
        className={`flex h-3.5 w-3.5 items-center justify-center rounded-full ${done ? "bg-[#2D9F5A]" : "bg-muted-foreground/20"}`}
      >
        {done && (
          <svg className="h-2 w-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      <span className={done ? "" : "text-muted-foreground"}>{label}</span>
      <span className="ml-auto text-[10px] text-muted-foreground">{done ? "✓" : "—"}</span>
    </div>
  );
}
