export type SemanticContractStatus =
  | "draft"
  | "awaiting_confirmation"
  | "confirmed"
  | "rejected"
  | "executing"
  | "completed"
  | "violated"
  | "superseded";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ConfirmationMode = "automatic" | "user_required" | "blocked";
export type SemanticTaskKind = "creation_tool" | "writer" | "tool_refinement" | "local_edit";

export type AffectedDimension =
  | "plot"
  | "character"
  | "relationship"
  | "worldbuilding"
  | "tone"
  | "pacing"
  | "style"
  | "dialogue"
  | "point_of_view"
  | "continuity"
  | "foreshadowing"
  | "other";

export interface SemanticInterpretation {
  id: string;
  sourceExpression: string;
  interpretedMeaning: string;
  affectedDimensions: AffectedDimension[];
  confidence: number;
  requiresConfirmation: boolean;
  editedByUser: boolean;
}

export interface SemanticConstraint {
  id: string;
  type: "must" | "must_not" | "prefer" | "avoid" | "preserve";
  description: string;
  source:
    | "current_user_input"
    | "project_bible"
    | "character_profile"
    | "outline"
    | "confirmed_memory"
    | "system_rule"
    | "model_inference";
  priority: number;
}

export interface SemanticAssumption {
  id: string;
  description: string;
  impactIfWrong: string;
  riskLevel: RiskLevel;
  confirmed: boolean;
  basis: string;
}

export interface PlannedCreativeDecision {
  id: string;
  decision: string;
  reason: string;
  alternativesConsidered?: string[];
  rejectedAlternatives?: Array<{ alternative: string; reasonForRejection: string }>;
  affectedFiles?: string[];
  riskLevel: RiskLevel;
}

export interface AmbiguityItem {
  id: string;
  expression: string;
  possibleMeanings: string[];
  selectedMeaning?: string;
  selectionReason?: string;
  requiresUserInput: boolean;
}

export interface SemanticSourceReference {
  path: string;
  version?: string;
  contentHash?: string;
  role: "project_truth" | "supporting_context" | "historical_reference";
}

export interface SemanticValidationResult {
  passed: boolean;
  checkedAt: string;
  satisfiedConstraints: string[];
  violatedConstraints: Array<{
    constraintId: string;
    description: string;
    evidence: string;
    severity: RiskLevel;
  }>;
  unverifiedConstraints: Array<{ constraintId: string; reason: string }>;
  detectedDrift: Array<{ contractField: string; expected: string; actual: string }>;
  requiresRegeneration: boolean;
}

export interface SemanticContract {
  id: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  taskKind: SemanticTaskKind;
  toolId?: string;
  version: number;
  status: SemanticContractStatus;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  contentHash?: string;
  originalUserInput: string;
  taskSummary: string;
  intendedOutcome: string;
  excludedScope: string[];
  interpretations: SemanticInterpretation[];
  constraints: SemanticConstraint[];
  assumptions: SemanticAssumption[];
  ambiguities: AmbiguityItem[];
  plannedDecisions: PlannedCreativeDecision[];
  riskLevel: RiskLevel;
  confirmationMode: ConfirmationMode;
  /**
   * 与项目硬事实的直接冲突或无法确定执行对象等阻断原因。
   * 这些内容只用于说明和拦截，不展示模型思考链。
   */
  blockingReasons?: string[];
  sourceReferences: SemanticSourceReference[];
  userEdits: Array<{
    fieldPath: string;
    previousValue: unknown;
    newValue: unknown;
    editedAt: string;
  }>;
  validation?: SemanticValidationResult;
}

export interface SemanticContractEditableFields {
  taskSummary: string;
  intendedOutcome: string;
  excludedScope: string[];
  interpretations: SemanticInterpretation[];
  constraints: SemanticConstraint[];
  assumptions: SemanticAssumption[];
  ambiguities: AmbiguityItem[];
  plannedDecisions: PlannedCreativeDecision[];
}

export interface SemanticContractEnvelope {
  contract: SemanticContract;
  history: SemanticContract[];
}
