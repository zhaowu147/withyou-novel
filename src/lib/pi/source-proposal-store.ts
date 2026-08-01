import "server-only";

import { resolveProjectPackageManager } from "./coding-environment";
import { requireSourceAccess } from "./source-permissions";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type PiSourceProposalStatus = "pending" | "applied" | "rejected" | "conflict" | "rolled_back";

export interface PiSourceProposal {
  id: string;
  filePath: string;
  summary: string;
  previousContent: string;
  proposedContent: string;
  previousHash: string;
  proposedHash: string;
  existedBefore: boolean;
  status: PiSourceProposalStatus;
  createdAt: string;
  decidedAt?: string;
  checkpoint?: {
    head: string;
    blob: string;
  };
  validation?: {
    command: string;
    ok: boolean;
    output: string;
  };
}

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".sql",
  ".toml",
  ".yaml",
  ".yml",
]);
const BLOCKED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".data",
  "node_modules",
  "novels",
  "secrets",
  "coverage",
  "dist",
  "build",
]);

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function storeFile(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "pi-source", "proposals.json");
}

export function resolveSourceFile(workspace: string, relativePath: string): string {
  const root = path.resolve(workspace);
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  const lowerName = path.basename(normalized).toLowerCase();
  if (
    !normalized ||
    segments.some((segment) => BLOCKED_SEGMENTS.has(segment)) ||
    segments.some((segment) => segment.toLowerCase().startsWith(".env")) ||
    lowerName === "settings.json" ||
    lowerName === ".npmrc"
  ) {
    throw new Error("该路径不允许由 Pi 访问");
  }
  const extension = path.extname(normalized).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`不允许修改 ${extension || "无扩展名"} 文件`);
  }
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("路径超出源码工作区");
  return resolved;
}

function readAll(): PiSourceProposal[] {
  const file = storeFile();
  try {
    if (!fs.existsSync(/* turbopackIgnore: true */ file)) return [];
    const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) as PiSourceProposal[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(proposals: PiSourceProposal[]): void {
  const file = storeFile();
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(/* turbopackIgnore: true */ temp, JSON.stringify(proposals, null, 2), "utf8");
  fs.renameSync(temp, file);
}

export function createSourceProposal(input: {
  filePath: string;
  proposedContent: string;
  summary: string;
}): PiSourceProposal {
  const workspace = requireSourceAccess();
  const target = resolveSourceFile(workspace, input.filePath);
  const existedBefore = fs.existsSync(/* turbopackIgnore: true */ target);
  const previousContent = existedBefore ? fs.readFileSync(/* turbopackIgnore: true */ target, "utf8") : "";
  const proposal: PiSourceProposal = {
    id: randomUUID(),
    filePath: path.relative(workspace, target).replaceAll("\\", "/"),
    summary: input.summary.trim() || "Pi 提议修改源码",
    previousContent,
    proposedContent: input.proposedContent,
    previousHash: hashText(previousContent),
    proposedHash: hashText(input.proposedContent),
    existedBefore,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  const proposals = readAll();
  proposals.unshift(proposal);
  writeAll(proposals.slice(0, 100));
  return proposal;
}

export function listSourceProposals(): PiSourceProposal[] {
  requireSourceAccess();
  return readAll();
}

function git(workspace: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    input,
    timeout: 20_000,
    windowsHide: true,
  }).trim();
}

function runTypecheck(workspace: string): PiSourceProposal["validation"] {
  const packageManager = resolveProjectPackageManager(workspace);
  if (!packageManager) {
    return {
      command: "未找到项目包管理器，未执行类型检查",
      ok: false,
      output: "未找到 pnpm、npm 或可用的 Corepack，源码已保留但需要先准备开发环境",
    };
  }
  const args =
    packageManager.manager === "npm"
      ? ["exec", "--", "tsc", "--noEmit"]
      : [...packageManager.prefixArgs, "exec", "tsc", "--noEmit"];
  const result = spawnSync(packageManager.executable, args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim().slice(-12_000);
  return {
    command: `${packageManager.displayName} ${args.slice(packageManager.prefixArgs.length).join(" ")}`,
    ok: result.status === 0,
    output: output || (result.status === 0 ? "类型检查通过" : "类型检查失败"),
  };
}

export function decideSourceProposal(proposalId: string, decision: "apply" | "reject"): PiSourceProposal {
  const workspace = requireSourceAccess();
  const proposals = readAll();
  const proposal = proposals.find((item) => item.id === proposalId);
  if (!proposal) throw new Error("找不到该源码候选改动");
  if (proposal.status !== "pending") return proposal;

  if (decision === "reject") {
    proposal.status = "rejected";
    proposal.decidedAt = new Date().toISOString();
    writeAll(proposals);
    return proposal;
  }

  const target = resolveSourceFile(workspace, proposal.filePath);
  const current = fs.existsSync(/* turbopackIgnore: true */ target)
    ? fs.readFileSync(/* turbopackIgnore: true */ target, "utf8")
    : "";
  if (hashText(current) !== proposal.previousHash) {
    proposal.status = "conflict";
    proposal.decidedAt = new Date().toISOString();
    writeAll(proposals);
    throw new Error("源码在候选补丁生成后已变化，请让 Pi 重新读取并生成补丁");
  }

  proposal.checkpoint = {
    head: git(workspace, ["rev-parse", "HEAD"]),
    blob: git(workspace, ["hash-object", "-w", "--stdin"], proposal.previousContent),
  };
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.pi.tmp`;
  fs.writeFileSync(/* turbopackIgnore: true */ temp, proposal.proposedContent, "utf8");
  fs.renameSync(temp, target);
  proposal.status = "applied";
  proposal.decidedAt = new Date().toISOString();
  proposal.validation = runTypecheck(workspace);
  writeAll(proposals);
  return proposal;
}

export function rollbackSourceProposal(proposalId: string): PiSourceProposal {
  const workspace = requireSourceAccess();
  const proposals = readAll();
  const proposal = proposals.find((item) => item.id === proposalId);
  if (!proposal) throw new Error("找不到该源码候选改动");
  if (proposal.status !== "applied") throw new Error("只有已应用的补丁可以回滚");

  const target = resolveSourceFile(workspace, proposal.filePath);
  const current = fs.existsSync(/* turbopackIgnore: true */ target)
    ? fs.readFileSync(/* turbopackIgnore: true */ target, "utf8")
    : "";
  if (hashText(current) !== proposal.proposedHash) {
    throw new Error("该文件在补丁应用后又有变化，为避免覆盖新修改，已拒绝自动回滚");
  }
  if (proposal.existedBefore) {
    const temp = `${target}.${process.pid}.rollback.tmp`;
    fs.writeFileSync(/* turbopackIgnore: true */ temp, proposal.previousContent, "utf8");
    fs.renameSync(temp, target);
  } else if (fs.existsSync(/* turbopackIgnore: true */ target)) {
    fs.unlinkSync(/* turbopackIgnore: true */ target);
  }
  proposal.status = "rolled_back";
  proposal.validation = runTypecheck(workspace);
  writeAll(proposals);
  return proposal;
}
