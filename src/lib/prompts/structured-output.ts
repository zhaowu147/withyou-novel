import type { ToolId } from "@/lib/prompts/prompt-package";

const STRUCTURED_TOOLS = new Set<ToolId>(["brainstorm", "character"]);

export function expectsStructuredOutput(toolId: string): toolId is ToolId {
  return STRUCTURED_TOOLS.has(toolId as ToolId);
}

export function extractJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced || text).trim();
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return candidate.slice(arrayStart, arrayEnd + 1);
  }
  return candidate;
}

export function validateStructuredOutput(toolId: string, text: string): string | null {
  if (!expectsStructuredOutput(toolId)) return null;
  try {
    const parsed = JSON.parse(extractJsonText(text));
    if (!Array.isArray(parsed) || parsed.length === 0) return "结果必须是非空 JSON 数组";
    if (toolId === "brainstorm" && parsed.some((item) => !item || typeof item.hook !== "string")) {
      return "每个脑洞必须包含 hook 字段";
    }
    if (toolId === "character" && parsed.some((item) => !item || typeof item.name !== "string")) {
      return "每个角色必须包含 name 字段";
    }
    return null;
  } catch {
    return "结果不是有效 JSON";
  }
}
