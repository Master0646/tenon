---
name: tenon-archive
description: 为验证通过的 Tenon 变更做归档前的准备：更新相关知识页，确认 wiki lint 通过，然后请用户在审查台或自己的终端归档。变更状态为 ready_to_archive，或用户说"归档变更 X""收尾"时使用。
---

# 归档前准备

<!-- 由 tenon 生成；tenon update 会覆盖本文件 -->

## 步骤

1. 运行 `tenon resume <id>`，状态必须是 `ready_to_archive`；否则说明原因并停下。
2. 对 v2 先核对验收矩阵、附件和人工确认，缺项不可归档；项目测试通过不等于业务验收已被证明。请用户先提交本次的代码改动（由用户决定何时提交）。代码提交后，知识页的 `verified_commit` 才能指向包含这些改动的提交。
3. 更新知识页（`.tenon/knowledge/pages/`）：
   - 找出引用了 `affected_paths` 内文件的页面，以及本变更涉及的业务模块对应的页面；
   - 没有相关页时：`pages/` 里已有其他页面，就为本变更涉及的模块新建一页（格式见 tenon-scan 技能），并在 `index.md` 加一行；`pages/` 为空（从没扫描过），就告诉用户知识页为空，建议先用 tenon-scan 生成，由用户决定是否跳过这一步；
   - 对照新代码改正文与 `sources`，`verified_commit` 改为当前提交（`git rev-parse --short HEAD`，加引号）；
   - 在相关页面写一句设计原因的链接：`见 [<变更标题>](../../changes/archive/<归档目录名>/design.md)`。归档目录名为 `<日期>-<id>`，id 已以日期开头时就是 id 本身；
   - 在 `.tenon/knowledge/log.md` 末尾追加 `- <日期> 更新 <slug>：<变更 id> <一句话>`。
4. 运行 `tenon wiki lint`，直到没有错误（指向本变更归档位置的链接在归档前也算有效）。
5. 请用户归档：在审查台打开该变更点「归档」，或在自己的终端运行 `tenon archive <id>`。它会合并规范增量、更新 `specs.lock`、把变更移到 `.tenon/changes/archive/`。可以在后台运行 `tenon wait <id>` 等用户归档。

## 规则

- 不运行 `tenon archive`，不手改 `.tenon/specs/`。
- 只写从代码能核对的事实；设计原因只链接，不复制。

- 归档成功后查看本地 usage 报告；重复问题形成候选后交给 propose 诊断，不自动改变规则或启动模型评测。
