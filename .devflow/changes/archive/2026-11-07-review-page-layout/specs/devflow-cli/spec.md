## ADDED Requirements

### Requirement: 审查页结构化展示规范与任务
`devflow render` SHALL 把规范增量中的每条需求展示为需求名、约束和场景表（列为场景、WHEN、THEN），把每个任务展示为单独的条目并逐条列出验收条件。无法识别场景结构的需求 MUST 原样展示，不丢内容。

#### Scenario: 标准需求
- WHEN 一条需求有约束句和两个各含 WHEN、THEN 的场景
- THEN 审查页中该需求下有一张两行的场景表

#### Scenario: AND 子句
- WHEN 场景中 THEN 后还有 `- AND` 行
- THEN AND 的内容并入同一行的 THEN 单元格

#### Scenario: 无法识别的场景
- WHEN 场景下出现 WHEN、THEN、AND 以外的内容
- THEN 该需求按原文展示

#### Scenario: 多条验收条件
- WHEN 一个任务有三条验收条件
- THEN 审查页中该任务下有三条列表项

### Requirement: 长段落提醒
`devflow validate <id>` SHALL 对 proposal.md、design.md 中超过 3 句的段落给出 warn，定位到段落起始行；不影响退出码。

#### Scenario: 长段落
- WHEN design.md 第 5 行起的一个段落有 5 句
- THEN validate 输出 warn，位置为 design.md:5，退出码为 0

#### Scenario: 列表与代码块
- WHEN 长内容写在列表项、表格或代码块中
- THEN 不给出该 warn

### Requirement: 带哈希的批准命令
审查页 SHALL 给出可直接运行的 `devflow approve <id> --hash <内容哈希前 12 位十六进制>`。`devflow approve <id> --hash <前缀>` 在前缀与当前内容哈希一致时 SHALL 直接批准，不再要求输入 y；不一致时 MUST 拒绝并说明被审文件已变化。该命令仍只能在交互终端运行。

#### Scenario: 前缀一致
- WHEN 人复制审查页上的命令在自己的终端运行
- THEN 不出现 y 确认提示，直接输出已批准与下一步

#### Scenario: 审查后文件被改
- WHEN 审查页生成后被审文件又被修改，再运行页面上的命令
- THEN 拒绝批准，提示重新运行 devflow render 并重新审查，事件日志不变

#### Scenario: 非交互终端
- WHEN Agent 在非交互终端运行带 --hash 的 approve
- THEN 与不带 --hash 一样被拒绝

#### Scenario: 前缀太短
- WHEN --hash 的值少于 12 位十六进制
- THEN 拒绝并提示从审查页复制完整命令
