import type { NextRequest } from "next/server";

import { getApiUser } from "@/lib/api/auth";
import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api/response";
import { syncGraphFromVault } from "@/lib/graph/extractor";
import {
  addEdge,
  addNode,
  generateEdgeId,
  generateEventId,
  generateNodeId,
  generateStageId,
  getOrCreateGraph,
  listGraphRecoveryPoints,
  removeEdge,
  removeEvent,
  removeNode,
  removeStage,
  replaceGraph,
  restoreGraphItem,
  restoreGraphRecoveryPoint,
  setGraphActiveStage,
  updateEdge,
  updateNode,
  upsertEvent,
  upsertStage,
} from "@/lib/graph/store";
import { getEntity, upsertEntity, upsertTimelineEvent } from "@/lib/local/store";
import { resolveWorkspaceProjectScope, workspaceErrorResponse } from "@/lib/workspaces/ownership";
import type {
  GraphEdge,
  GraphNode,
  GraphReviewStatus,
  GraphStage,
  NodeType,
  StoryEvent,
  StoryGraph,
} from "@/types/graph";

function entityType(type: NodeType) {
  return type === "concept" ? ("other" as const) : type;
}

async function syncNodeToEntity(novelId: string, node: GraphNode): Promise<GraphNode> {
  const entityId = typeof node.metadata.entityId === "string" ? node.metadata.entityId : undefined;
  const current = entityId ? getEntity(novelId, entityId) : null;
  const entity = await upsertEntity({
    ...(current ?? {}),
    id: entityId,
    novel_id: novelId,
    name: node.name,
    type: entityType(node.type),
    summary: node.description,
    active_state: node.status ?? current?.active_state,
    last_chapter: node.lastChapter ?? node.firstChapter,
    metadata: {
      ...(current?.metadata ?? {}),
      graphNodeId: node.id,
      hiddenFromGraph: false,
    },
  });
  return { ...node, metadata: { ...node.metadata, entityId: entity.id } };
}

export async function GET(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  try {
    const { projectId } = resolveWorkspaceProjectScope(req, req.nextUrl.searchParams.get("novelId"), "story-graph");
    const sync = req.nextUrl.searchParams.get("sync") !== "false";
    const graph = sync ? await syncGraphFromVault(projectId) : await getOrCreateGraph(projectId);
    return apiSuccess({ graph, recoveryPoints: listGraphRecoveryPoints(projectId) });
  } catch (error) {
    return workspaceErrorResponse(error) ?? apiError("图谱加载失败", 500);
  }
}

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  const body = (await req.json()) as {
    novelId?: string;
    centerName?: string;
    centerDescription?: string;
  };
  try {
    const { projectId } = resolveWorkspaceProjectScope(req, body.novelId, "story-graph");
    const graph = await getOrCreateGraph(projectId);
    if (body.centerName && !graph.center) {
      const node: GraphNode = {
        id: generateNodeId("character", body.centerName),
        type: "character",
        name: body.centerName,
        description: body.centerDescription ?? "主角",
        stageIds: [graph.activeStageId ?? graph.stages[0].id],
        source: "user",
        reviewStatus: "confirmed",
        freshness: "current",
        visibility: "visible",
        lastVerifiedAt: Date.now(),
        evidence: [],
        metadata: {},
      };
      graph.nodes.push(node);
      graph.center = node.id;
      return apiSuccess({ graph: await replaceGraph(projectId, graph) });
    }
    return apiSuccess({ graph });
  } catch (error) {
    return workspaceErrorResponse(error) ?? apiError("图谱创建失败", 500);
  }
}

export async function PUT(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return apiUnauthorized();
  const body = (await req.json()) as Record<string, unknown>;
  const requestedNovelId = typeof body.novelId === "string" ? body.novelId : "";
  const action = typeof body.action === "string" ? body.action : "";

  try {
    const { projectId: novelId, isWorkspaceDraft } = resolveWorkspaceProjectScope(req, requestedNovelId, "story-graph");
    switch (action) {
      case "replace":
        return apiSuccess({
          graph: await replaceGraph(novelId, body.graph as StoryGraph),
        });
      case "add-node": {
        const input = body.node as Partial<GraphNode> | undefined;
        if (!input?.name) return apiError("节点名称不能为空", 400);
        const graph = await getOrCreateGraph(novelId);
        const candidate: GraphNode = {
          id: input.id || generateNodeId((input.type as NodeType) || "other", input.name),
          type: (input.type as NodeType) || "other",
          name: input.name,
          description: input.description || "",
          stageIds: input.stageIds?.length ? input.stageIds : [graph.activeStageId || graph.stages[0].id],
          firstChapter: input.firstChapter,
          lastChapter: input.lastChapter,
          status: input.status,
          source: "user",
          reviewStatus: "confirmed",
          freshness: "current",
          visibility: "visible",
          lastVerifiedAt: Date.now(),
          evidence: input.evidence || [],
          layout: input.layout,
          metadata: input.metadata || {},
        };
        const node = isWorkspaceDraft ? candidate : await syncNodeToEntity(novelId, candidate);
        return apiSuccess({ graph: await addNode(novelId, node), node });
      }
      case "update-node": {
        const nodeId = String(body.nodeId || "");
        const updates = {
          ...(body.updates as Partial<GraphNode>),
          source: "user" as const,
          reviewStatus: "confirmed" as const,
          freshness: "current" as const,
          visibility: "visible" as const,
          lastVerifiedAt: Date.now(),
        };
        let graph = await updateNode(novelId, nodeId, updates);
        const node = graph.nodes.find((item) => item.id === nodeId);
        if (node && !isWorkspaceDraft) {
          const synced = await syncNodeToEntity(novelId, node);
          graph = await updateNode(novelId, nodeId, { metadata: synced.metadata });
        }
        return apiSuccess({ graph });
      }
      case "update-node-layout": {
        const nodeId = String(body.nodeId || "");
        const graph = await getOrCreateGraph(novelId);
        const node = graph.nodes.find((item) => item.id === nodeId);
        if (!node) return apiError("节点不存在", 404);
        const input = (body.updates || {}) as Partial<GraphNode>;
        const stageLayouts =
          input.metadata?.stageLayouts && typeof input.metadata.stageLayouts === "object"
            ? input.metadata.stageLayouts
            : node.metadata.stageLayouts;
        return apiSuccess({
          graph: await updateNode(novelId, nodeId, {
            layout: input.layout,
            metadata: { ...node.metadata, stageLayouts },
          }),
        });
      }
      case "remove-node": {
        const nodeId = String(body.nodeId || "");
        const graph = await getOrCreateGraph(novelId);
        const node = graph.nodes.find((item) => item.id === nodeId);
        const entityId =
          !isWorkspaceDraft && typeof node?.metadata.entityId === "string" ? node.metadata.entityId : undefined;
        const entity = entityId ? getEntity(novelId, entityId) : null;
        if (entity) {
          await upsertEntity({
            ...entity,
            novel_id: novelId,
            name: entity.name,
            metadata: { ...(entity.metadata ?? {}), hiddenFromGraph: true },
          });
        }
        return apiSuccess({ graph: await removeNode(novelId, nodeId) });
      }
      case "add-edge": {
        const input = body.edge as Partial<GraphEdge> | undefined;
        if (!input?.source || !input.target) return apiError("关系缺少起点或终点", 400);
        const graph = await getOrCreateGraph(novelId);
        const edge: GraphEdge = {
          id: input.id || generateEdgeId(input.source, input.target),
          source: input.source,
          target: input.target,
          relation: input.relation || "关联",
          relationType: input.relationType,
          directed: input.directed,
          weight: input.weight || 5,
          stageIds: input.stageIds?.length ? input.stageIds : [graph.activeStageId || graph.stages[0].id],
          chapterStart: input.chapterStart,
          chapterEnd: input.chapterEnd,
          sourceKind: "user",
          reviewStatus: "confirmed",
          freshness: "current",
          visibility: "visible",
          lastVerifiedAt: Date.now(),
          evidence: input.evidence || [],
          metadata: input.metadata || {},
        };
        return apiSuccess({ graph: await addEdge(novelId, edge), edge });
      }
      case "update-edge":
        return apiSuccess({
          graph: await updateEdge(novelId, String(body.edgeId || ""), {
            ...(body.updates as Partial<GraphEdge>),
            sourceKind: "user",
            reviewStatus: "confirmed",
            freshness: "current",
            visibility: "visible",
            lastVerifiedAt: Date.now(),
          }),
        });
      case "remove-edge":
        return apiSuccess({ graph: await removeEdge(novelId, String(body.edgeId || "")) });
      case "upsert-stage": {
        const input = body.stage as Partial<GraphStage> | undefined;
        if (!input?.name) return apiError("舞台名称不能为空", 400);
        const graph = await getOrCreateGraph(novelId);
        const stage: GraphStage = {
          id: input.id || generateStageId(input.name),
          name: input.name,
          description: input.description || "",
          parentId: input.parentId,
          order: input.order ?? graph.stages.length,
          color: input.color,
          chapterStart: input.chapterStart,
          chapterEnd: input.chapterEnd,
          source: "user",
          reviewStatus: "confirmed",
          freshness: "current",
          visibility: "visible",
          lastVerifiedAt: Date.now(),
          evidence: input.evidence || [],
          metadata: input.metadata || {},
        };
        return apiSuccess({ graph: await upsertStage(novelId, stage), stage });
      }
      case "set-active-stage":
        return apiSuccess({
          graph: await setGraphActiveStage(novelId, String(body.stageId || "")),
        });
      case "remove-stage":
        return apiSuccess({ graph: await removeStage(novelId, String(body.stageId || "")) });
      case "upsert-event": {
        const input = body.event as Partial<StoryEvent> | undefined;
        if (!input?.title) return apiError("事件标题不能为空", 400);
        const timelineId = typeof input.metadata?.timelineId === "string" ? input.metadata.timelineId : undefined;
        const participantName = input.participantIds?.length
          ? (await getOrCreateGraph(novelId)).nodes.find((node) => node.id === input.participantIds?.[0])?.name
          : undefined;
        const timeline = isWorkspaceDraft
          ? null
          : await upsertTimelineEvent(novelId, {
              id: timelineId,
              entityName: participantName,
              chapter: input.chapterStart,
              description: input.summary || input.title,
            });
        const event: StoryEvent = {
          id: input.id || generateEventId(input.title),
          title: input.title,
          summary: input.summary || "",
          stageId: input.stageId,
          chapterStart: input.chapterStart,
          chapterEnd: input.chapterEnd,
          participantIds: input.participantIds || [],
          locationIds: input.locationIds || [],
          factionIds: input.factionIds || [],
          relationshipChanges: input.relationshipChanges || [],
          source: "user",
          reviewStatus: "confirmed",
          freshness: "current",
          visibility: "visible",
          lastVerifiedAt: Date.now(),
          evidence: input.evidence || [],
          layout: input.layout,
          metadata: {
            ...(input.metadata || {}),
            ...(timeline ? { timelineId: timeline.id } : {}),
          },
        };
        return apiSuccess({ graph: await upsertEvent(novelId, event), event });
      }
      case "update-event-layout": {
        const eventId = String(body.eventId || "");
        const graph = await getOrCreateGraph(novelId);
        const event = graph.events.find((item) => item.id === eventId);
        if (!event) return apiError("事件不存在", 404);
        const layout = (body.layout || undefined) as StoryEvent["layout"];
        return apiSuccess({ graph: await upsertEvent(novelId, { ...event, layout }) });
      }
      case "remove-event": {
        const eventId = String(body.eventId || "");
        return apiSuccess({ graph: await removeEvent(novelId, eventId) });
      }
      case "restore-item": {
        const kind = body.kind;
        if (kind !== "node" && kind !== "edge" && kind !== "event") {
          return apiError("图谱信息类型无效", 400);
        }
        const graph = await restoreGraphItem(novelId, kind, String(body.itemId || ""));
        if (kind === "node" && !isWorkspaceDraft) {
          const node = graph.nodes.find((item) => item.id === String(body.itemId || ""));
          const entityId = typeof node?.metadata.entityId === "string" ? node.metadata.entityId : undefined;
          const entity = entityId ? getEntity(novelId, entityId) : null;
          if (entity) {
            await upsertEntity({
              ...entity,
              novel_id: novelId,
              name: entity.name,
              metadata: { ...(entity.metadata ?? {}), hiddenFromGraph: false },
            });
          }
        }
        return apiSuccess({ graph });
      }
      case "review-item": {
        const kind = body.kind;
        const status = body.status as GraphReviewStatus;
        if (
          (kind !== "node" && kind !== "edge" && kind !== "event") ||
          !["confirmed", "candidate", "conflict", "rejected"].includes(status)
        ) {
          return apiError("图谱审查参数无效", 400);
        }
        const itemId = String(body.itemId || "");
        const patch = {
          reviewStatus: status,
          visibility: status === "rejected" ? ("hidden" as const) : ("visible" as const),
          freshness: "current" as const,
          lastVerifiedAt: Date.now(),
        };
        if (kind === "node") {
          let graph = await updateNode(novelId, itemId, patch);
          const node = graph.nodes.find((item) => item.id === itemId);
          if (node && status === "confirmed" && !isWorkspaceDraft) {
            const synced = await syncNodeToEntity(novelId, { ...node, source: "user" });
            graph = await updateNode(novelId, itemId, {
              source: "user",
              metadata: synced.metadata,
            });
          }
          return apiSuccess({ graph });
        }
        if (kind === "edge") {
          return apiSuccess({ graph: await updateEdge(novelId, itemId, patch) });
        }
        const graph = await getOrCreateGraph(novelId);
        const event = graph.events.find((item) => item.id === itemId);
        if (!event) return apiError("事件不存在", 404);
        const nextEvent = { ...event, ...patch };
        if (status === "confirmed" && !isWorkspaceDraft) {
          const participant = graph.nodes.find((node) => node.id === event.participantIds[0]);
          const timeline = await upsertTimelineEvent(novelId, {
            id: typeof event.metadata?.timelineId === "string" ? event.metadata.timelineId : undefined,
            entityName: participant?.name,
            chapter: event.chapterStart,
            description: event.summary || event.title,
          });
          nextEvent.source = "user";
          nextEvent.metadata = { ...(event.metadata || {}), timelineId: timeline.id };
        }
        return apiSuccess({ graph: await upsertEvent(novelId, nextEvent) });
      }
      case "restore-recovery": {
        const index = Number(body.index);
        return apiSuccess({
          graph: await restoreGraphRecoveryPoint(novelId, index),
          recoveryPoints: listGraphRecoveryPoints(novelId),
        });
      }
      default:
        return apiError("无效操作", 400, "INVALID_ACTION");
    }
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "图谱操作失败", 500);
  }
}
