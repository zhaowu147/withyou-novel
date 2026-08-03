import type { VariableSchema } from "./prompt-templates";

function extractObject(text: string): Record<string, unknown> | null {
  const unfenced = text
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

/**
 * 一轮式表单填充的唯一解析入口。
 * 只接受模板声明的字段；已有非空值永不被模型覆盖；select 值必须属于选项。
 */
export function parseFullFormFill(
  raw: string,
  schema: VariableSchema[],
  current: Record<string, string>,
): Record<string, string> {
  const parsed = extractObject(raw);
  if (!parsed) throw new Error("AI 填写结果不是合法 JSON 对象");
  const result: Record<string, string> = {};
  for (const variable of schema) {
    if (current[variable.key]?.trim()) continue;
    const value = parsed[variable.key];
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.trim().slice(0, 20_000);
    if (variable.type === "select" && variable.options && !variable.options.includes(normalized)) continue;
    result[variable.key] = normalized;
  }
  return result;
}

export function buildFullFormFillTask(schema: VariableSchema[], variables: Record<string, string>): string {
  const fields = schema.map((variable) => ({
    key: variable.key,
    label: variable.label,
    type: variable.type,
    options: variable.options ?? [],
    existingValue: variables[variable.key] ?? "",
  }));
  return `用户点击了“一次填写整个表单”。请综合当前小说事实和所有已有表单信息，为空字段一次性生成建议。

字段定义：
${JSON.stringify(fields, null, 2)}

只输出一个 JSON 对象：
- 键只能使用上面列出的 key；
- 已有非空值原样保留，不得在输出中改写；
- 为所有可合理推断的空字段提供字符串值；
- select 字段只能使用 options 中的值；
- 无法可靠推断的字段输出空字符串；
- 不要解释、不要代码围栏、不要输出完整创作成品。`;
}
