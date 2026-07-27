/**
 * UserSkillManager — 用户自定义 Skill 加载器
 *
 * 用户自定义 Skill 系统：
 *   - 用户可在项目 .skills/ 目录下放置 SKILL.md
 *   - 系统启动时自动扫描加载
 *   - 可在 Agent prompt 中注入
 *
 * 目录结构:
 *   .skills/
 *     my-skill/
 *       SKILL.md          ← 技能定义（name + description + 内容）
 *     another-skill/
 *       SKILL.md
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface UserSkill {
  /** 技能唯一标识 */
  id: string;
  /** 技能名称 */
  name: string;
  /** 中文描述（含触发词） */
  description: string;
  /** 技能内容（注入 system prompt 的部分） */
  content: string;
  /** 触发关键词 */
  triggers: string[];
  /** 文件路径 */
  sourcePath: string;
}

const SKILLS_DIR = ".skills";

/**
 * 从项目目录加载用户自定义 Skills
 */
export function loadUserSkills(projectDir: string): UserSkill[] {
  const skillsDir = path.join(projectDir, SKILLS_DIR);
  if (!fs.existsSync(skillsDir)) return [];

  const skills: UserSkill[] = [];
  for (const dir of fs.readdirSync(skillsDir)) {
    const skillDir = path.join(skillsDir, dir);
    if (!fs.statSync(skillDir).isDirectory()) continue;

    const skillFile = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    try {
      const skill = parseSkillFile(skillFile, dir);
      if (skill) skills.push(skill);
    } catch {
      console.warn(`[SkillLoader] 跳过无效 skill: ${dir}`);
    }
  }

  return skills;
}

/**
 * 解析 SKILL.md 文件
 *
 * 格式:
 *   ---
 *   name: skill-name
 *   description: "中文描述，含触发词"
 *   triggers: [触发词1, 触发词2]
 *   ---
 *   正文内容...
 */
function parseSkillFile(filePath: string, dirName: string): UserSkill | null {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");

  // 解析 frontmatter
  if (!lines[0]?.trim().startsWith("---")) return null;

  let name = dirName;
  let description = "";
  const triggers: string[] = [];
  let contentStart = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("---")) {
      contentStart = i + 1;
      break;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      // 去掉引号
      value = value.replace(/^["']|["']$/g, "");

      if (key === "name") name = value;
      else if (key === "description") description = value;
      else if (key === "triggers") {
        // 解析 YAML 数组
        try {
          // 简单格式: [a, b, c]
          const arrMatch = value.match(/\[(.*)\]/);
          if (arrMatch) {
            triggers.push(...arrMatch[1].split(",").map((s) => s.trim().replace(/["']/g, "")));
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (contentStart === 0) return null;

  const content = lines.slice(contentStart).join("\n").trim();
  if (!content) return null;

  return {
    id: dirName,
    name,
    description,
    content,
    triggers: triggers.length ? triggers : extractTriggersFromDescription(description),
    sourcePath: filePath,
  };
}

/** 从描述中提取中文关键词作为触发词 */
function extractTriggersFromDescription(desc: string): string[] {
  const words = desc.match(/[\u4e00-\u9fff]{2,4}/g) || [];
  return Array.from(new Set(words)).slice(0, 5);
}

/**
 * 检查用户消息是否匹配某个 Skill 的触发词
 */
export function matchUserSkill(message: string, skills: UserSkill[]): UserSkill | null {
  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      if (message.includes(trigger)) {
        return skill;
      }
    }
  }
  return null;
}

/**
 * 将匹配的 Skill 注入 system prompt
 */
export function injectSkillToPrompt(systemPrompt: string, skill: UserSkill): string {
  return `${systemPrompt}

---

## 用户自定义技能: ${skill.name}

${skill.content}

---
> 以上为用户自定义技能的规则，请严格遵守。`;
}

/**
 * 列出所有可用 Skills（给 AI 看的描述）
 */
export function listSkillsForPrompt(skills: UserSkill[]): string {
  if (!skills.length) return "";
  return skills
    .map((s) => `- **${s.name}** (触发词: ${s.triggers.slice(0, 3).join(", ")}): ${s.description}`)
    .join("\n");
}

export default {
  loadUserSkills,
  matchUserSkill,
  injectSkillToPrompt,
  listSkillsForPrompt,
};
