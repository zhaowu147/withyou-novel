/**
 * EntityClient — 本地 JSON 版（服务端 only）
 */
import "server-only";

import { getEntity, type LocalEntity, listEntities, upsertEntity } from "@/lib/local/store";

export type LifecycleStatus = "active" | "cooling" | "resolved" | "abandoned";
export type Importance = "high" | "mid" | "low";

export interface EntityCard {
  id: string;
  novel_id: string;
  name: string;
  type: "character" | "location" | "item" | "faction" | "event" | "other";
  importance: Importance;
  active_state: LifecycleStatus;
  summary: string;
  last_chapter?: number;
  cooling_since?: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface EntityLifecycleConfig {
  cooling_window: number;
  dormant_window: number;
  importance_multipliers: Record<Importance, number>;
}

const DEFAULT_CONFIG: EntityLifecycleConfig = {
  cooling_window: 6,
  dormant_window: 12,
  importance_multipliers: { high: 3, mid: 2, low: 1 },
};

function toCard(e: LocalEntity): EntityCard {
  return {
    id: e.id,
    novel_id: e.novel_id,
    name: e.name,
    type: e.type as EntityCard["type"],
    importance: (e.importance as Importance) ?? "mid",
    active_state: (e.active_state as LifecycleStatus) ?? "active",
    summary: e.summary,
    last_chapter: e.last_chapter,
    metadata: e.metadata ?? {},
    created_at: e.created_at ?? new Date().toISOString(),
    updated_at: e.updated_at ?? new Date().toISOString(),
  };
}

export class EntityClient {
  private config: EntityLifecycleConfig;

  constructor(config?: Partial<EntityLifecycleConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async updateLifecycleByChapter(
    novelId: string,
    currentChapter: number,
  ): Promise<{ updated: number; changes: string[] }> {
    const entities = listEntities(novelId).filter((e) => e.active_state === "active");
    let updated = 0;
    const changes: string[] = [];

    for (const entity of entities) {
      if (!entity.last_chapter) continue;
      if (entity.importance === "high" || entity.importance === "core") continue;
      const gap = currentChapter - entity.last_chapter;
      const importance = (entity.importance as Importance) || "mid";
      const multiplier = this.config.importance_multipliers[importance] ?? 1;
      const threshold = Math.max(1, Math.floor(this.config.cooling_window * multiplier));
      if (gap >= threshold) {
        await upsertEntity({
          ...entity,
          novel_id: novelId,
          name: entity.name,
          active_state: "cooling",
        });
        updated++;
        changes.push(`${entity.name}: ${entity.active_state} → cooling (gap=${gap}, threshold=${threshold})`);
      }
    }
    return { updated, changes };
  }

  async getActiveEntities(novelId: string) {
    return listEntities(novelId)
      .filter((e) => e.active_state === "active")
      .map(toCard)
      .sort((a, b) => (b.last_chapter ?? 0) - (a.last_chapter ?? 0));
  }

  async getCoolingSummary(novelId: string): Promise<string[]> {
    return listEntities(novelId)
      .filter((e) => e.active_state === "cooling")
      .map((e) => {
        const lastChapter = e.last_chapter ?? "?";
        return `${e.name}（上次出现于第${lastChapter}章，冷却中）`;
      });
  }

  async batchUpdateTimeline(
    novelId: string,
    events: Array<{ entityId: string; chapter: number; description: string }>,
  ) {
    const results: EntityCard[] = [];
    for (const ev of events) {
      const existing = getEntity(novelId, ev.entityId);
      if (!existing) continue;
      const updated = await upsertEntity({
        ...existing,
        novel_id: novelId,
        name: existing.name,
        last_chapter: ev.chapter,
        active_state: "active",
      });
      results.push(toCard(updated));
    }
    return results;
  }

  async setLifecycle(novelId: string, entityId: string, status: LifecycleStatus) {
    const existing = getEntity(novelId, entityId);
    if (!existing) throw new Error("entity not found");
    await upsertEntity({ ...existing, novel_id: novelId, name: existing.name, active_state: status });
  }

  async setImportance(novelId: string, entityId: string, importance: Importance) {
    const existing = getEntity(novelId, entityId);
    if (!existing) throw new Error("entity not found");
    await upsertEntity({ ...existing, novel_id: novelId, name: existing.name, importance });
  }

  async searchByName(novelId: string, query: string) {
    const q = query.toLowerCase();
    return listEntities(novelId)
      .filter((e) => e.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map(toCard);
  }

  async getEntity(novelId: string, entityId: string) {
    const e = getEntity(novelId, entityId);
    return e ? toCard(e) : null;
  }

  async createEntity(
    novelId: string,
    input: {
      name: string;
      type: EntityCard["type"];
      importance?: Importance;
      summary?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    return toCard(
      await upsertEntity({
        novel_id: novelId,
        name: input.name,
        type: input.type,
        importance: input.importance ?? "mid",
        active_state: "active",
        summary: input.summary ?? "",
        metadata: input.metadata ?? {},
      }),
    );
  }

  async assembleForPrompt(novelId: string, currentChapter?: number) {
    if (currentChapter) {
      await this.updateLifecycleByChapter(novelId, currentChapter);
    }
    const active = await this.getActiveEntities(novelId);
    const cooling = await this.getCoolingSummary(novelId);
    return {
      activeEntities: active.map((e) => ({
        name: e.name,
        type: e.type,
        importance: e.importance,
        active_state: e.active_state,
        summary: e.summary,
        last_chapter: e.last_chapter,
      })),
      coolingEntities: cooling,
    };
  }
}

export default EntityClient;
