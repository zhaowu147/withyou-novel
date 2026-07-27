/**
 * 纯本地数据根路径（服务端 only）
 *
 * 数据根由 @/lib/runtime/app-paths 统一解析，不要在这里再拼 process.cwd()。
 * 覆盖顺序：NOVELS_BASE_DIR > WITHYOU_DATA_DIR/novels > 仓库根/novels > 用户数据目录/novels
 */
import "server-only";

import { novelsRoot } from "@/lib/runtime/app-paths";
import { normalizeProjectId } from "@/lib/security/project-path";

import * as path from "node:path";

export { LOCAL_USER, LOCAL_USER_ID } from "./constants";

export function novelsBaseDir(): string {
  return novelsRoot();
}

export function projectDir(novelId: string): string {
  return path.join(novelsBaseDir(), sanitizeNovelId(novelId));
}

/** vault 结构化数据目录（与 正文/设定 并列） */
export function vaultDir(novelId: string): string {
  return path.join(projectDir(novelId), "vault");
}

export function sanitizeNovelId(id: string): string {
  return normalizeProjectId(id);
}
