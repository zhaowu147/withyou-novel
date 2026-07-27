"use client";

import {
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  AlertTriangle,
  Bot,
  ChevronLeft,
  Clock3,
  EyeOff,
  Layers3,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DEFAULT_GRAPH_LAYERS, GRAPH_LAYER_REGISTRY, graphLayerForNodeType } from "@/lib/graph/layers";
import { workspaceFetch } from "@/lib/workspaces/client";
import type { GraphEdge, GraphLayerKey, GraphNode, GraphStage, NodeType, StoryEvent, StoryGraph } from "@/types/graph";
import { NODE_TYPE_CONFIG } from "@/types/graph";

interface StoryGraph3DProps {
  novelId: string;
  onClose: () => void;
  onSave?: (graph: StoryGraph) => void;
}

type LayerMode = "relations" | "events";
type CreateMode = "node" | "stage" | "event" | null;

interface AtlasNodeData extends Record<string, unknown> {
  kind: NodeType | "story-event";
  label: string;
  description: string;
  source: string;
  chapter?: number;
  reviewStatus: string;
  freshness: string;
  hidden: boolean;
  evidenceCount: number;
  foreshadowCount: number;
}

interface ContinentData extends Record<string, unknown> {
  kind: "continent";
  label: string;
  color: string;
  shape: string;
}

type StoryFlowData = AtlasNodeData | ContinentData;
type StoryFlowNode = Node<StoryFlowData>;
interface GraphRecoveryPoint {
  index: number;
  updatedAt: string;
  revision: number;
}

const PLANET_COLORS = ["#2d7d6a", "#b27a35", "#6d62aa", "#397698", "#9a565e", "#618247", "#8b6538"];
const CONTINENTS = [
  {
    x: -1320,
    y: -650,
    width: 820,
    height: 560,
    shape: "polygon(6% 38%,18% 12%,41% 5%,61% 18%,91% 11%,96% 45%,81% 71%,54% 66%,31% 94%,9% 78%)",
  },
  {
    x: -430,
    y: -650,
    width: 820,
    height: 560,
    shape: "polygon(4% 24%,25% 7%,52% 14%,69% 3%,94% 27%,86% 57%,98% 78%,67% 91%,39% 73%,12% 88%,2% 57%)",
  },
  {
    x: 460,
    y: -650,
    width: 820,
    height: 560,
    shape: "polygon(9% 14%,36% 2%,58% 15%,83% 8%,97% 38%,76% 54%,88% 85%,55% 96%,39% 73%,13% 84%,2% 48%)",
  },
  {
    x: 1350,
    y: -650,
    width: 820,
    height: 560,
    shape: "polygon(2% 31%,24% 8%,57% 2%,73% 20%,97% 35%,84% 63%,95% 87%,61% 96%,42% 77%,17% 91%,7% 61%)",
  },
  {
    x: -1040,
    y: 0,
    width: 820,
    height: 560,
    shape: "polygon(3% 18%,31% 3%,47% 17%,76% 6%,97% 33%,81% 55%,91% 86%,62% 97%,35% 79%,10% 91%,1% 52%)",
  },
  {
    x: -150,
    y: 0,
    width: 820,
    height: 560,
    shape: "polygon(8% 29%,20% 7%,48% 2%,68% 15%,94% 9%,98% 42%,77% 69%,57% 61%,34% 96%,5% 78%)",
  },
  {
    x: 740,
    y: 0,
    width: 820,
    height: 560,
    shape: "polygon(2% 39%,16% 13%,43% 5%,62% 21%,88% 8%,98% 37%,84% 64%,95% 86%,58% 95%,29% 75%,7% 87%)",
  },
  {
    x: -1040,
    y: 650,
    width: 820,
    height: 560,
    shape: "polygon(5% 22%,28% 4%,55% 11%,75% 2%,96% 30%,86% 52%,97% 79%,70% 94%,42% 73%,15% 91%,2% 58%)",
  },
  {
    x: -150,
    y: 650,
    width: 820,
    height: 560,
    shape: "polygon(7% 34%,19% 9%,39% 3%,65% 17%,91% 7%,98% 44%,80% 72%,52% 64%,30% 96%,4% 76%)",
  },
  {
    x: 740,
    y: 650,
    width: 820,
    height: 560,
    shape: "polygon(3% 27%,25% 5%,50% 13%,72% 3%,96% 35%,82% 58%,94% 88%,64% 96%,37% 76%,11% 90%,1% 51%)",
  },
];

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function stageColor(stage: GraphStage, index: number): string {
  return stage.color || PLANET_COLORS[index % PLANET_COLORS.length];
}

function stageLayout(node: GraphNode, stageId: string, index: number): { x: number; y: number } {
  const layouts = node.metadata?.stageLayouts;
  if (layouts && typeof layouts === "object") {
    const stored = (layouts as Record<string, { x?: number; y?: number }>)[stageId];
    if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) {
      return { x: Number(stored.x), y: Number(stored.y) };
    }
  }
  if (node.layout && node.stageIds.length <= 1) return { x: node.layout.x, y: node.layout.y };

  const seed = hashText(`${stageId}:${node.id}:${index}`);
  const continent = CONTINENTS[seed % CONTINENTS.length];
  const x = continent.x + 120 + ((seed >>> 5) % Math.max(200, continent.width - 360));
  const y = continent.y + 100 + ((seed >>> 13) % Math.max(180, continent.height - 260));
  return { x, y };
}

function eventPosition(event: StoryEvent, stageId: string, index: number): { x: number; y: number } {
  if (event.layout) return { x: event.layout.x, y: event.layout.y };
  const seed = hashText(`${stageId}:event:${event.id}:${index}`);
  const continent = CONTINENTS[seed % CONTINENTS.length];
  return {
    x: continent.x + 160 + ((seed >>> 4) % Math.max(200, continent.width - 420)),
    y: continent.y + 130 + ((seed >>> 12) % Math.max(160, continent.height - 300)),
  };
}

function AtlasNode({ data, selected }: NodeProps<StoryFlowNode>) {
  const nodeData = data as AtlasNodeData;
  const isEvent = nodeData.kind === "story-event";
  const config = isEvent ? NODE_TYPE_CONFIG.event : NODE_TYPE_CONFIG[nodeData.kind as NodeType];
  const isCandidate = nodeData.reviewStatus === "candidate";
  const isConflict = nodeData.reviewStatus === "conflict";
  const handleClass =
    "!size-2.5 !border-2 !border-background !bg-muted-foreground opacity-0 transition-opacity group-hover:opacity-100";

  return (
    <div
      className={`group min-w-40 max-w-56 rounded-2xl border bg-background/94 px-3 py-2.5 shadow-md backdrop-blur-sm transition ${
        selected ? "border-primary shadow-xl ring-2 ring-primary/20" : "border-border/80 hover:border-primary/50"
      } ${isCandidate ? "border-dashed" : ""} ${nodeData.hidden ? "opacity-45" : ""}`}
      style={{
        borderTopWidth: 3,
        borderTopColor: isConflict ? "#ef4444" : config.color,
      }}
    >
      <Handle id="target-left" type="target" position={Position.Left} className={handleClass} />
      <Handle id="target-top" type="target" position={Position.Top} className={handleClass} />
      <Handle id="source-right" type="source" position={Position.Right} className={handleClass} />
      <Handle id="source-bottom" type="source" position={Position.Bottom} className={handleClass} />
      <div className="flex items-center gap-2">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-full font-bold text-white text-xs shadow-sm"
          style={{ backgroundColor: config.color }}
        >
          {config.icon}
        </span>
        <div className="min-w-0">
          <div className="truncate font-semibold text-sm">{nodeData.label}</div>
          <div className="text-[10px] text-muted-foreground">
            {isEvent ? `事件${nodeData.chapter ? ` · 第${nodeData.chapter}章` : ""}` : config.label}
          </div>
        </div>
      </div>
      {nodeData.description && (
        <p className="mt-2 line-clamp-2 text-muted-foreground text-xs leading-relaxed">{nodeData.description}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-1 text-[9px]">
        {isCandidate && <span className="rounded bg-amber-500/12 px-1.5 py-0.5 text-amber-700">AI 候选</span>}
        {isConflict && <span className="rounded bg-red-500/12 px-1.5 py-0.5 text-red-700">资料冲突</span>}
        {nodeData.reviewStatus === "confirmed" && (
          <span className="rounded bg-emerald-500/12 px-1.5 py-0.5 text-emerald-700">已确认</span>
        )}
        {nodeData.freshness !== "current" && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{nodeData.freshness}</span>
        )}
        {nodeData.evidenceCount > 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{nodeData.evidenceCount} 条证据</span>
        )}
        {nodeData.foreshadowCount > 0 && (
          <span className="rounded bg-cyan-500/12 px-1.5 py-0.5 text-cyan-700">{nodeData.foreshadowCount} 条伏笔</span>
        )}
      </div>
    </div>
  );
}

function ContinentNode({ data }: NodeProps<StoryFlowNode>) {
  const continent = data as ContinentData;
  return (
    <div
      className="relative size-full overflow-hidden opacity-80"
      style={{
        clipPath: continent.shape,
        background: `radial-gradient(circle at 35% 30%, color-mix(in srgb, ${continent.color} 16%, white), color-mix(in srgb, ${continent.color} 15%, transparent) 46%, color-mix(in srgb, ${continent.color} 7%, transparent) 78%)`,
        border: `1px solid color-mix(in srgb, ${continent.color} 25%, transparent)`,
      }}
    >
      <span className="absolute top-[12%] left-[12%] font-semibold text-[11px] text-foreground/25 tracking-[0.18em]">
        {continent.label}
      </span>
    </div>
  );
}

const nodeTypes = { atlasNode: AtlasNode, continent: ContinentNode };

async function graphRequest(
  method: "GET" | "POST" | "PUT",
  novelId: string,
  body?: Record<string, unknown>,
): Promise<StoryGraph> {
  const scopeQuery = novelId ? `novelId=${encodeURIComponent(novelId)}&sync=false` : "sync=false";
  const response = await workspaceFetch(method === "GET" ? `/api/graph?${scopeQuery}` : "/api/graph", {
    method,
    headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({ ...(novelId ? { novelId } : {}), ...body }),
  });
  const json = await response.json();
  if (!response.ok || !json.success) throw new Error(json.error?.message || "图谱操作失败");
  return json.data.graph as StoryGraph;
}

async function loadGraphRequest(novelId: string): Promise<{
  graph: StoryGraph;
  recoveryPoints: GraphRecoveryPoint[];
}> {
  const scopeQuery = novelId ? `novelId=${encodeURIComponent(novelId)}&sync=false` : "sync=false";
  const response = await workspaceFetch(`/api/graph?${scopeQuery}`);
  const json = await response.json();
  if (!response.ok || !json.success) throw new Error(json.error?.message || "图谱加载失败");
  return {
    graph: json.data.graph as StoryGraph,
    recoveryPoints: Array.isArray(json.data.recoveryPoints) ? json.data.recoveryPoints : [],
  };
}

function PlanetOverview({
  graph,
  onEnter,
  onCreate,
  onClose,
  onAiRefresh,
  onRestore,
  canRestore,
  refreshing,
}: {
  graph: StoryGraph;
  onEnter: (stageId: string) => void;
  onCreate: () => void;
  onClose: () => void;
  onAiRefresh: () => void;
  onRestore: () => void;
  canRestore: boolean;
  refreshing: boolean;
}) {
  const isInitialGraph = graph.nodes.length === 0 && graph.events.length === 0 && graph.stages.length === 1;
  const width = Math.max(960, graph.stages.length * 320 + 260);
  const height = 700;
  const points = graph.stages.map((_, index) => ({
    x: isInitialGraph ? width / 2 : 180 + index * 310,
    y: isInitialGraph ? 450 : index % 2 === 0 ? 270 : 455,
  }));

  return (
    <div
      className="relative h-full overflow-hidden bg-[#07110f] text-white"
      style={{
        backgroundImage:
          "radial-gradient(circle at 15% 18%, #ffffffb0 0 1px, transparent 1.5px), radial-gradient(circle at 72% 35%, #ffffff80 0 1px, transparent 1.5px), radial-gradient(circle at 38% 76%, #ffffff65 0 1px, transparent 1.5px), radial-gradient(circle at 85% 82%, #ffffff75 0 1px, transparent 1.5px)",
        backgroundSize: "94px 94px, 137px 137px, 173px 173px, 211px 211px",
      }}
    >
      <header className="absolute inset-x-0 top-0 z-20 flex h-16 items-center gap-3 border-white/10 border-b bg-black/20 px-4 backdrop-blur">
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10 hover:text-white" onClick={onClose}>
          <ChevronLeft className="size-4" />
        </Button>
        <div>
          <div className="font-semibold text-sm">故事阶段星图</div>
          <div className="text-[10px] text-white/45">
            {graph.stages.length} / 10 个阶段 ·{" "}
            {graph.nodes.filter((node) => node.reviewStatus === "candidate" && node.visibility !== "hidden").length}{" "}
            个待确认节点
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
            onClick={onCreate}
            disabled={graph.stages.length >= 10}
          >
            <Plus className="mr-1 size-3.5" />
            新阶段
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
            onClick={onRestore}
            disabled={!canRestore}
            title={canRestore ? "恢复到上一个图谱保存点" : "当前还没有可用的恢复点"}
          >
            <RotateCcw className="mr-1 size-3.5" />
            恢复上次
          </Button>
          <Button size="sm" onClick={onAiRefresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Sparkles className="mr-1 size-3.5" />}
            AI 整理星图
          </Button>
        </div>
      </header>

      <div className="absolute inset-x-0 top-16 bottom-0 overflow-auto">
        <div className="relative" style={{ width, height }}>
          <div
            className={
              isInitialGraph
                ? "absolute top-16 left-1/2 w-full max-w-lg -translate-x-1/2 px-8 text-center"
                : "absolute top-10 left-16 max-w-lg"
            }
          >
            <div className="font-semibold text-[10px] text-white/35 tracking-[0.24em]">NARRATIVE UNIVERSE</div>
            <h1 className="mt-2 font-semibold text-2xl">
              {isInitialGraph ? "从空白星图开始搭建你的故事世界" : "故事沿着世界与阶段向前生长"}
            </h1>
            <p className="mt-2 text-sm text-white/50 leading-6">
              {isInitialGraph
                ? "无需先创建小说或大纲，可以直接进入第一阶段添加人物、势力、地点和关键事件。"
                : "每一颗星球是一段完整叙事空间；人物、势力和事件会在内部的不规则大陆上展开。"}
            </p>
          </div>

          <svg className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${width} ${height}`}>
            <defs>
              <marker id="stage-arrow" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto">
                <path d="M0,0 L0,8 L9,4 z" fill="#ffffff55" />
              </marker>
            </defs>
            {points.slice(0, -1).map((point, index) => {
              const next = points[index + 1];
              return (
                <path
                  key={`${point.x}-${next.x}`}
                  d={`M ${point.x + 92} ${point.y} C ${point.x + 160} ${point.y}, ${next.x - 155} ${next.y}, ${next.x - 96} ${next.y}`}
                  fill="none"
                  stroke="#ffffff35"
                  strokeDasharray="7 8"
                  strokeWidth="1.5"
                  markerEnd="url(#stage-arrow)"
                />
              );
            })}
          </svg>

          {graph.stages.map((stage, index) => {
            const point = points[index];
            const color = stageColor(stage, index);
            const nodeCount = graph.nodes.filter((node) => node.stageIds.includes(stage.id)).length;
            const eventCount = graph.events.filter((event) => event.stageId === stage.id).length;
            return (
              <button
                type="button"
                key={stage.id}
                onClick={() => onEnter(stage.id)}
                className="group absolute size-48 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15 text-left shadow-2xl transition duration-300 hover:scale-105 hover:border-white/35 focus:outline-none focus:ring-2 focus:ring-white/60"
                style={{
                  left: point.x,
                  top: point.y,
                  background: `radial-gradient(circle at 31% 25%, #ffffff 0 1.5%, color-mix(in srgb, ${color} 45%, white) 7%, ${color} 26%, color-mix(in srgb, ${color} 62%, #09130f) 62%, #020807 100%)`,
                  boxShadow: `inset -24px -28px 36px #00000099, inset 14px 12px 24px #ffffff16, 0 28px 60px color-mix(in srgb, ${color} 28%, transparent)`,
                }}
              >
                <span
                  className="absolute top-[29%] left-[13%] h-[25%] w-[40%] rotate-12 opacity-55"
                  style={{
                    clipPath: "polygon(0 28%,28% 0,68% 10%,100% 43%,70% 100%,25% 80%)",
                    background: "color-mix(in srgb, white 26%, transparent)",
                  }}
                />
                <span
                  className="absolute right-[14%] bottom-[18%] h-[29%] w-[35%] -rotate-12 opacity-35"
                  style={{
                    clipPath: "polygon(11% 5%,72% 0,100% 35%,74% 91%,27% 100%,0 56%)",
                    background: "color-mix(in srgb, white 22%, transparent)",
                  }}
                />
                <span className="absolute inset-x-0 bottom-8 px-6 text-center">
                  <span className="block text-[9px] text-white/55 tracking-[0.2em]">
                    阶段 {String(index + 1).padStart(2, "0")}
                  </span>
                  <strong className="mt-1 block truncate text-base">{stage.name}</strong>
                  <span className="mt-1 block text-[10px] text-white/55">
                    {nodeCount} 节点 · {eventCount} 事件
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StoryAtlas({ novelId, onClose, onSave }: StoryGraph3DProps) {
  const { zoomIn, zoomOut } = useReactFlow<StoryFlowNode, Edge>();
  const paneClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [graph, setGraph] = useState<StoryGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recoveryPoints, setRecoveryPoints] = useState<GraphRecoveryPoint[]>([]);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  const [layer, setLayer] = useState<LayerMode>("relations");
  const [chapterCursor, setChapterCursor] = useState(0);
  const [enabledLayers, setEnabledLayers] = useState<Set<GraphLayerKey>>(() => new Set(DEFAULT_GRAPH_LAYERS));
  const [showCandidates, setShowCandidates] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState("");
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<StoryFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const urlStateRestored = useRef(false);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await loadGraphRequest(novelId);
      setGraph(loaded.graph);
      setRecoveryPoints(loaded.recoveryPoints);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图谱加载失败");
    } finally {
      setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    const handleWorkspaceActivated = () => void loadGraph();
    window.addEventListener("workspace-activated", handleWorkspaceActivated);
    return () => window.removeEventListener("workspace-activated", handleWorkspaceActivated);
  }, [loadGraph]);

  useEffect(() => {
    urlStateRestored.current = false;
    setActiveStageId(null);
    setSelectedNodeId(null);
    setSelectedEventId(null);
    setSelectedEdgeId(null);
    setChapterCursor(0);
  }, [novelId]);

  useEffect(() => {
    if (!graph || (novelId && graph.novelId !== novelId) || urlStateRestored.current || typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const stageId = params.get("graphStage");
    if (stageId && graph.stages.some((stage) => stage.id === stageId)) {
      setActiveStageId(stageId);
    }
    const storedLayer = params.get("graphLayer");
    if (storedLayer === "relations" || storedLayer === "events") setLayer(storedLayer);
    const chapter = Number(params.get("graphChapter"));
    if (Number.isInteger(chapter) && chapter >= 0) setChapterCursor(chapter);
    const itemId = params.get("graphItem");
    if (itemId) {
      if (graph.nodes.some((item) => item.id === itemId)) setSelectedNodeId(itemId);
      else if (graph.events.some((item) => item.id === itemId)) setSelectedEventId(itemId);
      else if (graph.edges.some((item) => item.id === itemId)) setSelectedEdgeId(itemId);
    }
    const layerKeys = params
      .get("graphLayers")
      ?.split(",")
      .filter((key): key is GraphLayerKey => key in GRAPH_LAYER_REGISTRY);
    if (layerKeys?.length) setEnabledLayers(new Set(layerKeys));
    if (params.get("graphCandidates") === "false") setShowCandidates(false);
    if (params.get("graphHidden") === "true") setShowHidden(true);
    urlStateRestored.current = true;
  }, [graph]);

  useEffect(() => {
    if (!urlStateRestored.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (activeStageId) params.set("graphStage", activeStageId);
    else params.delete("graphStage");
    params.set("graphLayer", layer);
    if (chapterCursor > 0) params.set("graphChapter", String(chapterCursor));
    else params.delete("graphChapter");
    const selectedItem = selectedNodeId || selectedEventId || selectedEdgeId;
    if (selectedItem) params.set("graphItem", selectedItem);
    else params.delete("graphItem");
    params.set("graphLayers", Array.from(enabledLayers).sort().join(","));
    params.set("graphCandidates", String(showCandidates));
    params.set("graphHidden", String(showHidden));
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [
    activeStageId,
    chapterCursor,
    enabledLayers,
    layer,
    selectedEdgeId,
    selectedEventId,
    selectedNodeId,
    showCandidates,
    showHidden,
  ]);

  const mutate = useCallback(
    async (body: Record<string, unknown>, successMessage?: string): Promise<StoryGraph | undefined> => {
      try {
        const next = await graphRequest("PUT", novelId, body);
        setGraph(next);
        if (body.action !== "set-active-stage") {
          setRecoveryPoints((current) =>
            current.length
              ? current
              : [{ index: 0, updatedAt: new Date().toISOString(), revision: graph?.revision ?? 0 }],
          );
        }
        onSave?.(next);
        if (successMessage) toast.success(successMessage);
        return next;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "保存失败");
        return undefined;
      }
    },
    [graph?.revision, novelId, onSave],
  );

  const toggleGraphLayer = useCallback((key: GraphLayerKey) => {
    setEnabledLayers((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const activeStage = graph?.stages.find((stage) => stage.id === activeStageId);
  const maxChapter = useMemo(() => {
    if (!graph || !activeStageId) return 0;
    const stageNodes = graph.nodes.filter((node) => node.stageIds.includes(activeStageId));
    const stageEvents = graph.events.filter((event) => event.stageId === activeStageId);
    return Math.max(
      0,
      ...stageNodes.map((node) => node.lastChapter || node.firstChapter || 0),
      ...stageEvents.map((event) => event.chapterEnd || event.chapterStart || 0),
    );
  }, [activeStageId, graph]);

  const handlePaneClick = useCallback(
    (event: ReactMouseEvent) => {
      setSelectedNodeId(null);
      setSelectedEventId(null);
      setSelectedEdgeId(null);

      if (event.detail >= 2) {
        if (paneClickTimerRef.current) clearTimeout(paneClickTimerRef.current);
        paneClickTimerRef.current = null;
        void zoomIn({ duration: 180 });
        return;
      }

      if (paneClickTimerRef.current) clearTimeout(paneClickTimerRef.current);
      paneClickTimerRef.current = setTimeout(() => {
        paneClickTimerRef.current = null;
        void zoomOut({ duration: 180 });
      }, 220);
    },
    [zoomIn, zoomOut],
  );

  useEffect(
    () => () => {
      if (paneClickTimerRef.current) clearTimeout(paneClickTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!graph || !activeStageId) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const stageIndex = Math.max(
      0,
      graph.stages.findIndex((stage) => stage.id === activeStageId),
    );
    const color = stageColor(graph.stages[stageIndex] || graph.stages[0], stageIndex);
    const query = search.trim().toLocaleLowerCase();
    const visibleNodes = graph.nodes.filter((node) => {
      const inStage = node.stageIds.includes(activeStageId);
      const inTime = chapterCursor === 0 || (node.firstChapter || 0) <= chapterCursor;
      const layerEnabled = enabledLayers.has(graphLayerForNodeType(node.type));
      const visible =
        showHidden ||
        (node.visibility !== "hidden" && node.reviewStatus !== "rejected" && node.freshness !== "superseded");
      const reviewed = showCandidates || node.reviewStatus !== "candidate";
      const matches =
        !query || node.name.toLocaleLowerCase().includes(query) || node.description.toLocaleLowerCase().includes(query);
      return inStage && inTime && layerEnabled && visible && reviewed && matches;
    });
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    const flowNodes: StoryFlowNode[] = CONTINENTS.map((continent, index) => ({
      id: `continent-${activeStageId}-${index}`,
      type: "continent",
      position: { x: continent.x, y: continent.y },
      data: {
        kind: "continent",
        label: `${activeStage?.name || "故事世界"} · 板块 ${index + 1}`,
        color,
        shape: continent.shape,
      },
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
      zIndex: -10,
      style: { width: continent.width, height: continent.height, pointerEvents: "none" },
    }));

    flowNodes.push(
      ...visibleNodes.map((node, index) => ({
        id: node.id,
        type: "atlasNode",
        position: stageLayout(node, activeStageId, index),
        data: {
          label: node.name,
          description: node.description,
          kind: node.type,
          source: node.source,
          chapter: node.firstChapter,
          reviewStatus: node.reviewStatus || "candidate",
          freshness: node.freshness || "current",
          hidden: node.visibility === "hidden",
          evidenceCount: node.evidence.length,
          foreshadowCount:
            enabledLayers.has("foreshadows") && Array.isArray(node.metadata.foreshadowIds)
              ? node.metadata.foreshadowIds.length
              : 0,
        },
        zIndex: 3,
      })),
    );

    const flowEdges: Edge[] = [];
    if (layer === "relations" && enabledLayers.has("relations")) {
      for (const edge of graph.edges) {
        if (
          (!showHidden &&
            (edge.visibility === "hidden" || edge.reviewStatus === "rejected" || edge.freshness === "superseded")) ||
          (!showCandidates && edge.reviewStatus === "candidate")
        ) {
          continue;
        }
        if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
        if (edge.stageIds.length && !edge.stageIds.includes(activeStageId)) continue;
        if (chapterCursor && edge.chapterStart && edge.chapterStart > chapterCursor) continue;
        flowEdges.push({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.relation,
          reconnectable: true,
          animated: edge.relationType === "love" || edge.relationType === "conflict",
          markerEnd: edge.directed ? { type: MarkerType.ArrowClosed } : undefined,
          style: { strokeWidth: Math.max(1, Math.min(4, edge.weight / 2.5)) },
          labelStyle: { fontSize: 11 },
          labelBgPadding: [5, 3],
          labelBgBorderRadius: 7,
          className:
            edge.reviewStatus === "candidate"
              ? "opacity-65"
              : edge.reviewStatus === "conflict"
                ? "text-destructive"
                : undefined,
        });
      }
    } else if (layer === "events" && enabledLayers.has("events")) {
      const visibleEvents = graph.events.filter((event) => {
        const inStage = event.stageId === activeStageId;
        const inTime = chapterCursor === 0 || (event.chapterStart || 0) <= chapterCursor;
        const visible =
          showHidden ||
          (event.visibility !== "hidden" && event.reviewStatus !== "rejected" && event.freshness !== "superseded");
        const reviewed = showCandidates || event.reviewStatus !== "candidate";
        const matches =
          !query ||
          event.title.toLocaleLowerCase().includes(query) ||
          event.summary.toLocaleLowerCase().includes(query);
        return inStage && inTime && visible && reviewed && matches;
      });
      for (const [index, event] of visibleEvents.entries()) {
        const eventNodeId = `event-view-${event.id}`;
        flowNodes.push({
          id: eventNodeId,
          type: "atlasNode",
          position: eventPosition(event, activeStageId, index),
          data: {
            label: event.title,
            description: event.summary,
            kind: "story-event",
            source: event.source,
            chapter: event.chapterStart,
            reviewStatus: event.reviewStatus || "candidate",
            freshness: event.freshness || "current",
            hidden: event.visibility === "hidden",
            evidenceCount: event.evidence.length,
            foreshadowCount: 0,
          },
          connectable: false,
          zIndex: 4,
        });
        for (const participantId of [...event.participantIds, ...event.locationIds, ...event.factionIds]) {
          if (!visibleNodeIds.has(participantId)) continue;
          flowEdges.push({
            id: `event-link-${event.id}-${participantId}`,
            source: participantId,
            target: eventNodeId,
            label: "参与",
            style: { stroke: "#c58b3b", strokeDasharray: "5 4", strokeWidth: 1.6 },
          });
        }
      }
    }
    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [
    activeStage,
    activeStageId,
    chapterCursor,
    enabledLayers,
    graph,
    layer,
    search,
    setEdges,
    setNodes,
    showCandidates,
    showHidden,
  ]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!activeStageId || !connection.source || !connection.target || connection.source === connection.target) return;
      if (connection.source.startsWith("event-view-") || connection.target.startsWith("event-view-")) return;
      void (async () => {
        const next = await mutate(
          {
            action: "add-edge",
            edge: {
              source: connection.source,
              target: connection.target,
              relation: "新关系",
              stageIds: [activeStageId],
            },
          },
          "关系已建立",
        );
        const created = [...(next?.edges || [])]
          .reverse()
          .find((edge) => edge.source === connection.source && edge.target === connection.target);
        if (created) {
          setSelectedNodeId(null);
          setSelectedEventId(null);
          setSelectedEdgeId(created.id);
        }
      })();
    },
    [activeStageId, mutate],
  );

  const handleReconnect = useCallback(
    (edge: Edge, connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      void mutate(
        {
          action: "update-edge",
          edgeId: edge.id,
          updates: { source: connection.source, target: connection.target },
        },
        "关系连线已调整",
      );
    },
    [mutate],
  );

  const handleNodeDragStop = useCallback(
    (_event: unknown, node: StoryFlowNode) => {
      if (!activeStageId || node.id.startsWith("continent-")) return;
      if (node.id.startsWith("event-view-")) {
        const eventId = node.id.replace("event-view-", "");
        const event = graph?.events.find((item) => item.id === eventId);
        if (event) {
          void mutate({
            action: "update-event-layout",
            eventId,
            layout: { ...node.position, pinned: true },
          });
        }
        return;
      }
      const graphNode = graph?.nodes.find((item) => item.id === node.id);
      if (!graphNode) return;
      const currentLayouts =
        graphNode.metadata.stageLayouts && typeof graphNode.metadata.stageLayouts === "object"
          ? (graphNode.metadata.stageLayouts as Record<string, unknown>)
          : {};
      void mutate({
        action: "update-node-layout",
        nodeId: node.id,
        updates: {
          metadata: {
            ...graphNode.metadata,
            stageLayouts: { ...currentLayouts, [activeStageId]: { ...node.position, pinned: true } },
          },
        },
      });
    },
    [activeStageId, graph, mutate],
  );

  const handleNodeClick = useCallback((_event: unknown, node: StoryFlowNode) => {
    if (node.id.startsWith("continent-")) return;
    setSelectedEdgeId(null);
    if (node.id.startsWith("event-view-")) {
      setSelectedEventId(node.id.replace("event-view-", ""));
      setSelectedNodeId(null);
    } else {
      setSelectedNodeId(node.id);
      setSelectedEventId(null);
    }
  }, []);

  const handleAiRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await workspaceFetch("/api/graph/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(novelId ? { novelId } : {}),
          ...(activeStageId ? { stageId: activeStageId } : {}),
          action: "refresh",
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.error?.message || "AI 更新失败");
      setGraph(json.data.graph);
      toast.success("AI 已根据项目资料增量整理图谱");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI 更新失败");
    } finally {
      setRefreshing(false);
    }
  }, [activeStageId, novelId]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!graph) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>图谱加载失败</p>
        <Button variant="outline" onClick={loadGraph}>
          重新加载
        </Button>
      </div>
    );
  }

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const selectedEvent = graph.events.find((event) => event.id === selectedEventId);
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedEdgeId);

  if (!activeStageId || !activeStage) {
    return (
      <div className="relative h-full">
        <PlanetOverview
          graph={graph}
          onEnter={(stageId) => {
            setActiveStageId(stageId);
            setSelectedNodeId(null);
            setSelectedEventId(null);
            setSelectedEdgeId(null);
            void mutate({ action: "set-active-stage", stageId });
          }}
          onCreate={() => setCreateMode("stage")}
          onClose={onClose}
          onAiRefresh={handleAiRefresh}
          onRestore={() => {
            if (!window.confirm("恢复到上一个图谱保存点吗？当前版本仍会保留为新的恢复点。")) return;
            void mutate({ action: "restore-recovery", index: 0 }, "图谱已恢复到上一个保存点");
          }}
          canRestore={recoveryPoints.length > 0}
          refreshing={refreshing}
        />
        {createMode === "stage" && (
          <CreatePanel
            mode="stage"
            graph={graph}
            onClose={() => setCreateMode(null)}
            onMutate={async (body, message) => {
              const next = await mutate(body, message);
              setCreateMode(null);
              return next;
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setActiveStageId(null);
            setSelectedNodeId(null);
            setSelectedEventId(null);
            setSelectedEdgeId(null);
          }}
        >
          <ChevronLeft className="mr-1 size-4" />
          返回星图
        </Button>
        <div className="mr-2 min-w-0">
          <div className="truncate font-semibold text-sm">{activeStage.name}</div>
          <div className="truncate text-[10px] text-muted-foreground">{activeStage.description || "阶段大陆画布"}</div>
        </div>
        <div className="flex rounded-lg border bg-muted/40 p-0.5">
          <Button
            size="sm"
            variant={layer === "relations" ? "default" : "ghost"}
            onClick={() => {
              setLayer("relations");
              setEnabledLayers((current) => new Set([...current, "relations"]));
            }}
          >
            关系
          </Button>
          <Button
            size="sm"
            variant={layer === "events" ? "default" : "ghost"}
            onClick={() => {
              setLayer("events");
              setEnabledLayers((current) => new Set([...current, "events"]));
            }}
          >
            <Clock3 className="mr-1 size-3.5" />
            事件
          </Button>
        </div>
        <details className="group relative z-40">
          <summary className="flex h-8 cursor-pointer list-none items-center gap-1 rounded-md border bg-background px-2 text-xs hover:bg-muted">
            <Layers3 className="size-3.5" />
            图层
          </summary>
          <div className="absolute top-10 left-0 w-72 rounded-xl border bg-background p-3 shadow-2xl">
            <div className="mb-2 font-semibold text-xs">故事图层</div>
            <div className="grid grid-cols-2 gap-1.5">
              {Object.values(GRAPH_LAYER_REGISTRY).map((definition) => (
                <label
                  key={definition.key}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-xs hover:bg-muted/50"
                  title={definition.description}
                >
                  <input
                    type="checkbox"
                    checked={enabledLayers.has(definition.key)}
                    onChange={() => toggleGraphLayer(definition.key)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium">{definition.label}</span>
                    <span className="line-clamp-1 text-[9px] text-muted-foreground">{definition.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-3 space-y-2 border-t pt-3 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showCandidates}
                  onChange={(event) => setShowCandidates(event.target.checked)}
                />
                显示 AI 候选
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
                显示已隐藏/旧状态
              </label>
            </div>
            <p className="mt-3 rounded-lg bg-muted/60 p-2 text-[9px] text-muted-foreground leading-4">
              实线为已确认事实，虚线卡片为 AI 候选；候选经确认后才会进入写作知识。
            </p>
          </div>
        </details>
        <div className="relative min-w-36 max-w-64 flex-1">
          <Search className="absolute top-2 left-2 size-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索这个阶段"
            className="h-8 w-full rounded-md border bg-background pr-2 pl-8 text-xs outline-none focus:border-primary"
          />
        </div>
        {maxChapter > 0 && (
          <label className="hidden items-center gap-2 text-muted-foreground text-xs xl:flex">
            <span>{chapterCursor ? `第 ${chapterCursor} 章` : "全部章节"}</span>
            <input
              type="range"
              min={0}
              max={maxChapter}
              value={chapterCursor}
              onChange={(event) => setChapterCursor(Number(event.target.value))}
              className="w-28"
            />
          </label>
        )}
        <Button size="sm" variant="outline" onClick={() => setCreateMode(layer === "events" ? "event" : "node")}>
          <Plus className="mr-1 size-3.5" />
          {layer === "events" ? "事件" : "节点"}
        </Button>
        <Button size="sm" onClick={handleAiRefresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Sparkles className="mr-1 size-3.5" />}
          AI 构图
        </Button>
      </header>

      <main className="relative min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          onReconnect={handleReconnect}
          onNodeClick={handleNodeClick}
          onEdgeClick={(_event, edge) => {
            const real = graph.edges.find((item) => item.id === edge.id);
            if (!real) return;
            setSelectedEdgeId(real.id);
            setSelectedNodeId(null);
            setSelectedEventId(null);
          }}
          onNodeDragStop={handleNodeDragStop}
          onPaneClick={handlePaneClick}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 0.9 }}
          minZoom={0.08}
          maxZoom={3}
          panOnScroll
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick={false}
          selectionOnDrag
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={26} size={1} color="color-mix(in srgb, var(--muted-foreground) 16%, transparent)" />
          <Controls />
          <MiniMap
            pannable
            zoomable
            maskColor="color-mix(in srgb, var(--background) 74%, transparent)"
            nodeColor={(node) => {
              const data = node.data as StoryFlowData;
              if (data.kind === "continent") return "transparent";
              return data.kind === "story-event"
                ? NODE_TYPE_CONFIG.event.color
                : NODE_TYPE_CONFIG[data.kind as NodeType].color;
            }}
          />
        </ReactFlow>

        {!nodes.some((node) => node.type === "atlasNode") && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-2xl border bg-background/90 p-8 text-center shadow-sm backdrop-blur">
              <Bot className="mx-auto mb-3 size-8 text-primary" />
              <p className="font-medium">这个阶段还是一片空白大陆</p>
              <p className="mt-1 text-muted-foreground text-xs">添加节点，或让 AI 根据项目资料构建第一批人物与势力</p>
            </div>
          </div>
        )}

        {(selectedNode || selectedEvent || selectedEdge) && (
          <CompactEditor
            key={selectedNode?.id || selectedEvent?.id || selectedEdge?.id}
            graph={graph}
            node={selectedNode}
            event={selectedEvent}
            edge={selectedEdge}
            onClose={() => {
              setSelectedNodeId(null);
              setSelectedEventId(null);
              setSelectedEdgeId(null);
            }}
            onMutate={mutate}
          />
        )}

        {createMode && createMode !== "stage" && (
          <CreatePanel
            mode={createMode}
            graph={graph}
            currentStageId={activeStageId}
            onClose={() => setCreateMode(null)}
            onMutate={async (body, message) => {
              const next = await mutate(body, message);
              setCreateMode(null);
              return next;
            }}
          />
        )}
      </main>
    </div>
  );
}

function CompactEditor({
  graph,
  node,
  event,
  edge,
  onClose,
  onMutate,
}: {
  graph: StoryGraph;
  node?: GraphNode;
  event?: StoryEvent;
  edge?: GraphEdge;
  onClose: () => void;
  onMutate: (body: Record<string, unknown>, successMessage?: string) => Promise<StoryGraph | undefined>;
}) {
  const [summary, setSummary] = useState(node?.description ?? event?.summary ?? "");
  const [relation, setRelation] = useState(edge?.relation ?? "");
  const [relationType, setRelationType] = useState(edge?.relationType ?? "relation");
  const [source, setSource] = useState(edge?.source ?? "");
  const [target, setTarget] = useState(edge?.target ?? "");
  const itemKind = node ? "node" : event ? "event" : "edge";
  const reviewStatus = node?.reviewStatus || event?.reviewStatus || edge?.reviewStatus || "candidate";
  const freshness = node?.freshness || event?.freshness || edge?.freshness || "current";
  const visibility = node?.visibility || event?.visibility || edge?.visibility || "visible";
  const evidenceCount = node?.evidence.length || event?.evidence.length || edge?.evidence.length || 0;

  const save = async () => {
    if (node) {
      await onMutate({ action: "update-node", nodeId: node.id, updates: { description: summary } }, "节点梗概已保存");
    } else if (event) {
      await onMutate({ action: "upsert-event", event: { ...event, summary } }, "事件梗概已保存");
    } else if (edge) {
      if (!source || !target || source === target) {
        toast.error("关系起点和终点必须是两个不同节点");
        return;
      }
      await onMutate(
        {
          action: "update-edge",
          edgeId: edge.id,
          updates: { relation: relation.trim() || "关联", relationType, source, target },
        },
        "关系已保存",
      );
    }
  };

  const remove = async () => {
    if (!window.confirm("只从当前图谱隐藏这条信息吗？来源资料和历史记录不会删除，可随时恢复。")) return;
    if (node) await onMutate({ action: "remove-node", nodeId: node.id }, "节点已移出图谱");
    else if (event) await onMutate({ action: "remove-event", eventId: event.id }, "事件已从图谱隐藏");
    else if (edge) await onMutate({ action: "remove-edge", edgeId: edge.id }, "关系已从图谱隐藏");
    onClose();
  };

  const review = async (status: "confirmed" | "conflict" | "rejected") => {
    const itemId = node?.id || event?.id || edge?.id;
    if (!itemId) return;
    await onMutate(
      { action: "review-item", kind: itemKind, itemId, status },
      status === "confirmed" ? "已确认并纳入作品知识" : status === "conflict" ? "已标记资料冲突" : "候选已驳回",
    );
    if (status === "rejected") onClose();
  };

  const restore = async () => {
    const itemId = node?.id || event?.id || edge?.id;
    if (!itemId) return;
    await onMutate({ action: "restore-item", kind: itemKind, itemId }, "图谱信息已恢复显示");
  };

  return (
    <div className="absolute bottom-4 left-1/2 z-30 w-[min(620px,calc(100%-32px))] -translate-x-1/2 rounded-2xl border bg-background/96 p-3 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-sm">
            {node?.name ||
              event?.title ||
              (edge
                ? `${graph.nodes.find((item) => item.id === edge.source)?.name || "?"} → ${graph.nodes.find((item) => item.id === edge.target)?.name || "?"}`
                : "")}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[9px]">
            {reviewStatus === "confirmed" ? (
              <span className="flex items-center gap-1 rounded bg-emerald-500/12 px-1.5 py-0.5 text-emerald-700">
                <ShieldCheck className="size-3" /> 已确认
              </span>
            ) : reviewStatus === "conflict" ? (
              <span className="flex items-center gap-1 rounded bg-red-500/12 px-1.5 py-0.5 text-red-700">
                <AlertTriangle className="size-3" /> 资料冲突
              </span>
            ) : (
              <span className="rounded bg-amber-500/12 px-1.5 py-0.5 text-amber-700">AI 候选</span>
            )}
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{freshness}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{evidenceCount} 条证据</span>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      {edge ? (
        <div className="grid gap-2 md:grid-cols-[1.3fr_1fr_1fr_1fr]">
          <input
            value={relation}
            onChange={(event) => setRelation(event.target.value)}
            placeholder="关系名称"
            className="h-9 rounded-md border bg-background px-2 text-xs"
          />
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-xs"
          >
            {graph.nodes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-xs"
          >
            {graph.nodes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <select
            value={relationType}
            onChange={(event) => setRelationType(event.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-xs"
          >
            <option value="relation">普通关联</option>
            <option value="ally">同盟 / 亲近</option>
            <option value="conflict">冲突 / 敌对</option>
            <option value="control">隶属 / 支配</option>
          </select>
        </div>
      ) : (
        <textarea
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          rows={3}
          placeholder="填写这个节点在当前故事阶段中的身份、目标、处境和变化……"
          className="w-full resize-none rounded-xl border bg-background p-3 text-sm leading-6 outline-none focus:border-primary"
        />
      )}

      <div className="mt-2 flex justify-end gap-2">
        {visibility === "hidden" ? (
          <Button variant="outline" size="sm" onClick={restore}>
            <RotateCcw className="mr-1 size-3.5" />
            恢复显示
          </Button>
        ) : (
          <Button variant="ghost" size="icon" onClick={remove} title="从图谱隐藏">
            <EyeOff className="size-4 text-muted-foreground" />
          </Button>
        )}
        {reviewStatus !== "confirmed" && (
          <Button variant="outline" size="sm" onClick={() => void review("confirmed")}>
            <ShieldCheck className="mr-1 size-3.5" />
            确认事实
          </Button>
        )}
        {reviewStatus !== "conflict" && (
          <Button variant="outline" size="sm" onClick={() => void review("conflict")}>
            <AlertTriangle className="mr-1 size-3.5" />
            标记冲突
          </Button>
        )}
        {reviewStatus !== "confirmed" && (
          <Button variant="ghost" size="sm" onClick={() => void review("rejected")}>
            <Trash2 className="mr-1 size-3.5" />
            驳回
          </Button>
        )}
        <Button size="sm" onClick={save}>
          <Save className="mr-1 size-3.5" />
          保存
        </Button>
      </div>
    </div>
  );
}

function CreatePanel({
  mode,
  graph,
  currentStageId,
  onClose,
  onMutate,
}: {
  mode: Exclude<CreateMode, null>;
  graph: StoryGraph;
  currentStageId?: string;
  onClose: () => void;
  onMutate: (body: Record<string, unknown>, message: string) => Promise<StoryGraph | undefined>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<NodeType>("character");
  const [chapter, setChapter] = useState("");
  const [participantIds, setParticipantIds] = useState<string[]>([]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (mode === "node") {
      await onMutate(
        {
          action: "add-node",
          node: {
            name: name.trim(),
            description: description.trim(),
            type,
            stageIds: currentStageId ? [currentStageId] : [],
            firstChapter: chapter ? Number(chapter) : undefined,
          },
        },
        "节点已添加",
      );
    } else if (mode === "stage") {
      await onMutate(
        {
          action: "upsert-stage",
          stage: {
            name: name.trim(),
            description: description.trim(),
            chapterStart: chapter ? Number(chapter) : undefined,
          },
        },
        "故事阶段已添加",
      );
    } else {
      await onMutate(
        {
          action: "upsert-event",
          event: {
            title: name.trim(),
            summary: description.trim(),
            stageId: currentStageId,
            chapterStart: chapter ? Number(chapter) : undefined,
            chapterEnd: chapter ? Number(chapter) : undefined,
            participantIds,
          },
        },
        "事件已添加",
      );
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/45 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="font-semibold text-sm">
            {mode === "node" ? "添加节点" : mode === "stage" ? "创建故事阶段" : "添加事件"}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <form onSubmit={submit} className="space-y-3 p-4">
          <label className="block font-medium text-xs">
            {mode === "stage" ? "阶段名称" : mode === "event" ? "事件标题" : "节点名称"}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={mode === "stage" ? "例如：飞升天界、北境战争、玄渊秘境" : ""}
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 font-normal"
            />
          </label>
          {mode === "node" && (
            <label className="block font-medium text-xs">
              类型
              <select
                value={type}
                onChange={(event) => setType(event.target.value as NodeType)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 font-normal"
              >
                {Object.entries(NODE_TYPE_CONFIG)
                  .filter(([key]) => key !== "event")
                  .map(([key, config]) => (
                    <option key={key} value={key}>
                      {config.label}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="block font-medium text-xs">
            梗概
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              className="mt-1 w-full resize-none rounded-md border bg-background p-2 font-normal"
            />
          </label>
          <label className="block font-medium text-xs">
            {mode === "event" ? "发生章节" : "起始章节"}
            <input
              type="number"
              min={1}
              value={chapter}
              onChange={(event) => setChapter(event.target.value)}
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 font-normal"
            />
          </label>
          {mode === "event" && graph.nodes.length > 0 && (
            <div>
              <div className="font-medium text-xs">参与节点</div>
              <div className="mt-1 max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
                {graph.nodes.map((node) => (
                  <label key={node.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={participantIds.includes(node.id)}
                      onChange={(event) =>
                        setParticipantIds((current) =>
                          event.target.checked ? [...current, node.id] : current.filter((id) => id !== node.id),
                        )
                      }
                    />
                    {node.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <Button type="submit" className="w-full" disabled={!name.trim()}>
            <Plus className="mr-1 size-3.5" />
            {mode === "stage" ? "创建阶段星球" : "添加"}
          </Button>
        </form>
      </div>
    </div>
  );
}

export function StoryGraph3D(props: StoryGraph3DProps) {
  return (
    <ReactFlowProvider>
      <div className="h-full min-h-0 min-w-0 flex-1">
        <StoryAtlas {...props} />
      </div>
    </ReactFlowProvider>
  );
}
