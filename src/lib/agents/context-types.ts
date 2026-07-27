export interface NovelContext {
  novelName?: string;
  outline?: string;
  characters?: string;
  worldview?: string;
  foreshadowing?: string;
  chapters?: Record<string, string>;
  retrievedMemory?: string;
  novelId?: string;
  taskType?: string;
  currentChapterNum?: number;
}

export interface VaultContext {
  activeForeshadows?: Array<{
    description: string;
    plant_chapter?: number;
    state: string;
  }>;
  activeEntities?: Array<{
    name: string;
    type: string;
    importance: string;
    active_state: string;
    summary: string;
  }>;
  recentTimeline?: Array<{
    entity_name?: string;
    chapter?: number;
    description: string;
  }>;
}
