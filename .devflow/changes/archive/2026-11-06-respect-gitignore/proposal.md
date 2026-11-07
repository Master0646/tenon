# 提案

## 为什么

提交使用手册时，pre-commit 门禁拒绝了提交，原因是"`.devflow/specs/.DS_Store` 不在 specs.lock 中（被手动添加）"。这个文件是 macOS 访达自动生成的，devflow 仓库的 `.gitignore` 已经忽略了 `.DS_Store`，它永远不会进入提交。

原因：devflow 遍历 `.devflow/` 下的目录时，读的是磁盘上的全部文件，没有遵守 `.gitignore`。同样的问题出现在四个地方：

| 位置 | 被忽略的文件出现时的后果 |
| --- | --- |
| `.devflow/specs/`（`check`） | 当作手改规范，**拒绝提交** |
| 变更目录（批准哈希） | 文件被算进哈希；用访达打开一次目录，**批准就失效** |
| `changes/<id>/specs/`（`validate`） | 报"delta spec 路径必须是 specs/<能力>/spec.md" |
| `knowledge/pages/`（`wiki lint`） | 报"知识页必须是 pages/<slug>.md" |

## 改什么

上述四处改为只看 git 会跟踪的文件：已跟踪的文件，加上未被 `.gitignore` 忽略的新文件。被忽略的文件一律不参与校验、哈希和门禁。

## 影响

- 门禁、批准哈希、validate、wiki lint 不再受 `.DS_Store`、编辑器临时文件等被忽略文件的干扰。
- 没有被忽略的多余文件，行为不变：例如 `specs/` 下手动新加的 `notes.md` 仍会被门禁拒绝。
- 已有的批准不受影响：项目中原本没有被忽略的文件时，哈希不变。

## 不做什么

- 不改变 `.gitignore` 本身，也不让 `devflow init` 往 `.gitignore` 里加 `.DS_Store`。忽略规则由项目自己决定。
- 不改动 `.devflow/` 以外的工作树哈希（它本来就遵守 `.gitignore`）。
