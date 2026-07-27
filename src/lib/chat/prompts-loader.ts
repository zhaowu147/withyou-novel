/**
 * 分层 Prompt Loader
 *
 * 目录结构:
 *   src/chat/prompts/agents/<agentId>/
 *     hard_rules.md                L0:硬规则
 *     exec_guide.md                L0.5:执行指导
 *     persona.md                   L1:可选人设(Human 写)
 *     prompts/_active.json         当前启用哪个/哪些子 prompt
 *     prompts/_groups.json         子 prompt 分组
 *     prompts/<sub>.md             子 prompt(按组管理)
 *
 * _active.json 兼容:
 *   { "active": "文风-短句网感.md" }
 *   { "active": ["文风-短句网感.md", "章末钩子.md"] }
 *   { "presets": ["..."] } / { "active_presets": ["..."] }
 *   { "active": "a.md", "extra": ["b.md"] }
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PROMPTS_ROOT = path.join(__dirname, "..", "..", "chat", "prompts", "agents");

export interface AgentPromptLayers {
  hardRules: string;
  execGuide: string;
  persona: string;
  /** 生效中的子 prompt 正文（可多个） */
  subPrompts: string[];
  /** 实际加载的文件名，便于调试 */
  activePresetFiles: string[];
}

function readFirst(dir: string, names: string[]): string {
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return "";
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  }
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** 解析 _active.json → 有序、去重的 preset 文件名列表 */
export function parseActivePresetFilenames(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (names: string[]) => {
    for (const n of names) {
      const fn = n.replace(/^.*[\\/]/, ""); // 只取 basename
      if (!fn || seen.has(fn)) continue;
      seen.add(fn);
      ordered.push(fn);
    }
  };
  // 优先多选字段
  push(asStringArray(obj.active_presets));
  push(asStringArray(obj.presets));
  push(asStringArray(obj.writer_prompt_presets));
  push(asStringArray(obj.active));
  push(asStringArray(obj.extra));
  return ordered;
}

function readPresetFile(subDir: string, filename: string): string | null {
  const candidates = [
    path.join(subDir, filename),
    path.join(subDir, filename.endsWith(".md") ? filename : `${filename}.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return fs.readFileSync(p, "utf8");
    }
  }
  return null;
}

export function loadAgentPrompts(agentId: string): AgentPromptLayers | null {
  const agentDir = path.join(PROMPTS_ROOT, agentId);
  if (!fs.existsSync(agentDir)) return null;

  const hardRules = readFirst(agentDir, ["hard_rules.md", "block_outline_hard_rules.md"]);
  const execGuide = readFirst(agentDir, ["exec_guide.md", "block_outline_execution_guide.md"]);
  const persona = readFirst(agentDir, ["persona.md", "block_outline_persona.md"]);

  const subDir = path.join(agentDir, "prompts");
  const subPrompts: string[] = [];
  const activePresetFiles: string[] = [];

  if (fs.existsSync(subDir)) {
    const activeFile = path.join(subDir, "_active.json");
    if (fs.existsSync(activeFile)) {
      try {
        const active = JSON.parse(fs.readFileSync(activeFile, "utf8"));
        const names = parseActivePresetFilenames(active);
        for (const fn of names) {
          const body = readPresetFile(subDir, fn);
          if (body != null) {
            activePresetFiles.push(fn);
            subPrompts.push(body);
          }
        }
      } catch {
        // ignore malformed active.json
      }
    }
  }

  return { hardRules, execGuide, persona, subPrompts, activePresetFiles };
}

/**
 * 拼装最终 System Prompt（单字符串兼容路径）
 * @example L0 + L0.5 + L1 + sub-prompts[] + extraContext
 * @param activatedWriterPrompt - 已激活的会话写手提示词包内容（可选）
 */
export function buildSystemPrompt(
  agentId: string,
  extraContext = "",
  activatedWriterPrompt?: string | null,
): string | null {
  const layers = loadAgentPrompts(agentId);
  if (!layers) return null;

  const parts: string[] = [];
  if (layers.hardRules) parts.push(layers.hardRules);
  if (layers.execGuide) parts.push(layers.execGuide);
  if (layers.persona) parts.push(layers.persona);
  if (layers.subPrompts.length) parts.push(...layers.subPrompts);

  // 会话写手提示词包注入（只影响会话写手，不影响功能区）
  if (activatedWriterPrompt) {
    parts.push(`\n\n## [用户自定义提示词]\n${activatedWriterPrompt}`);
  }

  let systemPrompt = parts.join("\n\n---\n\n");
  if (extraContext) systemPrompt += `\n\n---\n\n${extraContext}`;
  return systemPrompt;
}

/**
 * 拆成 Writer 分层用的 hard / exec / presets
 */
export function loadAgentLayeredParts(agentId: string): {
  hardRules: string;
  execGuide: string;
  persona: string;
  presets: string[];
  activePresetFiles: string[];
} | null {
  const layers = loadAgentPrompts(agentId);
  if (!layers) return null;
  return {
    hardRules: layers.hardRules,
    execGuide: layers.execGuide,
    persona: layers.persona,
    presets: layers.subPrompts,
    activePresetFiles: layers.activePresetFiles,
  };
}
