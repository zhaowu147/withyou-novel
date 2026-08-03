import "server-only";

import { lock as acquireCrossProcessLock } from "proper-lockfile";

import { readJsonFile, writeJsonFile } from "@/lib/local/json-db";
import { projectDir } from "@/lib/local/paths";
import NovelFileSystem from "@/lib/novel-fs";

import type {
  SemanticConstraint,
  SemanticContract,
  SemanticContractStatus,
  SemanticSourceReference,
  SemanticValidationResult,
} from "./types";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function contractsRoot(novelId: string): string {
  return path.join(projectDir(novelId), ".withyou", "semantic-contracts");
}

function semanticNovelFs(): NovelFileSystem {
  return new NovelFileSystem();
}

function sourceContent(novelId: string, sourcePath: string): string | null {
  const root = path.resolve(projectDir(novelId));
  const absolute = path.resolve(root, sourcePath);
  if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return null;
  }
  return fs.readFileSync(absolute, "utf8");
}

function activePath(novelId: string, contractId: string): string {
  return path.join(contractsRoot(novelId), "active", `${contractId}.json`);
}

function versionPath(novelId: string, contractId: string, version: number): string {
  return path.join(contractsRoot(novelId), "versions", contractId, `v${version}.json`);
}

function lockedPath(novelId: string, contractId: string, version: number): string {
  return path.join(contractsRoot(novelId), "locked", contractId, `v${version}.json`);
}

function validationPath(novelId: string, contractId: string, version: number): string {
  return path.join(contractsRoot(novelId), "completed", contractId, `v${version}.validation.json`);
}

function lockTarget(novelId: string, contractId: string): string {
  return path.join(contractsRoot(novelId), "locks", `${contractId}.lock-target`);
}

async function withContractLock<T>(novelId: string, contractId: string, task: () => T | Promise<T>): Promise<T> {
  const target = lockTarget(novelId, contractId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) fs.writeFileSync(target, "", "utf8");
  const release = await acquireCrossProcessLock(target, {
    realpath: false,
    stale: 10_000,
    retries: { retries: 10, factor: 1.5, minTimeout: 80, maxTimeout: 1_500 },
  });
  try {
    return await task();
  } finally {
    await release();
  }
}

export function semanticContractHash(contract: SemanticContract): string {
  const payload = {
    id: contract.id,
    projectId: contract.projectId,
    taskId: contract.taskId,
    taskKind: contract.taskKind,
    toolId: contract.toolId,
    version: contract.version,
    originalUserInput: contract.originalUserInput,
    taskSummary: contract.taskSummary,
    intendedOutcome: contract.intendedOutcome,
    excludedScope: contract.excludedScope,
    interpretations: contract.interpretations,
    constraints: contract.constraints,
    assumptions: contract.assumptions,
    ambiguities: contract.ambiguities,
    plannedDecisions: contract.plannedDecisions,
    riskLevel: contract.riskLevel,
    confirmationMode: contract.confirmationMode,
    blockingReasons: contract.blockingReasons,
    sourceReferences: contract.sourceReferences,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function collectSemanticSourceReferences(novelId: string, limit = 36): SemanticSourceReference[] {
  const fsStore = semanticNovelFs();
  const all = fsStore
    .listAllFiles(novelId)
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".md") && !file.startsWith(".withyou/"));
  const prioritized = [
    ...all.filter((file) => /^(设定|大纲|追踪)\//.test(file)),
    ...all
      .filter((file) => /^正文\//.test(file))
      .sort((left, right) => right.localeCompare(left, "zh-CN"))
      .slice(0, 5),
    ...all.filter((file) => !/^(设定|大纲|追踪|正文)\//.test(file)),
  ];
  const semanticRulesPath = ".withyou/project-bible/semantic-rules.json";
  if (sourceContent(novelId, semanticRulesPath) !== null) prioritized.unshift(semanticRulesPath);
  const unique = [...new Set(prioritized)].slice(0, limit);
  return unique.flatMap((file) => {
    const content = sourceContent(novelId, file);
    if (content === null) return [];
    return [{ path: file, contentHash: hashText(content), role: "project_truth" as const }];
  });
}

export function readSemanticProjectContext(novelId: string, maxChars = 40_000): string {
  const refs = collectSemanticSourceReferences(novelId);
  const sections: string[] = [];
  let used = 0;
  for (const ref of refs) {
    if (used >= maxChars) break;
    const raw = sourceContent(novelId, ref.path);
    if (!raw?.trim()) continue;
    const content = raw.trim().slice(0, Math.min(5_000, maxChars - used));
    sections.push(`### ${ref.path}\n${content}`);
    used += content.length;
  }
  return sections.join("\n\n");
}

export function staleSemanticSources(novelId: string, contract: SemanticContract): string[] {
  const stale: string[] = [];
  for (const ref of contract.sourceReferences) {
    if (!ref.contentHash || ref.role === "historical_reference") continue;
    const current = sourceContent(novelId, ref.path);
    if (current === null || hashText(current) !== ref.contentHash) stale.push(ref.path);
  }
  return stale;
}

export async function createSemanticContract(contract: SemanticContract): Promise<SemanticContract> {
  return withContractLock(contract.projectId, contract.id, () => {
    const active = activePath(contract.projectId, contract.id);
    if (fs.existsSync(active)) throw new Error("语义契约已存在");
    writeJsonFile(versionPath(contract.projectId, contract.id, contract.version), contract);
    writeJsonFile(active, contract);
    if (contract.status === "confirmed") {
      const locked = { ...contract, contentHash: semanticContractHash(contract) };
      writeJsonFile(lockedPath(contract.projectId, contract.id, contract.version), locked);
      writeJsonFile(active, locked);
      return locked;
    }
    return contract;
  });
}

export function readSemanticContract(novelId: string, contractId: string): SemanticContract | null {
  const file = activePath(novelId, contractId);
  if (!fs.existsSync(file)) return null;
  const contract = readJsonFile<SemanticContract | null>(file, null);
  return contract?.projectId === novelId && contract.id === contractId ? contract : null;
}

export function readLockedSemanticContract(
  novelId: string,
  contractId: string,
  version: number,
): SemanticContract | null {
  const file = lockedPath(novelId, contractId, version);
  if (!fs.existsSync(file)) return null;
  const contract = readJsonFile<SemanticContract | null>(file, null);
  return contract?.projectId === novelId && contract.id === contractId && contract.version === version
    ? contract
    : null;
}

export function listSemanticContractVersions(novelId: string, contractId: string): SemanticContract[] {
  const directory = path.dirname(versionPath(novelId, contractId, 1));
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^v\d+\.json$/.test(name))
    .map((name) => readJsonFile<SemanticContract | null>(path.join(directory, name), null))
    .filter((contract): contract is SemanticContract => contract?.id === contractId && contract.projectId === novelId)
    .sort((left, right) => left.version - right.version);
}

export async function saveSemanticContractVersion(
  contract: SemanticContract,
  previousVersion: number,
): Promise<SemanticContract> {
  return withContractLock(contract.projectId, contract.id, () => {
    const current = readSemanticContract(contract.projectId, contract.id);
    if (!current || current.version !== previousVersion) {
      throw new Error("语义契约版本已变化，请重新加载后再修改");
    }
    const versionFile = versionPath(contract.projectId, contract.id, contract.version);
    if (fs.existsSync(versionFile)) throw new Error("语义契约版本不可覆盖");
    if (current.status === "confirmed" || current.status === "executing") {
      const supersededDir = path.join(contractsRoot(contract.projectId), "superseded", contract.id);
      writeJsonFile(path.join(supersededDir, `v${current.version}.json`), { ...current, status: "superseded" });
    }
    writeJsonFile(versionFile, contract);
    writeJsonFile(activePath(contract.projectId, contract.id), contract);
    return contract;
  });
}

export async function confirmSemanticContract(
  novelId: string,
  contractId: string,
  expectedVersion: number,
): Promise<SemanticContract> {
  return withContractLock(novelId, contractId, () => {
    const current = readSemanticContract(novelId, contractId);
    if (!current || current.version !== expectedVersion) throw new Error("语义契约版本已变化");
    if (current.confirmationMode === "blocked") throw new Error("该语义契约仍处于阻断状态，不能确认");
    if (current.status !== "awaiting_confirmation" && current.status !== "confirmed") {
      throw new Error(`当前契约状态 ${current.status} 不能确认`);
    }
    const now = new Date().toISOString();
    const confirmed: SemanticContract = {
      ...current,
      status: "confirmed",
      confirmedAt: current.confirmedAt ?? now,
      updatedAt: now,
    };
    confirmed.contentHash = semanticContractHash(confirmed);
    const locked = lockedPath(novelId, contractId, expectedVersion);
    if (fs.existsSync(locked)) {
      const existing = readJsonFile<SemanticContract | null>(locked, null);
      if (!existing || existing.contentHash !== confirmed.contentHash) {
        throw new Error("已锁定契约与当前内容不一致，拒绝静默覆盖");
      }
    } else {
      writeJsonFile(locked, confirmed);
    }
    writeJsonFile(activePath(novelId, contractId), confirmed);
    return confirmed;
  });
}

export async function setSemanticContractStatus(
  novelId: string,
  contractId: string,
  version: number,
  status: SemanticContractStatus,
  validation?: SemanticValidationResult,
): Promise<SemanticContract> {
  return withContractLock(novelId, contractId, () => {
    const current = readSemanticContract(novelId, contractId);
    if (!current || current.version !== version) throw new Error("语义契约版本已变化");
    const updated = { ...current, status, updatedAt: new Date().toISOString(), validation };
    writeJsonFile(activePath(novelId, contractId), updated);
    if (validation) writeJsonFile(validationPath(novelId, contractId, version), validation);
    return updated;
  });
}

export async function claimSemanticContractExecution(
  novelId: string,
  contractId: string,
  version: number,
): Promise<void> {
  await withContractLock(novelId, contractId, () => {
    const current = readSemanticContract(novelId, contractId);
    if (!current || current.version !== version) throw new Error("语义契约版本已变化");
    if (current.status !== "confirmed") {
      throw new Error(`语义契约当前状态为 ${current.status}，不能重复或并发执行`);
    }
    writeJsonFile(activePath(novelId, contractId), {
      ...current,
      status: "executing",
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function saveSemanticRules(novelId: string, constraints: SemanticConstraint[]): Promise<void> {
  const target = path.join(projectDir(novelId), ".withyou", "project-bible", "semantic-rules.json");
  const current = readJsonFile<Array<SemanticConstraint & { savedAt: string }>>(target, []);
  const additions = constraints
    .filter((item) => ["must", "must_not", "preserve"].includes(item.type))
    .map((item) => ({ ...item, savedAt: new Date().toISOString() }));
  const byDescription = new Map(current.map((item) => [`${item.type}:${item.description}`, item]));
  for (const item of additions) byDescription.set(`${item.type}:${item.description}`, item);
  writeJsonFile(target, [...byDescription.values()]);
}
