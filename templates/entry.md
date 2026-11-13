## DevFlow

本项目用 DevFlow 管理行为规范与项目知识。

- 知识页（`.devflow/knowledge/`）是项目地图，按需使用：问"在哪里""是什么、取值多少"这类能直接搜到的问题，直接搜源码；问跨模块流程、"为什么这样设计"、历史变更时，先读 `.devflow/knowledge/index.md` 和相关知识页。
- 以源码为准。关于本项目的事实必须带文件引用（`path:行号` 或 `path#符号`）。查不到就回答"未知"，不要凭通用经验推测。
- `.devflow/specs/` 是已批准的行为规范，只能经 `devflow archive` 修改，不要手改。
- `.devflow/changes/*/events.jsonl` 只能由 devflow 命令追加，不要手改。
- 批准、确认人工证据、归档只能由人来做：人在自己的终端运行 `devflow approve` / `devflow evidence confirm` / `devflow archive`，或在审查台（人自己启动的 `devflow review`）里点按钮。不要代为执行，不要启动或访问审查台。需要等人操作时，在后台运行 `devflow wait <id>`。
- 改代码之前先出方案：新功能或行为修改用 `devflow-propose` 写成变更，经人审批（`devflow approve`）后再实现。
- 技能：`devflow-propose`（提出变更方案）、`devflow-apply`（实现已批准的变更并验证）、`devflow-archive`（归档前更新知识页）、`devflow-scan`（生成或更新知识页）、`devflow-ask`（带引用回答项目问题）。
