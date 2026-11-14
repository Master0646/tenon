# 提案

## 为什么

- 声明 `code_roots` 后，代码哈希能覆盖兄弟仓库，但 `affected_paths` 仍只能写本仓库路径，「批准后路径被改」检测对兄弟仓库无效。
- gz-north-second-ring 里，证据的 `test` 字段只能填本仓库的检查脚本，填不了真正的测试文件。
- 自动证据的 `summary`、`assertion` 是 Agent 自己写的，devflow 不核对。上次出现过"37 个单元测试通过"而日志是空的。
- access-channel 变更停在 `applying` 一天多，没有任何提醒。
- 使用手册还是旧流程：终端批准、逐条确认、没有审查台。

## 改什么

- `affected_paths` 接受以某个 `code_roots` 项开头的路径。
- 批准时记录每个代码仓库的基线提交；派生状态时逐个仓库比对。
- 证据的 `test` 与附件来源可以位于代码仓库内。
- 自动证据新增可选字段 `log_quote`，记录时在对应检查的日志里核对。
- `devflow init` 为每个代码仓库安装 pre-commit 钩子；`devflow doctor` 检查这些钩子。
- `devflow check --staged` 新增 `--project <devflow 仓库>`，供代码仓库里的钩子调用。
- `status` 行尾与审查台首页对停滞的变更加标记；阈值由 `project.yaml` 的 `stale_hours` 决定。
- 更新 `docs/使用手册.md`、`docs/使用手册-概览.md`，并重新生成 `docs/使用手册.html`。

## 影响

- 批准事件多一个 `base_commits` 字段；旧事件没有它时只比对本仓库，行为不变。
- 没有声明 `code_roots` 的项目不受影响。
- 验收矩阵多一列「日志核对」。
- 代码仓库的 `.git/hooks/pre-commit` 会被写入；已有别的钩子时不覆盖，只提示要加的那一行。

## 不做什么

- 代码仓库的钩子不检查规范锁和事件日志：那些文件在 devflow 仓库里，由它自己的钩子把关。
- 不解析测试框架的输出格式，只做原文包含判断。
- 不重新生成 `docs/使用手册-概览.html`：它由另一个工具渲染，不在本仓库的脚本里。
