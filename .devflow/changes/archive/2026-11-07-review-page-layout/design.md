# 设计

```flow LR
buildDraft -> B 规范增量: formatRequirement
buildDraft -> D 任务: 每任务一个条目
buildDraft -> E 被审文件: 带哈希的命令
validate -> reviewIssues: 长段落 warn
approve --hash -> {前缀一致?}
{前缀一致?} -> 直接批准: 是
{前缀一致?} -> 拒绝: 否
```

## B 规范增量（`src/render.ts:80`）

- 新增 `formatRequirement(text)`：输入 `parseDelta` 给出的需求原文（`src/spec.ts:14` 的 `Requirement.text`）。
- 第一行 `### Requirement: <名称>` → `**<名称>**`；到第一个 `#### Scenario:` 前的内容 → 约束段落。
- 每个 `#### Scenario: <名称>` 下的 `- WHEN`、`- THEN`、`- AND` 行 → 表格一行；AND 并入前一个 WHEN 或 THEN 单元格，用"；"连接。
- 场景下出现其他非空行 → 返回 null，调用方回退到现在的 `toPanelBody(r.text)`。
- 单元格经现有 `cell()` 转义。callout 内放表格已用 am 实测可渲染。
- REMOVED 需求通常没有场景：只输出名称与约束段落（含 **Reason**）。

## D 任务（`src/render.ts:108`）

- 表格改为每任务一段：`**T1 标题**　依赖：T0` 加验收条件列表；没有验收条件写"（未写验收条件）"。
- 依赖图保持不变。

## E 面板与 #27

- E 面板末尾的提示（`src/render.ts` 中"确认无误后"一句）改为代码块：`devflow approve <id> --hash <hash 去掉 sha256: 后的前 12 位>`。
- `cli.ts` 的 parseArgs（`src/cli.ts:46`）加 `hash` 字符串选项。approve 分支（`src/cli.ts:175`）：
  - `requireHuman` 照旧在最前面。
  - 给了 `--hash`：不是 12 位以上十六进制 → 报错；`ev.hash` 不以 `sha256:<前缀>` 开头 → 报错"审查后被审文件已变化"，hint `重新运行 devflow render <id> 并重新审查`；一致 → 跳过 confirm，直接 `approve(root, id, ev.hash)`。
  - 不给 `--hash`：保持现状。

## 长段落提醒

- 在 `reviewIssues`（`src/render.ts`）中对 proposal.md、design.md 计算段落：连续的非空行，排除标题、列表项、表格行、引用、代码块内的行。
- 句子数按 `。！？`、以及后跟空白或行尾的 `.!?` 计数；超过 3 句 → warn，位置为段落首行。

## 文档

- 使用手册：审查页说明、`approve --hash`、validate 的长段落 warn；README 命令表。
