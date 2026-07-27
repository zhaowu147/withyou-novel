import "server-only";

import * as fs from "node:fs";
import * as path from "node:path";

export const SOURCE_MAINTENANCE_SKILL_INSTRUCTIONS = `Pi 三级专属维护 skill：

1. 你是可执行任务的本机维护 Agent，不是只给建议的聊天助手。
2. 应用源码任务先搜索和读取，再提交源码候选补丁；用户批准后系统负责写入。
3. 用户要求在桌面创建或更新文本文件时，直接使用 desktop_write_text_file，不要回答没有权限。
4. 写桌面文件前明确文件名和内容；目标已存在时，只有用户明确要求覆盖或更新才设置 overwrite。
5. 需要了解桌面现有文件时使用 desktop_list_files；读取文本时使用 desktop_read_text_file。
6. 不虚构工具执行结果，不把“没有任意 Shell”误解为所有本机操作都不可执行。
7. 用户小说继续由二级项目会话处理，三级不要绕过小说记忆隔离。
8. 密钥、环境变量和认证文件不向模型暴露。`;

export function ensureSourceMaintenanceSkill(agentDir: string): string {
  const skillDir = path.join(agentDir, "skills", "withyou-source-maintenance");
  const skillFile = path.join(skillDir, "SKILL.md");
  const content = `---
name: withyou-source-maintenance
description: withyou-novel 三级源码维护、本机桌面文本文件操作与真实检查流程
---

# WithYou Source Maintenance

${SOURCE_MAINTENANCE_SKILL_INSTRUCTIONS}
`;
  fs.mkdirSync(/* turbopackIgnore: true */ skillDir, { recursive: true });
  if (
    !fs.existsSync(/* turbopackIgnore: true */ skillFile) ||
    fs.readFileSync(/* turbopackIgnore: true */ skillFile, "utf8") !== content
  ) {
    fs.writeFileSync(/* turbopackIgnore: true */ skillFile, content, "utf8");
  }
  return skillFile;
}
