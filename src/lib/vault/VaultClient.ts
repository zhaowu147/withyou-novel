/**
 * VaultClient — 服务端本地 store
 */
import "server-only";

import {
  addSnapshot,
  addTimelineEvent,
  type ForeshadowState,
  type LocalForeshadow,
  type LocalSnapshot,
  type LocalTimelineEvent,
  latestSnapshot,
  listActiveForeshadows,
  listForeshadows,
  listTimeline,
  recycleDormant,
  upsertForeshadow,
} from "@/lib/local/store";

export type { ForeshadowState };

export interface Foreshadow {
  id: string;
  novel_id: string;
  description: string;
  plant_chapter?: number;
  target_resolve_chapter?: number;
  actual_resolve_chapter?: number;
  state: ForeshadowState;
  related_entity_ids?: string[];
  created_at: string;
}

export interface TimelineEvent {
  id: string;
  novel_id: string;
  entity_name?: string;
  chapter?: number;
  description: string;
  created_at: string;
}

export interface Snapshot {
  id: string;
  novel_id: string;
  chapter: number;
  data: Record<string, unknown>;
  interval_type: "snapshot" | "archive";
  created_at: string;
}

export interface VaultConfig {
  snapshotInterval: number;
  archiveInterval: number;
  dormantWindow: number;
  maxActiveForeshadows: number;
  maxTimelineEntries: number;
  timelineCompressKeep: number;
}

const DEFAULT_CONFIG: VaultConfig = {
  snapshotInterval: 50,
  archiveInterval: 100,
  dormantWindow: 15,
  maxActiveForeshadows: 10,
  maxTimelineEntries: 50,
  timelineCompressKeep: 10,
};

function toFs(f: LocalForeshadow): Foreshadow {
  return {
    id: f.id,
    novel_id: f.novel_id,
    description: f.description,
    plant_chapter: f.plant_chapter,
    target_resolve_chapter: f.target_resolve_chapter,
    actual_resolve_chapter: f.actual_resolve_chapter,
    state: f.state,
    related_entity_ids: f.related_entity_ids,
    created_at: f.created_at ?? new Date().toISOString(),
  };
}

export class VaultClient {
  private config: VaultConfig;
  constructor(config?: Partial<VaultConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async addForeshadow(
    novelId: string,
    input: {
      description: string;
      plantChapter?: number;
      targetResolveChapter?: number;
      relatedEntityIds?: string[];
    },
  ) {
    return toFs(
      await upsertForeshadow({
        novel_id: novelId,
        description: input.description,
        plant_chapter: input.plantChapter,
        target_resolve_chapter: input.targetResolveChapter,
        related_entity_ids: input.relatedEntityIds ?? [],
        state: "planted",
      }),
    );
  }

  async listActive(novelId: string) {
    return listActiveForeshadows(novelId, this.config.maxActiveForeshadows).map(toFs);
  }

  async activate(novelId: string, foreshadowId: string, chapter?: number) {
    const all = listForeshadows(novelId);
    const hit = all.find((f) => f.id === foreshadowId);
    if (!hit) throw new Error("foreshadow not found");
    await upsertForeshadow({
      ...hit,
      novel_id: novelId,
      description: hit.description,
      state: "activated",
      activated_chapter: chapter,
    });
  }

  async resolve(novelId: string, foreshadowId: string, chapter: number) {
    const all = listForeshadows(novelId);
    const hit = all.find((f) => f.id === foreshadowId);
    if (!hit) throw new Error("foreshadow not found");
    await upsertForeshadow({
      ...hit,
      novel_id: novelId,
      description: hit.description,
      state: "resolved",
      actual_resolve_chapter: chapter,
    });
  }

  async recycle(novelId: string, currentChapter: number): Promise<number> {
    return recycleDormant(novelId, currentChapter, this.config.dormantWindow);
  }

  async recordEvent(novelId: string, input: { entityName?: string; chapter?: number; description: string }) {
    const t = await addTimelineEvent(novelId, input);
    return t as TimelineEvent;
  }

  async getTimeline(novelId: string, entityName?: string) {
    let rows = listTimeline(novelId, this.config.timelineCompressKeep);
    if (entityName) rows = rows.filter((r) => r.entity_name === entityName);
    return rows as TimelineEvent[];
  }

  async getAllEvents(novelId: string) {
    return listTimeline(novelId, this.config.maxTimelineEntries) as LocalTimelineEvent[];
  }

  async recordState(novelId: string, chapter: number, state: Record<string, unknown>) {
    return (await addSnapshot(novelId, chapter, state)) as LocalSnapshot;
  }

  async getLatest(novelId: string) {
    return latestSnapshot(novelId);
  }

  async autoSnapshot(novelId: string, chapter: number, state: Record<string, unknown>): Promise<boolean> {
    const count = listTimeline(novelId, 9999).length;
    if (count > 0 && count % this.config.snapshotInterval === 0) {
      await addSnapshot(novelId, chapter, state);
      return true;
    }
    return false;
  }

  async assembleForPrompt(novelId: string) {
    const foreshadows = await this.listActive(novelId);
    const timeline = await this.getAllEvents(novelId);
    return {
      activeForeshadows: foreshadows.map((f) => ({
        description: f.description,
        plant_chapter: f.plant_chapter,
        state: f.state,
      })),
      recentTimeline: timeline.slice(0, 10).map((t) => ({
        entity_name: t.entity_name,
        chapter: t.chapter,
        description: t.description,
      })),
    };
  }
}

export default VaultClient;
