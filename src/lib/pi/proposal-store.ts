import "server-only";

import { projectDir, sanitizeNovelId, vaultDir } from "@/lib/local/paths";

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type PiProposalStatus = "pending" | "applied" | "rejected" | "conflict";

export interface PiFileProposal {
  id: string;
  workspaceId?: string;
  novelId: string;
  filePath: string;
  summary: string;
  previousContent: string;
  proposedContent: string;
  previousHash: string;
  status: PiProposalStatus;
  createdAt: string;
  decidedAt?: string;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function proposalFile(novelId: string): string {
  return path.join(vaultDir(sanitizeNovelId(novelId)), "pi-proposals.json");
}

function resolveProjectFile(novelId: string, relativePath: string): string {
  const root = path.resolve(projectDir(sanitizeNovelId(novelId)));
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("vault/") || normalized === "vault") {
    throw new Error("Pi 不能修改应用内部 vault 数据");
  }
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("文件路径超出当前小说项目");
  }
  return resolved;
}

function readAll(novelId: string): PiFileProposal[] {
  const file = proposalFile(novelId);
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PiFileProposal[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(novelId: string, proposals: PiFileProposal[]): void {
  const file = proposalFile(novelId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(proposals, null, 2), "utf8");
  fs.renameSync(temp, file);
}

export function createPiProposal(
  workspaceId: string,
  novelId: string,
  input: { filePath: string; proposedContent: string; summary: string },
): PiFileProposal {
  const target = resolveProjectFile(novelId, input.filePath);
  const previousContent = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const proposal: PiFileProposal = {
    id: randomUUID(),
    workspaceId,
    novelId: sanitizeNovelId(novelId),
    filePath: path.relative(projectDir(novelId), target).replaceAll("\\", "/"),
    summary: input.summary.trim() || "Pi 提议修改文件",
    previousContent,
    proposedContent: input.proposedContent,
    previousHash: hashText(previousContent),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  const proposals = readAll(novelId);
  proposals.unshift(proposal);
  writeAll(novelId, proposals.slice(0, 100));
  return proposal;
}

export function listPiProposals(novelId: string): PiFileProposal[] {
  return readAll(novelId);
}

export function decidePiProposal(
  workspaceId: string,
  novelId: string,
  proposalId: string,
  decision: "apply" | "reject",
): PiFileProposal {
  const proposals = readAll(novelId);
  const proposal = proposals.find((item) => item.id === proposalId);
  if (!proposal) throw new Error("找不到该候选改动");
  if (!proposal.workspaceId) {
    throw new Error("该候选改动来自旧版未隔离会话，无法证明所有权；请让 Pi 重新生成");
  }
  if (proposal.workspaceId !== workspaceId) {
    throw new Error("该候选改动不属于当前会话，已拒绝执行");
  }
  if (proposal.status !== "pending") return proposal;

  if (decision === "reject") {
    proposal.status = "rejected";
    proposal.decidedAt = new Date().toISOString();
    writeAll(novelId, proposals);
    return proposal;
  }

  const target = resolveProjectFile(novelId, proposal.filePath);
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (hashText(current) !== proposal.previousHash) {
    proposal.status = "conflict";
    proposal.decidedAt = new Date().toISOString();
    writeAll(novelId, proposals);
    throw new Error("文件在候选改动生成后已被修改，请让 Pi 重新读取后再提议");
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.pi.tmp`;
  fs.writeFileSync(temp, proposal.proposedContent, "utf8");
  fs.renameSync(temp, target);
  proposal.status = "applied";
  proposal.decidedAt = new Date().toISOString();
  writeAll(novelId, proposals);
  return proposal;
}
