# devflow-cli

## Purpose

devflow 命令行的安装与自检行为。

## Requirements

### Requirement: 安装后可直接运行
用 `npm pack` 得到的包安装后，`devflow` 命令 SHALL 在 Node 22 及以上版本直接运行，不依赖 TypeScript 类型剥离。

#### Scenario: 从打包文件安装
- WHEN 在干净目录中执行 `npm install <devflow-x.y.z.tgz>`
- THEN `npx devflow help` 输出命令列表，退出码为 0

### Requirement: 版本号
`devflow --version` SHALL 输出与 package.json 一致的版本号。

#### Scenario: 查看版本
- WHEN 运行 `devflow --version`
- THEN 输出 package.json 中的 version 字段

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

### Requirement: 遵守 .gitignore
devflow 在校验、计算批准哈希和提交门禁中遍历 `.devflow/` 下的目录时，SHALL 只考虑已跟踪的文件和未被忽略的新文件；被 `.gitignore` 忽略的文件 MUST NOT 影响校验结果、批准哈希或门禁结论。

#### Scenario: 访达生成的 .DS_Store
- WHEN `.gitignore` 忽略了 `.DS_Store`，且 `.devflow/specs/`、变更目录或 `knowledge/pages/` 中出现了 `.DS_Store`
- THEN `devflow check` 不报错，`devflow validate` 与 `devflow wiki lint` 不报错，已批准的变更仍为 approved

#### Scenario: 未被忽略的多余文件
- WHEN `.devflow/specs/` 中出现一个没有被忽略、也不在 specs.lock 中的文件
- THEN `devflow check` 仍报错并拒绝提交

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

### Requirement: 空知识页提醒
`devflow wiki lint` 在没有任何知识页时 SHALL 给出 warn，提示用 devflow-scan 生成；退出码 MUST 仍为 0。`devflow check` 不因知识页为空给出提示。

#### Scenario: 从未扫描
- WHEN `.devflow/knowledge/pages/` 只有 `.gitkeep`
- THEN wiki lint 输出 warn"知识页为空"与 devflow-scan 提示，退出码为 0

#### Scenario: 门禁
- WHEN 知识页为空时提交代码
- THEN `devflow check` 不输出知识页为空的提示

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

### Requirement: 重叠影响路径不误报未开工
`devflow check --staged` 对已被某个已开工变更 affected_paths 覆盖的暂存文件，MUST NOT 以其他未开工变更的名义报"未开工"。

#### Scenario: 只提交重叠文件
- WHEN 变更 A 已开工、B 未开工，两者 affected_paths 都含 `docs/x.md`，只暂存 `docs/x.md`
- THEN 不输出 B 未开工的警告

#### Scenario: 提交只属于未开工变更的文件
- WHEN 暂存的文件只在 B 的 affected_paths 内
- THEN 仍输出 B 未开工的警告
