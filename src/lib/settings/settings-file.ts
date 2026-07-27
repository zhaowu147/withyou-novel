/**
 * settings.json 的唯一持久化入口。
 *
 * - 临时文件完整写入并 fsync 后再原子替换
 * - 保留三代可恢复备份
 * - 主文件损坏时从最近有效备份恢复，同时保留损坏现场
 */
import "server-only";

import { settingsFilePath } from "@/lib/runtime/app-paths";
import { type AppSettings, DEFAULT_SETTINGS, type ModelProviderConfig } from "@/lib/settings/settings-store";

import * as fs from "node:fs";
import * as path from "node:path";

/** settings.json 的绝对路径。惰性求值：数据根在首次访问时解析并缓存。 */
function settingsFile(): string {
  return settingsFilePath();
}
const BACKUP_COUNT = 3;

function backupPath(index: number): string {
  return index === 0 ? `${settingsFile()}.bak` : `${settingsFile()}.bak.${index}`;
}

function cloneDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    creationTool: { ...DEFAULT_SETTINGS.creationTool },
    chatAgent: { ...DEFAULT_SETTINGS.chatAgent },
    coverGeneration: { ...DEFAULT_SETTINGS.coverGeneration },
    piAgent: { ...DEFAULT_SETTINGS.piAgent },
  };
}

function mergeModelConfig(fallback: ModelProviderConfig, value?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return { ...fallback, ...(value ?? {}) };
}

function normalizeSettings(value: unknown): AppSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Partial<AppSettings>;
  const scopes = [parsed.creationTool, parsed.chatAgent, parsed.coverGeneration, parsed.piAgent];
  if (
    scopes.some(
      (scope) =>
        scope != null &&
        (typeof scope !== "object" || typeof scope.provider !== "string" || typeof scope.model !== "string"),
    )
  ) {
    return null;
  }
  return {
    ...cloneDefaultSettings(),
    ...parsed,
    creationTool: mergeModelConfig(DEFAULT_SETTINGS.creationTool, parsed.creationTool),
    chatAgent: mergeModelConfig(DEFAULT_SETTINGS.chatAgent, parsed.chatAgent),
    coverGeneration: mergeModelConfig(DEFAULT_SETTINGS.coverGeneration, parsed.coverGeneration),
    piAgent: mergeModelConfig(DEFAULT_SETTINGS.piAgent, parsed.piAgent),
    version: DEFAULT_SETTINGS.version,
  };
}

function readCandidate(filePath: string): AppSettings | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function writeTemporary(target: string, content: string): string {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(handle, content, "utf8");
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

function rotateBackups(): void {
  for (let index = BACKUP_COUNT - 1; index >= 1; index--) {
    const source = backupPath(index - 1);
    const target = backupPath(index);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, target);
  }
  if (readCandidate(settingsFile())) {
    const backup = backupPath(0);
    const temporary = writeTemporary(backup, fs.readFileSync(settingsFile(), "utf8"));
    replaceWithTemporary(backup, temporary);
  }
}

function preserveCorruptMain(): void {
  if (!fs.existsSync(settingsFile())) return;
  const corruptPath = `${settingsFile()}.corrupt.${Date.now()}`;
  fs.renameSync(settingsFile(), corruptPath);
  const corruptFiles = fs
    .readdirSync(path.dirname(settingsFile()))
    .filter((name) => name.startsWith(`${path.basename(settingsFile())}.corrupt.`))
    .sort()
    .reverse();
  for (const stale of corruptFiles.slice(2)) {
    fs.rmSync(path.join(path.dirname(settingsFile()), stale), { force: true });
  }
}

function recoverMain(settings: AppSettings): void {
  preserveCorruptMain();
  const serialized = JSON.stringify(settings, null, 2);
  const temporary = writeTemporary(settingsFile(), serialized);
  replaceWithTemporary(settingsFile(), temporary);
}

export function readSettingsFile(): AppSettings {
  const primary = readCandidate(settingsFile());
  if (primary) return primary;

  for (let index = 0; index < BACKUP_COUNT; index++) {
    const recovered = readCandidate(backupPath(index));
    if (!recovered) continue;
    recoverMain(recovered);
    return recovered;
  }
  return cloneDefaultSettings();
}

export function writeSettingsFile(settings: AppSettings): AppSettings {
  const normalized = normalizeSettings({
    ...settings,
    version: DEFAULT_SETTINGS.version,
    updatedAt: new Date().toISOString(),
  });
  if (!normalized) throw new Error("设置内容格式无效");

  const serialized = JSON.stringify(normalized, null, 2);
  // 写入前再次解析，防止自定义序列化值形成不可恢复文件。
  if (!normalizeSettings(JSON.parse(serialized))) throw new Error("设置序列化校验失败");

  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  rotateBackups();
  const temporary = writeTemporary(settingsFile(), serialized);
  replaceWithTemporary(settingsFile(), temporary);
  return normalized;
}
