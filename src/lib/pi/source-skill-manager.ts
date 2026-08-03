import "server-only";

import { appStateDir } from "@/lib/runtime/app-paths";

import { createHash, verify } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const SKILL_ROOT_NAME = "pi-source-skills";
const REGISTRY_FILE = "registry.json";
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_RESOURCE_BYTES = 64 * 1024;
const MAX_TOTAL_RESOURCE_BYTES = 256 * 1024;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESOURCE_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);

export type SourceSkillIntegrity = "verified" | "local" | "mismatch" | "missing" | "invalid";

export interface SourceSkillSource {
  type: "local" | "remote";
  uri?: string;
  publisher?: string;
}

export interface SourceSkillRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  source: SourceSkillSource;
  contentHash: string;
  publicKey?: string;
  signature?: string;
  resources?: SourceSkillResourceRecord[];
  installedAt: string;
  updatedAt: string;
}

export interface SourceSkillResourceRecord {
  path: string;
  contentHash: string;
  bytes: number;
}

export interface SourceSkillView extends SourceSkillRecord {
  integrity: SourceSkillIntegrity;
  filePath: string;
}

export interface InstallSourceSkillInput {
  id: string;
  content: string;
  name?: string;
  description?: string;
  version?: string;
  source?: SourceSkillSource;
  publicKey?: string;
  signature?: string;
  resources?: Array<{ path: string; content: string }>;
  enabled?: boolean;
}

function sourceSkillRoot(): string {
  return path.join(appStateDir(), SKILL_ROOT_NAME);
}

function registryPath(): string {
  return path.join(sourceSkillRoot(), REGISTRY_FILE);
}

function skillDirectory(id: string): string {
  return path.join(sourceSkillRoot(), id);
}

function skillPath(id: string): string {
  return path.join(skillDirectory(id), "SKILL.md");
}

function resourceDirectory(id: string): string {
  return path.join(skillDirectory(id), "resources");
}

function normalizeResourcePath(input: string): string {
  const normalized = input.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Skill 资源路径无效");
  }
  const extension = path.extname(normalized).toLowerCase();
  if (!RESOURCE_EXTENSIONS.has(extension)) throw new Error("Skill 资源只允许 Markdown、文本或结构化数据文件");
  return normalized;
}

function resourcePath(id: string, relativePath: string): string {
  const root = resourceDirectory(id);
  const target = path.resolve(root, normalizeResourcePath(relativePath));
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Skill 资源路径超出安装目录");
  return target;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSkillId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!SKILL_ID.test(normalized)) throw new Error("Skill ID 只能包含小写字母、数字和连字符，长度不超过 64");
  return normalized;
}

function parseText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readRegistry(): SourceSkillRecord[] {
  try {
    const raw = fs.readFileSync(/* turbopackIgnore: true */ registryPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      try {
        const id = assertSkillId(parseText(value.id));
        const sourceRaw = value.source && typeof value.source === "object" ? (value.source as Record<string, unknown>) : {};
        const sourceType = sourceRaw.type === "remote" ? "remote" : "local";
        const contentHash = parseText(value.contentHash);
        if (!contentHash) return [];
        return [
          {
            id,
            name: parseText(value.name, id),
            description: parseText(value.description),
            version: parseText(value.version, "0.0.0"),
            enabled: value.enabled !== false,
            source: {
              type: sourceType,
              uri: parseText(sourceRaw.uri) || undefined,
              publisher: parseText(sourceRaw.publisher) || undefined,
            },
            contentHash,
            publicKey: parseText(value.publicKey) || undefined,
            signature: parseText(value.signature) || undefined,
            resources: Array.isArray(value.resources)
              ? value.resources.flatMap((resource) => {
                  if (!resource || typeof resource !== "object") return [];
                  const raw = resource as Record<string, unknown>;
                  try {
                    const resourcePathValue = normalizeResourcePath(parseText(raw.path));
                    const resourceHash = parseText(raw.contentHash);
                    const bytes = typeof raw.bytes === "number" && Number.isInteger(raw.bytes) ? raw.bytes : 0;
                    return resourceHash && bytes >= 0 && bytes <= MAX_RESOURCE_BYTES
                      ? [{ path: resourcePathValue, contentHash: resourceHash, bytes }]
                      : [];
                  } catch {
                    return [];
                  }
                })
              : [],
            installedAt: parseText(value.installedAt, new Date(0).toISOString()),
            updatedAt: parseText(value.updatedAt, new Date(0).toISOString()),
          },
        ];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function writeRegistry(records: SourceSkillRecord[]): void {
  const target = registryPath();
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(/* turbopackIgnore: true */ temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  fs.copyFileSync(/* turbopackIgnore: true */ temporary, /* turbopackIgnore: true */ target);
  fs.unlinkSync(/* turbopackIgnore: true */ temporary);
}

function parseSkillMetadata(content: string): { name?: string; description?: string; version?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && value) fields.set(key, value);
  }
  return {
    name: fields.get("name"),
    description: fields.get("description"),
    version: fields.get("version"),
  };
}

function verifySignature(content: string, publicKey: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(content, "utf8"), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function integrityFor(record: SourceSkillRecord): SourceSkillIntegrity {
  const target = skillPath(record.id);
  if (!fs.existsSync(/* turbopackIgnore: true */ target)) return "missing";
  try {
    const content = fs.readFileSync(/* turbopackIgnore: true */ target, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) return "invalid";
    if (hashText(content) !== record.contentHash) return "mismatch";
    for (const resource of record.resources ?? []) {
      const targetResource = resourcePath(record.id, resource.path);
      if (!fs.existsSync(/* turbopackIgnore: true */ targetResource)) return "missing";
      const resourceContent = fs.readFileSync(/* turbopackIgnore: true */ targetResource, "utf8");
      if (Buffer.byteLength(resourceContent, "utf8") > MAX_RESOURCE_BYTES) return "invalid";
      if (hashText(resourceContent) !== resource.contentHash) return "mismatch";
    }
    if (record.signature || record.publicKey) {
      if (!record.signature || !record.publicKey) return "invalid";
      return verifySignature(content, record.publicKey, record.signature) ? "verified" : "invalid";
    }
    return "local";
  } catch {
    return "invalid";
  }
}

function toView(record: SourceSkillRecord): SourceSkillView {
  return { ...record, integrity: integrityFor(record), filePath: skillPath(record.id) };
}

/** 列出来源、版本和完整性可追溯的源码 Pi Skill。 */
export function listSourceSkills(): SourceSkillView[] {
  return readRegistry().map(toView).sort((a, b) => a.id.localeCompare(b.id));
}

/** 只返回已启用且内容完整的 Skill 路径，供源码 Pi ResourceLoader 使用。 */
export function enabledSourceSkillPaths(): string[] {
  return listSourceSkills()
    .filter((skill) => skill.enabled && (skill.integrity === "local" || skill.integrity === "verified"))
    .map((skill) => skill.filePath);
}

export function sourceSkillFingerprint(): string {
  const state = listSourceSkills().map((skill) => ({
    id: skill.id,
    enabled: skill.enabled,
    contentHash: skill.contentHash,
    integrity: skill.integrity,
  }));
  return hashText(JSON.stringify(state));
}

export function installSourceSkill(input: InstallSourceSkillInput): SourceSkillView {
  const id = assertSkillId(input.id);
  const content = input.content.replace(/^\uFEFF/, "").trim();
  if (!content) throw new Error("Skill 内容不能为空");
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw new Error("单个 Skill 不能超过 64KB");
  const metadata = parseSkillMetadata(content);
  const source = input.source?.type === "remote" ? input.source : { type: "local" as const };
  if (source.type === "remote" && !source.uri?.trim()) throw new Error("远程 Skill 必须记录来源地址");
  if (Boolean(input.publicKey) !== Boolean(input.signature)) {
    throw new Error("签名校验需要同时提供 publicKey 和 signature");
  }
  if (input.publicKey && input.signature && !verifySignature(content, input.publicKey, input.signature)) {
    throw new Error("Skill 签名校验失败");
  }
  const resourceContents = new Map<string, string>();
  let resourceBytes = 0;
  for (const resource of input.resources ?? []) {
    const resourcePathValue = normalizeResourcePath(resource.path);
    const resourceContent = resource.content.replace(/^\uFEFF/, "");
    const bytes = Buffer.byteLength(resourceContent, "utf8");
    if (!resourceContent.trim()) throw new Error(`Skill 资源不能为空：${resourcePathValue}`);
    if (bytes > MAX_RESOURCE_BYTES) throw new Error(`Skill 单个资源不能超过 64KB：${resourcePathValue}`);
    resourceBytes += bytes;
    if (resourceBytes > MAX_TOTAL_RESOURCE_BYTES) throw new Error("Skill 资源总量不能超过 256KB");
    resourceContents.set(resourcePathValue, resourceContent);
  }

  const records = readRegistry();
  const previous = records.find((item) => item.id === id);
  const now = new Date().toISOString();
  const record: SourceSkillRecord = {
    id,
    name: parseText(input.name, metadata.name || id),
    description: parseText(input.description, metadata.description || ""),
    version: parseText(input.version, metadata.version || "0.0.0"),
    enabled: input.enabled ?? previous?.enabled ?? true,
    source: {
      type: source.type,
      uri: parseText(source.uri) || undefined,
      publisher: parseText(source.publisher) || undefined,
    },
    contentHash: hashText(content),
    publicKey: input.publicKey?.trim() || undefined,
    signature: input.signature?.trim() || undefined,
    resources: [...resourceContents.entries()].map(([resourcePathValue, resourceContent]) => ({
      path: resourcePathValue,
      contentHash: hashText(resourceContent),
      bytes: Buffer.byteLength(resourceContent, "utf8"),
    })),
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
  };

  const target = skillPath(id);
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  // The registry hash and optional signature are calculated from this exact
  // content. Do not normalize it again while writing, or every reload would
  // falsely report the freshly installed Skill as tampered with.
  fs.writeFileSync(/* turbopackIgnore: true */ temporary, content, "utf8");
  fs.copyFileSync(/* turbopackIgnore: true */ temporary, /* turbopackIgnore: true */ target);
  fs.unlinkSync(/* turbopackIgnore: true */ temporary);
  for (const [resourcePathValue, resourceContent] of resourceContents) {
    const targetResource = resourcePath(id, resourcePathValue);
    fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(targetResource), { recursive: true });
    const resourceTemporary = `${targetResource}.${process.pid}.tmp`;
    fs.writeFileSync(/* turbopackIgnore: true */ resourceTemporary, resourceContent, "utf8");
    fs.copyFileSync(/* turbopackIgnore: true */ resourceTemporary, /* turbopackIgnore: true */ targetResource);
    fs.unlinkSync(/* turbopackIgnore: true */ resourceTemporary);
  }
  writeRegistry([...records.filter((item) => item.id !== id), record]);
  return toView(record);
}

/** 读取已安装 Skill 的受控文档资源，供 Pi 在任务需要时按需加载。 */
export function readSourceSkillResource(idInput: string, resourceInput: string): string {
  const id = assertSkillId(idInput);
  const resourcePathValue = normalizeResourcePath(resourceInput);
  const record = readRegistry().find((item) => item.id === id);
  if (!record) throw new Error("找不到该 Skill");
  if (!record.enabled || !["local", "verified"].includes(integrityFor(record))) {
    throw new Error("Skill 未启用或完整性校验未通过");
  }
  if (!(record.resources ?? []).some((resource) => resource.path === resourcePathValue)) {
    throw new Error("该资源不在已登记的 Skill 包内");
  }
  const target = resourcePath(id, resourcePathValue);
  return fs.readFileSync(/* turbopackIgnore: true */ target, "utf8");
}

export function setSourceSkillEnabled(idInput: string, enabled: boolean): SourceSkillView {
  const id = assertSkillId(idInput);
  const records = readRegistry();
  const index = records.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("找不到该 Skill");
  records[index] = { ...records[index], enabled, updatedAt: new Date().toISOString() };
  writeRegistry(records);
  return toView(records[index]);
}

export function uninstallSourceSkill(idInput: string): SourceSkillRecord {
  const id = assertSkillId(idInput);
  const records = readRegistry();
  const record = records.find((item) => item.id === id);
  if (!record) throw new Error("找不到该 Skill");
  writeRegistry(records.filter((item) => item.id !== id));
  const target = skillDirectory(id);
  if (fs.existsSync(/* turbopackIgnore: true */ target)) {
    fs.rmSync(/* turbopackIgnore: true */ target, { recursive: true, force: true });
  }
  return record;
}
