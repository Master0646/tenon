# Tenon

嵌入现有 AI 编码 Agent（Claude Code、Codex）使用的软件工程内核：先出方案、人审批，再实现、验证、归档；项目规范与知识以文件形式留在仓库里，换一个会话也能接着做。

Tenon 自己不调用任何模型。读代码、写方案、写代码由你已有的 Agent 完成；`tenon` 命令只做确定性的事：校验格式、绑定批准哈希、判定状态、运行验证命令、合并规范、渲染审查页、在提交时把关。

## 安装

要求：Node 22 或更高版本、git。

在源码目录里：

```bash
npm install && npm pack
```

```bash
npm install -g ./tenon-0.3.0.tgz
```

```bash
tenon --version
```

必须全局安装：终端里能运行 `tenon --version`，后面的命令和 pre-commit hook 才能用。

> 开发时可以不打包，直接运行 `node src/cli.ts <命令>`（需要 Node 23.6 或更高版本）。

> 从 DevFlow 升级：Tenon 只提供 `tenon` 命令。只有 `.devflow/` 的旧项目继续用它，批准和归档都有效；在项目里运行一次 `tenon init` 和 `tenon update`，hook 与 Agent 技能会换成 tenon 版本。详见使用手册「从 DevFlow 升级」。

## 让 Agent 帮你安装并配置

在要启用 Tenon 的项目里打开 Claude Code 或 Codex，把下面整段发给它。把 `<tenon 源码目录>` 换成本仓库的绝对路径。

```text
请在当前项目里安装并配置 Tenon。tenon 源码在 <tenon 源码目录>。按顺序做，每步把命令输出给我看：

1. 检查环境：node --version 必须 ≥ 22；git 可用；当前目录是 Git 仓库且至少有一次提交（没有就停下告诉我，不要替我提交）。
2. 安装 tenon：先运行 tenon --version。没有输出或版本低于源码目录 package.json 的 version 时，在源码目录运行 npm install && npm pack，再运行 npm install -g <源码目录>/tenon-<版本>.tgz，然后再次确认 tenon --version。全局安装被沙箱或权限拦住时，停下把要运行的命令告诉我，由我在自己的终端运行。
3. 在项目根目录运行 tenon init。项目只用 Claude Code 就加 --agents claude，只用 Codex 就加 --agents codex，不确定就不加。已有别的 pre-commit hook 时 init 不会覆盖，把它提示要加的那一行告诉我。
4. 代码不在本仓库、而在旁边的兄弟仓库时：问我有哪些仓库，在 .tenon/project.yaml 写 code_roots（路径相对本仓库根，每项是一个 Git 仓库的根），然后再运行一次 tenon init。
5. 验证命令：读项目的构建配置（package.json、pom.xml、build.gradle、pyproject.toml、go.mod 等），列出你建议写进 .tenon/project.yaml 的 verify 条目（name、run、可选 cwd），说明每条依据。等我确认后再写入。这个文件由人维护，不要自己加我没确认的命令，也不要为了让验证通过而删减命令。
6. 把验证命令生成的目录（dist/、target/、node_modules/ 等）补进 .gitignore，确认 .tenon/runtime/ 已被忽略。
7. 运行 tenon doctor，逐条处理 ✗；! 只说明含义。"知识页为空"可以先不管。
8. 汇报：生成了哪些文件、doctor 结果、还需要我做的事。不要提交。

规则：tenon approve、tenon archive、tenon evidence confirm、tenon review 只能由人运行，不要执行，也不要访问审查台；不要手改 .tenon/specs/ 和任何 events.jsonl。
```

装好之后由你自己做三件事：

1. 审一遍 Agent 写进 `.tenon/project.yaml` 的 `verify`。
2. 用 Codex 时，重新打开 Codex，选择**信任**这个项目，再运行 `/hooks` 确认 `tenon guard` 钩子。不做这一步，Codex 的禁止规则和钩子都不生效。
3. 提交：`git add -A && git commit -m "启用 Tenon"`，输出里应有 `✓ tenon check 通过`。

## 五分钟上手

先完成上面的全局安装，确认 `tenon --version` 有输出。然后在一个已有提交的 Git 项目里：

```bash
tenon init
```

它会创建 `.tenon/`，安装 pre-commit hook，并为检测到的 Agent 生成技能与说明：Claude Code（`.claude/skills/`、`CLAUDE.md`）、Codex（`.agents/skills/`、`AGENTS.md`、`.codex/rules/`、`.codex/hooks.json`）。一个都检测不到时两个都装；用 `--agents claude` 或 `--agents codex` 指定。然后：

1. **声明验证命令**（由人维护）：编辑 `.tenon/project.yaml` 的 `verify`，例如 `mvn -q test`、`npm test`。只有这里声明的命令会被 `tenon verify` 运行，验证结果决定变更能否归档。
2. **自检**：`tenon doctor`。
3. **启动审查台**（一次）：在**自己的终端**运行 `tenon review`，保持它开着。浏览器会打开审查台，之后的批准、确认人工证据、归档都在这里点按钮。
4. **提方案**：在 Agent 里说"用 tenon-propose 提一个变更：……"。Agent 写好方案后，变更出现在审查台首页，工作节点为"待你批准"。首页的「工作节点」一列显示每个变更走到哪一步，下方的「已归档」可以打开归档过的变更的只读页；状态变化时页面提示「有新进展，点此刷新」，不会自己刷新。
5. **审批**：打开变更。操作栏固定在顶部，左侧是可跳转的目录；首屏写明现在到哪一步、要你做什么和待拍板事项，方案要点紧接其后，细节面板默认折叠，页面最后是发过的批注记录。选好后点「批准此版本」。不用审查台时，也可以复制审查页上的 `tenon approve <id> --hash <前缀>` 到终端运行。
6. **实现与验证**：在 Agent 里说"用 tenon-apply 实现变更 <id>"。它会开工、逐个完成任务，并运行 `tenon verify <id>` 直到通过。
7. **提交代码**：由你决定何时提交。
8. **归档准备**：在 Agent 里说"用 tenon-archive 为变更 <id> 做归档准备"。它会更新知识页。
9. **归档**：在审查台点「归档」，或在自己的终端运行 `tenon archive <id>`。规范增量合并进 `.tenon/specs/`，变更移到 `.tenon/changes/archive/`。

以上说法按 Claude Code 写。用 Codex 时用 `$技能名` 调用，例如"`$tenon-propose` 提一个变更：……"；Codex 不能后台等待时，让它前台运行 `tenon wait <id> --timeout 300`。

以后任何新会话，Agent 都能从 `.tenon/` 找回当时的需求、规范和设计原因。

## 人与 Agent 的分工

| 谁 | 做什么 |
| --- | --- |
| 人 | 审查方案、`tenon approve`、确认人工证据、提交代码、`tenon archive`、维护 `project.yaml` 中的验证命令 |
| Agent | 把需求文档章节转成需求 md（intake）、读代码、写方案（propose）、实现与测试（apply）、更新知识页（archive 准备、scan）、带引用回答问题（ask） |
| tenon | 校验、哈希批准、派生状态、运行验证命令、合并规范、渲染审查页、pre-commit 门禁 |

## 命令

| 命令 | 作用 |
| --- | --- |
| `tenon init [--agents claude,codex]` | 初始化 `.tenon/`、hook 与 Agent 文件 |
| `tenon update [--agents …]` | 升级 tenon 后重新生成 Agent 文件 |
| `tenon doctor` | 自检，并给出修复命令 |
| `tenon new <id>` | 生成变更目录骨架 |
| `tenon validate <id>` | 校验变更文件、对当前规范做合并试算，并检查审查页写法与图语法 |
| `tenon render <id> [-o 文件]` | 生成离线审查页 |
| `tenon status [id] [--all]` | 显示派生状态与任务进度，行尾标出轮到谁（待你批准、待你确认 N 条人工证据、待你归档，或 Agent 进行中）；`--json` 带 `todo` 字段；`--all` 同时列出已归档的变更 |
| `tenon review [id]` | 启动本地审查台（只能由人在交互终端运行）：在浏览器里批准、批量确认人工证据、归档，并列出所有没收尾的变更 |
| `tenon wait <id> [--timeout 秒]` | 等人批准、确认证据、归档或发来批注后退出；Agent 在后台运行，人不用回对话里说"已批准"，也不用复制意见 |
| `tenon approve <id> [--hash 前缀]` | 批准并绑定内容哈希（只能由人在交互终端运行）；`--hash` 与审查页一致时直接批准 |
| `tenon apply <id> --start` | 记录开工 |
| `tenon task done <id> <任务>` | 记录任务完成 |
| `tenon verify <id>` | 运行 `project.yaml` 中的验证命令 |
| `tenon resume <id>` | 显示当前进度、证据缺口与下一步（Agent 换会话后先看它） |
| `tenon evidence add <id> --file <json>` | 记录验收证据 |
| `tenon evidence confirm <id> <证据>` | 确认人工证据（只能由人在交互终端运行） |
| `tenon archive <id>` | 合并规范并归档（只能由人在交互终端运行；中断后重跑即继续） |
| `tenon wiki lint` | 校验知识页的引用、链接，并检查是否过期 |
| `tenon req render <需求目录> [-o 文件]` | 把 `.tenon/requirements/<章节>/` 下的需求 md 渲染成仿 Stripe 文档样式的离线 html |
| `tenon check [--staged]` | 门禁检查（hook 与 CI 使用） |
| `tenon guard` | 供 Codex 的 PreToolUse 钩子调用，拦截人专属命令和改 `specs/`、`events.jsonl` 的补丁 |
| `tenon usage` / `improve` / `eval` | 本地使用记录、改进候选与评测，见下文 |

所有命令支持 `--json`。

## 状态

状态不存盘，每次由变更文件、`events.jsonl` 和 git 现算：

`draft` → `approved` → `applying` → `ready_to_archive` → `archived`。另有两个旁支：`rebase_required`（批准后，有别的提交改动了影响路径）和 `needs_fix`（验证失败或结果未知）。

- 批准后修改方案文件或 `project.yaml`，批准自动失效，状态回到 `draft`。
- 验证通过后再改代码，需要重新验证。
- 验证命令无法运行、没有声明命令、验证期间工作树发生变化，结果都记为 `unknown`，不算通过。

## 安全模型与已知限制

- **防的是失误与越级，不防恶意篡改。** 有写权限的 Agent 理论上能改任何文件。
- **人专属命令**：`approve`、`archive`、`evidence confirm`、`review` 要求交互终端（TTY），检测到 Agent 的环境变量（`CLAUDECODE`、`CODEX_SANDBOX`、`CODEX_THREAD_ID`）时也拒绝。Claude Code 的 shell 不是 TTY；Codex 可以让模型申请 TTY，所以多了环境变量这一层。Agent 清掉变量仍可绕过，它只防越级。
- **禁止规则**：`init` 为 Claude Code 写入 deny 规则（已实测拦截 `tenon approve`），为 Codex 写入 `.codex/rules/tenon.rules` 和 `.codex/hooks.json`。钩子调用 `tenon guard`，拦截各种写法的人专属命令，以及改 `specs/`、`events.jsonl` 的补丁。两者只在项目被信任时加载，钩子还要在 Codex 里用 `/hooks` 确认一次。
- **审查台**只监听 `127.0.0.1`，所有地址都带启动时生成的随机令牌，令牌只打印在你的终端里；令牌不对或 Host 不是本机一律返回 404。批准时页面提交它显示的内容哈希，与当前内容不一致就拒绝。能读到你终端输出或浏览器历史的进程可以拿到令牌，所以它和 TTY 检查一样只防越级。
- **最后一道防线**是 git：pre-commit 与 CI 中的 `tenon check` 会拒绝手改 `.tenon/specs/`、改写已提交的事件日志等行为；批准记录随 `events.jsonl` 进入代码审查。
- `check --staged` 对规范、事件日志及受控快照/附件读取暂存区；方案格式和业务状态仍从工作树派生，部分暂存时应核对对应材料。
- 在小项目上，知识页对"代码里能直接搜到的事实"没有带来准确率提升（见 `docs/tasks/2026-11-06-tenon-m1.md`）；它的价值在于设计原因和历史变更这类代码里看不出来的知识。

## 第三方许可证

见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。tenon 本身尚未选择开源许可证。

## 0.2.0：证据与持续改进

新建变更默认为 v2，change.yaml 使用 schema_version: 2 和 min_cli_version: 0.2.0；tasks.yaml 同为 v2。旧 v1 可继续使用，`tenon new <id> --schema 1` 可显式创建旧格式；v1 重新批准后旧任务完成记录不再计数。

v2 每个任务的 acceptance 是至少一个 `{id, text, method, check?}` 对象；id 在变更内唯一，method 为 automated/manual，自动项的 check 引用 project.yaml 已声明的 verify.name。只有固定 execution.md 实施笔记不参与批准哈希，其他契约修改仍需重批。

推荐顺序：实现代码 → verify → evidence add → 人工项 confirm → task done → resume → 人工 archive。verify 输出 run_id；自动证据必须关联本轮、同代码版本的成功检查，不能凭测试通过推断需求覆盖充分。

```bash
tenon resume <id> --json
tenon verify <id> --json
tenon evidence add <id> --file evidence.json
# 下面的确认仅由人来做：在审查台勾选确认，或在自己的终端运行
tenon evidence confirm <id> <evidence-id>
tenon task done <id> <task>
```

自动 evidence.json 示例（填写实际 run_id、任务和已批准条件）：

```json
{"task":"T1","acceptance":"AC1","kind":"automated","summary":"普通用户被拒绝且数据不变","verify_run":"实际运行ID","check":"unit-tests","test":"test/access.test.ts","assertion":"断言 status=403，数据未修改","log_quote":"✔ 普通用户被拒绝","artifacts":[]}
```

`log_quote` 可选：从该检查日志原样复制的一行。tenon 记录前核对它在日志里（日志被改或丢失时拒绝，提示重新 verify），验收矩阵的「日志核对」列显示「已核对」。

人工项改为 kind: manual，并提供 procedure、expected、observed。附件最多十个、每个最多 1 MiB，禁止 exclude 文件、越界或符号链接；证据和批准快照属于受控项目材料，应与 events.jsonl 一起提交。原始运行日志丢失仅提示，受控附件或快照损坏会阻止后续流程。

代码变化需重建证据。重新批准开始新周期，但验收条件（文本、方式、检查命令）和代码都没变的证据与任务完成记录自动沿用，只需重新 `apply --start` 和 `verify`。

代码不在 tenon 所在的仓库时，在 `project.yaml` 里声明 `code_roots: ["../backend", "../frontend"]`（每项是一个 Git 仓库的根，路径相对本仓库）。声明后代码哈希只算这些仓库：它们的改动会让验证和证据过期，本仓库里的文档改动不会。`affected_paths` 写成以该项开头的路径（`../backend/src/**`）；批准后那个仓库有提交改动这些路径，变更进入 rebase_required。证据的 `test` 与附件也可以在这些仓库里。声明或改动 `code_roots` 后重新运行 `tenon init`，它给每个代码仓库装上 pre-commit hook（`tenon check --staged --project <本仓库>`），在那边提交未开工变更的代码时按 `enforce` 警告或拒绝；已有其他 hook 时不覆盖，打印要加的那一行。

`tenon status` 对已批准或已开工、最后一条记录超过 `stale_hours`（`project.yaml`，默认 24）小时的变更在行尾标「停滞 N 小时」，审查台列表同样显示。`project.yaml` 计入批准哈希，改阈值要重新批准进行中的变更。

`change.yaml` 的 `summary`（方案要点，最多 7 条）和 `decisions`（待拍板事项，每项给出选项和推荐）显示在审查页前两个面板（拍板事项在首屏，方案要点紧接其后）。在审查台批准时选的结论记入批准事件，`tenon resume` 会显示给 Agent。

一个工作树只开工一个 v2 变更，多个任务用独立 worktree 隔离；同能力规范变化进入 rebase_required，更新方案后重新批准。归档确认期间代码变化会拒绝继续，部分写入事务只能在恢复相应代码与证据后前滚。

### 本地使用记录

初始化项目内默认记录命令白名单、结果、原因码和耗时，不记录完整参数、输出、环境、用户名或源码；不上传。原始记录默认保留 30 天，用户反馈 90 天，报告 180 天；未解决候选保留到显式删除。

```bash
tenon usage configure --off
tenon usage configure --on
DEVFLOW_USAGE=off tenon status
tenon usage report --since 2026-11-08
tenon usage feedback <id> --file feedback.json
tenon usage export --since 2026-11-08 --out summary.json
tenon usage prune --before 2026-10-01
```

反馈 JSON 为 `{category, impact, note, related_invocation?}`；category 使用 blocked、confusing、false-positive、missed-defect 或 other。自由文本是用户填写的数据，默认聚合导出不含它；不要填写凭据。

每 20 次结束调用或有新调用且距离报告超过 7 天自动汇总；同类问题至少 3 次产生去重候选。关闭或记录写入失败不影响业务退出码，JSON stdout 保持纯净。墙钟周期包含等待，不能视为人工时间；token、成本与真实漏检率缺失时保持 unknown。

```bash
tenon improve list
tenon improve draft <candidate-id> <change-id>
tenon eval run --suite workflow --out regression.json
tenon eval compare baseline.json regression.json
tenon improve resolve <candidate-id> --report comparison.json
```

候选生成待补全提案，不自动审批或实施。故障评测在临时仓库运行；协议和夹具不一致时不给出可比提升，至少每任务每版本五次且关键结果不退化、目标中位指标下降至少 10% 才标本批 improved，仍不表示统计显著。

真实 Agent 评测需要显式启动且可能消耗账号额度，不由本地记录或业务 verify 自动触发；环境不满足时记 unknown，不将构建或真实业务验收降级为静态检查。升级时重新安装包并运行 tenon update 同步技能和人的命令规则；已有 v2 项目不得退回旧 CLI 追加事件。
