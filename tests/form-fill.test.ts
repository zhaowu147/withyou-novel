import { buildFullFormFillTask, parseFullFormFill } from "../src/lib/tools/form-fill";
import type { VariableSchema } from "../src/lib/tools/prompt-templates";
import assert from "node:assert/strict";
import test from "node:test";

const schema: VariableSchema[] = [
  { key: "theme", label: "题材", type: "textarea", default: "" },
  { key: "target", label: "目标读者", type: "select", default: "", options: ["男频", "女频"] },
  { key: "extra", label: "补充", type: "textarea", default: "" },
];

test("一轮式填写只接受模板字段且不覆盖已有内容", () => {
  const fields = parseFullFormFill(
    '```json\n{"theme":"都市悬疑","target":"女频","extra":"慢热","unknown":"越权"}\n```',
    schema,
    { theme: "现代都市", target: "", extra: "" },
  );
  assert.deepEqual(fields, { target: "女频", extra: "慢热" });
});

test("select 字段拒绝模板选项之外的模型输出", () => {
  const fields = parseFullFormFill('{"target":"全年龄"}', schema, {});
  assert.deepEqual(fields, {});
});

test("非法 JSON 不会退化成猜测性字段解析", () => {
  assert.throws(() => parseFullFormFill("题材：玄幻", schema, {}), /合法 JSON/);
});

test("一轮式任务明确要求所有空字段和禁止覆盖", () => {
  const prompt = buildFullFormFillTask(schema, { theme: "科幻", target: "", extra: "" });
  assert.match(prompt, /一次性生成建议/);
  assert.match(prompt, /已有非空值原样保留/);
  assert.match(prompt, /"existingValue": "科幻"/);
});
