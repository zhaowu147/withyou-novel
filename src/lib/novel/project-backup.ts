import "server-only";

import { sanitizeNovelId } from "@/lib/local/paths";
import { queueMemoryBackfill } from "@/lib/memory/backfill";
import { isRebuildableMemoryIndexPath } from "@/lib/memory/memory-index";
import { novelFS } from "@/lib/novel-fs";
import { appStateDir } from "@/lib/runtime/app-paths";

import * as fs from "node:fs";
import * as path from "node:path";

const MAX_BACKUP_FILES = 5_000;
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
const MAX_RECOVERY_POINTS = 10;
const MAX_RECOVERY_BYTES = 100 * 1024 * 1024;

export interface ProjectBackup {
  format: "withyou-novel-backup";
  version: 1;
  novelId: string;
  exportedAt: string;
  files: Array<{ path: string; content: string }>;
}

export function createProjectBackup(novelIdInput: string): ProjectBackup {
  const novelId = sanitizeNovelId(novelIdInput);
  // SQLite 索引是可由 JSON 记忆重建的派生数据，避免按 UTF-8 读取二进制文件并写入备份。
  const paths = novelFS.listAllFiles(novelId).filter((filePath) => !isRebuildableMemoryIndexPath(filePath));
  if (paths.length > MAX_BACKUP_FILES) throw new Error("项目文件数量超出备份安全限制");
  let totalBytes = 0;
  const files = paths.map((filePath) => {
    const content = novelFS.readFile(novelId, filePath);
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MAX_BACKUP_BYTES) throw new Error("项目备份大小超出 25MB 安全限制");
    return { path: filePath, content };
  });
  return {
    format: "withyou-novel-backup",
    version: 1,
    novelId,
    exportedAt: new Date().toISOString(),
    files,
  };
}

function validateBackup(input: unknown): ProjectBackup {
  if (!input || typeof input !== "object") throw new Error("备份文件格式无效");
  const backup = input as Partial<ProjectBackup>;
  if (backup.format !== "withyou-novel-backup" || backup.version !== 1 || !Array.isArray(backup.files)) {
    throw new Error("这不是可识别的 WithYou Novel 备份");
  }
  if (backup.files.length > MAX_BACKUP_FILES) throw new Error("备份中的文件数量超出安全限制");

  let totalBytes = 0;
  const seen = new Set<string>();
  const files = backup.files.map((item) => {
    if (!item || typeof item.path !== "string" || typeof item.content !== "string") {
      throw new Error("备份中存在无效文件");
    }
    const normalized = item.path.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
      throw new Error(`备份包含不安全路径: ${item.path}`);
    }
    if (seen.has(normalized)) throw new Error(`备份包含重复文件: ${normalized}`);
    seen.add(normalized);
    totalBytes += Buffer.byteLength(item.content, "utf8");
    if (totalBytes > MAX_BACKUP_BYTES) throw new Error("备份大小超出 25MB 安全限制");
    return { path: normalized, content: item.content };
  });

  return {
    format: "withyou-novel-backup",
    version: 1,
    novelId: typeof backup.novelId === "string" ? backup.novelId : "",
    exportedAt: typeof backup.exportedAt === "string" ? backup.exportedAt : "",
    files,
  };
}

function saveRecoveryPoint(novelId: string): string {
  const recoveryDir = path.join(appStateDir(), "recovery", novelId);
  fs.mkdirSync(recoveryDir, { recursive: true });
  const filePath = path.join(recoveryDir, `${Date.now()}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(createProjectBackup(novelId)), "utf8");
  fs.renameSync(tempPath, filePath);
  const points = fs
    .readdirSync(recoveryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const absolute = path.join(recoveryDir, entry.name);
      const stat = fs.statSync(absolute);
      return { absolute, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let retainedBytes = 0;
  for (const [index, point] of points.entries()) {
    retainedBytes += point.size;
    if (index >= MAX_RECOVERY_POINTS || retainedBytes > MAX_RECOVERY_BYTES) fs.unlinkSync(point.absolute);
  }
  return path.basename(filePath, ".json");
}

export async function restoreProjectBackup(
  novelIdInput: string,
  input: unknown,
): Promise<{ restoredFiles: number; recoveryPoint: string; memoryBackfillJobId: string }> {
  const novelId = sanitizeNovelId(novelIdInput);
  const backup = validateBackup(input);
  if (backup.novelId !== novelId) {
    throw new Error("备份属于其他作品，已阻止跨项目恢复以避免记忆污染");
  }
  const recoveryPoint = saveRecoveryPoint(novelId);

  // 合并恢复，不删除备份之外的现有文件，避免旧备份误删后来新增的正文。
  for (const file of backup.files) {
    novelFS.writeFile(novelId, file.path, file.content);
  }

  const memoryBackfillJobId = (await queueMemoryBackfill(novelId)).id;
  return { restoredFiles: backup.files.length, recoveryPoint, memoryBackfillJobId };
}
