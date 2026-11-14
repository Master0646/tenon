# 设计

## 实测依据

环境：本机 codex-cli 0.154.0 的 `:workspace` 沙箱，tenon 0.3.0，临时仓库。

- 沙箱内 `.git`、`.codex`、`.agents` 不可写，工作区其余位置和临时目录可写。
- 沙箱内 `tenon status`、`tenon resume` 报 `unable to create temporary file` 后崩溃；沙箱外正常。
- 沙箱内 `tenon wait`、`tenon wiki lint`、`tenon doctor` 正常。
- `codex execpolicy check`：`tenon approve demo` 命中 forbidden；`npx tenon approve`、绝对路径、`node dist/cli.js approve` 不命中。
- 沙箱内环境变量有 `CODEX_SANDBOX`；Claude Code 的 shell 里有 `CLAUDECODE`。

## 1. 不再写 .git

```flow LR
worktreeHash -> treeHash -> git add -A -> 临时对象目录
treeHash -> git write-tree -> 临时对象目录
临时对象目录 -> 原对象库: 只读引用
```

- 原因：`treeHash` 用临时索引跑 `git add -A` 和 `write-tree`，新对象写进 `.git/objects`（`src/core.ts:288`）。
- 改法：给这三条 git 命令加两个环境变量。`GIT_OBJECT_DIRECTORY` 指向临时目录下的 `objects/`，`GIT_ALTERNATE_OBJECT_DIRECTORIES` 指向原对象库。
- 已验证：沙箱内用这组变量算出的树哈希与现有算法相同（同为 `efd593d…`）。
- 工作树锁：现在建在 `git rev-parse --git-path tenon.lock`（`src/core.ts:329`），apply、task、verify、approve、archive、evidence 都要拿（`src/cli.ts:431`）。
- 改法：锁改为 `<数据目录>/runtime/tenon.lock`。该目录已被 gitignore，每个 worktree 各有一份，沙箱内可写（已验证）。

## 2. tenon guard 与 Codex 钩子

```flow TB
(Codex 调用工具) -> {是 Bash 或 apply_patch?}
{是 Bash 或 apply_patch?} -> 放行: 否
{是 Bash 或 apply_patch?} -> guard 读取标准输入: 是
guard 读取标准输入 -> {人专属命令或受保护路径?}
{人专属命令或受保护路径?} -> 输出 deny 与原因: 是
{人专属命令或受保护路径?} -> 放行: 否
```

- 现状：Claude 的 deny 规则同时管命令和文件编辑（`src/agents.ts:21`）；Codex 只有命令前缀规则（`templates/tenon.rules`），官方文档里 rules 只管命令。
- 新文件 `src/guard.ts`，`src/cli.ts` 增加 `guard` 子命令。它不需要项目已初始化，也不记 usage。
- 输入：钩子 JSON 的 `tool_name` 和 `tool_input.command`。
- 命令判断：处在命令位置上的 `tenon`（含 `npx`、路径前缀、`node …/cli.js` 形式）后接 approve、archive、review 或 evidence confirm 时拒绝。出现在引号里的搜索词不拦。
- 补丁判断：补丁里的文件路径落在 `.tenon/specs/`、`.devflow/specs/`，或是 `changes/` 下的 `events.jsonl` 时拒绝。
- 输出：拒绝时打印 `hookSpecificOutput`，其中 `permissionDecision` 为 `deny` 并带原因，退出码 0；放行时不输出。这是 Codex 官方文档推荐的格式。
- 输入无法解析时放行：guard 只防越级，失败时不能把 Agent 卡死。
- `installAgents` 的 Codex 分支（`src/agents.ts:144`）合并写入 `.codex/hooks.json`，做法与现有的 `.claude/settings.json` 合并相同：保留已有内容，已登记就不重复，文件损坏时不改并给出警告。
- 钩子命令写 `tenon guard`，不写绝对路径：这个文件会提交进仓库，给多台机器用。
- 保留 `.codex/rules/tenon.rules` 作为第一层。
- `init` 的 Codex 提示增加一句：首次使用要在 Codex 里用 `/hooks` 确认钩子。

## 3. 人专属命令拒绝 Agent 环境

- 现状：`requireHuman` 只看是否交互终端（`src/cli.ts:82`），Codex 可以自己申请交互终端。
- 改法：环境里有 `CLAUDECODE`、`CODEX_SANDBOX`、`CODEX_THREAD_ID` 任一个就拒绝，一行条件。
- 它和交互终端检查一样只防越级：Agent 清掉变量仍可绕过，最后一道防线还是 `tenon check`。
- 拍板为「不加这项检查」时，我会删掉任务 T3 和对应的规范条目，再请你重新批准。

## 4. 技能与入口说明

- 「在后台运行 `tenon wait`」出现在 `templates/skills/tenon-propose/SKILL.md:21`、`templates/skills/tenon-apply/SKILL.md:15`、`templates/skills/tenon-archive/SKILL.md:21`、`templates/entry.md:9` 等处。
- 改法：每处补一句前台做法。不能后台运行、或命令退出后不会被唤醒时，前台运行 `tenon wait <id> --timeout 300`，超时就结束本轮，请用户操作后回来说一声。
- `templates/skills/tenon-apply/SKILL.md:42` 的「读文件用 Read」一条删掉。
- 改完运行 `tenon update`，重新生成本仓库的 `.claude/skills/`、`.agents/skills/`、`CLAUDE.md`、`AGENTS.md`、`.codex/`。

## 5. doctor 与文档

- 现状：`agentDrift` 只比对技能和入口说明（`src/agents.ts:73`），防线文件被删时 doctor 仍报一致。
- 改法：`agentDrift` 增加三项。Claude 的 `permissions.deny` 是否包含全部 `CLAUDE_DENY`；Codex 的 `tenon.rules` 是否与模板相同；`hooks.json` 是否登记了 guard。
- 顺带修 `src/doctor.ts:75`：修复提示用了单引号，现在会原样打印 `${dfOf(root)}`。
- README 的安全模型一节和使用手册的「选择你的 Agent」表按新防线改写。

## 测试

- `.git` 只读的场景用 `chmod` 模拟，不依赖本机装了 codex，任何机器都能跑。
- guard 用标准输入喂 JSON 样本，逐条对应规范里的场景。
- 真实 Codex 会话的两项验收（AC10、AC11）是人工项，由你在 Codex 里操作后确认。

## 未知

- Codex 钩子输入里 `tool_input.command` 是脚本字符串还是参数数组：官方文档没有样例。实现时先抓一份真实输入再定解析方式。
- `.codex/hooks.json` 的完整结构：官方文档只确认了顶层 `hooks`、事件名、`matcher`、`command`、`timeout` 这些字段，实现时按官方示例核对。
- Codex 后台命令退出后是否会唤醒 Agent：未实测，所以技能里两种做法都写。
- `CODEX_THREAD_ID` 只在 Codex 二进制里看到名字，没有在真实会话里确认它会被设置。
- 300 秒的前台等待是否在 Codex 单条命令的时限内：未实测，AC10 覆盖。
- `docs/使用手册.html` 是手写还是由 md 生成：未核对，实现时确认后同步。
