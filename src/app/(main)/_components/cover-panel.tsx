"use client";

import { useCallback, useRef, useState } from "react";

import { AlertCircle, Download, ImageIcon, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { uploadImage, validateFile } from "@/lib/upload/client";
import { workspaceFetch } from "@/lib/workspaces/client";

const MAX_PROMPT_LENGTH = 2000;

interface CoverPanelProps {
  onClose: () => void;
}

type CoverMeta = {
  size?: string;
  ratio?: string;
  genre?: string;
  sceneHint?: string;
  expanded?: boolean;
};

export function CoverPanel({ onClose }: CoverPanelProps) {
  const [image, setImage] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [waitSec, setWaitSec] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [meta, setMeta] = useState<CoverMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const waitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const processFile = useCallback(async (file: File) => {
    const err = validateFile(file);
    if (err) {
      toast.error(err.message);
      return;
    }
    const blob = URL.createObjectURL(file);
    setImage(blob);
    setUploading(true);
    try {
      const res = await uploadImage(file);
      setImageUrl(res.url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "上传失败");
      setImage(null);
    }
    setUploading(false);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void processFile(file); // 内部自带 try/catch，此处有意不等待
      e.target.value = "";
    },
    [processFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void processFile(file); // 内部自带 try/catch，此处有意不等待
    },
    [processFile],
  );

  const handleGenerate = async () => {
    if (!prompt.trim() && !imageUrl) {
      toast.error("请上传参考图或填写描述");
      return;
    }
    if (uploading) {
      toast.error("图片正在上传中，请稍候");
      return;
    }

    setLoading(true);
    setWaitSec(0);
    setError(null);
    setResult(null);
    setMeta(null);
    if (waitTimerRef.current) clearInterval(waitTimerRef.current);
    waitTimerRef.current = setInterval(() => setWaitSec((s) => s + 1), 1000);

    try {
      let analysis = "";
      if (imageUrl) {
        try {
          const analyzeRes = await workspaceFetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              imageUrl,
              customPrompt: "分析这张图片的视觉风格、色调、构图、氛围。输出简洁的英文风格关键词（供封面生成复用）。",
            }),
          });
          const analyzeData = await analyzeRes.json();
          if (analyzeData.success && analyzeData.data) {
            analysis =
              typeof analyzeData.data === "string"
                ? analyzeData.data
                : analyzeData.data.raw || JSON.stringify(analyzeData.data);
          }
        } catch {
          console.warn("[cover-panel] image analysis failed, skipping");
        }
      }

      // 短中文 → 服务端 cover-prompt；Agnes 单次常 1–3 分钟
      const res = await workspaceFetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coverBrief: prompt.trim() || "网文封面，有氛围感",
          analysis: analysis || undefined,
          expandPrompt: true,
        }),
      });
      const data = await res.json();
      const payload = data?.data;
      const images = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.images)
          ? payload.images
          : Array.isArray(payload?.data)
            ? payload.data
            : [];
      const url = images[0]?.url as string | undefined;
      if (data.success && url) {
        setResult(url);
        if (payload && !Array.isArray(payload) && payload.meta) {
          setMeta(payload.meta as CoverMeta);
        }
      } else if (data.error) {
        throw new Error(data.error.message || String(data.error));
      } else {
        throw new Error("生成失败：未返回图片 URL");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "请求失败";
      setError(msg);
      toast.error(msg);
    } finally {
      if (waitTimerRef.current) {
        clearInterval(waitTimerRef.current);
        waitTimerRef.current = null;
      }
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!result) return;
    try {
      const res = await fetch(result);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `withyou-cover-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      toast.error("下载失败");
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="font-semibold text-sm">封面生成</span>
        <button onClick={onClose} className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Upload */}
        <div>
          <label className="mb-2 block font-medium text-sm">参考图（可选）</label>
          <div
            className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
              dragOver ? "border-primary bg-primary/10" : "hover:border-primary/50 hover:bg-primary/5"
            }`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleFileChange}
            />
            {image ? (
              <div className="flex flex-col items-center gap-2">
                <img src={image} alt="" className="max-h-24 rounded-lg border object-cover" />
                <p className="text-muted-foreground text-xs">点击更换</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1 text-muted-foreground">
                <Upload className="h-6 w-6" />
                <p className="font-medium text-xs">上传参考图</p>
              </div>
            )}
          </div>
        </div>

        {/* Prompt */}
        <div>
          <label className="mb-2 block font-medium text-sm">封面描述</label>
          <Textarea
            value={prompt}
            onChange={(e) => {
              if (e.target.value.length <= MAX_PROMPT_LENGTH) setPrompt(e.target.value);
            }}
            placeholder={"写题材/卖点即可，不必写英文提示词。例：\n玄幻风格，万族争霸.9:16\n都市重生，夜景天际线 2:3"}
            className="h-24 resize-none text-sm"
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">
            系统会自动扩写专业封面 prompt。比例写在描述里（如 9:16 / 2:3 / 3:4），默认竖版 9:16。
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-2 text-destructive text-sm">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        {/* Generate Button */}
        <Button
          onClick={handleGenerate}
          disabled={loading || uploading || (!prompt.trim() && !imageUrl)}
          className="w-full"
          size="default"
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              生成中 {waitSec}s（通常 1–3 分钟）
            </>
          ) : (
            "生成封面"
          )}
        </Button>
        {loading && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Agnes 队列较慢属正常，请保持页面打开。超时上限约 5 分钟。
          </p>
        )}

        {/* Result — object-contain，不强制正方形裁切 */}
        {result && (
          <div className="space-y-2">
            <div className="flex items-center justify-center overflow-hidden rounded-lg border bg-muted/30">
              <img src={result} alt="Cover" className="mx-auto h-auto max-h-[70vh] w-auto max-w-full object-contain" />
            </div>
            {meta && (
              <p className="text-[11px] text-muted-foreground">
                {[meta.ratio, meta.size, meta.genre, meta.sceneHint].filter(Boolean).join(" · ")}
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={handleDownload}>
                <Download className="h-3.5 w-3.5" />
                下载
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-1.5"
                onClick={handleGenerate}
                disabled={loading}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重做
              </Button>
            </div>
          </div>
        )}

        {/* Empty state hint */}
        {!result && !loading && (
          <div className="flex h-32 items-center justify-center rounded-lg border text-muted-foreground/50">
            <div className="text-center">
              <ImageIcon className="mx-auto mb-2 h-8 w-8 opacity-40" />
              <p className="text-xs">生成的封面将显示在这里</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
