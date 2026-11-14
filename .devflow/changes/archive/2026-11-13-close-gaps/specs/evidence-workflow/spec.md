## ADDED Requirements

### Requirement: 自动证据可核对日志引文
自动证据带 `log_quote` 时，devflow SHALL 在记录前核对该原文出现在所引用验证运行的对应检查日志中；核对不通过 MUST 拒绝记录。

#### Scenario: 引文在日志中
- WHEN 日志含一行 `✔ 普通用户被拒绝`，证据的 `log_quote` 为这一行
- THEN 记录成功，事件的 `quote_checked` 为 true

#### Scenario: 引文不在日志中
- WHEN `log_quote` 为 `37 tests passed`，日志里没有这段文字
- THEN 拒绝记录，提示日志中没有这段原文

#### Scenario: 日志被改或丢失
- WHEN 日志文件的哈希与验证记录不一致，或文件不存在
- THEN 拒绝带 `log_quote` 的记录，提示重新运行 verify

#### Scenario: 没有引文
- WHEN 自动证据不带 `log_quote`
- THEN 记录成功，验收矩阵里标为未核对

### Requirement: 证据文件可位于代码仓库
证据的 `test` 与附件来源 SHALL 可以是 `code_roots` 声明的仓库内的文件，并受与本仓库文件相同的越界、符号链接与大小检查。

#### Scenario: 兄弟仓库里的测试文件
- WHEN `code_roots` 含 `../backend`，`test` 为 `../backend/src/test/AccessTest.java` 且文件存在
- THEN 记录成功

#### Scenario: 越界
- WHEN `test` 为 `../backend/../secret.txt`
- THEN 拒绝记录
