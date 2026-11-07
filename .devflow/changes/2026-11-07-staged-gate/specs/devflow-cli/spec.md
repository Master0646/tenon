## ADDED Requirements

### Requirement: 门禁检查暂存区内容
`devflow check --staged` 判断规范是否被手改、事件日志是否只追加时，SHALL 以暂存区中的内容为准；未暂存的工作树改动 MUST NOT 影响结论。不带 `--staged` 时以工作树为准。

#### Scenario: 手改规范但未暂存
- WHEN 工作树中 `.devflow/specs/` 下的文件被手改，但没有暂存，提交其他文件
- THEN `check --staged` 不因规范报错

#### Scenario: 暂存了手改后又在工作树恢复
- WHEN 手改的规范文件已暂存，随后工作树中恢复为原内容
- THEN `check --staged` 报错并拒绝提交

#### Scenario: 事件日志部分暂存
- WHEN 暂存区中的 events.jsonl 删改了已提交的行，工作树中的版本是合法追加
- THEN `check --staged` 报错并拒绝提交

### Requirement: 提示未暂存的变更记录
`devflow check --staged` 在暂存了某个已开工变更 affected_paths 内的文件、而该变更的 `events.jsonl` 暂存版本与工作树不一致时，SHALL 给出警告并提示暂存命令；不拒绝提交。

#### Scenario: 变更目录从未提交
- WHEN 变更已开工，暂存了 affected_paths 内的代码，变更目录不在暂存区
- THEN 输出警告"变更记录未暂存"，提示 `git add .devflow/changes/<id>`，提交成功

#### Scenario: 记录已一并暂存
- WHEN 代码与变更目录一起暂存
- THEN 不输出该警告

### Requirement: 提示超出影响路径的文件
存在已开工的变更时，`devflow check --staged` SHALL 对不属于任何进行中变更 affected_paths、也不在 `.devflow/` 下的已暂存文件给出警告并列出文件；不拒绝提交。没有已开工的变更时 MUST NOT 给出该警告。

#### Scenario: 顺带提交了配置文件
- WHEN 变更已开工，affected_paths 为 `backend/**`，暂存了 `backend/A.java` 与 `.claude/launch.json`
- THEN 输出警告，列出 `.claude/launch.json`，提交成功

#### Scenario: 没有进行中的变更
- WHEN 没有已开工的变更，暂存任意文件
- THEN 不输出该警告
