import type {
  AffectedDimension,
  AmbiguityItem,
  ConfirmationMode,
  PlannedCreativeDecision,
  RiskLevel,
  SemanticAssumption,
  SemanticConstraint,
  SemanticContract,
  SemanticContractEditableFields,
  SemanticInterpretation,
  SemanticTaskKind,
} from "./types";

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const DIMENSIONS = new Set<AffectedDimension>([
  "plot",
  "character",
  "relationship",
  "worldbuilding",
  "tone",
  "pacing",
  "style",
  "dialogue",
  "point_of_view",
  "continuity",
  "foreshadowing",
  "other",
]);
const CONSTRAINT_TYPES = new Set<SemanticConstraint["type"]>(["must", "must_not", "prefer", "avoid", "preserve"]);
const CONSTRAINT_SOURCES = new Set<SemanticConstraint["source"]>([
  "current_user_input",
  "project_bible",
  "character_profile",
  "outline",
  "confirmed_memory",
  "system_rule",
  "model_inference",
]);
const HIGH_IMPACT_TOOLS = new Set(["outline", "detailed-outline", "opening", "character", "worldview", "goldfinger"]);
const IRREVERSIBLE_PATTERN =
  /死亡|杀死|背叛|失忆|身份反转|决裂|改写世界观|修改世界观|核心动机|角色关系|主线|伏笔|删除角色|新增角色|增加角色|已发布|锁定章节/i;
const AMBIGUOUS_STYLE_PATTERN = /一点|一些|保持原来|原来的感觉|适当|差不多|别太|不要太|更有感觉|冷漠|克制|优雅/i;
const LOCAL_TEXT_UNIT_PATTERN = /这(?:一)?句|这句话|这个句子|本句|这(?:一)?段|选中(?:的)?(?:文字|内容|段落)/i;
const LOCAL_EDIT_ACTION_PATTERN =
  /修正|改正|纠正|调整语序|修改语序|修复标点|修改标点|删除这|删掉这|替换这|改成第一人称|改为第一人称|修改(?:指定)?角色姓名/i;
const NON_LOCAL_SCOPE_PATTERN =
  /全文|全书|整本|全部章节|所有章节|每(?:一)?章|后续章节|跨章节|世界观|主线|核心动机|角色关系|伏笔|新增角色|增加角色|删除角色/i;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim().slice(0, 20_000) : fallback;
}

function stringArray(value: unknown, max = 20): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => text(item))
        .filter(Boolean)
        .slice(0, max)
    : [];
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function risk(value: unknown, fallback: RiskLevel = "medium"): RiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "critical" ? value : fallback;
}

function withId(prefix: string, index: number, value: unknown): string {
  const candidate = value && typeof value === "object" ? text((value as { id?: unknown }).id) : "";
  return candidate || `${prefix}-${index + 1}`;
}

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeInterpretations(value: unknown): SemanticInterpretation[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 7)
    .map((entry, index) => {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const dimensions = stringArray(item.affectedDimensions, 6).filter((dimension) =>
        DIMENSIONS.has(dimension as AffectedDimension),
      ) as AffectedDimension[];
      return {
        id: withId("interpretation", index, item),
        sourceExpression: text(item.sourceExpression),
        interpretedMeaning: text(item.interpretedMeaning),
        affectedDimensions: (dimensions.length ? dimensions : ["other"]) as AffectedDimension[],
        confidence: numberInRange(item.confidence, 0.6, 0, 1),
        requiresConfirmation: item.requiresConfirmation === true,
        editedByUser: item.editedByUser === true,
      };
    })
    .filter((item) => item.sourceExpression && item.interpretedMeaning);
}

function normalizeConstraints(value: unknown): SemanticConstraint[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 30)
    .map((entry, index) => {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      return {
        id: withId("constraint", index, item),
        type: CONSTRAINT_TYPES.has(item.type as SemanticConstraint["type"])
          ? (item.type as SemanticConstraint["type"])
          : "prefer",
        description: text(item.description),
        source: CONSTRAINT_SOURCES.has(item.source as SemanticConstraint["source"])
          ? (item.source as SemanticConstraint["source"])
          : "model_inference",
        priority: numberInRange(item.priority, item.source === "current_user_input" ? 100 : 60, 0, 100),
      };
    })
    .filter((item) => item.description);
}

function normalizeAssumptions(value: unknown): SemanticAssumption[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 12)
    .map((entry, index) => {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      return {
        id: withId("assumption", index, item),
        description: text(item.description),
        impactIfWrong: text(item.impactIfWrong),
        riskLevel: risk(item.riskLevel),
        confirmed: item.confirmed === true,
        basis: text(item.basis),
      };
    })
    .filter((item) => item.description);
}

function normalizeAmbiguities(value: unknown): AmbiguityItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 12)
    .map((entry, index) => {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      return {
        id: withId("ambiguity", index, item),
        expression: text(item.expression),
        possibleMeanings: stringArray(item.possibleMeanings, 6),
        selectedMeaning: text(item.selectedMeaning) || undefined,
        selectionReason: text(item.selectionReason) || undefined,
        requiresUserInput: item.requiresUserInput === true,
      };
    })
    .filter((item) => item.expression && item.possibleMeanings.length > 0);
}

function normalizeDecisions(value: unknown): PlannedCreativeDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 12)
    .map((entry, index) => {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const rejectedAlternatives = Array.isArray(item.rejectedAlternatives)
        ? item.rejectedAlternatives
            .slice(0, 6)
            .map((entry) => {
              const rejected = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
              return {
                alternative: text(rejected.alternative),
                reasonForRejection: text(rejected.reasonForRejection),
              };
            })
            .filter((entry) => entry.alternative)
        : undefined;
      return {
        id: withId("decision", index, item),
        decision: text(item.decision),
        reason: text(item.reason),
        alternativesConsidered: stringArray(item.alternativesConsidered, 8),
        rejectedAlternatives,
        affectedFiles: stringArray(item.affectedFiles, 20),
        riskLevel: risk(item.riskLevel),
      };
    })
    .filter((item) => item.decision);
}

export function normalizeEditableFields(
  value: Record<string, unknown>,
  originalUserInput: string,
): SemanticContractEditableFields {
  return {
    taskSummary: text(value.taskSummary, originalUserInput.slice(0, 300)),
    intendedOutcome: text(value.intendedOutcome, originalUserInput.slice(0, 500)),
    excludedScope: stringArray(value.excludedScope, 12),
    interpretations: normalizeInterpretations(value.interpretations),
    constraints: normalizeConstraints(value.constraints),
    assumptions: normalizeAssumptions(value.assumptions),
    ambiguities: normalizeAmbiguities(value.ambiguities),
    plannedDecisions: normalizeDecisions(value.plannedDecisions),
  };
}

export function maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return RISK_ORDER[left] >= RISK_ORDER[right] ? left : right;
}

export function deriveMinimumRisk(input: {
  userInput: string;
  taskKind: SemanticTaskKind;
  toolId?: string;
}): RiskLevel {
  if (IRREVERSIBLE_PATTERN.test(input.userInput)) return "high";
  if (input.taskKind === "writer" || input.taskKind === "tool_refinement") return "medium";
  if (input.toolId && HIGH_IMPACT_TOOLS.has(input.toolId)) return "high";
  return input.taskKind === "local_edit" ? "low" : "medium";
}

export function classifySemanticTaskKind(input: {
  userInput: string;
  requestedKind: SemanticTaskKind;
  toolId?: string;
}): SemanticTaskKind {
  if (input.requestedKind === "local_edit") return "local_edit";
  if (input.requestedKind !== "writer" || input.toolId) return input.requestedKind;
  const userInput = input.userInput.trim();
  if (
    userInput.length <= 300 &&
    LOCAL_TEXT_UNIT_PATTERN.test(userInput) &&
    LOCAL_EDIT_ACTION_PATTERN.test(userInput) &&
    !NON_LOCAL_SCOPE_PATTERN.test(userInput) &&
    !IRREVERSIBLE_PATTERN.test(userInput)
  ) {
    return "local_edit";
  }
  return input.requestedKind;
}

export function ensureKnownAmbiguities(contract: SemanticContract): SemanticContract {
  if (!/冷漠/.test(contract.originalUserInput) || !/不要突然|别突然|不能突然/.test(contract.originalUserInput)) {
    return contract;
  }
  const canonicalMeanings = [
    "仍然在意，但主动减少表达和解释",
    "感情正在消退，只是角色尚未完全意识到",
    "因疲惫或防御暂时拉开距离",
  ];
  const ambiguityWasEditedByUser = contract.userEdits.some((edit) => edit.fieldPath === "ambiguities");
  const existingIndex = contract.ambiguities.findIndex((item) => /冷漠/.test(item.expression));
  if (existingIndex >= 0) {
    return {
      ...contract,
      ambiguities: contract.ambiguities.map((item, index) =>
        index === existingIndex
          ? {
              ...item,
              possibleMeanings: [...new Set([...item.possibleMeanings, ...canonicalMeanings])],
              selectedMeaning: ambiguityWasEditedByUser ? item.selectedMeaning : undefined,
              selectionReason: ambiguityWasEditedByUser ? item.selectionReason : undefined,
              requiresUserInput: true,
            }
          : item,
      ),
      riskLevel: maxRisk(contract.riskLevel, "high"),
    };
  }
  return {
    ...contract,
      ambiguities: [
      ...contract.ambiguities,
      {
        id: `ambiguity-coldness-${contract.version}`,
        expression: "冷漠",
        possibleMeanings: canonicalMeanings,
        requiresUserInput: true,
      },
    ],
    riskLevel: maxRisk(contract.riskLevel, "high"),
  };
}

function normalizedConstraintDescription(description: string): string {
  return description
    .toLocaleLowerCase()
    .replace(/不得|不能|不要|必须|应当|需要|保留|保持|避免|禁止|not|must|preserve/gi, "")
    .replace(/[\s，。！？、,.!?;；:“”"'（）()]/g, "");
}

export function findConstraintConflicts(constraints: SemanticConstraint[]): string[] {
  const hard = constraints.filter(
    (item) => item.priority >= 90 && ["must", "must_not", "preserve"].includes(item.type),
  );
  const conflicts: string[] = [];
  for (let index = 0; index < hard.length; index += 1) {
    for (let other = index + 1; other < hard.length; other += 1) {
      const left = hard[index];
      const right = hard[other];
      const opposite = (left.type === "must_not") !== (right.type === "must_not");
      const sameMeaning =
        normalizedConstraintDescription(left.description) === normalizedConstraintDescription(right.description);
      if (opposite && sameMeaning) conflicts.push(`${left.id}:${right.id}`);
    }
  }
  return conflicts;
}

export function applyAlignmentGate(
  input: SemanticContract,
  options: { autoConfirmLowRisk: boolean; hasProjectFactConflict?: boolean; parseFailed?: boolean },
): SemanticContract {
  let contract = ensureKnownAmbiguities(input);
  const minimumRisk = deriveMinimumRisk({
    userInput: contract.originalUserInput,
    taskKind: contract.taskKind,
    toolId: contract.toolId,
  });
  contract = { ...contract, riskLevel: maxRisk(contract.riskLevel, minimumRisk) };
  const highRiskAssumption = contract.assumptions.some(
    (item) => !item.confirmed && (item.riskLevel === "high" || item.riskLevel === "critical"),
  );
  const conflicts = findConstraintConflicts(contract.constraints);
  const ambiguous =
    contract.ambiguities.some((item) => item.requiresUserInput && !item.selectedMeaning) ||
    contract.interpretations.some((item) => item.requiresConfirmation) ||
    AMBIGUOUS_STYLE_PATTERN.test(contract.originalUserInput);
  const highRiskDecision = contract.plannedDecisions.some(
    (item) => item.riskLevel === "high" || item.riskLevel === "critical",
  );

  let confirmationMode: ConfirmationMode;
  const hasProjectFactConflict = options.hasProjectFactConflict ?? Boolean(contract.blockingReasons?.length);
  if (options.parseFailed || hasProjectFactConflict || conflicts.length > 0 || highRiskAssumption) {
    confirmationMode = "blocked";
  } else if (contract.riskLevel === "high" || contract.riskLevel === "critical" || ambiguous || highRiskDecision) {
    confirmationMode = "user_required";
  } else if (options.autoConfirmLowRisk && contract.riskLevel === "low" && contract.taskKind === "local_edit") {
    confirmationMode = "automatic";
  } else {
    confirmationMode = "user_required";
  }

  const now = new Date().toISOString();
  return {
    ...contract,
    confirmationMode,
    status: confirmationMode === "automatic" ? "confirmed" : "awaiting_confirmation",
    confirmedAt: confirmationMode === "automatic" ? now : undefined,
    updatedAt: now,
  };
}

export function editableContractFields(contract: SemanticContract): SemanticContractEditableFields {
  return {
    taskSummary: contract.taskSummary,
    intendedOutcome: contract.intendedOutcome,
    excludedScope: contract.excludedScope,
    interpretations: contract.interpretations,
    constraints: contract.constraints,
    assumptions: contract.assumptions,
    ambiguities: contract.ambiguities,
    plannedDecisions: contract.plannedDecisions,
  };
}

export function diffEditableFields(
  previous: SemanticContract,
  next: SemanticContractEditableFields,
  editedAt = new Date().toISOString(),
): SemanticContract["userEdits"] {
  const edits: SemanticContract["userEdits"] = [];
  for (const key of Object.keys(next) as Array<keyof SemanticContractEditableFields>) {
    if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue;
    edits.push({ fieldPath: key, previousValue: previous[key], newValue: next[key], editedAt });
  }
  return edits;
}
