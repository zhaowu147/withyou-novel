"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  LibraryBig,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addHistory, getAllHistory, type HistoryEntry } from "@/lib/ai/history";
import { getDynamicToolState } from "@/lib/tools/project-knowledge";
import type { PromptTemplate } from "@/lib/tools/prompt-templates";
import {
  ARTIFACT_LABELS,
  ARTIFACT_PRODUCERS,
  applyArtifactBindings,
  getWorkflowStatus,
  TOOL_WORKFLOWS,
} from "@/lib/tools/workflow";
import { workspaceFetch } from "@/lib/workspaces/client";
import { checkFieldHealth, useFileTreeMetaStore } from "@/stores/file-tree-meta";
import type { ToolId } from "@/stores/session-owner";
import type { NovelData } from "@/types/novel";

/**
 * 轻量 Markdown → JSX 渲染器
 * 支持：# 标题、**粗体**、*斜体*、- 列表、--- 分隔线、表格、代码块
 */
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  let blockKey = 0;
  const nextBlockKey = () => `markdown-block-${blockKey++}`;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 标题 ### / ## / #
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const sizeClass = level === 1 ? "text-lg" : level === 2 ? "text-base" : "text-sm";
      const headingContent = renderInline(headingMatch[2]);
      if (level === 1) {
        elements.push(
          <h2 key={nextBlockKey()} className={`${sizeClass} mt-4 mb-2 font-bold text-foreground`}>
            {headingContent}
          </h2>,
        );
      } else if (level === 2) {
        elements.push(
          <h3 key={nextBlockKey()} className={`${sizeClass} mt-4 mb-2 font-bold text-foreground`}>
            {headingContent}
          </h3>,
        );
      } else if (level === 3) {
        elements.push(
          <h4 key={nextBlockKey()} className={`${sizeClass} mt-4 mb-2 font-bold text-foreground`}>
            {headingContent}
          </h4>,
        );
      } else {
        elements.push(
          <h5 key={nextBlockKey()} className={`${sizeClass} mt-4 mb-2 font-bold text-foreground`}>
            {headingContent}
          </h5>,
        );
      }
      i++;
      continue;
    }

    // 分隔线 ---
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={nextBlockKey()} className="my-3 border-border" />);
      i++;
      continue;
    }

    // 表格（连续的 | 行）
    if (line.trim().startsWith("|") && i + 1 < lines.length && lines[i + 1]?.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]?.trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(renderTable(tableLines, nextBlockKey()));
      continue;
    }

    // 列表 - / * / 数字
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const listItems: string[] = [];
      const isOrdered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        listItems.push(lines[i].replace(/^\s*[-*]\s+/, "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      const ListTag = isOrdered ? "ol" : "ul";
      elements.push(
        <ListTag
          key={nextBlockKey()}
          className={`${isOrdered ? "list-decimal" : "list-disc"} my-2 space-y-1 pl-5 text-sm`}
        >
          {listItems.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // 普通段落（连续非空行合并）
    const paragraphLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^#{1,4}\s/) &&
      !/^---+$/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith("|")
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    elements.push(
      <p key={nextBlockKey()} className="my-1.5 text-sm leading-relaxed">
        {paragraphLines.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {renderInline(l)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return elements;
}

/** 渲染行内格式：**粗体**、*斜体*、`代码` */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let partKey = 0;
  const nextPartKey = (kind: string) => `markdown-inline-${kind}-${partKey++}`;
  const pushText = (value: string) => {
    if (!value) return;
    parts.push(<Fragment key={nextPartKey("text")}>{value}</Fragment>);
  };

  while (remaining.length > 0) {
    // **粗体**
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // *斜体*
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);
    // `代码`
    const codeMatch = remaining.match(/`(.+?)`/);

    // 找最早的匹配
    const matches = [
      boldMatch ? { type: "bold", match: boldMatch } : null,
      italicMatch ? { type: "italic", match: italicMatch } : null,
      codeMatch ? { type: "code", match: codeMatch } : null,
    ]
      .filter(Boolean)
      .sort((a, b) => (a!.match!.index ?? 0) - (b!.match!.index ?? 0));

    if (matches.length === 0) {
      pushText(remaining);
      break;
    }

    const first = matches[0]!;
    const idx = first.match!.index ?? 0;

    if (idx > 0) {
      pushText(remaining.slice(0, idx));
    }

    if (first.type === "bold") {
      parts.push(
        <strong key={nextPartKey("bold")} className="font-semibold">
          {first.match![1]}
        </strong>,
      );
    } else if (first.type === "italic") {
      parts.push(<em key={nextPartKey("italic")}>{first.match![1]}</em>);
    } else if (first.type === "code") {
      parts.push(
        <code key={nextPartKey("code")} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {first.match![1]}
        </code>,
      );
    }

    remaining = remaining.slice(idx + first.match![0].length);
  }

  return parts;
}

/** 渲染 Markdown 表格 */
function renderTable(lines: string[], baseKey: string): React.ReactNode {
  const parseRow = (line: string) =>
    line
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c !== "");

  // 跳过分隔行（|---|---|）
  const headerCells = parseRow(lines[0]);
  const bodyStart = lines[1]?.match(/^\s*\|[\s-:|]+\|\s*$/) ? 2 : 1;
  const bodyLines = lines.slice(bodyStart);

  return (
    <div key={baseKey} className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-border border-b">
            {headerCells.map((cell, j) => (
              <th key={j} className="px-2 py-1.5 text-left font-semibold text-muted-foreground">
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyLines.map((line, j) => {
            const cells = parseRow(line);
            return (
              <tr key={j} className="border-border/50 border-b">
                {cells.map((cell, k) => (
                  <td key={k} className="px-2 py-1.5">
                    {renderInline(cell)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// StepFun API call (no auth)
// 注意：不再往上送 context —— 项目上下文由 /api/generate 自己回读文件树组装
// （见 lib/tools/server-tool-context.ts），前端送什么服务端都不采信。
async function callGenerateAPI(
  toolType: string,
  variables: Record<string, string>,
  novelId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await workspaceFetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolType, variables, novel_id: novelId }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || "请求失败");
  return data.data.result;
}

// AI填充 API 调用
async function callAiFillAPI(
  toolType: string,
  variables: Record<string, string>,
  targetField: string,
  novelId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await workspaceFetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      toolType,
      variables,
      targetField,
      novel_id: novelId,
      action: "ai-fill",
    }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || "请求失败");
  return data.data.result;
}

interface ToolPanelProps {
  template: PromptTemplate;
  novelId?: string;
  novelData: NovelData;
  onClose: () => void;
  onSaveToField: (field: keyof NovelData, value: string, sourceToolId?: ToolId) => void;
  onSelectTool?: (toolId: ToolId) => void;
  /** 将工具输出应用到对话区（工具 Agent 接管中栏会话） */
  onApplyToChat?: (toolId: string, userInput: string, toolOutput: string) => void;
}

// 书名候选数据结构
interface BookCandidate {
  name: string;
  score: number;
  type: string;
  hook: string;
  imagery: string;
  platform: string;
  audience: string;
  risk: string;
  keyword: string;
}

// 脑洞候选数据结构
interface BrainstormCandidate {
  type: string;
  hook: string;
  conflict: string;
  twist: string;
  act1: string;
  risk: string;
  commercial: number;
}

// 角色候选数据结构
interface CharacterCandidate {
  name: string;
  nameReason: string;
  age: number;
  identity: string;
  appearance: string;
  proactivity: number;
  likability: number;
  competence: number;
  ghost: string;
  wound: string;
  lie: string;
  want: string;
  need: string;
  arc: string;
  speechStyle: {
    catchphrase: string;
    exampleDialogues: string[];
  };
  secrets: string[];
  relations: { target: string; relation: string }[];
}

// 通用JSON解析辅助函数
function parseJsonResult<T>(text: string, validator: (item: Record<string, unknown>) => boolean): T[] {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>[];
      if (Array.isArray(parsed) && parsed.length > 0 && validator(parsed[0])) {
        return parsed as T[];
      }
    }
  } catch {
    // JSON 解析失败
  }
  return [];
}

const STRUCTURED_FIELD_LABELS: Record<string, string> = {
  name: "名称",
  score: "评分",
  type: "类型",
  hook: "核心钩子",
  imagery: "画面感",
  platform: "适合平台",
  audience: "目标读者",
  risk: "风险",
  keyword: "关键词",
  conflict: "核心冲突",
  twist: "反套路卖点",
  act1: "第一幕",
  commercial: "商业潜力",
  nameReason: "命名思路",
  age: "年龄",
  identity: "身份",
  appearance: "外貌",
  proactivity: "主动性",
  likability: "好感度",
  competence: "能力值",
  ghost: "内心阴影",
  wound: "创伤",
  lie: "错误信念",
  want: "外在欲望",
  need: "内在需求",
  arc: "人物弧光",
  speechStyle: "说话风格",
  catchphrase: "口头禅",
  exampleDialogues: "示例对白",
  secrets: "秘密",
  relations: "人物关系",
  target: "对象",
  relation: "关系",
};

function structuredLabel(key: string): string {
  return STRUCTURED_FIELD_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function extractStructuredValue(text: string): unknown | null {
  const withoutFence = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const candidates = [withoutFence, withoutFence.match(/\[[\s\S]*\]/)?.[0], withoutFence.match(/\{[\s\S]*\}/)?.[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // 尝试下一个候选片段。
    }
  }
  return null;
}

function formatStructuredLines(value: unknown, indent = ""): string[] {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) {
      return [`${indent}${value.map(String).join("；")}`];
    }
    return value.flatMap((item, index) => [
      `${indent}方案 ${index + 1}`,
      ...formatStructuredLines(item, `${indent}  `),
      "",
    ]);
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, fieldValue]) => {
      const label = structuredLabel(key);
      if (Array.isArray(fieldValue)) {
        if (fieldValue.length === 0) return [];
        if (fieldValue.every((item) => item === null || typeof item !== "object")) {
          return [`${indent}${label}：${fieldValue.map(String).join("；")}`];
        }
        return [
          `${indent}${label}：`,
          ...fieldValue.flatMap((item, index) => [
            `${indent}  （${index + 1}）`,
            ...formatStructuredLines(item, `${indent}    `),
          ]),
        ];
      }
      if (fieldValue && typeof fieldValue === "object") {
        return [`${indent}${label}：`, ...formatStructuredLines(fieldValue, `${indent}  `)];
      }
      if (fieldValue === null || fieldValue === undefined || fieldValue === "") return [];
      return [`${indent}${label}：${String(fieldValue)}`];
    });
  }
  return value === null || value === undefined ? [] : [`${indent}${String(value)}`];
}

/** 将模型为了机器解析返回的 JSON 转为用户可读文本，避免把括号、引号和字段名原样泄漏到界面。 */
function formatToolOutput(text: string): string {
  const structured = extractStructuredValue(text);
  if (structured !== null) {
    return formatStructuredLines(structured)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return text
    .replace(/^```(?:json|markdown|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

// 解析书名候选 → JSON 格式
function parseCandidates(text: string): BookCandidate[] {
  const jsonResult = parseJsonResult<BookCandidate>(text, (item) => !!item.name);
  if (jsonResult.length > 0) {
    return jsonResult.map((item) => ({
      name: String(item.name || ""),
      score: Number(item.score) || 0,
      type: String(item.type || "未知"),
      hook: String(item.hook || ""),
      imagery: String(item.imagery || ""),
      platform: String(item.platform || ""),
      audience: String(item.audience || ""),
      risk: String(item.risk || ""),
      keyword: String(item.keyword || ""),
    }));
  }

  // 旧格式兼容：纯文本解析
  const candidates: BookCandidate[] = [];
  const lines = text.split("\n");
  let current: Partial<BookCandidate> | null = null;
  const flush = () => {
    if (current?.name) {
      candidates.push({
        name: current.name,
        score: Number(current.score) || 0,
        type: current.type || "未知",
        hook: current.hook || "",
        imagery: current.imagery || "",
        platform: current.platform || "",
        audience: current.audience || "",
        risk: current.risk || "",
        keyword: current.keyword || "",
      });
    }
  };
  for (const line of lines) {
    const startMatch = line.match(/^\s*(\d+)\.\s*《(.+?)》\s*(\d+(?:\.\d+)?)\s*分?/);
    if (startMatch) {
      flush();
      current = { name: startMatch[2], score: Number(startMatch[3]) };
      continue;
    }
    if (current) {
      const reasonMatch = line.match(/^\s*(?:↳?\s*理由[:：]\s*)(.+)/);
      if (reasonMatch) {
        current.hook = reasonMatch[1].trim();
        flush();
        current = null;
      }
    }
  }
  flush();
  return candidates;
}

export function ToolPanel({
  template,
  novelId,
  novelData,
  onClose,
  onSaveToField,
  onSelectTool,
  onApplyToChat,
}: ToolPanelProps) {
  const toolId = template.toolType as ToolId;
  const dynamicState = useMemo(() => getDynamicToolState(toolId, novelData), [toolId, novelData]);
  const [variables, setVariables] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const v of template.variableSchema) initial[v.key] = v.default;
    return applyArtifactBindings(toolId, novelData, { ...initial, ...dynamicState.variableDefaults });
  });
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiFilling, setAiFilling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileTreeMeta = useFileTreeMetaStore((state) => state.fields);
  const workflowStatus = useMemo(() => getWorkflowStatus(toolId, novelData), [toolId, novelData]);
  const hasBlockingDependency =
    workflowStatus.missingRequired.length > 0 || workflowStatus.missingRequiredGroups.length > 0;
  const outputField = TOOL_WORKFLOWS[toolId].outputField;
  const outputHealth = outputField ? checkFieldHealth(outputField, fileTreeMeta) : null;

  // 初始加载 + 切换工具时：拉最新历史
  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const variable of template.variableSchema) {
      initial[variable.key] = variable.default;
    }
    setVariables({ ...initial, ...getDynamicToolState(toolId, novelData).variableDefaults });
    setResult(null);
    setError(null);
    setShowHistory(false);
    setSelectedCandidate(null);
    abortRef.current?.abort();
    setHistory(getAllHistory().filter((h) => h.toolType === template.toolType));
  }, [template.toolType, template.variableSchema, toolId]);

  useEffect(() => {
    setVariables((current) =>
      applyArtifactBindings(toolId, novelData, {
        ...dynamicState.variableDefaults,
        ...current,
      }),
    );
  }, [dynamicState.variableDefaults, toolId, novelData]);

  // 候选列表（书名生成器）
  const candidates = template.toolType === "book-name" && result ? parseCandidates(result) : [];
  // 脑洞候选列表
  const brainstormCandidates =
    template.toolType === "brainstorm" && result
      ? parseJsonResult<BrainstormCandidate>(result, (item) => !!item.hook).map((item) => ({
          type: String(item.type || "未知"),
          hook: String(item.hook || ""),
          conflict: String(item.conflict || ""),
          twist: String(item.twist || ""),
          act1: String(item.act1 || ""),
          risk: String(item.risk || ""),
          commercial: Number(item.commercial) || 0,
        }))
      : [];
  // 角色候选列表
  const characterCandidates =
    template.toolType === "character" && result
      ? parseJsonResult<CharacterCandidate>(result, (item) => !!item.name).map((item) => ({
          name: String(item.name || ""),
          nameReason: String(item.nameReason || ""),
          age: Number(item.age) || 0,
          identity: String(item.identity || ""),
          appearance: String(item.appearance || ""),
          proactivity: Number(item.proactivity) || 0,
          likability: Number(item.likability) || 0,
          competence: Number(item.competence) || 0,
          ghost: String(item.ghost || ""),
          wound: String(item.wound || ""),
          lie: String(item.lie || ""),
          want: String(item.want || ""),
          need: String(item.need || ""),
          arc: String(item.arc || ""),
          speechStyle: (item.speechStyle as CharacterCandidate["speechStyle"]) || {
            catchphrase: "",
            exampleDialogues: [],
          },
          secrets: Array.isArray(item.secrets) ? item.secrets.map(String) : [],
          relations: Array.isArray(item.relations) ? (item.relations as CharacterCandidate["relations"]) : [],
        }))
      : [];
  const readableResult = result ? formatToolOutput(result) : "";
  const refinementResult =
    selectedCandidate !== null && brainstormCandidates[selectedCandidate]
      ? formatStructuredLines(brainstormCandidates[selectedCandidate]).join("\n").trim()
      : readableResult;

  const updateVar = useCallback((key: string, value: string) => {
    setVariables((prev) => ({ ...prev, [key]: value }));
  }, []);

  // 从文本提取图谱
  const extractGraphFromText = useCallback(
    async (text: string, action: "from-outline" | "from-detailed-outline") => {
      if (!novelId) return;
      try {
        const res = await workspaceFetch("/api/graph/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ novelId, action, text }),
        });
        const data = await res.json();
        if (data.success) {
          toast.success("图谱已自动更新");
        }
      } catch {
        console.log("图谱提取失败（不影响存入）");
      }
    },
    [novelId],
  );

  // AI填充：基于当前工具的prompt，为指定字段生成建议
  const handleAiFill = useCallback(
    async (targetKey: string) => {
      setAiFilling(targetKey);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await callAiFillAPI(template.toolType, variables, targetKey, novelId, controller.signal);
        // 解析结果并填充到目标字段
        updateVar(targetKey, result);
        toast.success(`已填充「${template.variableSchema.find((v) => v.key === targetKey)?.label}」`);
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : "AI填充失败";
        setError(msg);
        toast.error(msg);
      } finally {
        setAiFilling(null);
      }
    },
    [template, variables, updateVar, novelId],
  );

  const handleGenerate = useCallback(async () => {
    if (hasBlockingDependency) {
      const direct = workflowStatus.missingRequired.map((field) => ARTIFACT_LABELS[field]);
      const groups = workflowStatus.missingRequiredGroups.map((group) =>
        group.map((field) => ARTIFACT_LABELS[field]).join(" 或 "),
      );
      setError(`请先完成：${[...direct, ...groups].join("、")}`);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedCandidate(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const promptText = template.buildUserPrompt(variables);

    try {
      const full = await callGenerateAPI(template.toolType, variables, novelId, controller.signal);
      setResult(full);

      addHistory({
        toolType: template.toolType,
        toolName: template.name,
        variables,
        promptText,
        resultText: full,
        saved: false,
      });
      setHistory(getAllHistory().filter((h) => h.toolType === template.toolType));
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return;
      const msg = e instanceof Error ? e.message : "请求失败";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [hasBlockingDependency, template, variables, novelId, workflowStatus]);

  // 存入文件树
  const handleSaveToFile = useCallback(() => {
    const field = TOOL_WORKFLOWS[toolId].outputField;
    if (!field) {
      toast.error(`${template.name} 没有对应的文件树位置`);
      return;
    }
    let value: string;
    if (template.toolType === "book-name" && selectedCandidate !== null) {
      const cand = candidates[selectedCandidate];
      if (!cand) return;
      value = cand.name;
    } else {
      if (!result) return;
      value = refinementResult;
    }
    onSaveToField(field, value, toolId);
    toast.success(`已${template.toolType === "book-name" ? "选入" : "存入"}文件树「${field}」`);

    // 大纲/细纲存入后自动提取图谱
    if (template.toolType === "outline" || template.toolType === "detailed-outline") {
      void extractGraphFromText(value, template.toolType === "outline" ? "from-outline" : "from-detailed-outline");
    }
  }, [template, toolId, result, refinementResult, selectedCandidate, candidates, onSaveToField, extractGraphFromText]);

  const _handleSave = useCallback(() => {
    toast.success("已保存到历史记录");
    setShowHistory(true);
  }, []);

  const handleClearResult = useCallback(() => {
    setResult(null);
    setError(null);
    setSelectedCandidate(null);
  }, []);

  const hasFileField = outputField !== null;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div>
          <span className="font-semibold text-sm">{template.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (!showHistory) {
                // 每次展开都实时拉最新历史
                setHistory(getAllHistory().filter((h) => h.toolType === template.toolType));
              }
              setShowHistory((p) => !p);
            }}
            className="cursor-pointer text-muted-foreground text-xs hover:text-foreground"
            title="历史记录"
          >
            <Clock className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer text-muted-foreground text-xs hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {showHistory && history.length > 0 ? (
          <HistoryList
            entries={history}
            onClose={() => setShowHistory(false)}
            onApply={(entry) => {
              setResult(entry.resultText);
              setVariables(entry.variables);
              setSelectedCandidate(null);
              setShowHistory(false);
            }}
          />
        ) : (
          <div className="space-y-4 p-4">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">{dynamicState.actionLabel}</span>
                <span className="rounded-full bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
                  {dynamicState.mode === "extract"
                    ? "基于已有正文"
                    : dynamicState.mode === "continue"
                      ? "续写模式"
                      : dynamicState.mode === "check"
                        ? "校准模式"
                        : "创作模式"}
                </span>
              </div>
              <p className="mt-1 text-muted-foreground text-xs">{dynamicState.description}</p>
              {dynamicState.sources.length > 0 && (
                <p className="mt-2 text-[11px] text-primary">检测到：{dynamicState.sources.join("、")}</p>
              )}
            </div>

            <div className="rounded-lg border bg-muted/30 p-3 text-xs">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium">创作依赖</span>
                {outputField && <span className="text-muted-foreground">产出：{ARTIFACT_LABELS[outputField]}</span>}
              </div>

              {hasBlockingDependency ? (
                <div className="flex items-start gap-2 text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <div>
                    <p>生成前必须先完成：</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {workflowStatus.missingRequired.map((field) => {
                        const producer = ARTIFACT_PRODUCERS[field];
                        return (
                          <button
                            key={field}
                            type="button"
                            className="rounded border border-destructive/30 px-2 py-1 hover:bg-destructive/10"
                            onClick={() => producer && onSelectTool?.(producer)}
                            disabled={!producer || !onSelectTool}
                          >
                            {ARTIFACT_LABELS[field]}
                          </button>
                        );
                      })}
                      {workflowStatus.missingRequiredGroups.map((group) => (
                        <span key={group.join("-")} className="rounded border border-destructive/30 px-2 py-1">
                          {group.map((field) => ARTIFACT_LABELS[field]).join(" 或 ")}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-emerald-600">
                  <CheckCircle2 className="size-3.5" />
                  <span>必需的上游内容已就绪</span>
                </div>
              )}

              {workflowStatus.availableContext.length > 0 && (
                <p className="mt-2 text-muted-foreground">
                  本次会自动引用：
                  {workflowStatus.availableContext.map((field) => ARTIFACT_LABELS[field]).join("、")}
                </p>
              )}
              {workflowStatus.missingRecommended.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  建议补充：
                  {workflowStatus.missingRecommended.map((field) => ARTIFACT_LABELS[field]).join("、")}
                </p>
              )}
              {outputHealth?.status === "stale" && (
                <div className="mt-2 flex items-start gap-2 text-amber-600">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    上游内容已变化，现有{outputField ? ARTIFACT_LABELS[outputField] : "结果"}可能需要更新：
                    {outputHealth.staleUpstreams
                      .map((field) => ARTIFACT_LABELS[field as keyof typeof ARTIFACT_LABELS])
                      .join("、")}
                  </span>
                </div>
              )}
            </div>

            {/* Variables */}
            {template.variableSchema.map((v) => (
              <div key={v.key}>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium text-muted-foreground text-xs">{v.label}</span>
                  {v.type !== "select" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => handleAiFill(v.key)}
                      disabled={aiFilling !== null || loading}
                    >
                      {aiFilling === v.key ? (
                        <>
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          生成中
                        </>
                      ) : (
                        <>
                          <Sparkles className="mr-1 h-3 w-3" />
                          AI帮我填
                        </>
                      )}
                    </Button>
                  )}
                </div>
                {v.type === "select" && v.options ? (
                  <div className="flex gap-2">
                    {v.options.map((opt) => (
                      <button
                        type="button"
                        key={opt}
                        onClick={() => updateVar(v.key, opt)}
                        className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-sm transition-all ${
                          variables[v.key] === opt
                            ? "border-primary bg-primary/10 font-medium text-primary"
                            : "border-border bg-background text-muted-foreground hover:border-primary/50"
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                ) : (
                  <Textarea
                    value={variables[v.key] || ""}
                    onChange={(e) => updateVar(v.key, e.target.value)}
                    placeholder={v.placeholder}
                    className="h-16 resize-none text-sm"
                  />
                )}
              </div>
            ))}

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-2 text-destructive text-sm">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                onClick={handleGenerate}
                disabled={loading || aiFilling !== null || hasBlockingDependency}
                className="flex-1"
                size="default"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    生成中...
                  </>
                ) : (
                  dynamicState.actionLabel
                )}
              </Button>
              {result && (
                <Button onClick={handleClearResult} variant="outline" size="default">
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {/* Candidates selector (book-name only) */}
            {candidates.length > 0 && (
              <div className="space-y-3">
                <p className="font-medium text-muted-foreground text-xs">选择你要的书名：</p>
                {candidates.map((cand, i) => (
                  <button
                    type="button"
                    key={i}
                    onClick={() => setSelectedCandidate(i)}
                    className={`w-full cursor-pointer rounded-lg border p-4 text-left transition-all ${
                      selectedCandidate === i
                        ? "border-primary bg-primary/5"
                        : "border-border bg-background hover:border-primary/50"
                    }`}
                  >
                    {/* 书名和评分 */}
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-bold text-base text-foreground">《{cand.name}》</span>
                      <span className="font-bold text-lg text-primary">{cand.score}分</span>
                    </div>

                    {/* 标签 */}
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary text-xs">{cand.type}</span>
                      {cand.platform && (
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground text-xs">
                          {cand.platform}
                        </span>
                      )}
                      {cand.audience && (
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground text-xs">
                          {cand.audience}
                        </span>
                      )}
                    </div>

                    {/* 双维度分析 */}
                    <div className="space-y-1.5 text-xs">
                      {cand.hook && (
                        <div className="flex gap-2">
                          <span className="shrink-0 text-muted-foreground">钩子：</span>
                          <span className="text-foreground">{cand.hook}</span>
                        </div>
                      )}
                      {cand.imagery && (
                        <div className="flex gap-2">
                          <span className="shrink-0 text-muted-foreground">画面：</span>
                          <span className="text-foreground">{cand.imagery}</span>
                        </div>
                      )}
                    </div>

                    {/* 风险提示 */}
                    {cand.risk && (
                      <div className="mt-2 text-xs text-yellow-600 dark:text-yellow-400">风险：{cand.risk}</div>
                    )}

                    {/* 热门关键词 */}
                    {cand.keyword && <div className="mt-2 text-muted-foreground text-xs">关键词：{cand.keyword}</div>}
                  </button>
                ))}
                {selectedCandidate !== null && (
                  <Button onClick={handleSaveToFile} className="w-full" size="default">
                    <LibraryBig className="mr-2 h-4 w-4" />
                    把「《{candidates[selectedCandidate]?.name}》」作为书名存入
                  </Button>
                )}
              </div>
            )}

            {/* 脑洞候选展示 */}
            {brainstormCandidates.length > 0 && (
              <div className="space-y-3">
                <p className="font-medium text-muted-foreground text-xs">选择你要的脑洞：</p>
                {brainstormCandidates.map((cand, i) => (
                  <button
                    type="button"
                    key={i}
                    onClick={() => setSelectedCandidate(i)}
                    className={`w-full cursor-pointer rounded-lg border p-4 text-left transition-all ${
                      selectedCandidate === i
                        ? "border-primary bg-primary/5"
                        : "border-border bg-background hover:border-primary/50"
                    }`}
                  >
                    {/* 类型和商业潜力 */}
                    <div className="mb-2 flex items-center justify-between">
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary text-xs">{cand.type}</span>
                      <span className="font-bold text-primary text-sm">商业潜力 {cand.commercial}/10</span>
                    </div>

                    {/* 钩子 */}
                    <p className="mb-2 font-medium text-foreground text-sm">{cand.hook}</p>

                    {/* 核心冲突 */}
                    <div className="mb-1.5 text-xs">
                      <span className="text-muted-foreground">冲突：</span>
                      <span className="text-foreground">{cand.conflict}</span>
                    </div>

                    {/* 反套路卖点 */}
                    <div className="mb-1.5 text-xs">
                      <span className="text-muted-foreground">反套路：</span>
                      <span className="text-foreground">{cand.twist}</span>
                    </div>

                    {/* 第一幕设想 */}
                    <div className="mb-1.5 text-xs">
                      <span className="text-muted-foreground">第一幕：</span>
                      <span className="text-foreground">{cand.act1}</span>
                    </div>

                    {/* 风险提示 */}
                    {cand.risk && (
                      <div className="mt-2 text-xs text-yellow-600 dark:text-yellow-400">风险：{cand.risk}</div>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* 角色候选展示 */}
            {characterCandidates.length > 0 && (
              <div className="space-y-3">
                <p className="font-medium text-muted-foreground text-xs">生成的角色：</p>
                {characterCandidates.map((char, i) => (
                  <div key={i} className="rounded-lg border border-border bg-background p-4">
                    {/* 名字和身份 */}
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-bold text-base text-foreground">{char.name}</span>
                      <span className="text-muted-foreground text-xs">{char.identity}</span>
                    </div>
                    {/* 命名思路 */}
                    {char.nameReason && <p className="mb-2 text-muted-foreground text-xs">命名：{char.nameReason}</p>}
                    {/* 三滑块 */}
                    <div className="mb-2 flex gap-3">
                      <span className="text-xs">主动 {char.proactivity}</span>
                      <span className="text-xs">好感 {char.likability}</span>
                      <span className="text-xs">能力 {char.competence}</span>
                    </div>
                    {/* 外貌 */}
                    {char.appearance && (
                      <p className="mb-1.5 text-xs">
                        <span className="text-muted-foreground">外貌：</span>
                        {char.appearance}
                      </p>
                    )}
                    {/* Wound/Want/Need */}
                    <div className="mb-2 space-y-1 text-xs">
                      {char.wound && (
                        <p>
                          <span className="text-muted-foreground">伤痛：</span>
                          {char.wound}
                        </p>
                      )}
                      {char.want && (
                        <p>
                          <span className="text-muted-foreground">欲望：</span>
                          {char.want}
                        </p>
                      )}
                      {char.need && (
                        <p>
                          <span className="text-muted-foreground">真相：</span>
                          {char.need}
                        </p>
                      )}
                    </div>
                    {/* 口头禅 */}
                    {char.speechStyle?.catchphrase && (
                      <p className="mb-1.5 text-xs">
                        <span className="text-muted-foreground">口头禅：</span>"{char.speechStyle.catchphrase}"
                      </p>
                    )}
                    {/* 秘密 */}
                    {char.secrets.length > 0 && (
                      <p className="text-xs text-yellow-600 dark:text-yellow-400">秘密：{char.secrets.join("；")}</p>
                    )}
                    {/* 关系 */}
                    {char.relations.length > 0 && (
                      <p className="mt-1 text-muted-foreground text-xs">
                        关系：{char.relations.map((r) => `${r.target}(${r.relation})`).join("、")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 结构化结果展示（non book-name, non brainstorm, non character） */}
            {result &&
              candidates.length === 0 &&
              brainstormCandidates.length === 0 &&
              characterCandidates.length === 0 && (
                <div className="min-h-[120px] rounded-lg border border-border bg-background p-4 shadow-sm">
                  <div className="text-sm leading-relaxed">{renderMarkdown(readableResult)}</div>
                </div>
              )}

            {/* 存入文件树按钮 */}
            {result && candidates.length === 0 && hasFileField && (
              <Button onClick={handleSaveToFile} variant="outline" className="w-full" size="default">
                <LibraryBig className="mr-2 h-4 w-4" />
                存入文件树「{outputField ? ARTIFACT_LABELS[outputField] : ""}」
              </Button>
            )}

            {/* 应用到对话区按钮（有结果且有回调时显示） */}
            {result && candidates.length === 0 && onApplyToChat && (
              <Button
                onClick={() => {
                  const userInput = template.buildUserPrompt(variables);
                  onApplyToChat(template.toolType, userInput, refinementResult);
                }}
                variant="secondary"
                className="w-full"
                size="default"
              >
                <ChevronRight className="mr-2 h-4 w-4" />
                应用到对话区（精修）
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 从结果文本中提取摘要（书名列表或其他）
function extractSummary(text: string): string {
  try {
    // 尝试解析 JSON
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>[];
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name) {
        // 书名列表：提取所有书名
        return parsed.map((item) => `《${item.name}》`).join("、");
      }
    }
  } catch {
    // JSON 解析失败
  }
  // 回退：直接截取前 100 字符
  return text.slice(0, 100);
}

// ---- History List ----

function HistoryList({
  entries,
  onClose,
  onApply,
}: {
  entries: HistoryEntry[];
  onClose: () => void;
  onApply: (entry: HistoryEntry) => void;
}) {
  return (
    <div className="space-y-3 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-muted-foreground text-xs">历史记录</span>
        <button type="button" onClick={onClose} className="text-muted-foreground text-xs hover:text-foreground">
          返回
        </button>
      </div>
      {entries.map((e) => (
        <div key={e.id} className="space-y-2 rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap gap-1">
              {Object.entries(e.variables)
                .filter(([, v]) => v)
                .slice(0, 3)
                .map(([k, v]) => (
                  <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {v}
                  </span>
                ))}
            </div>
            <span className="text-[10px] text-muted-foreground">{new Date(e.createdAt).toLocaleTimeString()}</span>
          </div>
          <p className="line-clamp-2 text-muted-foreground text-xs">{extractSummary(e.resultText)}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onApply(e)}
              className="cursor-pointer text-primary text-xs hover:underline"
            >
              重新应用
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
