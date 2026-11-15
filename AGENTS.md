<!-- tenon:begin（由 tenon 生成；tenon update 会覆盖本段） -->
## Tenon

本项目用 Tenon 管理行为规范与项目知识。数据目录是 `.tenon/`；改名前初始化的项目沿用 `.devflow/`，下文的 `.tenon/` 都指它。

- 知识页（`.tenon/knowledge/`）是项目地图，按需使用：问"在哪里""是什么、取值多少"这类能直接搜到的问题，直接搜源码；问跨模块流程、"为什么这样设计"、历史变更时，先读 `.tenon/knowledge/index.md` 和相关知识页。
- 以源码为准。关于本项目的事实必须带文件引用（`path:行号` 或 `path#符号`）。查不到就回答"未知"，不要凭通用经验推测。
- `.tenon/specs/` 是已批准的行为规范，只能经 `tenon archive` 修改，不要手改。
- `.tenon/changes/*/events.jsonl` 只能由 tenon 命令追加，不要手改。
- 批准、确认人工证据、归档只能由人来做：人在自己的终端运行 `tenon approve` / `tenon evidence confirm` / `tenon archive`，或在审查台（人自己启动的 `tenon review`）里点按钮。不要代为执行，不要启动或访问审查台。需要等人操作时，在后台运行 `tenon wait <id>`；不能后台运行、或命令退出后不会被唤醒时，前台运行 `tenon wait <id> --timeout 300`，超时就结束本轮，请用户操作后回来说一声。
- 改代码之前先出方案：新功能或行为修改用 `tenon-propose` 写成变更，经人审批（`tenon approve`）后再实现。
- 技能：`tenon-propose`（提出变更方案）、`tenon-apply`（实现已批准的变更并验证）、`tenon-archive`（归档前更新知识页）、`tenon-scan`（生成或更新知识页）、`tenon-ask`（带引用回答项目问题）、`tenon-intake`（把需求文档的指定章节转成需求 md 与 html）。
<!-- tenon:end -->
