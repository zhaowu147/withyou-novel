"use client";

import { useCallback, useEffect, useMemo } from "react";

import {
  Background,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
  getBezierPath,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  BEAT_COLORS,
  type CharacterNodeData,
  type ForeshadowNodeData,
  type PlotNodeData,
  RELATION_COLORS,
  type RelationEdgeData,
  useStoryMapStore,
} from "@/stores/story-map-store";
import type { NovelData } from "@/types/novel";

// ── 角色节点组件 ──

function CharacterNode({ data, selected, id }: NodeProps<Node<CharacterNodeData>>) {
  const _hoveredNodeId = useStoryMapStore((s) => s.hoveredNodeId);
  const highlightedNodeIds = useStoryMapStore((s) => s.highlightedNodeIds);
  const setHoveredNode = useStoryMapStore((s) => s.setHoveredNode);

  const isHighlighted = highlightedNodeIds.size === 0 || highlightedNodeIds.has(id);
  const isDimmed = highlightedNodeIds.size > 0 && !isHighlighted;

  const roleColor =
    data.role === "主角" ? "#6366f1" : data.role === "反派" ? "#ef4444" : data.role === "龙套" ? "#9ca3af" : "#8b5cf6";

  return (
    <div
      className={`relative flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 bg-background px-4 py-3 shadow-lg transition-all duration-200 ${selected ? "scale-110 shadow-xl ring-2 ring-primary/30" : ""}
        ${isDimmed ? "opacity-30" : "opacity-100"}
        ${!selected && isHighlighted && highlightedNodeIds.size > 1 ? "ring-2 ring-primary/20" : ""}
      `}
      style={{ borderColor: roleColor, minWidth: 120 }}
      onMouseEnter={() => setHoveredNode(id)}
      onMouseLeave={() => setHoveredNode(null)}
    >
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-transparent !w-3 !h-3" />
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-transparent !w-3 !h-3" />
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-transparent !w-3 !h-3" />
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-transparent !w-3 !h-3" />

      <div
        className="flex h-10 w-10 items-center justify-center rounded-full text-xl"
        style={{ backgroundColor: `${roleColor}20` }}
      >
        {data.emoji}
      </div>

      <div className="font-bold text-foreground text-sm">{data.name}</div>

      <span className="rounded-full px-2 py-0.5 text-white text-xs" style={{ backgroundColor: roleColor }}>
        {data.role}
      </span>

      {selected && data.summary && (
        <div className="mt-1 line-clamp-3 max-w-[180px] text-center text-muted-foreground text-xs">{data.summary}</div>
      )}
    </div>
  );
}

// ── 剧情节点组件 ──

function PlotNode({ data, selected, id }: NodeProps<Node<PlotNodeData>>) {
  const highlightedNodeIds = useStoryMapStore((s) => s.highlightedNodeIds);
  const setHoveredNode = useStoryMapStore((s) => s.setHoveredNode);
  const isDimmed = highlightedNodeIds.size > 0 && !highlightedNodeIds.has(id);

  const beatColor = BEAT_COLORS[data.beatType] || BEAT_COLORS.default;

  return (
    <div
      className={`relative flex cursor-pointer flex-col gap-1 rounded-lg border bg-background px-4 py-3 shadow-md transition-all duration-200 ${selected ? "scale-105 border-primary shadow-lg" : "border-border"}
        ${isDimmed ? "opacity-30" : "opacity-100"}
      `}
      style={{ minWidth: 180, maxWidth: 220 }}
      onMouseEnter={() => setHoveredNode(id)}
      onMouseLeave={() => setHoveredNode(null)}
    >
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-transparent" />
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-transparent" />

      {data.beatType !== "default" && (
        <span className="self-start rounded-full px-2 py-0.5 text-white text-xs" style={{ backgroundColor: beatColor }}>
          {data.beatType}
        </span>
      )}

      {data.chapter && <span className="text-muted-foreground text-xs">{data.chapter}</span>}

      <div className="font-semibold text-foreground text-sm">{data.label}</div>

      <div className="line-clamp-2 text-muted-foreground text-xs">{data.summary}</div>

      <div className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground text-xs">
        {data.index + 1}
      </div>
    </div>
  );
}

// ── 伏笔节点组件 ──

function ForeshadowNode({ data, selected, id }: NodeProps<Node<ForeshadowNodeData>>) {
  const highlightedNodeIds = useStoryMapStore((s) => s.highlightedNodeIds);
  const setHoveredNode = useStoryMapStore((s) => s.setHoveredNode);
  const isDimmed = highlightedNodeIds.size > 0 && !highlightedNodeIds.has(id);

  const statusColor =
    data.status === "resolved"
      ? "#22c55e"
      : data.status === "revealed"
        ? "#f59e0b"
        : data.status === "hinted"
          ? "#60a5fa"
          : "#a78bfa";

  return (
    <div
      className={`relative flex cursor-pointer flex-col gap-1 rounded-lg border bg-background px-3 py-2 shadow-sm transition-all duration-200 ${selected ? "scale-105 border-primary shadow-md" : "border-border"}
        ${isDimmed ? "opacity-30" : "opacity-100"}
      `}
      style={{ minWidth: 140, maxWidth: 180, borderLeftWidth: 3, borderLeftColor: statusColor }}
      onMouseEnter={() => setHoveredNode(id)}
      onMouseLeave={() => setHoveredNode(null)}
    >
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-transparent" />
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-transparent" />

      <div className="flex items-center gap-1">
        <span className="text-sm">{data.emoji}</span>
        <span className="font-medium text-foreground text-xs">{data.label}</span>
      </div>

      <div className="line-clamp-2 text-muted-foreground text-xs">{data.description}</div>

      <div className="mt-0.5 flex items-center gap-1">
        <span className="rounded-full px-1.5 py-0.5 text-[10px] text-white" style={{ backgroundColor: statusColor }}>
          {data.status === "resolved"
            ? "已回收"
            : data.status === "revealed"
              ? "已揭示"
              : data.status === "hinted"
                ? "已暗示"
                : "已埋设"}
        </span>
        {data.relatedChars.length > 0 && (
          <span className="text-[10px] text-muted-foreground">{data.relatedChars.join("、")}</span>
        )}
      </div>
    </div>
  );
}

// ── 关系边组件 ──

function RelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  selected,
}: EdgeProps<Edge<RelationEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const relationColor = RELATION_COLORS[data?.relationType || "default"] || RELATION_COLORS.default;

  return (
    <>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={relationColor}
        strokeWidth={selected ? 3 : 2}
        strokeDasharray={data?.relationType === "foreshadow" ? "4,4" : undefined}
        className="transition-all duration-200"
        style={{
          ...style,
          opacity: selected ? 1 : 0.7,
        }}
      />
      {data?.relationType === "love" && (
        <circle r="4" fill={relationColor}>
          <animateMotion dur="3s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
            }}
            className="cursor-pointer rounded-full border bg-background px-2 py-0.5 font-medium text-xs shadow-sm transition-shadow hover:shadow-md"
          >
            <span style={{ color: relationColor }}>{data.label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── 注册自定义类型 ──

const nodeTypes: NodeTypes = {
  characterNode: CharacterNode,
  plotNode: PlotNode,
  foreshadowNode: ForeshadowNode,
};

const edgeTypes: EdgeTypes = {
  relationEdge: RelationEdge,
};

// ── 内部组件 ──

function StoryMapInner({ novelData }: { novelData: NovelData }) {
  const {
    characterNodes,
    plotNodes,
    foreshadowNodes,
    relationEdges,
    activeTab,
    selectedNodeId,
    buildFromNovelData,
    setSelectedNode,
    setHoveredNode,
  } = useStoryMapStore();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 从 NovelData 构建可视化数据
  useEffect(() => {
    buildFromNovelData({
      characters: novelData.characters,
      outline: novelData.outline,
      foreshadowing: novelData.foreshadowing,
    });
  }, [novelData.characters, novelData.outline, novelData.foreshadowing, buildFromNovelData]);

  // 同步到 ReactFlow
  useEffect(() => {
    if (activeTab === "characters") {
      setNodes([...characterNodes, ...foreshadowNodes]);
      setEdges(relationEdges);
    } else {
      setNodes(plotNodes);
      setEdges([]);
    }
  }, [activeTab, characterNodes, plotNodes, foreshadowNodes, relationEdges, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNode(node.id);
    },
    [setSelectedNode],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  // 详情面板内容
  const selectedNodeData = useMemo(() => {
    const allNodes = [...characterNodes, ...plotNodes, ...foreshadowNodes];
    return allNodes.find((n) => n.id === selectedNodeId);
  }, [characterNodes, plotNodes, foreshadowNodes, selectedNodeId]);

  const isEmpty = nodes.length === 0;

  // 统计
  const stats = useMemo(() => {
    if (activeTab === "characters") {
      const relCount = relationEdges.filter((e) => !e.id.startsWith("fs-edge")).length;
      const fsCount = foreshadowNodes.length;
      return `${characterNodes.length} 角色 · ${relCount} 关系 · ${fsCount} 伏笔`;
    }
    return `${plotNodes.length} 节拍`;
  }, [activeTab, characterNodes.length, relationEdges, foreshadowNodes.length, plotNodes.length]);

  return (
    <div className="flex h-full flex-col">
      {/* 标签切换 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
        <button
          onClick={() => useStoryMapStore.getState().setActiveTab("characters")}
          className={`rounded-md px-3 py-1.5 font-medium text-sm transition-colors ${
            activeTab === "characters" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
          }`}
        >
          🧑‍🤝‍🧑 角色关系
        </button>
        <button
          onClick={() => useStoryMapStore.getState().setActiveTab("timeline")}
          className={`rounded-md px-3 py-1.5 font-medium text-sm transition-colors ${
            activeTab === "timeline" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
          }`}
        >
          📖 剧情脉络
        </button>
        <div className="flex-1" />
        <span className="text-muted-foreground text-xs">{stats}</span>
      </div>

      {/* 图例 */}
      {activeTab === "characters" && characterNodes.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-1.5 text-muted-foreground text-xs">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "#6366f1" }} />
            主角
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "#8b5cf6" }} />
            配角
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "#ef4444" }} />
            反派
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-6 rounded" style={{ backgroundColor: "#f472b6" }} />
            恋人
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-6 rounded" style={{ backgroundColor: "#34d399" }} />
            盟友
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-6 rounded" style={{ backgroundColor: "#ef4444" }} />
            敌对
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-6 rounded border-t-2 border-dashed"
              style={{ borderColor: "#a78bfa" }}
            />
            伏笔
          </span>
        </div>
      )}

      {/* 画布 */}
      <div className="relative flex-1">
        {isEmpty ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <div className="text-center">
              <div className="mb-2 text-4xl">🗺️</div>
              <div className="text-sm">暂无数据</div>
              <div className="mt-1 text-xs">请先使用「人设」「大纲」工具生成内容</div>
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            minZoom={0.3}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls />
            <MiniMap nodeStrokeWidth={3} zoomable pannable className="!bg-background !border-border" />
          </ReactFlow>
        )}

        {/* 详情浮层 */}
        {selectedNodeData && (
          <div className="absolute right-4 bottom-4 left-4 z-10 rounded-lg border bg-background/95 p-4 shadow-xl backdrop-blur-sm">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <div className="font-bold text-foreground text-sm">
                  {"emoji" in selectedNodeData.data
                    ? `${(selectedNodeData.data as CharacterNodeData).emoji} ${(selectedNodeData.data as CharacterNodeData).name}`
                    : "beatType" in selectedNodeData.data
                      ? (selectedNodeData.data as PlotNodeData).label
                      : `${(selectedNodeData.data as ForeshadowNodeData).emoji} ${(selectedNodeData.data as ForeshadowNodeData).label}`}
                </div>

                {/* 角色详情 */}
                {"role" in selectedNodeData.data && (
                  <div className="mt-1 space-y-1">
                    <div className="text-muted-foreground text-xs">
                      <span className="font-medium">性格：</span>
                      {(selectedNodeData.data as CharacterNodeData).personality || "未设定"}
                    </div>
                    {(selectedNodeData.data as CharacterNodeData).summary && (
                      <div className="text-muted-foreground text-xs">
                        <span className="font-medium">简介：</span>
                        {(selectedNodeData.data as CharacterNodeData).summary}
                      </div>
                    )}
                  </div>
                )}

                {/* 剧情详情 */}
                {"beatType" in selectedNodeData.data && (
                  <div className="mt-1 space-y-1">
                    {(selectedNodeData.data as PlotNodeData).chapter && (
                      <div className="text-muted-foreground text-xs">
                        {(selectedNodeData.data as PlotNodeData).chapter}
                      </div>
                    )}
                    <div className="text-muted-foreground text-xs">
                      {(selectedNodeData.data as PlotNodeData).summary}
                    </div>
                  </div>
                )}

                {/* 伏笔详情 */}
                {"status" in selectedNodeData.data && (
                  <div className="mt-1 space-y-1">
                    <div className="text-muted-foreground text-xs">
                      {(selectedNodeData.data as ForeshadowNodeData).description}
                    </div>
                    {(selectedNodeData.data as ForeshadowNodeData).relatedChars.length > 0 && (
                      <div className="text-muted-foreground text-xs">
                        关联角色：{(selectedNodeData.data as ForeshadowNodeData).relatedChars.join("、")}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                className="ml-2 shrink-0 text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 导出组件 ──

interface StoryMapPanelProps {
  novelData: NovelData;
}

export function StoryMapPanel({ novelData }: StoryMapPanelProps) {
  return (
    <ReactFlowProvider>
      <StoryMapInner novelData={novelData} />
    </ReactFlowProvider>
  );
}
