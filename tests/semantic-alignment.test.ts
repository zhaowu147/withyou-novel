import {
  applyAlignmentGate,
  classifySemanticTaskKind,
  findConstraintConflicts,
  normalizeEditableFields,
} from "../src/lib/semantic-alignment/core";
import type { SemanticContract } from "../src/lib/semantic-alignment/types";
import assert from "node:assert/strict";
import test from "node:test";

function contract(overrides: Partial<SemanticContract> = {}): SemanticContract {
  const now = "2026-07-30T00:00:00.000Z";
  return {
    id: "contract-1",
    projectId: "novel-1",
    taskId: "task-1",
    sessionId: "workspace-1",
    taskKind: "writer",
    version: 1,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    originalUserInput: "调整这句话",
    taskSummary: "调整一句话",
    intendedOutcome: "语序更自然",
    excludedScope: [],
    interpretations: [],
    constraints: [],
    assumptions: [],
    ambiguities: [],
    plannedDecisions: [],
    riskLevel: "low",
    confirmationMode: "user_required",
    sourceReferences: [],
    userEdits: [],
    ...overrides,
  };
}

test("冷漠但不要突然会暴露内部动机歧义并要求用户确认", () => {
  const gated = applyAlignmentGate(
    contract({
      originalUserInput: "让林川后面冷漠一点，但不要突然。",
      taskKind: "writer",
    }),
    { autoConfirmLowRisk: true },
  );
  assert.equal(gated.riskLevel, "high");
  assert.equal(gated.confirmationMode, "user_required");
  assert.equal(gated.status, "awaiting_confirmation");
  const ambiguity = gated.ambiguities.find((item) => item.expression === "冷漠");
  assert.ok(ambiguity);
  assert.equal(ambiguity.requiresUserInput, true);
  assert.ok(ambiguity.possibleMeanings.length >= 2);
});

test("模型已识别冷漠歧义时 Gate 仍补齐内部动机解释并提升风险", () => {
  const gated = applyAlignmentGate(
    contract({
      originalUserInput: "让顾临冷漠一点，但不要突然。",
      riskLevel: "medium",
      ambiguities: [
        {
          id: "model-coldness",
          expression: "冷漠一点",
          possibleMeanings: ["言语简短冷淡"],
          selectedMeaning: "模型擅自选择",
          selectionReason: "模型推断",
          requiresUserInput: true,
        },
      ],
    }),
    { autoConfirmLowRisk: true },
  );
  assert.equal(gated.riskLevel, "high");
  assert.ok(
    gated.ambiguities[0].possibleMeanings.includes("感情正在消退，只是角色尚未完全意识到"),
  );
  assert.equal(gated.ambiguities[0].selectedMeaning, undefined);
});

test("用户在新版本中选择的冷漠含义不会被 Gate 当成模型擅选清空", () => {
  const gated = applyAlignmentGate(
    contract({
      originalUserInput: "让顾临冷漠一点，但不要突然。",
      riskLevel: "high",
      ambiguities: [
        {
          id: "model-coldness",
          expression: "冷漠一点",
          possibleMeanings: ["仍然在意，但主动减少表达和解释"],
          selectedMeaning: "仍然在意，但主动减少表达和解释",
          selectionReason: "用户在语义契约中选择",
          requiresUserInput: true,
        },
      ],
      userEdits: [
        {
          fieldPath: "ambiguities",
          previousValue: [],
          newValue: ["仍然在意，但主动减少表达和解释"],
          editedAt: "2026-07-30T00:01:00.000Z",
        },
      ],
    }),
    { autoConfirmLowRisk: true },
  );
  assert.equal(gated.ambiguities[0].selectedMeaning, "仍然在意，但主动减少表达和解释");
});

test("未确认的高风险假设会阻断执行", () => {
  const gated = applyAlignmentGate(
    contract({
      assumptions: [
        {
          id: "assumption-1",
          description: "角色仍然爱对方",
          impactIfWrong: "关系主线改变",
          riskLevel: "high",
          confirmed: false,
          basis: "模型推断",
        },
      ],
    }),
    { autoConfirmLowRisk: false },
  );
  assert.equal(gated.confirmationMode, "blocked");
});

test("项目事实冲突作为可见阻断原因持续阻止确认", () => {
  const gated = applyAlignmentGate(
    contract({
      blockingReasons: ["[设定/角色/林川.md] 用户要求与已确认身份冲突"],
    }),
    { autoConfirmLowRisk: true },
  );
  assert.equal(gated.confirmationMode, "blocked");
  assert.deepEqual(gated.blockingReasons, ["[设定/角色/林川.md] 用户要求与已确认身份冲突"]);
});

test("只有白名单中的低风险局部编辑可自动确认，且设置可以关闭", () => {
  const local = contract({
    taskKind: "local_edit",
    originalUserInput: "修正这一句的错别字",
    riskLevel: "low",
  });
  assert.equal(applyAlignmentGate(local, { autoConfirmLowRisk: true }).status, "confirmed");
  assert.equal(applyAlignmentGate(local, { autoConfirmLowRisk: false }).status, "awaiting_confirmation");
});

test("明确且局部可逆的文本修改进入快速路径，跨章或设定修改不会", () => {
  assert.equal(
    classifySemanticTaskKind({
      requestedKind: "writer",
      userInput: "请修正这句话里的错别字。",
    }),
    "local_edit",
  );
  assert.equal(
    classifySemanticTaskKind({
      requestedKind: "writer",
      userInput: "请把所有章节都改成第一人称。",
    }),
    "writer",
  );
  assert.equal(
    classifySemanticTaskKind({
      requestedKind: "writer",
      userInput: "修改这段里角色的核心动机。",
    }),
    "writer",
  );
});

test("互相冲突的硬约束会被识别", () => {
  const conflicts = findConstraintConflicts([
    {
      id: "must-1",
      type: "must",
      description: "必须保留林川仍然在意对方",
      source: "current_user_input",
      priority: 100,
    },
    {
      id: "must-not-1",
      type: "must_not",
      description: "不得保留林川仍然在意对方",
      source: "current_user_input",
      priority: 100,
    },
  ]);
  assert.deepEqual(conflicts, ["must-1:must-not-1"]);
});

test("模型字段会被限量、规范化且推断不会冒充用户事实", () => {
  const fields = normalizeEditableFields(
    {
      taskSummary: " 任务 ",
      intendedOutcome: " 结果 ",
      interpretations: [
        {
          sourceExpression: "克制",
          interpretedMeaning: "减少直白说明",
          affectedDimensions: ["style", "invalid"],
          confidence: 9,
        },
      ],
      constraints: [{ type: "must", description: "不得改剧情", source: "unknown", priority: 120 }],
    },
    "原始输入",
  );
  assert.equal(fields.interpretations[0].confidence, 1);
  assert.deepEqual(fields.interpretations[0].affectedDimensions, ["style"]);
  assert.equal(fields.constraints[0].source, "model_inference");
  assert.equal(fields.constraints[0].priority, 100);
});
