/**
 * 工作区中的小说状态根类型
 * 整个工作台的 "single source of truth" 模型。
 */
import { editableLabelToField } from "@/lib/novel/field-map";

export interface NovelData {
  novelName: string;
  totalChapters: number;
  brainstorm: string;
  outline: string;
  detailedOutline: string;
  characters: string;
  worldview: string;
  goldfinger: string;
  synopsis: string;
  opening: string;
  foreshadowing: string;
  chapters: Record<string, string>;
  novelId?: string;
  taskType?:
    | "write_chapter"
    | "block_outline"
    | "volume_outline"
    | "logic_check"
    | "state_update"
    | "entity_enrich"
    | "refine";
  currentChapterNum?: number;
}

export const INITIAL_NOVEL_DATA: NovelData = {
  novelName: "我的作品",
  totalChapters: 300,
  brainstorm: "",
  outline: "",
  detailedOutline: "",
  characters: "",
  worldview: "",
  goldfinger: "",
  synopsis: "",
  opening: "",
  foreshadowing: "",
  chapters: {},
};

/**
 * 文件树节点显示名 → NovelData 字段映射表。
 * 从 @/lib/novel/field-map 的单一真相源派生（排除无文件的 novelName）。
 * 不要在此手写映射；改动请到 field-map.ts。
 */
export const FILE_FIELDS: Record<string, keyof NovelData> = editableLabelToField();
