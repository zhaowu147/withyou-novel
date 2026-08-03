import "server-only";

import { gatewayCall } from "@/lib/ai/gateway";
import { readSettingsFile } from "@/lib/settings/settings-file";

import {
  applyAlignmentGate,
  classifySemanticTaskKind,
  diffEditableFields,
  editableContractFields,
  extractJsonObject,
  maxRisk,
  normalizeEditableFields,
} from "./core";
import {
  buildSemanticParserUserPrompt,
  buildSemanticValidatorUserPrompt,
  SEMANTIC_PARSER_SYSTEM_PROMPT,
  SEMANTIC_VALIDATOR_SYSTEM_PROMPT,
} from "./prompts";
import {
  claimSemanticContractExecution,
  collectSemanticSourceReferences,
  confirmSemanticContract,
  createSemanticContract,
  listSemanticContractVersions,
  readLockedSemanticContract,
  readSemanticContract,
  readSemanticProjectContext,
  saveSemanticContractVersion,
  saveSemanticRules,
  semanticContractHash,
  setSemanticContractStatus,
  staleSemanticSources,
} from "./store";
import type {
  RiskLevel,
  SemanticContract,
  SemanticContractEditableFields,
  SemanticContractEnvelope,
  SemanticTaskKind,
  SemanticValidationResult,
} from "./types";

export class SemanticAlignmentError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status = 409) {
    super(message);
    this.name = "SemanticAlignmentError";
    this.status = status;
    this.code = code;
  }
}

import { randomUUID } from "node:crypto";

function parserFailureDraft(input: {
  novelId: string;
  workspaceId: string;
  taskKind: SemanticTaskKind;
  toolId?: string;
  userInput: string;
  reason: string;
}): Record<string, unknown> {
  return {
    taskSummary: input.userInput.slice(0, 300) || "未能解析任务",
    intendedOutcome: input.userInput.slice(0, 500) || "未知",
    excludedScope: [],
    interpretations: [],
    constraints: [],
    assumptions: [
      {
        description: "语义解析结果不可用",
        impactIfWrong: "系统无法证明执行 Agent 与用户意图一致",
        riskLevel: "critical",
        confirmed: false,
        basis: input.reason,
      },
    ],
    ambiguities: [
      {
        expression: "语义契约解析失败",
        possibleMeanings: [input.reason],
        requiresUserInput: true,
      },
    ],
    plannedDecisions: [],
    riskLevel: "critical",
  };
}

function envelope(contract: SemanticContract): SemanticContractEnvelope {
  return { contract, history: listSemanticContractVersions(contract.projectId, contract.id) };
}

function projectFactConflictReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const conflict = entry as Record<string, unknown>;
    const description = typeof conflict.description === "string" ? conflict.description.trim() : "";
    const userRequirement = typeof conflict.userRequirement === "string" ? conflict.userRequirement.trim() : "";
    const projectFact = typeof conflict.projectFact === "string" ? conflict.projectFact.trim() : "";
    const sourcePath = typeof conflict.sourcePath === "string" ? conflict.sourcePath.trim() : "";
    if (!description && !(userRequirement && projectFact)) return [];
    const detail = description || `用户要求“${userRequirement}”与项目事实“${projectFact}”冲突`;
    return [`${sourcePath ? `[${sourcePath}] ` : ""}${detail}`.slice(0, 2_000)];
  });
}

export async function parseSemanticContract(input: {
  novelId: string;
  workspaceId: string;
  taskKind: SemanticTaskKind;
  toolId?: string;
  userInput: string;
  formData?: Record<string, string>;
}): Promise<SemanticContractEnvelope> {
  const originalUserInput = input.userInput.trim().slice(0, 30_000);
  if (!originalUserInput) throw new Error("用户任务不能为空");
  const taskKind = classifySemanticTaskKind({
    userInput: originalUserInput,
    requestedKind: input.taskKind,
    toolId: input.toolId,
  });
  const projectContext = readSemanticProjectContext(input.novelId);
  let parsed: Record<string, unknown> | null = null;
  let parseFailure = "";
  try {
    const raw = await gatewayCall({
      channel: "dispatch",
      systemPrompt: SEMANTIC_PARSER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildSemanticParserUserPrompt({
            userInput: originalUserInput,
            taskKind,
            toolId: input.toolId,
            formData: input.formData,
            projectContext,
          }),
        },
      ],
      maxTokens: 6_000,
      temperature: 0.1,
    });
    parsed = extractJsonObject(raw);
    if (!parsed) parseFailure = "Semantic Parser 未返回合法 JSON 对象";
  } catch (error) {
    parseFailure = error instanceof Error ? error.message : "Semantic Parser 调用失败";
  }
  const source = parsed ?? parserFailureDraft({ ...input, taskKind, reason: parseFailure });
  const now = new Date().toISOString();
  const editable = normalizeEditableFields(source, originalUserInput);
  const draft: SemanticContract = {
    id: randomUUID(),
    projectId: input.novelId,
    taskId: randomUUID(),
    sessionId: input.workspaceId,
    taskKind,
    toolId: input.toolId,
    version: 1,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    originalUserInput,
    ...editable,
    riskLevel: (["low", "medium", "high", "critical"] as const).includes(source.riskLevel as RiskLevel)
      ? (source.riskLevel as RiskLevel)
      : "medium",
    confirmationMode: "user_required",
    blockingReasons: projectFactConflictReasons(source.projectFactConflicts),
    sourceReferences: collectSemanticSourceReferences(input.novelId),
    userEdits: [],
  };
  const autoConfirmLowRisk = readSettingsFile().semanticAlignment.autoConfirmLowRisk;
  let gated = applyAlignmentGate(draft, {
    autoConfirmLowRisk,
    hasProjectFactConflict: Boolean(draft.blockingReasons?.length),
    parseFailed: Boolean(parseFailure),
  });
  if (gated.status === "confirmed") gated = { ...gated, contentHash: semanticContractHash(gated) };
  return envelope(await createSemanticContract(gated));
}

export function getSemanticContractEnvelope(novelId: string, contractId: string): SemanticContractEnvelope {
  const contract = readSemanticContract(novelId, contractId);
  if (!contract) throw new Error("语义契约不存在");
  return envelope(contract);
}

export async function updateSemanticContract(input: {
  novelId: string;
  contractId: string;
  expectedVersion: number;
  fields: SemanticContractEditableFields;
}): Promise<SemanticContractEnvelope> {
  const current = readSemanticContract(input.novelId, input.contractId);
  if (!current || current.version !== input.expectedVersion) throw new Error("语义契约版本已变化");
  const normalized = normalizeEditableFields(
    input.fields as unknown as Record<string, unknown>,
    current.originalUserInput,
  );
  const edits = diffEditableFields(current, normalized);
  if (!edits.length) return envelope(current);
  const now = new Date().toISOString();
  const next: SemanticContract = {
    ...current,
    ...normalized,
    version: current.version + 1,
    status: "draft",
    updatedAt: now,
    confirmedAt: undefined,
    contentHash: undefined,
    validation: undefined,
    userEdits: [...current.userEdits, ...edits],
    riskLevel: maxRisk(current.riskLevel, "medium"),
  };
  const gated = applyAlignmentGate(next, {
    autoConfirmLowRisk: readSettingsFile().semanticAlignment.autoConfirmLowRisk,
  });
  return envelope(await saveSemanticContractVersion(gated, current.version));
}

export async function confirmSemanticContractForExecution(input: {
  novelId: string;
  contractId: string;
  version: number;
  saveAsLongTerm?: boolean;
}): Promise<SemanticContractEnvelope> {
  const current = readSemanticContract(input.novelId, input.contractId);
  if (!current || current.version !== input.version) throw new Error("语义契约版本已变化");
  const unresolvedAmbiguity = current.ambiguities.some((item) => item.requiresUserInput && !item.selectedMeaning);
  const unconfirmedRisk = current.assumptions.some(
    (item) => !item.confirmed && (item.riskLevel === "high" || item.riskLevel === "critical"),
  );
  if (unresolvedAmbiguity || unconfirmedRisk) {
    throw new Error("仍有高风险歧义或假设未确认，请先修改契约");
  }
  const confirmed = await confirmSemanticContract(input.novelId, input.contractId, input.version);
  if (input.saveAsLongTerm) await saveSemanticRules(input.novelId, confirmed.constraints);
  return envelope(confirmed);
}

export async function rejectSemanticContract(
  novelId: string,
  contractId: string,
  version: number,
): Promise<SemanticContractEnvelope> {
  return envelope(await setSemanticContractStatus(novelId, contractId, version, "rejected"));
}

export async function reparseSemanticContract(
  novelId: string,
  contractId: string,
  expectedVersion: number,
): Promise<SemanticContractEnvelope> {
  const current = readSemanticContract(novelId, contractId);
  if (!current || current.version !== expectedVersion) throw new Error("语义契约版本已变化");
  const parsed = await parseSemanticContract({
    novelId,
    workspaceId: current.sessionId,
    taskKind: current.taskKind,
    toolId: current.toolId,
    userInput: current.originalUserInput,
  });
  await setSemanticContractStatus(novelId, contractId, expectedVersion, "superseded");
  return parsed;
}

export async function requireExecutableSemanticContract(
  novelId: string,
  contractId: string,
  version: number,
): Promise<SemanticContract> {
  const locked = readLockedSemanticContract(novelId, contractId, version);
  if (!locked || locked.status !== "confirmed") {
    throw new SemanticAlignmentError("只能执行已经确认并锁定的语义契约版本", "SEMANTIC_CONTRACT_NOT_CONFIRMED");
  }
  if (!locked.contentHash || locked.contentHash !== semanticContractHash(locked)) {
    throw new SemanticAlignmentError("语义契约内容哈希不一致，已阻止执行", "SEMANTIC_CONTRACT_HASH_MISMATCH");
  }
  const stale = staleSemanticSources(novelId, locked);
  if (stale.length) {
    await setSemanticContractStatus(novelId, contractId, version, "superseded");
    throw new SemanticAlignmentError(
      `语义契约依据已过期，请重新解析：${stale.slice(0, 5).join("、")}`,
      "SEMANTIC_CONTRACT_STALE",
    );
  }
  try {
    await claimSemanticContractExecution(novelId, contractId, version);
  } catch (error) {
    throw new SemanticAlignmentError(
      error instanceof Error ? error.message : "语义契约不能重复或并发执行",
      "SEMANTIC_EXECUTION_CONFLICT",
    );
  }
  return locked;
}

function validationFailure(contract: SemanticContract, reason: string): SemanticValidationResult {
  const checkable = contract.constraints.filter((item) => ["must", "must_not", "preserve"].includes(item.type));
  return {
    passed: false,
    checkedAt: new Date().toISOString(),
    satisfiedConstraints: [],
    violatedConstraints: [],
    unverifiedConstraints: checkable.map((item) => ({ constraintId: item.id, reason })),
    detectedDrift: [],
    requiresRegeneration: true,
  };
}

export async function recordSemanticExecutionFailure(
  contract: SemanticContract,
  error: unknown,
): Promise<SemanticValidationResult> {
  const validation = validationFailure(
    contract,
    `执行未完成：${error instanceof Error ? error.message : String(error)}`,
  );
  await setSemanticContractStatus(contract.projectId, contract.id, contract.version, "violated", validation);
  return validation;
}

export async function validateSemanticExecution(
  contract: SemanticContract,
  result: string,
): Promise<SemanticValidationResult> {
  let validation: SemanticValidationResult;
  try {
    const raw = await gatewayCall({
      channel: "dispatch",
      systemPrompt: SEMANTIC_VALIDATOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildSemanticValidatorUserPrompt(contract, result, readSemanticProjectContext(contract.projectId)),
        },
      ],
      maxTokens: 5_000,
      temperature: 0.1,
    });
    const parsed = extractJsonObject(raw);
    if (!parsed) {
      validation = validationFailure(contract, "Semantic Validator 未返回合法 JSON");
    } else {
      const satisfiedConstraints = Array.isArray(parsed.satisfiedConstraints)
        ? parsed.satisfiedConstraints.map(String).slice(0, 100)
        : [];
      const violatedConstraints = Array.isArray(parsed.violatedConstraints)
        ? parsed.violatedConstraints.slice(0, 100).flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const item = entry as Record<string, unknown>;
            return [
              {
                constraintId: String(item.constraintId ?? ""),
                description: String(item.description ?? ""),
                evidence: String(item.evidence ?? ""),
                severity: (["low", "medium", "high", "critical"] as const).includes(item.severity as RiskLevel)
                  ? (item.severity as RiskLevel)
                  : ("medium" as const),
              },
            ];
          })
        : [];
      const unverifiedConstraints = Array.isArray(parsed.unverifiedConstraints)
        ? parsed.unverifiedConstraints.slice(0, 100).flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const item = entry as Record<string, unknown>;
            return [{ constraintId: String(item.constraintId ?? ""), reason: String(item.reason ?? "") }];
          })
        : [];
      const detectedDrift = Array.isArray(parsed.detectedDrift)
        ? parsed.detectedDrift.slice(0, 100).flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const item = entry as Record<string, unknown>;
            return [
              {
                contractField: String(item.contractField ?? ""),
                expected: String(item.expected ?? ""),
                actual: String(item.actual ?? ""),
              },
            ];
          })
        : [];
      const passed =
        parsed.passed === true &&
        violatedConstraints.length === 0 &&
        unverifiedConstraints.length === 0 &&
        detectedDrift.length === 0;
      validation = {
        passed,
        checkedAt: new Date().toISOString(),
        satisfiedConstraints,
        violatedConstraints,
        unverifiedConstraints,
        detectedDrift,
        requiresRegeneration: parsed.requiresRegeneration === true || !passed,
      };
    }
  } catch (error) {
    validation = validationFailure(
      contract,
      `Semantic Validator 不可用：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
  await setSemanticContractStatus(
    contract.projectId,
    contract.id,
    contract.version,
    validation.passed ? "completed" : "violated",
    validation,
  );
  return validation;
}

export function editableFieldsForClient(contract: SemanticContract): SemanticContractEditableFields {
  return editableContractFields(contract);
}
