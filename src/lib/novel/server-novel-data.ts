/**
 * 服务端从文件树回读 NovelData —— 记忆隔离的落地点。
 *
 * 作者的核心诉求是「每个功能自己回读文件树确认，不继承他人推断」。
 * 此前 /api/generate 直接采信前端 body.context：前端内存里的那份数据可能是
 * 上一个工具刚生成、尚未落盘的推断，也可能被改包请求任意伪造，模型据此产出
 * 的内容又被存回文件树 —— 推断以事实的身份闭环。
 *
 * 这里让服务端自己去读，谁也不信。
 *
 * 与 /api/novels/[id]/data 的 GET 有一处**有意的差异**：
 *   GET 是 meta 优先、文件兜底（保持前端既有行为）；
 *   这里是**文件优先、meta 兜底**。
 * 理由：文件树是用户可以直接打开编辑的（也是 Pi agent 的写入面），外部改了文件
 * 而没走 API 时 meta.json 会过期。要"回读文件树确认"，就得以文件为准；只有文件
 * 缺失或为空时才回落到 meta，这样正常路径（改动都经 data PUT 双写）两者一致，
 * 只有外部编辑这一种情况会分叉，而那种情况下文件本来就是对的。
 */
import "server-only";

import { getNovel, listChapterFiles } from "@/lib/local/store";
import { FIELD_MAP } from "@/lib/novel/field-map";
import { isUntouchedScaffold } from "@/lib/novel/project-scaffold";
import { novelFS } from "@/lib/novel-fs";
import { INITIAL_NOVEL_DATA, type NovelData } from "@/types/novel";

function readTextFile(novelId: string, filePath: string): string | null {
  try {
    const content = novelFS.readFileSafe(novelId, filePath);
    if (!content?.trim()) return null;
    // createProject 会给每个创作文件先落一份占位模板，"文件存在"不等于"写过东西"。
    // 还是空模板就当没有，别用一行标题盖掉 meta 里的真数据。
    if (isUntouchedScaffold(filePath, content)) return null;
    return content;
  } catch {
    // 文件不存在 / 读取失败：交给 meta 兜底。
    return null;
  }
}

function metaString(meta: Record<string, unknown>, field: string): string | null {
  const value = meta[field];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * 从磁盘重建一份 NovelData。纯读，不写任何东西。
 * 读不到的字段用 INITIAL_NOVEL_DATA 的空值填充，调用方据此判断"该产物还不存在"。
 */
export function loadNovelDataFromDisk(novelId: string): NovelData {
  // getNovel 返回 LocalNovelMeta | null（项目不存在时为 null），可选链是必需的。
  // biome 未跨模块解析该返回类型，误判为非空，故此处及下方书名处一并抑制。
  const novel = getNovel(novelId);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: getNovel 可能返回 null
  const meta = (novel?.metadata ?? {}) as Record<string, unknown>;

  const data: NovelData = { ...INITIAL_NOVEL_DATA, chapters: {}, novelId };

  for (const entry of FIELD_MAP) {
    if (entry.field === "novelName") continue; // 书名无文件，下面单独取
    const fromFile = entry.filePath ? readTextFile(novelId, entry.filePath) : null;
    const value = fromFile ?? metaString(meta, entry.field);
    if (value) data[entry.field] = value;
  }

  // 书名没有对应文件，只能取 meta；项目标题作次选，两边都空才用占位名。
  // biome-ignore lint/suspicious/noUnnecessaryConditions: getNovel 可能返回 null
  const projectTitle = novel?.title.trim();
  data.novelName = metaString(meta, "novelName") ?? (projectTitle || INITIAL_NOVEL_DATA.novelName);
  const totalChapters = meta.totalChapters ?? novel?.total_chapters;
  if (typeof totalChapters === "number" && Number.isFinite(totalChapters)) {
    data.totalChapters = totalChapters;
  }

  // 正文：listChapterFiles 已经是「vault 索引优先、正文/ 目录兜底」，
  // 编码格式与前端 NovelData.chapters 保持一致（见 import-parser.decodeChapterRecord）。
  for (const chapter of listChapterFiles(novelId)) {
    data.chapters[`第${chapter.number}章`] = JSON.stringify({
      title: chapter.title,
      content: chapter.content,
    });
  }

  return data;
}
