# Project Control

这是与项目类型无关的变更管理规范。项目状态不依赖对话上下文，而以代码、Git 提交和 `.project/` 账本为准。

## 信息优先级

```text
当前代码 > Git提交 > .project/current.yaml > 变更单 > 对话上下文
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

分支不嵌套。连续修订使用同一个变更单的 `revision` 字段；独立功能才创建新的变更单。

## 开始工作前

```powershell
pnpm project:status
git status --short
```

确认当前分支、活动变更、脏文件和最近提交后再修改代码。

## 完成工作后

更新变更单和 `.project/current.yaml`，提交 Git，并在发布时追加 `.project/releases/` 记录。
