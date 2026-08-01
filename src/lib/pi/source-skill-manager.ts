import "server-only";

import { appStateDir } from "@/lib/runtime/app-paths";

import { createHash, verify } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const SKILL_ROOT_NAME = "pi-source-skills";
const REGISTRY_FILE = "registry.json";
const MAX_SKILL_BYTES = 64 * 1024;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
  installedAt: string;
  updatedAt: string;
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
  writeRegistry([...records.filter((item) => item.id !== id), record]);
  return toView(record);
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
