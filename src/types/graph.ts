/**
 * 故事知识图谱数据结构。
 *
 * 舞台（stage）是自由命名的叙事范围，可以是国家、城市、宗门、秘境、
 * 世界、星域或任何作者定义的空间/篇章，不预设现实地图语义。
 */

export type NodeType = "character" | "faction" | "location" | "item" | "event" | "concept" | "other";

export type GraphSource = "user" | "ai" | "vault" | "file" | "migration";
export type GraphReviewStatus = "confirmed" | "candidate" | "conflict" | "rejected";
export type GraphFreshness = "current" | "aging" | "stale" | "superseded";
export type GraphVisibility = "visible" | "hidden";
export type GraphLayerKey =
  | "characters"
  | "factions"
  | "locations"
  | "items"
  | "concepts"
  | "others"
  | "relations"
  | "events"
  | "foreshadows";

/** 兼容旧图谱；新图谱使用章节区间和舞台，不再依赖固定三阶段。 */
export type Phase = "early" | "middle" | "late";

export interface GraphEvidence {
  id: string;
  sourceType: "chapter" | "outline" | "setting" | "entity" | "foreshadow" | "user";
  sourcePath?: string;
  chapter?: number;
  excerpt?: string;
  contentHash?: string;
  status?: "active" | "superseded" | "conflict";
  createdAt: number;
}

export interface GraphLayout {
  x: number;
  y: number;
  pinned?: boolean;
}

export interface GraphStage {
  id: string;
  name: string;
  description: string;
  parentId?: string | null;
  order: number;
  color?: string;
  chapterStart?: number;
  chapterEnd?: number;
  source: GraphSource;
  reviewStatus?: GraphReviewStatus;
  freshness?: GraphFreshness;
  visibility?: GraphVisibility;
  lastVerifiedAt?: number;
  confidence?: number;
  evidence?: GraphEvidence[];
  metadata?: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  stageIds: string[];
  firstChapter?: number;
  lastChapter?: number;
  status?: string;
  source: GraphSource;
  reviewStatus?: GraphReviewStatus;
  freshness?: GraphFreshness;
  visibility?: GraphVisibility;
  lastVerifiedAt?: number;
  confidence?: number;
  evidence: GraphEvidence[];
  layout?: GraphLayout;
  metadata: Record<string, unknown>;
  /** legacy compatibility */
  phase?: Phase;
  /** legacy compatibility */
  layer?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  relationType?: string;
  directed?: boolean;
  weight: number;
  stageIds: string[];
  chapterStart?: number;
  chapterEnd?: number;
  sourceKind: GraphSource;
  reviewStatus?: GraphReviewStatus;
  freshness?: GraphFreshness;
  visibility?: GraphVisibility;
  lastVerifiedAt?: number;
  confidence?: number;
  evidence: GraphEvidence[];
  metadata?: Record<string, unknown>;
}

export interface RelationshipChange {
  sourceNodeId: string;
  targetNodeId: string;
  before?: string;
  after: string;
}

export interface StoryEvent {
  id: string;
  title: string;
  summary: string;
  stageId?: string | null;
  chapterStart?: number;
  chapterEnd?: number;
  participantIds: string[];
  locationIds: string[];
  factionIds: string[];
  relationshipChanges: RelationshipChange[];
  source: GraphSource;
  reviewStatus?: GraphReviewStatus;
  freshness?: GraphFreshness;
  visibility?: GraphVisibility;
  lastVerifiedAt?: number;
  confidence?: number;
  evidence: GraphEvidence[];
  layout?: GraphLayout;
  metadata?: Record<string, unknown>;
}

export interface StoryGraph {
  version: 3;
  revision: number;
  id: string;
  novelId: string;
  stages: GraphStage[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  events: StoryEvent[];
  center?: string;
  activeStageId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export const NODE_TYPE_CONFIG: Record<NodeType, { color: string; icon: string; label: string }> = {
  character: { color: "#6366f1", icon: "人", label: "人物" },
  faction: { color: "#ef4444", icon: "势", label: "势力" },
  location: { color: "#10b981", icon: "地", label: "地点" },
  item: { color: "#f59e0b", icon: "物", label: "物品" },
  event: { color: "#ec4899", icon: "事", label: "事件" },
  concept: { color: "#8b5cf6", icon: "理", label: "概念" },
  other: { color: "#64748b", icon: "·", label: "其他" },
};

export const PHASE_CONFIG: Record<Phase, { label: string; description: string }> = {
  early: { label: "前期", description: "兼容旧图谱阶段" },
  middle: { label: "中期", description: "兼容旧图谱阶段" },
  late: { label: "后期", description: "兼容旧图谱阶段" },
};
