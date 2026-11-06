---
name: devflow-apply
description: 按已批准的 DevFlow 变更实现代码：开工、按依赖顺序完成任务、运行验证直到通过。用户说"实现变更 X""开始开发""按方案改代码"，或变更状态为 approved / applying / needs_fix 时使用。没有已批准的变更时，先用 devflow-propose。
---

# 实现已批准的变更

<!-- 由 devflow 生成；devflow update 会覆盖本文件 -->

## 步骤

1. 运行 `devflow status <id>`。
   - `approved`：运行 `devflow apply <id> --start` 记录开工。
   - `applying` / `needs_fix`：继续上次的工作。
   - `draft` / `rebase_required`：停下，告诉用户需要先（重新）审批，不要写代码。
2. 读 `.devflow/changes/<id>/` 下的 proposal、delta spec、design、tasks。它们是已批准的方案，照此实现。
3. 按 `tasks.yaml` 的依赖顺序逐个实现任务。每完成一个：
   - 为验收条件写测试或可执行的检查，并实际运行；
   - 全部验收条件满足后，运行 `devflow task done <id> <任务ID>`。
4. 所有任务完成后运行 `devflow verify <id>`。它只运行 `.devflow/project.yaml` 中声明的命令。
   - `pass` 且状态为 `ready_to_archive`：报告完成情况，下一步用 devflow-archive。
   - `fail`：读输出中给出的日志，修复后再运行 `devflow verify <id>`。
   - `unknown`：说明原因（命令无法运行、没有声明命令、验证期间工作树变化），请用户处理，不要把它当作通过。
5. 向用户报告：改了哪些文件、每个任务如何验证、verify 结果。

## 规则

- 不修改 `.devflow/changes/<id>/` 下的任何文件，也不修改 `.devflow/project.yaml`。这些属于已批准的内容，改动会使批准失效。实现中发现方案有问题时，停下来说明问题，请用户修改方案并重新批准。
- 只改 `change.yaml` 中 `affected_paths` 覆盖的代码；确实需要改其他文件时，先告诉用户。
- 不运行 `devflow approve`、`devflow archive`；不提交、不推送，除非用户明确要求。
- 没有实际运行过的检查，不要说"已验证"。
