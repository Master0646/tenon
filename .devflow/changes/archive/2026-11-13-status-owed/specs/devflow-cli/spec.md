## ADDED Requirements

### Requirement: status 显示轮到人的操作
`devflow status` SHALL 为每个进行中的变更标出当前需要人完成的操作；不需要人操作时 MUST NOT 输出待办。

#### Scenario: 等待批准
- WHEN 变更状态为 draft 或 rebase_required，运行 `devflow status`
- THEN 该行末尾显示「← 待你批准」

#### Scenario: 等待确认人工证据
- WHEN 变更已开工，有 2 条人工证据已记录但未确认
- THEN 该行末尾显示「← 待你确认 2 条人工证据」

#### Scenario: 等待归档
- WHEN 变更状态为 ready_to_archive
- THEN 该行末尾显示「← 待你归档」

#### Scenario: JSON 输出
- WHEN 运行 `devflow status --json`
- THEN 每个进行中的变更带 `todo` 字段，没有待办时为 null
