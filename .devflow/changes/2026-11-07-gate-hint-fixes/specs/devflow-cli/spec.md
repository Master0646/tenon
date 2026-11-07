## ADDED Requirements

### Requirement: 重叠影响路径不误报未开工
`devflow check --staged` 对已被某个已开工变更 affected_paths 覆盖的暂存文件，MUST NOT 以其他未开工变更的名义报"未开工"。

#### Scenario: 只提交重叠文件
- WHEN 变更 A 已开工、B 未开工，两者 affected_paths 都含 `docs/x.md`，只暂存 `docs/x.md`
- THEN 不输出 B 未开工的警告

#### Scenario: 提交只属于未开工变更的文件
- WHEN 暂存的文件只在 B 的 affected_paths 内
- THEN 仍输出 B 未开工的警告

## MODIFIED Requirements

### Requirement: validate 覆盖审查页规则
`devflow validate <id>` SHALL 报出 `devflow render` 会拒绝的所有写法，包括图块语法错误；每个问题 MUST 定位到源文件与行号，提示中 MUST NOT 出现临时文件路径。

#### Scenario: er 图使用 Mermaid 语法
- WHEN design.md 第 12 行的 er 图块中写了 `USER ||--o{ ORDER : places`
- THEN validate 报 error，位置为 design.md:12，提示中带正确写法示例，不含 `draft:` 行，退出码为 1

#### Scenario: 代码块带属性
- WHEN proposal.md 中有 ```` ```ts title=x ```` 代码块
- THEN validate 报 error，位置为该行

#### Scenario: validate 通过
- WHEN validate 没有报 error
- THEN render 不会因被审文件的写法或图语法失败

### Requirement: 带哈希的批准命令
审查页 SHALL 给出可直接运行的 `devflow approve <id> --hash <内容哈希前 12 位十六进制>`。`devflow approve <id> --hash <前缀>` 在前缀与当前内容哈希一致时 SHALL 直接批准，不再要求输入 y；不一致时 MUST 拒绝，并说明可能是审查后文件被改或命令复制错了。该命令仍只能在交互终端运行。

#### Scenario: 前缀一致
- WHEN 人复制审查页上的命令在自己的终端运行
- THEN 不出现 y 确认提示，直接输出已批准与下一步

#### Scenario: 审查后文件被改
- WHEN 审查页生成后被审文件又被修改，再运行页面上的命令
- THEN 拒绝批准，提示重新运行 devflow render 并从新页面复制命令，事件日志不变

#### Scenario: 哈希输错
- WHEN 被审文件没变，但 --hash 的值与当前哈希不一致
- THEN 拒绝批准，提示中同时提到"文件被改"与"命令复制错"两种可能

#### Scenario: 非交互终端
- WHEN Agent 在非交互终端运行带 --hash 的 approve
- THEN 与不带 --hash 一样被拒绝

#### Scenario: 前缀太短
- WHEN --hash 的值少于 12 位十六进制
- THEN 拒绝并提示从审查页复制完整命令
