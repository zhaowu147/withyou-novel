import type { GraphLayerKey, NodeType } from "@/types/graph";

export interface GraphLayerDefinition {
  key: GraphLayerKey;
  label: string;
  shortLabel: string;
  description: string;
  color: string;
  defaultEnabled: boolean;
  kind: "node" | "edge" | "event" | "derived";
  nodeTypes?: NodeType[];
}

export const GRAPH_LAYER_REGISTRY: Record<GraphLayerKey, GraphLayerDefinition> = {
  characters: {
    key: "characters",
    label: "人物",
    shortLabel: "人",
    description: "人物及其在当前章节的状态",
    color: "#6366f1",
    defaultEnabled: true,
    kind: "node",
    nodeTypes: ["character"],
  },
  factions: {
    key: "factions",
    label: "势力",
    shortLabel: "势",
    description: "宗门、组织、国家与阵营",
    color: "#ef4444",
    defaultEnabled: true,
    kind: "node",
    nodeTypes: ["faction"],
  },
  locations: {
    key: "locations",
    label: "地点",
    shortLabel: "地",
    description: "城市、秘境、星域与场景位置",
    color: "#10b981",
    defaultEnabled: true,
    kind: "node",
    nodeTypes: ["location"],
  },
  items: {
    key: "items",
    label: "物品",
    shortLabel: "物",
    description: "关键物品、装备与能力载体",
    color: "#f59e0b",
    defaultEnabled: true,
    kind: "node",
    nodeTypes: ["item"],
  },
  concepts: {
    key: "concepts",
    label: "概念",
    shortLabel: "理",
    description: "规则、能力体系与核心概念",
    color: "#8b5cf6",
    defaultEnabled: false,
    kind: "node",
    nodeTypes: ["concept"],
  },
  others: {
    key: "others",
    label: "其他",
    shortLabel: "其",
    description: "暂未归类的故事实体",
    color: "#64748b",
    defaultEnabled: false,
    kind: "node",
    nodeTypes: ["other", "event"],
  },
  relations: {
    key: "relations",
    label: "关系",
    shortLabel: "线",
    description: "人物、势力和地点之间的关系",
    color: "#94a3b8",
    defaultEnabled: true,
    kind: "edge",
  },
  events: {
    key: "events",
    label: "事件",
    shortLabel: "事",
    description: "按章节发生的关键事件",
    color: "#ec4899",
    defaultEnabled: true,
    kind: "event",
  },
  foreshadows: {
    key: "foreshadows",
    label: "伏笔",
    shortLabel: "伏",
    description: "节点关联的待回收与已回收伏笔",
    color: "#06b6d4",
    defaultEnabled: false,
    kind: "derived",
  },
};

export const DEFAULT_GRAPH_LAYERS = (Object.values(GRAPH_LAYER_REGISTRY) as GraphLayerDefinition[])
  .filter((layer) => layer.defaultEnabled)
  .map((layer) => layer.key);

export function graphLayerForNodeType(type: NodeType): GraphLayerKey {
  const matched = (Object.values(GRAPH_LAYER_REGISTRY) as GraphLayerDefinition[]).find((layer) =>
    layer.nodeTypes?.includes(type),
  );
  return matched?.key ?? "others";
}
