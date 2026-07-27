"use client";

import { useRef, useState } from "react";

import { AlertCircle, FileUp, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type ImportedChapter, parseNovelText } from "@/lib/novel/import-parser";

export interface NovelImportRequest {
  title: string;
  fileName: string;
  chapters: ImportedChapter[];
  conflictMode: "append" | "overwrite" | "skip";
  analyze: boolean;
}

interface NovelImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingChapterCount: number;
  onImport: (request: NovelImportRequest) => Promise<void>;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function NovelImportDialog({ open, onOpenChange, existingChapterCount, onImport }: NovelImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [title, setTitle] = useState("");
  const [chapters, setChapters] = useState<ImportedChapter[]>([]);
  const [totalCharacters, setTotalCharacters] = useState(0);
  const [tokenRange, setTokenRange] = useState({ min: 0, max: 0 });
  const [conflictMode, setConflictMode] = useState<NovelImportRequest["conflictMode"]>("append");
  const [analyze, setAnalyze] = useState(false);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setFileName("");
    setTitle("");
    setChapters([]);
    setTotalCharacters(0);
    setTokenRange({ min: 0, max: 0 });
    setAnalyze(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleFile = async (file: File) => {
    if (!/\.(txt|md)$/i.test(file.name)) {
      toast.error("当前支持 TXT 和 Markdown 小说文件");
      return;
    }
    const parsed = parseNovelText(await file.text(), file.name);
    setFileName(file.name);
    setTitle(parsed.title);
    setChapters(parsed.chapters);
    setTotalCharacters(parsed.totalCharacters);
    const analysisCharacters = Math.min(parsed.totalCharacters, 24_000);
    setTokenRange({
      min: Math.ceil(analysisCharacters * 0.7),
      max: Math.ceil(analysisCharacters * 1.2),
    });
    toast.success(`识别到 ${parsed.chapters.length} 个章节`);
  };

  const updateChapter = (index: number, patch: Partial<ImportedChapter>) => {
    setChapters((current) =>
      current.map((chapter, chapterIndex) => (chapterIndex === index ? { ...chapter, ...patch } : chapter)),
    );
  };

  const submit = async () => {
    if (!chapters.length || !title.trim()) return;
    setLoading(true);
    try {
      await onImport({
        title: title.trim(),
        fileName,
        chapters,
        conflictMode,
        analyze,
      });
      onOpenChange(false);
      reset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!loading) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>导入我的小说</DialogTitle>
          <DialogDescription>
            章节切分在本地完成，不消耗 AI。确认导入后，可选择识别人物、势力、地点和主要事件。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <button
            type="button"
            className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-muted-foreground text-sm hover:bg-muted/40"
            onClick={() => inputRef.current?.click()}
          >
            <FileUp className="size-6 text-primary" />
            <span>{fileName || "选择 TXT 或 Markdown 小说文件"}</span>
          </button>

          {chapters.length > 0 && (
            <>
              <div className="grid grid-cols-[1fr_180px] gap-3">
                <div>
                  <label htmlFor="import-book-title" className="mb-1 block font-medium text-muted-foreground text-xs">
                    作品名称
                  </label>
                  <Input id="import-book-title" value={title} onChange={(event) => setTitle(event.target.value)} />
                </div>
                <div>
                  <label
                    htmlFor="import-conflict-mode"
                    className="mb-1 block font-medium text-muted-foreground text-xs"
                  >
                    已有章节冲突时
                  </label>
                  <select
                    id="import-conflict-mode"
                    value={conflictMode}
                    onChange={(event) => setConflictMode(event.target.value as NovelImportRequest["conflictMode"])}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="append">追加到现有章节后</option>
                    <option value="skip">跳过同章节号</option>
                    <option value="overwrite">覆盖同章节号</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-xs">
                <span>
                  识别 {chapters.length} 章，共 {formatNumber(totalCharacters)} 字
                  {existingChapterCount > 0 ? `；项目已有 ${existingChapterCount} 章` : ""}
                </span>
                <span className="text-muted-foreground">章节切分：0 token</span>
              </div>

              <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-2">
                {chapters.map((chapter, index) => (
                  <div
                    key={chapter.sourceHeading || chapter.content.slice(0, 48)}
                    className="grid grid-cols-[74px_1fr_90px] items-center gap-2"
                  >
                    <Input
                      type="number"
                      min={1}
                      value={chapter.number}
                      onChange={(event) => updateChapter(index, { number: Number(event.target.value) || index + 1 })}
                      className="h-8 text-xs"
                      aria-label="章节号"
                    />
                    <Input
                      value={chapter.title}
                      onChange={(event) => updateChapter(index, { title: event.target.value })}
                      className="h-8 text-xs"
                      aria-label="章节标题"
                    />
                    <span className="text-right text-muted-foreground text-xs">
                      {formatNumber(chapter.wordCount)} 字
                    </span>
                  </div>
                ))}
              </div>

              <label htmlFor="import-smart-analysis" className="flex items-start gap-3 rounded-lg border p-3">
                <Checkbox
                  id="import-smart-analysis"
                  checked={analyze}
                  onCheckedChange={(checked) => setAnalyze(checked === true)}
                />
                <span className="space-y-1">
                  <span className="flex items-center gap-1 font-medium text-sm">
                    <Sparkles className="size-3.5 text-primary" />
                    导入后智能识别人物与事件
                  </span>
                  <span className="block text-muted-foreground text-xs">
                    可选，会抽取开头与最近章节，并写入人物卡和故事图谱。本次预计最多约
                    {formatNumber(tokenRange.min)}—{formatNumber(tokenRange.max)} token；实际会受分批与截断策略限制。
                  </span>
                </span>
              </label>

              {conflictMode === "overwrite" && existingChapterCount > 0 && (
                <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 p-2 text-amber-700 text-xs dark:text-amber-300">
                  <AlertCircle className="size-4 shrink-0" />
                  同章节号的已有正文将被新内容覆盖，其他章节不会删除。
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button onClick={submit} disabled={loading || !chapters.length || !title.trim()}>
            {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
            {loading ? (analyze ? "导入并识别中…" : "导入中…") : `导入 ${chapters.length || ""} 章`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
