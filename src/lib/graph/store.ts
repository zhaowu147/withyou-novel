import "server-only";

import { projectDir, vaultDir } from "@/lib/local/paths";
import { novelsRoot } from "@/lib/runtime/app-paths";
import type {
  GraphEdge,
  GraphFreshness,
  GraphNode,
  GraphReviewStatus,
  GraphSource,
  GraphStage,
  GraphVisibility,
  NodeType,
  Phase,
  StoryEvent,
  StoryGraph,
} from "@/types/graph";

import * as fs from "node:fs";
import * as path from "node:path";

const GRAPH_FILE = "story-graph.json";
const GRAPH_BACKUP_COUNT = 3;
/**
 * 单个实体承载过多直接关系会同时破坏画布可读性与上下文质量。
 * 跨阶段的同一关系应复用一条 edge，并以 stageIds / 事件记录其演变，
 * 而不是为每个阶段复制一条关系。
 */
export const MAX_GRAPH_EDGES_PER_NODE = 200;
export const MAX_GRAPH_STAGES = 10;

function assertGraphEdgeCapacity(edges: GraphEdge[]): void {
  const degrees = new Map<string, number>();
  for (const edge of edges.filter((item) => item.visibility !== "hidden")) {
    if (!edge.source || !edge.target) throw new Error("关系缺少起点或终点");
    if (edge.source === edge.target) throw new Error("关系的起点与终点不能相同");
    for (const nodeId of [edge.source, edge.target]) {
      const next = (degrees.get(nodeId) ?? 0) + 1;
      if (next > MAX_GRAPH_EDGES_PER_NODE) {
        throw new Error(`单个节点最多保留 ${MAX_GRAPH_EDGES_PER_NODE} 条直接关系，请合并重复关系或拆分为势力/事件节点`);
      }
      degrees.set(nodeId, next);
    }
  }
}

function assertStageCapacity(stages: GraphStage[]): void {
  if (stages.length > MAX_GRAPH_STAGES) {
    throw new Error(`每部作品最多创建 ${MAX_GRAPH_STAGES} 个故事阶段`);
  }
}

function graphPath(novelId: string): string {
  return path.join(vaultDir(novelId), GRAPH_FILE);
}

function graphBackupPath(novelId: string, index: number): string {
  const target = graphPath(novelId);
  return index === 0 ? `${target}.bak` : `${target}.bak.${index}`;
}

function legacyPaths(novelId: string): string[] {
  return [path.join(projectDir(novelId), "graph.json"), path.join(novelsRoot(), novelId, "graph.json")];
}

function now(): number {
  return Date.now();
}

function defaultStage(novelId: string): GraphStage {
  return {
    id: `stage_${novelId}_default`,
    name: "默认舞台",
    description: "尚未归入具体叙事舞台的内容",
    order: 0,
    source: "file",
    reviewStatus: "confirmed",
    freshness: "current",
    visibility: "visible",
    lastVerifiedAt: now(),
  };
}

export function createEmptyGraph(novelId: string): StoryGraph {
  const createdAt = now();
  const stage = defaultStage(novelId);
  return {
    version: 3,
    revision: 0,
    id: `graph_${novelId}`,
    novelId,
    stages: [stage],
    nodes: [],
    edges: [],
    events: [],
    activeStageId: stage.id,
    createdAt,
    updatedAt: createdAt,
  };
}

function reviewStatus(value: unknown, source: GraphSource): GraphReviewStatus {
  if (value === "confirmed" || value === "candidate" || value === "conflict" || value === "rejected") {
    return value;
  }
  return source === "ai" || source === "migration" ? "candidate" : "confirmed";
}

function freshness(value: unknown): GraphFreshness {
  return value === "aging" || value === "stale" || value === "superseded" ? value : "current";
}

function visibility(value: unknown): GraphVisibility {
  return value === "hidden" ? "hidden" : "visible";
}

function migrateGraph(novelId: string, value: unknown): StoryGraph {
  const raw = (value || {}) as Partial<StoryGraph> & {
    nodes?: Array<Partial<GraphNode>>;
    edges?: Array<Partial<GraphEdge>>;
  };
  if (Array.isArray(raw.stages) && Array.isArray(raw.events)) {
    const base = createEmptyGraph(novelId);
    const stages = raw.stages.map((stage) => {
      const source = stage.source || "migration";
      return {
        ...stage,
        source,
        reviewStatus: reviewStatus(stage.reviewStatus, source),
        freshness: freshness(stage.freshness),
        visibility: visibility(stage.visibility),
        lastVerifiedAt: stage.lastVerifiedAt || raw.updatedAt || now(),
        evidence: Array.isArray(stage.evidence) ? stage.evidence : [],
        metadata: stage.metadata || {},
      } as GraphStage;
    });
    const nodes = (raw.nodes || []).map((node) => {
      const source = node.source || "migration";
      return {
        ...node,
        source,
        reviewStatus: reviewStatus(node.reviewStatus, source),
        freshness: freshness(node.freshness),
        visibility: visibility(node.visibility),
        lastVerifiedAt: node.lastVerifiedAt || raw.updatedAt || now(),
        evidence: Array.isArray(node.evidence) ? node.evidence : [],
        metadata: node.metadata || {},
      } as GraphNode;
    });
    const edges = (raw.edges || []).map((edge) => {
      const sourceKind = edge.sourceKind || "migration";
      return {
        ...edge,
        sourceKind,
        reviewStatus: reviewStatus(edge.reviewStatus, sourceKind),
        freshness: freshness(edge.freshness),
        visibility: visibility(edge.visibility),
        lastVerifiedAt: edge.lastVerifiedAt || raw.updatedAt || now(),
        evidence: Array.isArray(edge.evidence) ? edge.evidence : [],
        metadata: edge.metadata || {},
      } as GraphEdge;
    });
    const events = raw.events.map((event) => {
      const source = event.source || "migration";
      return {
        ...event,
        source,
        reviewStatus: reviewStatus(event.reviewStatus, source),
        freshness: freshness(event.freshness),
        visibility: visibility(event.visibility),
        lastVerifiedAt: event.lastVerifiedAt || raw.updatedAt || now(),
        evidence: Array.isArray(event.evidence) ? event.evidence : [],
        metadata: event.metadata || {},
      } as StoryEvent;
    });
    return {
      ...base,
      ...raw,
      version: 3,
      revision: Number.isInteger(raw.revision) && Number(raw.revision) >= 0 ? Number(raw.revision) : 0,
      novelId,
      stages: stages.length ? stages : base.stages,
      nodes,
      edges,
      events,
    };
  }

  const migrated = createEmptyGraph(novelId);
  const stageId = migrated.stages[0].id;
  migrated.nodes = (raw.nodes || []).map((node, index) => ({
    id: node.id || `migration_node_${index}`,
    type: node.type || "other",
    name: node.name || `未命名节点 ${index + 1}`,
    description: node.description || "",
    stageIds: Array.isArray(node.stageIds) ? node.stageIds : [stageId],
    source: node.source || "migration",
    reviewStatus: "candidate",
    freshness: "current",
    visibility: "visible",
    lastVerifiedAt: now(),
    confidence: node.confidence,
    evidence: Array.isArray(node.evidence) ? node.evidence : [],
    metadata: node.metadata || {},
    layout: node.layout,
    phase: node.phase,
    layer: node.layer,
  }));
  migrated.edges = (raw.edges || []).map((edge, index) => ({
    id: edge.id || `migration_edge_${index}`,
    source: edge.source || "",
    target: edge.target || "",
    relation: edge.relation || "关联",
    relationType: edge.relationType,
    directed: edge.directed,
    weight: edge.weight || 5,
    stageIds: Array.isArray(edge.stageIds) ? edge.stageIds : [stageId],
    sourceKind: edge.sourceKind || "migration",
    reviewStatus: "candidate",
    freshness: "current",
    visibility: "visible",
    lastVerifiedAt: now(),
    confidence: edge.confidence,
    evidence: Array.isArray(edge.evidence) ? edge.evidence : [],
    metadata: edge.metadata || {},
  }));
  migrated.center = raw.center;
  migrated.createdAt = raw.createdAt || migrated.createdAt;
  migrated.updatedAt = now();
  return migrated;
}

function readGraphCandidate(filePath: string, novelId: string): StoryGraph | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return null;
    }
    return migrateGraph(novelId, parsed);
  } catch {
    return null;
  }
}

function writeTemporary(target: string, content: string): string {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(handle, content, "utf-8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return temporary;
}

function replaceWithTemporary(target: string, temporary: string): void {
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function rotateGraphBackups(novelId: string): void {
  for (let index = GRAPH_BACKUP_COUNT - 1; index >= 1; index--) {
    const source = graphBackupPath(novelId, index - 1);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, graphBackupPath(novelId, index));
  }
  const target = graphPath(novelId);
  if (!readGraphCandidate(target, novelId)) return;
  const backup = graphBackupPath(novelId, 0);
  const temporary = writeTemporary(backup, fs.readFileSync(target, "utf-8"));
  replaceWithTemporary(backup, temporary);
}

function preserveCorruptGraph(novelId: string): void {
  const target = graphPath(novelId);
  if (!fs.existsSync(target)) return;
  fs.renameSync(target, `${target}.corrupt.${Date.now()}`);
  const directory = path.dirname(target);
  const prefix = `${path.basename(target)}.corrupt.`;
  const corrupt = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();
  for (const stale of corrupt.slice(2)) {
    fs.rmSync(path.join(directory, stale), { force: true });
  }
}

function writeRecoveredGraph(novelId: string, graph: StoryGraph): void {
  const target = graphPath(novelId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = writeTemporary(target, JSON.stringify(graph, null, 2));
  replaceWithTemporary(target, temporary);
}

export async function getGraph(novelId: string): Promise<StoryGraph | null> {
  const target = graphPath(novelId);
  const current = readGraphCandidate(target, novelId);
  if (current) return migrateGraph(novelId, current);

  if (fs.existsSync(target)) preserveCorruptGraph(novelId);
  for (let index = 0; index < GRAPH_BACKUP_COUNT; index++) {
    const recovered = readGraphCandidate(graphBackupPath(novelId, index), novelId);
    if (!recovered) continue;
    writeRecoveredGraph(novelId, recovered);
    return recovered;
  }

  for (const legacyPath of legacyPaths(novelId)) {
    const legacy = readGraphCandidate(legacyPath, novelId);
    if (!legacy) continue;
    const migrated = migrateGraph(novelId, legacy);
    await saveGraph(migrated);
    return migrated;
  }
  return null;
}

export async function getOrCreateGraph(novelId: string): Promise<StoryGraph> {
  const existing = await getGraph(novelId);
  if (existing) return existing;
  const graph = createEmptyGraph(novelId);
  await saveGraph(graph);
  return graph;
}

export async function saveGraph(graph: StoryGraph, options: { createRecoveryPoint?: boolean } = {}): Promise<void> {
  const target = graphPath(graph.novelId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  graph.version = 3;
  assertStageCapacity(graph.stages);
  assertGraphEdgeCapacity(graph.edges);
  const current = readGraphCandidate(target, graph.novelId);
  if (current && current.revision !== graph.revision) {
    throw new Error("图谱已被其他操作更新，请重新载入后再保存");
  }
  graph.updatedAt = now();
  graph.revision = (current?.revision ?? graph.revision) + 1;
  const next: StoryGraph = { ...graph, novelId: graph.novelId };
  const serialized = JSON.stringify(next, null, 2);
  migrateGraph(graph.novelId, JSON.parse(serialized));
  if (options.createRecoveryPoint !== false) rotateGraphBackups(graph.novelId);
  const temporary = writeTemporary(target, serialized);
  replaceWithTemporary(target, temporary);
}

export async function createGraph(novelId: string, centerNode: GraphNode): Promise<StoryGraph> {
  const graph = createEmptyGraph(novelId);
  graph.nodes = [
    {
      ...centerNode,
      stageIds: centerNode.stageIds.length ? centerNode.stageIds : [graph.stages[0].id],
      source: centerNode.source,
      evidence: centerNode.evidence,
      metadata: centerNode.metadata,
    },
  ];
  graph.center = centerNode.id;
  await saveGraph(graph);
  return graph;
}

export async function addNode(novelId: string, node: GraphNode): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  if (graph.nodes.some((item) => item.id === node.id)) throw new Error("节点已存在");
  graph.nodes.push(node);
  await saveGraph(graph);
  return graph;
}

export async function updateNode(novelId: string, nodeId: string, updates: Partial<GraphNode>): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  const index = graph.nodes.findIndex((item) => item.id === nodeId);
  if (index < 0) throw new Error("节点不存在");
  graph.nodes[index] = { ...graph.nodes[index], ...updates, id: nodeId };
  await saveGraph(graph);
  return graph;
}

export async function removeNode(novelId: string, nodeId: string): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("节点不存在");
  node.visibility = "hidden";
  node.lastVerifiedAt = now();
  if (graph.center === nodeId) graph.center = undefined;
  await saveGraph(graph);
  return graph;
}

export async function addEdge(novelId: string, edge: GraphEdge): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  if (graph.edges.some((item) => item.id === edge.id)) throw new Error("关系已存在");
  assertGraphEdgeCapacity([...graph.edges, edge]);
  graph.edges.push(edge);
  await saveGraph(graph);
  return graph;
}

export async function updateEdge(novelId: string, edgeId: string, updates: Partial<GraphEdge>): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  const index = graph.edges.findIndex((item) => item.id === edgeId);
  if (index < 0) throw new Error("关系不存在");
  const nextEdge = { ...graph.edges[index], ...updates, id: edgeId };
  assertGraphEdgeCapacity(graph.edges.map((edge, itemIndex) => (itemIndex === index ? nextEdge : edge)));
  graph.edges[index] = nextEdge;
  await saveGraph(graph);
  return graph;
}

export async function removeEdge(novelId: string, edgeId: string): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge) throw new Error("关系不存在");
  edge.visibility = "hidden";
  edge.lastVerifiedAt = now();
  await saveGraph(graph);
  return graph;
}

export async function upsertStage(novelId: string, stage: GraphStage): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  const index = graph.stages.findIndex((item) => item.id === stage.id);
  if (index >= 0) graph.stages[index] = { ...graph.stages[index], ...stage };
  else {
    assertStageCapacity([...graph.stages, stage]);
    graph.stages.push(stage);
  }
  graph.stages.sort((a, b) => a.order - b.order);
  await saveGraph(graph);
  return graph;
}

export async function setGraphActiveStage(novelId: string, stageId: string): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  if (!graph.stages.some((stage) => stage.id === stageId)) throw new Error("故事阶段不存在");
  if (graph.activeStageId === stageId) return graph;
  graph.activeStageId = stageId;
  // 当前舞台属于导航状态；持久化供 AI 构图使用，但不应污染内容恢复点。
  await saveGraph(graph, { createRecoveryPoint: false });
  return graph;
}

export async function removeStage(novelId: string, stageId: string): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  if (graph.stages.length <= 1) throw new Error("至少保留一个舞台");
  graph.stages = graph.stages.filter((item) => item.id !== stageId);
  const fallbackId = graph.stages[0].id;
  graph.nodes = graph.nodes.map((node) => ({
    ...node,
    stageIds: node.stageIds.includes(stageId)
      ? [...node.stageIds.filter((id) => id !== stageId), fallbackId]
      : node.stageIds,
  }));
  graph.edges = graph.edges.map((edge) => ({
    ...edge,
    stageIds: edge.stageIds.filter((id) => id !== stageId),
  }));
  graph.events = graph.events.map((event) => ({
    ...event,
    stageId: event.stageId === stageId ? fallbackId : event.stageId,
  }));
  if (graph.activeStageId === stageId) graph.activeStageId = fallbackId;
  await saveGraph(graph);
  return graph;
}

export async function upsertEvent(novelId: string, event: StoryEvent): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  const index = graph.events.findIndex((item) => item.id === event.id);
  if (index >= 0) graph.events[index] = { ...graph.events[index], ...event };
  else graph.events.push(event);
  await saveGraph(graph);
  return graph;
}

export async function removeEvent(novelId: string, eventId: string): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  const event = graph.events.find((item) => item.id === eventId);
  if (!event) throw new Error("事件不存在");
  event.visibility = "hidden";
  event.lastVerifiedAt = now();
  await saveGraph(graph);
  return graph;
}

export async function replaceGraph(novelId: string, graph: StoryGraph): Promise<StoryGraph> {
  const next = migrateGraph(novelId, { ...graph, novelId, version: 3 });
  assertStageCapacity(next.stages);
  assertGraphEdgeCapacity(next.edges);
  await saveGraph(next);
  return next;
}

export async function restoreGraphItem(
  novelId: string,
  kind: "node" | "edge" | "event",
  id: string,
): Promise<StoryGraph> {
  const graph = await getOrCreateGraph(novelId);
  const collection = kind === "node" ? graph.nodes : kind === "edge" ? graph.edges : graph.events;
  const item = collection.find((candidate) => candidate.id === id);
  if (!item) throw new Error("图谱信息不存在");
  item.visibility = "visible";
  item.lastVerifiedAt = now();
  await saveGraph(graph);
  return graph;
}

export function listGraphRecoveryPoints(
  novelId: string,
): Array<{ index: number; updatedAt: string; revision: number }> {
  const points: Array<{ index: number; updatedAt: string; revision: number }> = [];
  for (let index = 0; index < GRAPH_BACKUP_COUNT; index++) {
    const filePath = graphBackupPath(novelId, index);
    const graph = readGraphCandidate(filePath, novelId);
    if (!graph) continue;
    points.push({
      index,
      updatedAt: fs.statSync(filePath).mtime.toISOString(),
      revision: graph.revision,
    });
  }
  return points;
}

export async function restoreGraphRecoveryPoint(novelId: string, index: number): Promise<StoryGraph> {
  if (!Number.isInteger(index) || index < 0 || index >= GRAPH_BACKUP_COUNT) {
    throw new Error("图谱恢复点无效");
  }
  const recovered = readGraphCandidate(graphBackupPath(novelId, index), novelId);
  if (!recovered) throw new Error("图谱恢复点不存在或已损坏");
  const current = await getOrCreateGraph(novelId);
  recovered.revision = current.revision;
  await saveGraph(recovered);
  return recovered;
}

export async function getNodesByLayer(novelId: string, layer: number): Promise<GraphNode[]> {
  return (await getOrCreateGraph(novelId)).nodes.filter((node) => node.layer === layer);
}

export async function getNodesByPhase(novelId: string, phase: Phase): Promise<GraphNode[]> {
  return (await getOrCreateGraph(novelId)).nodes.filter((node) => node.phase === phase);
}

export async function getNodeConnections(
  novelId: string,
  nodeId: string,
): Promise<{ incoming: GraphEdge[]; outgoing: GraphEdge[] }> {
  const graph = await getOrCreateGraph(novelId);
  return {
    incoming: graph.edges.filter((edge) => edge.target === nodeId),
    outgoing: graph.edges.filter((edge) => edge.source === nodeId),
  };
}

export function generateNodeId(type: NodeType, name: string): string {
  const slug = name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
  return `${type}_${slug || "node"}_${now().toString(36)}`;
}

export function generateEdgeId(source: string, target: string): string {
  // 同一对节点可同时存在多种关系（例如师徒、敌对、利益合作），不能以节点对作为唯一键。
  return `edge_${source}_${target}_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateStageId(name: string): string {
  const slug = name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
  return `stage_${slug || "stage"}_${now().toString(36)}`;
}

export function generateEventId(title: string): string {
  const slug = title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
  return `event_${slug || "event"}_${now().toString(36)}`;
}
