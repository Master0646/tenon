## ADDED Requirements

### Requirement: Git 目录只读时可运行
tenon 的 status、resume、validate、render、apply、task、verify、evidence add、wait 自身 MUST NOT 向 `.git/` 写入文件，SHALL 在 `.git/` 不可写时正常运行。

#### Scenario: 只读时查看状态
- WHEN `.git/` 不可写且工作树有未提交的改动，运行 `tenon status`
- THEN 正常输出状态，退出码为 0

#### Scenario: 只读时开工
- WHEN `.git/` 不可写，对已批准的变更运行 `tenon apply <id> --start`
- THEN 开工成功，锁文件建在数据目录的 `runtime/` 下

#### Scenario: 哈希值不变
- WHEN 对同一工作树分别用改动前后的算法计算工作树哈希
- THEN 两个哈希相同，已有的验证与证据记录继续有效

### Requirement: guard 拦截越级操作
`tenon guard` SHALL 从标准输入读取 PreToolUse 钩子的 JSON，对人专属命令（approve、archive、review、evidence confirm）和改动 `specs/`、`events.jsonl` 的补丁输出拒绝决定与原因；其他调用和无法解析的输入 MUST 放行。

#### Scenario: 换写法运行人专属命令
- WHEN 命令是 `npx tenon approve x`、`/opt/homebrew/bin/tenon archive x`、`node dist/cli.js approve x` 或 `cd a && tenon approve x 2>&1`
- THEN 输出拒绝决定，原因说明该命令只能由人在自己的终端运行

#### Scenario: 补丁改规范或事件日志
- WHEN apply_patch 的补丁涉及 `.tenon/specs/user/spec.md` 或 `.devflow/changes/x/events.jsonl`
- THEN 输出拒绝决定

#### Scenario: 正常命令
- WHEN 命令是 `tenon status`、`tenon evidence add x --file e.json` 或 `rg "tenon approve" docs`
- THEN 放行

#### Scenario: 输入损坏
- WHEN 标准输入不是合法 JSON
- THEN 退出码为 0，不输出拒绝决定

### Requirement: 为 Codex 登记钩子
`tenon init` 与 `tenon update` 为 Codex 安装时 SHALL 在 `.codex/hooks.json` 登记调用 `tenon guard` 的 PreToolUse 钩子，保留文件里已有的内容，重复运行 MUST NOT 重复登记。

#### Scenario: 已有其他钩子
- WHEN `.codex/hooks.json` 里已有用户自己的钩子，运行 `tenon update --agents codex`
- THEN 原有钩子保留，tenon guard 钩子只出现一次

#### Scenario: 文件不是合法 JSON
- WHEN `.codex/hooks.json` 无法解析
- THEN 不改动该文件，并提示手动加入的内容

### Requirement: 人专属命令拒绝 Agent 环境
approve、archive、evidence confirm、review SHALL 在环境变量 `CLAUDECODE`、`CODEX_SANDBOX`、`CODEX_THREAD_ID` 任一存在时拒绝运行，即使标准输入输出是交互终端。

#### Scenario: Agent 申请了交互终端
- WHEN 环境里有 `CODEX_SANDBOX`，在交互终端运行 `tenon approve x`
- THEN 拒绝，并说明请在自己的终端里运行

### Requirement: 技能指引适用于两种 Agent
生成的技能与入口说明 SHALL 同时给出后台等待和前台等待两种做法，MUST NOT 要求使用某一种 Agent 专有的工具。

#### Scenario: 不能后台等待
- WHEN Agent 不能后台运行命令，或命令退出后不会被唤醒
- THEN 技能指引它前台运行 `tenon wait <id> --timeout 300`，超时后结束本轮并请用户操作后回来说一声

#### Scenario: 读文件
- WHEN 阅读生成的 tenon-apply 技能
- THEN 其中没有只适用于 Claude Code 的读文件工具要求

### Requirement: doctor 检查 Agent 防线
`tenon doctor` SHALL 检查已安装 Agent 的防线文件：Claude Code 的 `.claude/settings.json` 禁止规则，Codex 的 `.codex/rules/tenon.rules` 与 `.codex/hooks.json`；缺失或与当前版本不一致时 MUST 报告 warn 并提示运行 `tenon update`。

#### Scenario: Codex 规则文件被删
- WHEN 已安装 Codex 技能但 `.codex/rules/tenon.rules` 不存在，运行 `tenon doctor`
- THEN 报告 warn，提示 `tenon update --agents codex`
