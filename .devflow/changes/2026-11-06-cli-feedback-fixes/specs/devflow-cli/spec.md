## MODIFIED Requirements

### Requirement: 环境自检
`devflow doctor` SHALL 逐项报告 Node 版本、git、仓库初始化、pre-commit hook、Agent 文件、验证命令声明、知识页的状态，每个问题 MUST 附带修复命令。存在 error 级问题时退出码 MUST 为 1，否则为 0。

#### Scenario: hook 指向的 devflow 已不存在
- WHEN pre-commit hook 中记录的 devflow 路径已被删除
- THEN doctor 报告 error，并提示运行 `devflow init` 重新安装 hook

#### Scenario: Agent 文件过期
- WHEN 某个 Agent 的技能文件与当前版本的模板不一致
- THEN doctor 报告 warn，并提示运行 `devflow update`

#### Scenario: 不在 Git 仓库中
- WHEN 在非 Git 目录运行 doctor
- THEN 只报告环境项，说明其余检查已跳过，不抛出未捕获异常

#### Scenario: 知识页为空
- WHEN `.devflow/knowledge/pages/` 中没有知识页
- THEN doctor 报告 warn，提示用 devflow-scan 生成，退出码不受影响

## ADDED Requirements

### Requirement: 批准结果明确
`devflow approve` 在用户未输入 y 时 MUST 说明变更未被批准及其当前状态，退出码为 1；批准成功时 SHALL 给出下一步。

#### Scenario: 未输入 y
- WHEN 用户在确认提示处直接回车或输入其他内容
- THEN 输出"未批准"、变更 id 与当前状态，事件日志不变，退出码为 1

#### Scenario: 批准成功
- WHEN 用户输入 y
- THEN 输出已批准，并提示下一步用 devflow-apply 实现

### Requirement: init 按检测安装 Agent
`devflow init` 未指定 `--agents` 时 SHALL 只为项目中检测到的 Agent 生成文件；一个都检测不到时安装全部 Agent，并提示可用 `--agents` 指定。

#### Scenario: 只有 Claude Code
- WHEN 项目有 `.claude/` 或 `CLAUDE.md`，没有 `.codex/`、`.agents/`、`AGENTS.md`，运行 `devflow init`
- THEN 只生成 Claude Code 的技能与说明，不生成 Codex 文件

#### Scenario: 都检测不到
- WHEN 项目里没有任何 Agent 的目录或说明文件，运行 `devflow init`
- THEN 生成全部 Agent 的文件，并输出可用 `--agents` 指定的提示

#### Scenario: 显式指定
- WHEN 运行 `devflow init --agents codex`
- THEN 只生成 Codex 文件，不做检测

### Requirement: 审查页展示验证命令
`devflow render` 生成的审查页 SHALL 列出 `project.yaml` 中每条验证命令的 name、run、cwd；没有声明时 MUST 明确写出未声明。

#### Scenario: 已声明验证命令
- WHEN project.yaml 声明了两条 verify
- THEN 审查页的被审文件面板中有一张表，列出这两条命令的 name、run、cwd

#### Scenario: 未声明验证命令
- WHEN project.yaml 的 verify 为空
- THEN 审查页写明未声明验证命令，verify 结果只会是 unknown

### Requirement: 查看已归档变更
`devflow status --all` SHALL 在进行中的变更之外，列出 `.devflow/changes/archive/` 下每个已归档变更及其归档时间。

#### Scenario: 有已归档变更
- WHEN 存在一个进行中的变更和两个已归档变更，运行 `devflow status --all`
- THEN 输出三行，已归档的两行状态为 archived 并带归档时间

#### Scenario: 不带 --all
- WHEN 运行 `devflow status`
- THEN 只列出进行中的变更，与现在一致

### Requirement: validate 覆盖审查页规则
`devflow validate <id>` SHALL 报出 `devflow render` 会拒绝的所有写法，包括图块语法错误；每个问题 MUST 定位到源文件与行号。

#### Scenario: er 图使用 Mermaid 语法
- WHEN design.md 第 12 行的 er 图块中写了 `USER ||--o{ ORDER : places`
- THEN validate 报 error，位置为 design.md:12，提示中带正确写法示例，退出码为 1

#### Scenario: 代码块带属性
- WHEN proposal.md 中有 ```` ```ts title=x ```` 代码块
- THEN validate 报 error，位置为该行

#### Scenario: validate 通过
- WHEN validate 没有报 error
- THEN render 不会因被审文件的写法或图语法失败

### Requirement: 空知识页提醒
`devflow wiki lint` 在没有任何知识页时 SHALL 给出 warn，提示用 devflow-scan 生成；退出码 MUST 仍为 0。`devflow check` 不因知识页为空给出提示。

#### Scenario: 从未扫描
- WHEN `.devflow/knowledge/pages/` 只有 `.gitkeep`
- THEN wiki lint 输出 warn"知识页为空"与 devflow-scan 提示，退出码为 0

#### Scenario: 门禁
- WHEN 知识页为空时提交代码
- THEN `devflow check` 不输出知识页为空的提示
