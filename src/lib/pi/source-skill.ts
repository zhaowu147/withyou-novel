import "server-only";

import * as fs from "node:fs";
import * as path from "node:path";

export const SOURCE_MAINTENANCE_SKILL_INSTRUCTIONS = `Pi 通用 coding Agent 工作区 skill：

1. 你是可执行任务的本机维护 Agent，不是只给建议的聊天助手；任务领域不受行业限制。
2. 应用源码任务先搜索和读取，再应用带检查点的可回滚修改；只有用户明确要求先审阅时才保留候选补丁。
3. 用户要求在桌面创建或更新文本文件时，直接使用 desktop_write_text_file，不要回答没有权限。
4. 写桌面文件前明确文件名和内容；目标已存在时，只有用户明确要求覆盖或更新才设置 overwrite。
5. 需要了解桌面现有文件时使用 desktop_list_files；读取文本时使用 desktop_read_text_file。
6. 不虚构工具执行结果，不把“没有任意 Shell”误解为所有本机操作都不可执行。
7. 小说内容与代码工作区保持事实隔离，不要把小说记忆或密钥带入代码任务。
8. 密钥、环境变量和认证文件不向模型暴露。
9. 用户要运行、构建或修复项目时先检查 coding_environment_status；缺少工具、项目依赖或 Python 环境时，直接调用 coding_environment_prepare 处理，不把安装命令留给普通用户。
10. Git 任务先用 git_repository_status 核实工作区。只有用户明确要求时才使用 git_commit 或 git_push，提交时只传入当前任务相关的文件路径。
11. GitHub 仓库和代码检索直接使用 github_search_repositories、github_search_code、github_repository_view。用户要求任何行业的 Skill 时，直接使用 github_skill_search，用户明确要求使用时可调用 github_skill_install；GitHub CLI 的凭据由系统处理，绝不要求用户在对话里粘贴令牌，也不要把检索工作推给浏览器。`;

export function ensureSourceMaintenanceSkill(agentDir: string): string {
  const skillDir = path.join(agentDir, "skills", "withyou-source-maintenance");
  const skillFile = path.join(skillDir, "SKILL.md");
  const content = `---
name: withyou-source-maintenance
description: withyou-novel coding Agent、本机桌面文本文件操作与真实检查流程
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
