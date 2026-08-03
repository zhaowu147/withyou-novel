# 变更单规范

每个独立修改使用一个变更单目录：

```text
.project/changes/active/CHG-YYYY-NNN-short-name/
├── change.yaml
├── PLAN.md
├── NOTES.md
└── DIFF.md
```

## 生命周期

1. 在改代码前创建磁盘变更单，不等待 Git 提交。
2. 记录修改前的磁盘状态、功能区域和文件范围。
3. 可选地从 `main` 创建 `change/<area>/<slug>` 分支。
4. 同一功能的后续修改增加 `revision`，不要无限创建修补分支。
5. 完成后把变更单移动到 `merged/`，不要求立即提交 Git。
6. 放弃的方案移动到 `discarded/`，只记录原因，不把废弃代码留在当前工作树。

## change.yaml

```yaml
id: CHG-2026-001
area: memory
title: 示例变更
status: active # active|merged|discarded
areas: [memory]
scope:
  - src/lib/memory/**
disk_baseline: 修改前的磁盘状态说明
branch: change/memory/example # 可选，仅作辅助记录
revision: 1
supersedes: null
files: []
```

变更单是项目事实记录，分支只是实现载体。分支可以删除，合并后的 Git 提交和变更单仍然保留。
