<h1 align="center"><em>With You</em></h1>

<p align="center">人机协作小说创作平台</p>

With You Novel 面向长篇网文创作，帮助作者把大纲、人物、世界观、章节、记忆和故事图谱放在同一个创作工作区中，并通过 AI 写作 Agent 提供连续的创作协作。

## 当前能力

- 长篇小说项目与文件树管理
- 大纲、细纲、角色、世界观和开篇生成
- 网文拆书与创作增强工具
- 泛记忆、长记忆、短记忆的分层管理
- 按小说项目隔离上下文与记忆
- Agent 工作台与 Pi 协作入口
- 故事世界图谱与实体关系提取
- 精修、应用到会话和章节写作流程
- Windows 桌面交付版本

## 本地开发

环境要求：Node.js 22、pnpm。

```powershell
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

然后访问 `http://localhost:3000`。

真实密钥只放在本地 `.env.local`，不要提交到仓库。桌面安装版运行时读取：

```text
%APPDATA%\WithYou Novel\.env.local
```

## Windows 交付包

```powershell
pnpm install --frozen-lockfile
pnpm electron:build
```

安装包输出到 `release\delivery\`。用户小说和本地数据保存在应用用户数据目录，卸载程序不会主动删除这些数据。

## 项目结构

```text
src/app             Next.js 页面与 API
src/lib/agents      Agent 运行时、上下文规划与工具注册
src/lib/memory      小说记忆与检索
src/lib/graph       故事图谱提取与存储
src/lib/pi          Pi 权限、技能与执行运行时
electron            Windows 桌面壳
scripts             构建辅助脚本
```

## 说明

这是 With You Novel 的当前开发交付代码。仓库不附带 MIT 或其他开源许可证声明。
