# WithYou Novel 当前交接基线

更新时间：2026-07-28

本文件只描述当前仓库状态。项目事实优先级见 [PROJECT_CONTROL.md](PROJECT_CONTROL.md)，完整状态见 [PROJECT_STATE.md](PROJECT_STATE.md)。旧对话和旧版交接内容不再作为事实依据。

## 当前仓库

- 当前分支：`main`
- 当前本地基线：`c409526`
- 迁移时远端 `origin/main`：`6d19a79`
- 本地包含一个尚未推送的项目治理提交
- 当前工作树：干净

## 已确认存在的核心模块

- `src/lib/agents/runtime/`：Planner、Writer、Reviewer、Memory 四类核心 Agent 的统一运行时。
- `src/lib/agents/runtime/tool-registry.ts`：当前小说范围内的文件、章节、实体、伏笔、时间线、图谱和记忆读取工具；Memory Agent 还可以暂存待审批候选。
- `src/lib/memory/`：作品级规范/长期/短期记忆、来源追踪、派生层级、SQLite FTS 索引、章节回填和阶段归并。
- `src/lib/pi/`：普通 Pi、源码 Pi、三级权限、源码授权、候选改动、回滚和 Skill 原型。
- `src/lib/graph/`：故事图谱 v3 存储、提取、候选确认、隐藏/恢复、恢复点和实体别名对账。
- `src/app/api/`：Agent、记忆、图谱、实体、Pi、小说、导入、同步、提示词和功能区接口。
- `src/app/(main)/_components/`：聊天区、功能区、Agent 工作台、文件树、图谱和工作区 UI。
- `electron/` 与 `scripts/prepare-electron-runtime.mjs`：Electron 桌面运行时和 Next standalone 运行时准备。

## 当前产品约束

- 文件树和正文是小说事实源；派生记忆、图谱和阶段汇总必须可追溯。
- 每个小说项目必须隔离文件、记忆、Agent 工作区和图谱。
- Agent 读取证据后才能输出；Memory Agent 生成的候选必须经过用户批准。
- Pi 写入必须经过对应权限和候选改动链路。
- 不改变现有 UI，除非任务明确要求。
- 用户要求验证时再集中验证；本次迁移只做只读审计。
- 用户数据不能因程序卸载被删除。
- 真实密钥、本地运行数据和打包中间物不得提交。
- 不添加 MIT 或其他开源许可证文件。

## 暂缓事项

- UI 最终整理。
- 故事图谱最终对账。
- 灰度发布和真实模型集中验收。
- Pi Skill 管理器和可信 Skill 发布机制。
- Electron 中源码维护运行时的独立 sidecar。

## 继续工作前必须执行

```powershell
pnpm project:status
git status --short
```

先读取 `PROJECT_STATE.md`、`.project/current.yaml` 和对应变更单，再修改代码。
