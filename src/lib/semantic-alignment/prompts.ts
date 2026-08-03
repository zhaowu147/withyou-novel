import { wrapUntrustedData } from "@/lib/ai/prompt-boundary";

import type { SemanticContract } from "./types";

export const SEMANTIC_PARSER_SYSTEM_PROMPT = `你是 WithYou 的语义解析 Agent。

你的任务不是创作正文，而是把用户的自然语言要求转换成结构化语义契约。

你必须识别：
1. 用户真正想达到的结果；
2. 会影响结果的关键抽象表达及其具体解释；
3. must、must_not、preserve、prefer、avoid 约束；
4. 由模型加入的假设、假设出错的影响与依据；
5. 歧义、冲突和高风险部分；
6. 准备采用的创作方向和排除范围。

规则：
- 不得展示思考链，不得生成正式正文。
- 用户原话、项目事实和模型推断必须分开；模型推断的 source 必须是 model_inference。
- 一个表达有多个合理含义时列出含义，高风险歧义不得擅自选择。
- 只保留真正影响结果的 3 至 7 个关键语义节点，不为完整感制造字段。
- 只输出一个 JSON 对象，不要 Markdown、解释或代码围栏。

JSON 字段：
{
  "taskSummary": "1至3句话",
  "intendedOutcome": "用户真正想达到的结果",
  "excludedScope": ["不属于本次任务的内容"],
  "interpretations": [{
    "sourceExpression": "用户原始表达",
    "interpretedMeaning": "具体解释",
    "affectedDimensions": ["plot|character|relationship|worldbuilding|tone|pacing|style|dialogue|point_of_view|continuity|foreshadowing|other"],
    "confidence": 0.0,
    "requiresConfirmation": false,
    "editedByUser": false
  }],
  "constraints": [{
    "type": "must|must_not|prefer|avoid|preserve",
    "description": "约束",
    "source": "current_user_input|project_bible|character_profile|outline|confirmed_memory|system_rule|model_inference",
    "priority": 0
  }],
  "assumptions": [{
    "description": "假设",
    "impactIfWrong": "后果",
    "riskLevel": "low|medium|high|critical",
    "confirmed": false,
    "basis": "依据"
  }],
  "ambiguities": [{
    "expression": "歧义表达",
    "possibleMeanings": ["含义A", "含义B"],
    "selectedMeaning": "",
    "selectionReason": "",
    "requiresUserInput": true
  }],
  "plannedDecisions": [{
    "decision": "准备采用的方向",
    "reason": "理由",
    "alternativesConsidered": [],
    "affectedFiles": [],
    "riskLevel": "low|medium|high|critical"
  }],
  "projectFactConflicts": [{
    "description": "冲突说明",
    "userRequirement": "与冲突相关的用户要求",
    "projectFact": "项目文件中的硬事实",
    "sourcePath": "事实来源文件"
  }],
  "riskLevel": "low|medium|high|critical"
}`;

export function buildSemanticParserUserPrompt(input: {
  userInput: string;
  taskKind: string;
  toolId?: string;
  formData?: Record<string, string>;
  projectContext?: string;
}): string {
  const form = input.formData
    ? Object.entries(input.formData)
        .filter(([, value]) => value.trim())
        .map(([key, value]) => `${key}：${value}`)
        .join("\n")
    : "";
  return [
    `任务类型：${input.taskKind}`,
    input.toolId ? `当前功能：${input.toolId}` : "",
    `用户原始要求：\n${wrapUntrustedData("original_user_input", input.userInput)}`,
    form ? `当前表单：\n${wrapUntrustedData("tool_form", form)}` : "",
    input.projectContext?.trim()
      ? `当前项目事实：\n${wrapUntrustedData("project_facts", input.projectContext.slice(0, 40_000))}`
      : "当前项目没有可读取的既有事实。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const SEMANTIC_EXECUTION_RULES = `## 语义契约执行规则
1. 语义契约是本次任务的语义边界，只能在契约范围内工作。
2. 必须遵守 must、must_not 和 preserve；prefer 与 avoid 可以权衡但不能无理由忽略。
3. 不得重新解释已确认的关键概念，不得扩大任务范围。
4. 契约没有覆盖的新歧义若会影响核心结果，返回 alignment_required，不得自行选择。
5. 不得把新推断写成项目长期事实。
6. 只交付任务结果；契约标识由系统附加，不在正文中污染内容。`;

export function compileSemanticContractForExecution(contract: SemanticContract): string {
  const payload = {
    contractId: contract.id,
    contractVersion: contract.version,
    taskSummary: contract.taskSummary,
    intendedOutcome: contract.intendedOutcome,
    excludedScope: contract.excludedScope,
    interpretations: contract.interpretations.map((item) => ({
      sourceExpression: item.sourceExpression,
      interpretedMeaning: item.interpretedMeaning,
      affectedDimensions: item.affectedDimensions,
    })),
    constraints: contract.constraints.map((item) => ({
      id: item.id,
      type: item.type,
      description: item.description,
      priority: item.priority,
    })),
    assumptions: contract.assumptions.filter((item) => item.confirmed),
    plannedDecisions: contract.plannedDecisions,
  };
  return `${SEMANTIC_EXECUTION_RULES}\n\n${wrapUntrustedData("confirmed_semantic_contract", JSON.stringify(payload, null, 2))}`;
}

export const SEMANTIC_VALIDATOR_SYSTEM_PROMPT = `你是 WithYou 的语义验证 Agent。

逐项对照已确认语义契约检查执行结果。必须检查 intendedOutcome、excludedScope、must、must_not、preserve、关键解释、未经确认的扩展、语义漂移与范围漂移。
必须给出具体证据。无法验证的约束必须列入 unverifiedConstraints，不能默认通过；文笔流畅不能作为通过依据。
只输出 JSON，不要 Markdown 或解释：
{
  "passed": false,
  "satisfiedConstraints": ["constraint-id"],
  "violatedConstraints": [{"constraintId":"id","description":"违反内容","evidence":"结果中的具体证据","severity":"low|medium|high|critical"}],
  "unverifiedConstraints": [{"constraintId":"id","reason":"无法验证的原因"}],
  "detectedDrift": [{"contractField":"字段","expected":"预期","actual":"实际"}],
  "requiresRegeneration": true
}`;

export function buildSemanticValidatorUserPrompt(
  contract: SemanticContract,
  result: string,
  projectContext = "",
): string {
  return [
    `契约 ID：${contract.id}`,
    `契约版本：${contract.version}`,
    wrapUntrustedData(
      "confirmed_semantic_contract",
      JSON.stringify(
        {
          taskSummary: contract.taskSummary,
          intendedOutcome: contract.intendedOutcome,
          excludedScope: contract.excludedScope,
          interpretations: contract.interpretations,
          constraints: contract.constraints,
          plannedDecisions: contract.plannedDecisions,
        },
        null,
        2,
      ),
    ),
    wrapUntrustedData("execution_result", result.slice(0, 120_000)),
    projectContext.trim()
      ? wrapUntrustedData("current_project_facts", projectContext.slice(0, 40_000))
      : "当前项目事实不可读；涉及项目事实的约束必须标记为 unverified。",
  ].join("\n\n");
}
