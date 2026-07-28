# Project Control

这是与项目类型无关的变更管理规范。项目状态不依赖对话上下文，也不以 Git 是否及时提交为前提；当前磁盘代码和磁盘上的 `.project/` 变更账本才是事实来源。

## 信息优先级

```text
当前磁盘代码 > 磁盘变更单 > PROJECT_STATE.md > Git辅助信息 > 对话上下文
```

## 目录约定

- `.project/manifest.yaml`：项目元信息和规范入口
- `.project/areas.yaml`：功能区域与代码路径映射
- `.project/current.yaml`：当前状态、约束和延期事项
- `.project/changes/active`：进行中的修改
- `.project/changes/merged`：已完成修改
- `.project/changes/discarded`：放弃方案的记录
- `.project/decisions`：架构决策
- `.project/releases`：发布记录

## 分支约定

```text
main
change/<area>/<slug>
release/<version>
```

分支不嵌套。连续修订使用同一个变更单的 `revision` 字段；独立功能才创建新的变更单。Git 分支和提交只是辅助追踪，不能代替磁盘变更记录。

## 大改动标记

涉及多个模块、公共数据结构、路由、Agent 行为、记忆逻辑、权限、图谱或打包流程的修改，必须在改代码前创建：

```text
.project/changes/active/CHG-YYYY-NNN-short-name/change.yaml
```

至少记录：

- 修改目的和影响范围
- `areas` 功能区域
- `scope` 预计修改的文件路径
- `disk_baseline` 修改前的磁盘状态说明
- 当前 `revision`

这样即使没有 Git 提交，也能直接从磁盘看出哪里发生过大改动。

## 开始工作前

```powershell
pnpm project:status
git status --short
```

确认磁盘上的活动变更单、修改范围和当前状态后再修改代码；Git 状态只作为辅助参考。

## 完成工作后

更新变更单和 `.project/current.yaml`，提交 Git，并在发布时追加 `.project/releases/` 记录。
