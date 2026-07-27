"use client";

import type { Edge, Node } from "@xyflow/react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import { create } from "zustand";

// ── 可视化节点类型 ──

/** 角色节点数据 */
export interface CharacterNodeData {
  name: string;
  role: string;
  personality: string;
  emoji: string;
  summary: string;
  [key: string]: unknown;
}

/** 剧情节点数据 */
export interface PlotNodeData {
  label: string;
  chapter: string;
  summary: string;
  beatType: string;
  index: number;
  [key: string]: unknown;
}

/** 伏笔节点数据 */
export interface ForeshadowNodeData {
  label: string;
  description: string;
  status: string; // planted / hinted / revealed / resolved
  relatedChars: string[];
  emoji: string;
  [key: string]: unknown;
}

/** 关系边数据 */
export interface RelationEdgeData {
  label: string;
  relationType: string;
  [key: string]: unknown;
}

// ── 颜色映射 ──

export const RELATION_COLORS: Record<string, string> = {
  love: "#f472b6",
  ally: "#34d399",
  rival: "#fbbf24",
  enemy: "#ef4444",
  family: "#60a5fa",
  foreshadow: "#a78bfa",
  default: "#9ca3af",
};

const BEAT_COLORS: Record<string, string> = {
  "Opening Image": "#818cf8",
  Setup: "#6366f1",
  Catalyst: "#f59e0b",
  Debate: "#f97316",
  "Break into Two": "#10b981",
  "B Story": "#60a5fa",
  "Fun and Games": "#8b5cf6",
  Midpoint: "#ec4899",
  "Bad Guys Close In": "#ef4444",
  "All Is Lost": "#991b1b",
  "Dark Night of the Soul": "#7c3aed",
  "Break into Three": "#14b8a6",
  Finale: "#059669",
  "Final Image": "#6366f1",
  default: "#6b7280",
};

export { BEAT_COLORS };

// ── d3-force 布局引擎 ──

interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
}

function runForceLayout(
  nodes: Array<{ id: string }>,
  edges: Array<{ source: string; target: string }>,
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();

  if (nodes.length === 0) return result;

  // 创建模拟节点
  const simNodes: SimNode[] = nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const r = Math.min(width, height) * 0.3;
    return {
      id: n.id,
      x: width / 2 + r * Math.cos(angle),
      y: height / 2 + r * Math.sin(angle),
    };
  });

  // 创建 link 引用
  const simLinks = edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));

  const simulation = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simLinks)
        .id((d: any) => d.id)
        .distance(180)
        .strength(0.3),
    )
    .force("charge", forceManyBody().strength(-400))
    .force("collide", forceCollide(80))
    .force("center", forceX(width / 2).strength(0.05))
    .force("y", forceY(height / 2).strength(0.05))
    .stop();

  // 运行 120 次 tick
  for (let i = 0; i < 120; i++) simulation.tick();

  // 限制在画布范围内
  for (const node of simNodes) {
    node.x = Math.max(80, Math.min(width - 80, node.x));
    node.y = Math.max(60, Math.min(height - 60, node.y));
    result.set(node.id, { x: node.x, y: node.y });
  }

  return result;
}

// ── 解析函数 ──

/** 从 characters markdown 解析角色列表 */
function parseCharacters(markdown: string): Array<{
  name: string;
  role: string;
  personality: string;
  summary: string;
}> {
  if (!markdown?.trim()) return [];

  const characters: Array<{
    name: string;
    role: string;
    personality: string;
    summary: string;
  }> = [];

  const blocks = markdown.split(/^## /m).filter((b) => b.trim());

  for (const block of blocks) {
    const lines = block.split("\n");
    const nameLine = lines[0]?.trim() || "";
    const name = nameLine
      .replace(/^\d+\.\s*/, "")
      .replace(/\*\*/g, "")
      .trim();

    if (!name || name.length > 50) continue;

    let role = "配角";
    let personality = "";
    const summaryLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes("角色定位") || trimmed.includes("身份") || trimmed.includes("Role")) {
        const val = trimmed.split(/[:：]/)[1]?.trim() || "";
        if (val.includes("主角")) role = "主角";
        else if (val.includes("反派") || val.includes("对手") || val.includes("antagonist")) role = "反派";
        else if (val.includes("龙套") || val.includes("路人") || val.includes("minor")) role = "龙套";
        else role = "配角";
      }
      if (trimmed.includes("性格") || trimmed.includes("Personality")) {
        personality = trimmed.split(/[:：]/)[1]?.trim() || "";
      }
      if (trimmed.startsWith("- ") && trimmed.length > 10) {
        summaryLines.push(trimmed.slice(2));
      }
    }

    characters.push({
      name,
      role,
      personality: personality || summaryLines[0]?.slice(0, 50) || "",
      summary: summaryLines.slice(0, 3).join("；"),
    });
  }

  return characters;
}

/** 从 outline markdown 解析剧情节拍 */
function parsePlotBeats(markdown: string): Array<{
  label: string;
  chapter: string;
  summary: string;
  beatType: string;
}> {
  if (!markdown?.trim()) return [];

  const beats: Array<{
    label: string;
    chapter: string;
    summary: string;
    beatType: string;
  }> = [];

  const blocks = markdown.split(/^#{2,3} /m).filter((b) => b.trim());

  for (const block of blocks) {
    const lines = block.split("\n");
    const titleLine = lines[0]?.trim() || "";

    if (!titleLine || titleLine.length > 100) continue;

    let beatType = "default";
    for (const beat of Object.keys(BEAT_COLORS)) {
      if (titleLine.toLowerCase().includes(beat.toLowerCase())) {
        beatType = beat;
        break;
      }
    }

    const chapterMatch = titleLine.match(/第[一二三四五六七八九十\d]+章/);
    const chapter = chapterMatch?.[0] || "";

    const summaryLines = lines
      .slice(1)
      .filter((l) => l.trim().startsWith("- ") || l.trim().startsWith("* "))
      .map((l) => l.trim().slice(2))
      .slice(0, 2);

    beats.push({
      label: titleLine.replace(/\*\*/g, "").slice(0, 40),
      chapter,
      summary: summaryLines.join("；") || titleLine,
      beatType,
    });
  }

  return beats;
}

/** 从 foreshadowing markdown 解析伏笔 */
function parseForeshadows(markdown: string): Array<{
  label: string;
  description: string;
  status: string;
  relatedChars: string[];
}> {
  if (!markdown?.trim()) return [];

  const foreshadows: Array<{
    label: string;
    description: string;
    status: string;
    relatedChars: string[];
  }> = [];

  const blocks = markdown.split(/^#{2,3} |^[-*] /m).filter((b) => b.trim());

  for (const block of blocks) {
    const lines = block.split("\n");
    const firstLine = lines[0]?.trim() || "";

    if (!firstLine || firstLine.length < 4) continue;

    // 检测状态
    let status = "planted";
    const allText = block.toLowerCase();
    if (allText.includes("揭示") || allText.includes("revealed")) status = "revealed";
    else if (allText.includes("埋") || allText.includes("planted") || allText.includes("铺垫")) status = "planted";
    else if (allText.includes("暗示") || allText.includes("hinted")) status = "hinted";
    else if (allText.includes("收") || allText.includes("resolved") || allText.includes("回收")) status = "resolved";

    // 提取描述
    const descLines = lines
      .slice(1)
      .filter((l) => l.trim().length > 5)
      .slice(0, 2);

    foreshadows.push({
      label: firstLine
        .replace(/[-*]\s*/, "")
        .replace(/\*\*/g, "")
        .slice(0, 30),
      description: descLines.join("；") || firstLine,
      status,
      relatedChars: [],
    });
  }

  return foreshadows.slice(0, 10); // 最多 10 个伏笔
}

/** 从角色描述中推断关系 */
function inferRelations(
  characters: Array<{ name: string; role: string; personality: string; summary: string }>,
  foreshadowing: string,
): Array<{ source: string; target: string; label: string; relationType: string }> {
  const relations: Array<{
    source: string;
    target: string;
    label: string;
    relationType: string;
  }> = [];

  const names = characters.map((c) => c.name);
  const foreshadowLower = (foreshadowing || "").toLowerCase();

  // 主角与所有其他角色默认有关系
  const protagonist = characters.find((c) => c.role === "主角");
  if (protagonist) {
    for (const c of characters) {
      if (c.name === protagonist.name) continue;

      let relationType = "default";
      let label = "关联";

      const summaryLower = (c.summary + c.personality + c.role).toLowerCase();
      if (
        summaryLower.includes("爱") ||
        summaryLower.includes("恋") ||
        summaryLower.includes("love") ||
        summaryLower.includes("情")
      ) {
        relationType = "love";
        label = "恋人";
      } else if (
        summaryLower.includes("敌") ||
        summaryLower.includes("反对") ||
        summaryLower.includes("enemy") ||
        summaryLower.includes("恨")
      ) {
        relationType = "enemy";
        label = "敌对";
      } else if (summaryLower.includes("竞") || summaryLower.includes("对手") || summaryLower.includes("rival")) {
        relationType = "rival";
        label = "竞争";
      } else if (
        summaryLower.includes("家") ||
        summaryLower.includes("父") ||
        summaryLower.includes("母") ||
        summaryLower.includes("兄弟") ||
        summaryLower.includes("姐妹") ||
        summaryLower.includes("family")
      ) {
        relationType = "family";
        label = "家人";
      } else if (c.role === "配角") {
        relationType = "ally";
        label = "盟友";
      }

      relations.push({
        source: protagonist.name,
        target: c.name,
        label,
        relationType,
      });
    }
  }

  // 非主角之间的关系（从伏笔中推断）
  if (foreshadowing) {
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        if (names[i] === protagonist?.name || names[j] === protagonist?.name) continue;
        if (foreshadowLower.includes(names[i].toLowerCase()) && foreshadowLower.includes(names[j].toLowerCase())) {
          const exists = relations.some(
            (r) => (r.source === names[i] && r.target === names[j]) || (r.source === names[j] && r.target === names[i]),
          );
          if (!exists) {
            relations.push({
              source: names[i],
              target: names[j],
              label: "伏笔关联",
              relationType: "foreshadow",
            });
          }
        }
      }
    }
  }

  return relations;
}

// ── Store 定义 ──

interface StoryMapState {
  // 节点和边
  characterNodes: Node<CharacterNodeData>[];
  plotNodes: Node<PlotNodeData>[];
  foreshadowNodes: Node<ForeshadowNodeData>[];
  relationEdges: Edge<RelationEdgeData>[];

  // 选中/高亮
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  highlightedNodeIds: Set<string>;

  // 视图模式
  activeTab: "characters" | "timeline";

  // 操作
  buildFromNovelData: (data: { characters: string; outline: string; foreshadowing: string }) => void;
  setSelectedNode: (id: string | null) => void;
  setHoveredNode: (id: string | null) => void;
  setActiveTab: (tab: "characters" | "timeline") => void;
}

export const useStoryMapStore = create<StoryMapState>((set, get) => ({
  characterNodes: [],
  plotNodes: [],
  foreshadowNodes: [],
  relationEdges: [],
  selectedNodeId: null,
  hoveredNodeId: null,
  highlightedNodeIds: new Set(),
  activeTab: "characters",

  buildFromNovelData: (data) => {
    // 1. 解析角色
    const parsedChars = parseCharacters(data.characters);

    // 2. 解析关系
    const parsedRelations = inferRelations(parsedChars, data.foreshadowing);

    // 3. d3-force 布局
    const charNodeIds = parsedChars.map((c) => `char-${c.name}`);
    const relEdges = parsedRelations.map((r) => ({
      source: `char-${r.source}`,
      target: `char-${r.target}`,
    }));

    const positions = runForceLayout(
      charNodeIds.map((id) => ({ id })),
      relEdges,
      800,
      600,
    );

    const characterNodes: Node<CharacterNodeData>[] = parsedChars.map((char) => {
      const pos = positions.get(`char-${char.name}`) || { x: 400, y: 300 };
      return {
        id: `char-${char.name}`,
        type: "characterNode",
        position: { x: pos.x - 60, y: pos.y - 40 },
        data: {
          name: char.name,
          role: char.role,
          personality: char.personality,
          emoji: char.role === "主角" ? "⭐" : char.role === "反派" ? "🔥" : char.role === "龙套" ? "👤" : "💫",
          summary: char.summary,
        },
      };
    });

    const relationEdges: Edge<RelationEdgeData>[] = parsedRelations.map((rel, i) => ({
      id: `rel-${i}`,
      source: `char-${rel.source}`,
      target: `char-${rel.target}`,
      type: "relationEdge",
      data: {
        label: rel.label,
        relationType: rel.relationType,
      },
      animated: rel.relationType === "love",
    }));

    // 4. 解析剧情节拍
    const parsedBeats = parsePlotBeats(data.outline);
    const plotNodes: Node<PlotNodeData>[] = parsedBeats.map((beat, i) => ({
      id: `plot-${i}`,
      type: "plotNode",
      position: { x: 100 + i * 240, y: 200 },
      data: {
        label: beat.label,
        chapter: beat.chapter,
        summary: beat.summary,
        beatType: beat.beatType,
        index: i,
      },
    }));

    // 5. 解析伏笔
    const parsedForeshadows = parseForeshadows(data.foreshadowing);
    // 将伏笔关联到角色
    for (const fs of parsedForeshadows) {
      const fsText = fs.description.toLowerCase();
      for (const char of parsedChars) {
        if (fsText.includes(char.name.toLowerCase())) {
          fs.relatedChars.push(char.name);
        }
      }
    }

    const foreshadowNodes: Node<ForeshadowNodeData>[] = parsedForeshadows.map((fs, i) => ({
      id: `fs-${i}`,
      type: "foreshadowNode",
      position: { x: 100 + i * 180, y: 450 },
      data: {
        label: fs.label,
        description: fs.description,
        status: fs.status,
        relatedChars: fs.relatedChars,
        emoji: fs.status === "resolved" ? "✅" : fs.status === "revealed" ? "💡" : "🌱",
      },
    }));

    // 6. 伏笔→角色的边
    const foreshadowEdges: Edge<RelationEdgeData>[] = [];
    for (let i = 0; i < parsedForeshadows.length; i++) {
      for (const charName of parsedForeshadows[i].relatedChars) {
        foreshadowEdges.push({
          id: `fs-edge-${i}-${charName}`,
          source: `fs-${i}`,
          target: `char-${charName}`,
          type: "relationEdge",
          data: { label: "伏笔", relationType: "foreshadow" },
          style: { strokeDasharray: "4,4" },
        });
      }
    }

    set({
      characterNodes,
      plotNodes,
      foreshadowNodes,
      relationEdges: [...relationEdges, ...foreshadowEdges],
    });
  },

  setSelectedNode: (id) => {
    const state = get();
    // 计算高亮节点：选中节点的所有邻居
    const highlighted = new Set<string>();
    if (id) {
      highlighted.add(id);
      for (const edge of state.relationEdges) {
        if (edge.source === id) highlighted.add(edge.target);
        if (edge.target === id) highlighted.add(edge.source);
      }
    }
    set({ selectedNodeId: id, highlightedNodeIds: highlighted });
  },

  setHoveredNode: (id) => {
    const state = get();
    const highlighted = new Set<string>();
    if (id) {
      highlighted.add(id);
      for (const edge of state.relationEdges) {
        if (edge.source === id) highlighted.add(edge.target);
        if (edge.target === id) highlighted.add(edge.source);
      }
    }
    set({ hoveredNodeId: id, highlightedNodeIds: highlighted });
  },

  setActiveTab: (tab) => set({ activeTab: tab }),
}));
