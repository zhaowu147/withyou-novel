/**
 * AI拆书面板 — 分析用户上传的小说
 *
 * 对标星月写作的"拆书"功能
 * 核心逻辑：用户上传文件 → 解析章节 → 选择章节 → 拆书分析
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AlertCircle, BookOpen, Clock, FileText, Loader2, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type AnalysisHistoryEntry,
  addHistory,
  clearHistory,
  deleteHistory,
  getAllHistory,
} from "@/lib/ai/analysis-history";
import { readableApiError, workspaceFetch } from "@/lib/workspaces/client";

interface BookAnalysisPanelProps {
  onClose: () => void;
}

// ─── 预设拆书提示词模板 ───

const ANALYSIS_PRESETS = [
  {
    id: 877,
    name: "网文优化",
    prompt:
      "你作为一名资深网文大神作家，本文作为网文小说而言，有不少缺点。 从角色刻画，情节设定，节奏把控等分析全文。 请你列出具体需要修改片段或者段落，予以修改，让本文成为更优秀的网文。",
  },
  {
    id: 878,
    name: "结构分析",
    prompt:
      "分析这部小说的整体结构，包括：\n1. 三幕结构或起承转合\n2. 主要情节节点\n3. 节奏把控（紧凑/舒缓）\n4. 结构优缺点",
  },
  {
    id: 879,
    name: "人物分析",
    prompt:
      "分析这部小说的人物塑造，包括：\n1. 主要人物的性格特点\n2. 人物关系网络\n3. 人物成长弧线\n4. 人物塑造的亮点和不足",
  },
  {
    id: 880,
    name: "伏笔分析",
    prompt: "分析这部小说的伏笔运用，包括：\n1. 已埋伏笔清单\n2. 伏笔回收情况\n3. 伏笔埋设技巧\n4. 未回收的伏笔",
  },
  {
    id: 881,
    name: "钩子分析",
    prompt: "分析这部小说的钩子设计，包括：\n1. 开篇钩子\n2. 章末钩子\n3. 悬念设置\n4. 读者留存技巧",
  },
  {
    id: 882,
    name: "文风分析",
    prompt: "分析这部小说的写作风格，包括：\n1. 叙述视角\n2. 语言特点\n3. 对话风格\n4. 场景描写技巧",
  },
];

// ─── 章节解析 ───

interface ParsedChapter {
  number: number;
  title: string;
  content: string;
  wordCount: number;
}

function parseChapters(text: string): ParsedChapter[] {
  const chapters: ParsedChapter[] = [];

  // 匹配常见的章节格式
  const patterns = [
    /^第[一二三四五六七八九十百千\d]+章\s*.*/gm,
    /^第\d+章\s*.*/gm,
    /^Chapter\s+\d+.*/gim,
    /^第[一二三四五六七八九十百千\d]+节\s*.*/gm,
  ];

  const chapterPositions: Array<{ start: number; title: string; number: number }> = [];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const title = match[0].trim();
      // 提取章节号
      const numMatch = title.match(/第([一二三四五六七八九十百千\d]+)章/);
      let number = chapterPositions.length + 1;
      if (numMatch) {
        const numStr = numMatch[1];
        // 简单转换中文数字
        const chineseNums: Record<string, number> = {
          一: 1,
          二: 2,
          三: 3,
          四: 4,
          五: 5,
          六: 6,
          七: 7,
          八: 8,
          九: 9,
          十: 10,
          十一: 11,
          十二: 12,
          十三: 13,
          十四: 14,
          十五: 15,
          十六: 16,
          十七: 17,
          十八: 18,
          十九: 19,
          二十: 20,
          二十一: 21,
          二十二: 22,
          二十三: 23,
          二十四: 24,
          二十五: 25,
          二十六: 26,
          二十七: 27,
          二十八: 28,
          二十九: 29,
          三十: 30,
        };
        number = chineseNums[numStr] || parseInt(numStr, 10) || number;
      }
      chapterPositions.push({ start: match.index, title, number });
    }
    if (chapterPositions.length > 0) break;
  }

  // 按位置排序
  chapterPositions.sort((a, b) => a.start - b.start);

  // 提取每章内容
  for (let i = 0; i < chapterPositions.length; i++) {
    const start = chapterPositions[i].start;
    const end = i + 1 < chapterPositions.length ? chapterPositions[i + 1].start : text.length;
    const content = text.slice(start, end).trim();
    const wordCount = content.replace(/\s/g, "").length;

    chapters.push({
      number: chapterPositions[i].number,
      title: chapterPositions[i].title,
      content,
      wordCount,
    });
  }

  return chapters;
}

// ─── 主组件 ───

export function BookAnalysisPanel({ onClose }: BookAnalysisPanelProps) {
  // 文件状态
  const [fileName, setFileName] = useState<string | null>(null);
  const [chapters, setChapters] = useState<ParsedChapter[]>([]);
  const [selectedChapters, setSelectedChapters] = useState<number[]>([]);
  const [parsing, setParsing] = useState(false);

  // 拆书配置
  const [selectedPreset, setSelectedPreset] = useState<number>(877);
  const [customPrompt, setCustomPrompt] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [extra, setExtra] = useState("");
  const [mode, setMode] = useState<"merge" | "split">("merge");

  // 结果状态
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 历史记录
  const [activeTab, setActiveTab] = useState<"analysis" | "history">("analysis");
  const [history, setHistory] = useState<AnalysisHistoryEntry[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<string | null>(null);

  // 加载历史
  useEffect(() => {
    setHistory(getAllHistory());
  }, []);

  // ─── 文件上传处理 ───

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 检查文件类型
    if (!file.name.endsWith(".txt") && !file.name.endsWith(".md")) {
      toast.error("仅支持 .txt 或 .md 文件");
      return;
    }

    setParsing(true);
    setFileName(file.name);
    setResult(null);
    setError(null);

    try {
      const text = await file.text();
      const parsed = parseChapters(text);

      if (parsed.length === 0) {
        // 没有识别到章节，把整个文件当作一章
        setChapters([
          {
            number: 1,
            title: file.name.replace(/\.\w+$/, ""),
            content: text,
            wordCount: text.replace(/\s/g, "").length,
          },
        ]);
      } else {
        setChapters(parsed);
      }

      toast.success(`解析完成，共 ${parsed.length || 1} 章`);
    } catch {
      toast.error("文件解析失败");
    } finally {
      setParsing(false);
    }
  }, []);

  // ─── 章节选择 ───

  const toggleChapter = (num: number) => {
    setSelectedChapters((prev) => {
      if (prev.includes(num)) {
        return prev.filter((n) => n !== num);
      }
      if (prev.length >= 30) {
        toast.warning("最多选择30个章节");
        return prev;
      }
      return [...prev, num];
    });
  };

  const selectAll = () => {
    const maxChapters = chapters.slice(0, 30);
    setSelectedChapters(maxChapters.map((c) => c.number));
  };

  const selectFirst = (count: number) => {
    const selected = chapters.slice(0, Math.min(count, 30));
    setSelectedChapters(selected.map((c) => c.number));
  };

  const resetSelection = () => {
    setSelectedChapters([]);
  };

  // ─── 发起拆书 ───

  const handleAnalyze = useCallback(async () => {
    if (chapters.length === 0) {
      toast.error("请先上传小说文件");
      return;
    }

    if (selectedChapters.length === 0) {
      toast.error("请选择要分析的章节");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 获取选中章节的内容
      const selectedContent = chapters
        .filter((c) => selectedChapters.includes(c.number))
        .map((c) => `## ${c.title}\n${c.content}`)
        .join("\n\n---\n\n");

      const totalWords = chapters
        .filter((c) => selectedChapters.includes(c.number))
        .reduce((sum, c) => sum + c.wordCount, 0);

      // 获取提示词
      const prompt = useCustom
        ? customPrompt.trim()
        : ANALYSIS_PRESETS.find((p) => p.id === selectedPreset)?.prompt || "";

      if (!prompt) {
        toast.error("请输入拆书要求");
        setLoading(false);
        return;
      }

      // 拆书使用独立分析通道，不绑定当前小说、会话或文件树。
      const res = await workspaceFetch("/api/book-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: selectedContent,
          analysisPrompt: prompt,
          extra,
          mode,
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(await readableApiError(res, "拆书分析失败"));
      const json = (await res.json()) as { success?: boolean; data?: { result?: string } };
      const content = json.data?.result?.trim() ?? "";
      if (!content) throw new Error("模型没有返回拆书结果");

      setResult(content);

      // 保存到历史记录
      const presetName = useCustom ? "自定义" : ANALYSIS_PRESETS.find((p) => p.id === selectedPreset)?.name || "未知";

      addHistory({
        fileName: fileName || "未知文件",
        selectedChapters,
        presetName,
        customPrompt: useCustom ? customPrompt : "",
        extra,
        mode,
        result: content,
        wordCount: totalWords,
      });
      setHistory(getAllHistory());

      toast.success("拆书完成");
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return;
      const msg = e instanceof Error ? e.message : "请求失败";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [chapters, selectedChapters, useCustom, customPrompt, selectedPreset, extra, fileName, mode]);

  // ─── 选中的总字数 ───

  const selectedWordCount = chapters
    .filter((c) => selectedChapters.includes(c.number))
    .reduce((sum, c) => sum + c.wordCount, 0);

  // ─── 渲染 ───

  // ─── 查看历史详情 ───

  const viewHistory = (entry: AnalysisHistoryEntry) => {
    setSelectedHistory(entry.id);
    setResult(entry.result);
    setActiveTab("analysis");
  };

  // ─── 删除历史 ───

  const handleDeleteHistory = (id: string) => {
    deleteHistory(id);
    setHistory(getAllHistory());
    if (selectedHistory === id) {
      setSelectedHistory(null);
      setResult(null);
    }
    toast.success("已删除");
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b p-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5" />
          <h2 className="font-semibold">AI拆书</h2>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 border-b">
        <button
          className={`flex-1 py-2 font-medium text-sm transition-colors ${
            activeTab === "analysis"
              ? "border-primary border-b-2 text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("analysis")}
        >
          拆书
        </button>
        <button
          className={`relative flex-1 py-2 font-medium text-sm transition-colors ${
            activeTab === "history"
              ? "border-primary border-b-2 text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("history")}
        >
          历史
          {history.length > 0 && <span className="ml-1 rounded-full bg-muted px-1.5 text-xs">{history.length}</span>}
        </button>
      </div>

      {/* Content */}
      {activeTab === "analysis" && (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {/* 文件上传 */}
          <div>
            <input ref={fileInputRef} type="file" accept=".txt,.md" className="hidden" onChange={handleFileUpload} />
            <Button
              variant="outline"
              className="w-full"
              disabled={parsing}
              onClick={() => fileInputRef.current?.click()}
            >
              {parsing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {fileName || "上传小说文件 (.txt / .md)"}
            </Button>
          </div>

          {/* 章节选择 */}
          {chapters.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-sm">
                  共 {chapters.length} 章，已选 {selectedChapters.length} 章（最多30章）
                </p>
                <span className="text-muted-foreground text-xs">{selectedWordCount.toLocaleString()} 字</span>
              </div>

              {/* 快捷选择 */}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => selectFirst(5)}>
                  前5章
                </Button>
                <Button variant="outline" size="sm" onClick={() => selectFirst(10)}>
                  前10章
                </Button>
                <Button variant="outline" size="sm" onClick={selectAll}>
                  全选
                </Button>
                <Button variant="outline" size="sm" onClick={resetSelection}>
                  重置
                </Button>
              </div>

              {/* 章节列表 */}
              <div className="max-h-48 overflow-y-auto rounded-lg border">
                {chapters.map((ch, index) => (
                  <label
                    key={`${ch.number}-${index}-${ch.title}`}
                    className={`flex cursor-pointer items-center gap-2 p-2 hover:bg-muted ${
                      selectedChapters.includes(ch.number) ? "bg-muted" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedChapters.includes(ch.number)}
                      onChange={() => toggleChapter(ch.number)}
                      className="rounded"
                    />
                    <span className="flex-1 text-sm">{ch.title}</span>
                    <span className="text-muted-foreground text-xs">{ch.wordCount.toLocaleString()}字</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 拆书要求 */}
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">拆书要求</p>

            {/* Tab 切换 */}
            <div className="flex gap-2">
              <Button variant={!useCustom ? "default" : "outline"} size="sm" onClick={() => setUseCustom(false)}>
                快捷选项
              </Button>
              <Button variant={useCustom ? "default" : "outline"} size="sm" onClick={() => setUseCustom(true)}>
                自定义
              </Button>
            </div>

            {/* 快捷选项 */}
            {!useCustom && (
              <select
                className="w-full rounded-lg border p-2 text-sm"
                value={selectedPreset}
                onChange={(e) => setSelectedPreset(Number(e.target.value))}
              >
                {ANALYSIS_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}

            {/* 自定义提示词 */}
            {useCustom && (
              <Textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="输入你想要的分析角度..."
                rows={4}
              />
            )}
          </div>

          {/* 补充信息 */}
          <div>
            <p className="mb-1 text-muted-foreground text-sm">补充信息（可选）</p>
            <Textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value.slice(0, 500))}
              placeholder="添加任何有助于拆书的补充信息..."
              rows={2}
            />
            <p className="mt-1 text-right text-muted-foreground text-xs">{extra.length} / 500</p>
          </div>

          {/* 模式选择 */}
          <div>
            <p className="mb-1 text-muted-foreground text-sm">分析模式</p>
            <div className="flex gap-2">
              <Button
                variant={mode === "merge" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setMode("merge")}
              >
                合并拆
              </Button>
              <Button
                variant={mode === "split" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setMode("split")}
              >
                分章拆
              </Button>
            </div>
          </div>

          {/* 开始分析 */}
          <Button
            className="w-full"
            disabled={loading || chapters.length === 0 || selectedChapters.length === 0}
            onClick={handleAnalyze}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                分析中...
              </>
            ) : (
              <>
                <FileText className="mr-2 h-4 w-4" />
                开始拆书
              </>
            )}
          </Button>

          {/* 错误提示 */}
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-destructive text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* 分析结果 */}
          {result && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="font-medium text-sm">分析结果</p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(result);
                    toast.success("已复制");
                  }}
                >
                  复制
                </Button>
              </div>
              <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm leading-relaxed">
                {result}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── 历史记录 Tab ─── */}
      {activeTab === "history" && (
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {history.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              <Clock className="mx-auto mb-2 h-8 w-8 opacity-50" />
              <p className="text-sm">暂无历史记录</p>
            </div>
          ) : (
            <>
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => {
                    clearHistory();
                    setHistory([]);
                    setSelectedHistory(null);
                    setResult(null);
                    toast.success("已清空");
                  }}
                >
                  清空
                </Button>
              </div>
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                    selectedHistory === entry.id ? "border-primary bg-primary/5" : "hover:bg-muted"
                  }`}
                  onClick={() => viewHistory(entry)}
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-sm">{entry.fileName}</p>
                      <p className="mt-1 text-muted-foreground text-xs">
                        {entry.presetName} · {entry.mode === "merge" ? "合并拆" : "分章拆"}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {entry.selectedChapters.length}章 · {entry.wordCount.toLocaleString()}字 ·{" "}
                        {new Date(entry.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteHistory(entry.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                  {/* 预览 */}
                  <p className="mt-2 line-clamp-2 text-muted-foreground text-xs">{entry.result.slice(0, 150)}...</p>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default BookAnalysisPanel;
