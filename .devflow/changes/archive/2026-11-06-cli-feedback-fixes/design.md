# 设计

## 改动总览

```flow LR
group cli.ts: approve, init, status, wiki lint, validate
approve -> 未批准时报告状态
init -> agents.ts 检测 Agent
status -> 列出 archive 目录
wiki lint -> 空知识页 warn
validate -> render.ts 审查页规则检查
render.ts 审查页规则检查 -> am 子进程
doctor.ts -> 空知识页 warn
```

## #1 approve 提示

- `confirm()`（`src/cli.ts:59`）增加取消文案参数，默认仍为"已取消"；archive（`src/cli.ts:220`）不变。
- approve（`src/cli.ts:166`）取消时输出 `✗ 未批准：<id> 状态仍为 <status>（<reason>）`，status 来自 `deriveStatus`。
- 成功时追加一行：`下一步：在 Agent 里说"用 devflow-apply 实现变更 <id>"`。

## #7 init 检测 Agent

- 新增 `agents.ts#guessAgents(root)`：已安装的（`detectAgents`，`src/agents.ts:35`）并上按标记检测的结果。
- 标记：claude 为 `.claude/`、`CLAUDE.md`；codex 为 `.codex/`、`.agents/`、`AGENTS.md`。
- 结果为空时返回全部 Agent，并由 CLI 打印 `! 未检测到 Agent，已安装全部；可用 --agents claude 或 --agents codex 指定`。
- `init`（`src/cli.ts:115`）在 `--agents` 缺省时改用 `guessAgents`；`parseAgents` 不变。HELP 文案（`src/cli.ts:26`）同步。

## #8 审查页验证命令表

- `buildDraft` 的 E 面板（`src/render.ts:112`）在文件表前加"验证命令"表：`| name | run | cwd |`，cwd 缺省显示 `.`。
- 读取用 yaml 解析 `project.yaml`；单元格经 `cell()` 转义。verify 为空时写"未声明验证命令：devflow verify 的结果只会是 unknown"。

## #17 status --all

- parseArgs（`src/cli.ts:42`）加 `all` 布尔选项。
- 遍历 `.devflow/changes/archive/` 下的目录（`repoFiles` 不适用于目录，用 readdirSync 过滤目录），归档时间取 events.jsonl 最后一条 `archived` 事件的 `at`。
- 文本输出：`<目录名>  archived  <at 的日期与时间>`；`--json` 输出 `{ id, status: 'archived', archived_at }`。

## #23 validate 覆盖审查页规则

- 新增 `render.ts#reviewIssues(root, id): Issue[]`，CLI validate（`src/cli.ts:153`）在现有检查后调用。`check` 与 `render` 内部的 `validateChange` 不调用它，避免每次提交起子进程。
- 第一步：对 proposal.md、design.md、每个 `specs/<cap>/spec.md` 调用 `toPanelBody`（`src/render.ts:22`），收集 problems。
- 第二步：抽出所有 `flow / sequence / tree / er` 图块，每块放进一个面板，拼成一份草稿，记录"草稿行号 → 源文件:行号"映射。
- 用 am 渲染到临时目录；解析输出中的 `✗ L<n> <消息>` 行和其后的"Correct example"缩进块，映射回源文件行号，作为 error 与 hint。
- 调用 am 的代码从 `render()`（`src/render.ts:134`）抽成 `runAm(draft, out)`，两处共用，仍使用独立 AM_HOME。

```sequence
CLI -> render.ts: reviewIssues(id)
render.ts -> render.ts: toPanelBody 各文件
render.ts -> am: 只含图块的草稿
am --> render.ts: ✗ L<n> 消息
render.ts --> CLI: Issue（源文件:行号）
```

- 同步改 propose 技能（`templates/skills/devflow-propose/SKILL.md:107`）："validate 会检查图语法"，再运行 `devflow update` 更新 `.claude/`、`.agents/` 下的副本。

## #28 空知识页提醒

- 不改 `lintWiki`（`src/wiki.ts:45`），因为 `check` 也调用它。
- CLI `wiki lint`（`src/cli.ts:138`）在 `pages.length === 0` 时追加 warn：`知识页为空`，hint `用 devflow-scan 生成；小项目可以跳过`。
- doctor（`src/doctor.ts:67` 之后）用 `lintWiki(root).pages.length` 判断，为 0 时报 warn。`test/doctor.test.ts` 的"全部正常"用例需补一个知识页。

## 文档

- 使用手册：init 默认行为、`status --all`、validate 检查图语法、wiki lint 空页提示。
- README：init 说明里的"默认两个都装"。
