# 新流程完整跑通记录：2026-11-13-status-owed

本文记录用一个真实变更把新版 devflow 流程从提方案到归档走完一遍的全过程，供最终验收。时间为 2026-11-13，括号内是北京时间。

## 结论

- 流程走通：提方案 → 审查台批准 → 实现 → 验证 → 证据 → 审查台确认 → 归档，变更已归档，规范已合并。
- 人的操作：浏览器里点了 3 次（批准 1 次、确认证据 2 次），终端里 2 条命令（启动审查台、归档）。归档本该也是点按钮，按钮当时有缺陷，改用了终端。
- 过程中发现 6 个问题：2 个已修复并验证，4 个未修，列在「发现的问题」一节。

## 案例

| 项 | 内容 |
| --- | --- |
| 变更 | `2026-11-13-status-owed`：`devflow status` 每行末尾标出轮到谁 |
| 仓库 | devflow 自身 |
| 规模 | 2 个任务，4 条验收（3 条自动、1 条人工），2 个待拍板事项 |
| 改动 | `src/status.ts`、`src/review.ts`、`src/cli.ts`、`test/cli-feedback.test.ts`、`README.md` |
| 归档位置 | `.devflow/changes/archive/2026-11-13-status-owed/` |

## 时间线

事件时间取自归档后的 `events.jsonl`。

| 时间（UTC） | 谁 | 做了什么 | 方式 |
| --- | --- | --- | --- |
| 批准前 | Agent | `devflow new`，写 5 个方案文件，`validate`、`render` | 命令 |
| 批准前 | Agent | 后台运行 `devflow wait` 等批准 | 命令 |
| 批准前 | 人 | 启动审查台 `devflow review`（启动了两次，一次就够） | 终端 |
| 08:42:03（16:42） | 人 | 选 2 个待拍板事项，点「批准此版本」 | 审查台 |
| 08:45:35 | Agent | `devflow apply --start` | 命令 |
| 08:45–08:49 | Agent | 改代码、补测试、写实施笔记 | 编辑 |
| 08:49:37 | Agent | `devflow verify`：通过 | 命令 |
| 08:50:50–53 | Agent | `devflow evidence add` × 4 | 命令 |
| 08:50:54 | Agent | `devflow task done T1`；后台 `devflow wait` 等确认 | 命令 |
| 08:52:25（16:52） | 人 | 点「确认人工证据」→「确认所选」 | 审查台 |
| 08:56:40 | Agent | `devflow task done T2`，状态变为 `ready_to_archive` | 命令 |
| 08:56 之后 | 人 | 点「归档」：没有反应 | 审查台（失败） |
| 09:00:14（17:00） | 人 | `devflow archive`，输入 `y` | 终端 |

从批准到归档共 18 分钟。

## 分步记录

### 1 提方案

```bash
devflow new 2026-11-13-status-owed
devflow validate 2026-11-13-status-owed
devflow render 2026-11-13-status-owed
```

- `validate` 输出 `✓ 2026-11-13-status-owed 校验通过`，没有警告。
- `render` 输出内容哈希 `sha256:b3e41f592208…`，并提示可用审查台批准、用 `devflow wait` 等待。
- `change.yaml` 里写了 4 条 `summary` 和 2 个 `decisions`：

| 待拍板事项 | 选项 | 推荐 |
| --- | --- | --- |
| 文本输出里，待办写在哪里？ | 写在该行末尾 / 另起一行缩进显示 | 写在该行末尾 |
| 不需要人操作的变更，要不要也给出提示？ | 不显示任何内容 / 显示「Agent 进行中」 | 不显示任何内容 |

### 2 批准

- 人运行 `devflow review`，输出 `审查台已启动：http://127.0.0.1:<端口>/<令牌>/`，浏览器自动打开。这是第一次在真实终端里验证启动，成功。
- 人在审查台选好两项后点「批准此版本」。
- 后台的 `devflow wait` 输出 `2026-11-13-status-owed: approved — 已批准，可以开工` 后退出。
- `devflow resume` 显示了人的选择：

```text
2026-11-13-status-owed: approved — 已批准，可以开工
拍板：文本输出里，待办写在哪里？ → 写在该行末尾
拍板：不需要人操作的变更，要不要也给出提示？ → 显示「Agent 进行中」
下一步：devflow apply 2026-11-13-status-owed --start
```

- 第二项选的不是推荐项，批准事件的 `decisions` 字段如实记录了它。
- 批准记录带的内容哈希与 `render` 输出的一致。

### 3 实现

- `devflow apply 2026-11-13-status-owed --start` 输出 `✓ 已开工（基于 dceb7e1）`。
- 改动：
  - `src/status.ts` 新增并导出 `humanTodo()`。
  - `src/review.ts` 删除自己的 `owed()`，改用 `humanTodo()`。
  - `src/cli.ts` 的 `status` 分支：文本行尾追加 `← <待办>`，没有待办时追加 `← Agent 进行中`；`--json` 增加 `todo`。
  - `test/cli-feedback.test.ts` 新增 1 个测试，覆盖四种取值和已归档行。
  - `README.md` 命令表更新一行。
- 实施笔记 `execution.md` 记下了对第二项结论的处理：文本显示「Agent 进行中」，`--json` 的 `todo` 仍为 null。

### 4 验证

```bash
devflow verify 2026-11-13-status-owed --json
```

| 检查 | 命令 | 退出码 | 耗时 | 日志 |
| --- | --- | --- | --- | --- |
| unit-tests | `pnpm -s test` | 0 | 39.2 秒 | 132 项全部通过，含新测试 |
| typecheck | `pnpm -s typecheck` | 0 | 0.7 秒 | 空（被标为「没有任何输出」） |

结果 `pass`，运行编号 `676dc104-…`。

### 5 证据

| 验收 | 方式 | 证据内容 | 状态 |
| --- | --- | --- | --- |
| AC1 四种取值有单元测试 | 自动，unit-tests | 新测试里 4 处 `assert.equal(todo(), …)` | 有效 |
| AC2 类型检查通过，`owed` 已删除 | 自动，typecheck | `tsc` 退出码 0；`src/review.ts` 里搜不到 `owed` | 有效 |
| AC3 文本与 JSON 输出 | 自动，unit-tests | 新测试里对 `status --all` 与 `status --json` 的断言 | 有效 |
| AC4 在本仓库实际运行 | 人工 | 见下 | 人已确认 |

AC4 的实际输出（源码版 `node src/cli.ts status`）：

```text
2026-11-08-v2-agent-evaluation  draft  任务 0/4  尚未批准  ← 待你批准
2026-11-13-status-owed  applying  任务 0/2  开工后尚未验证  ← Agent 进行中
```

证据里写明了没验证到的部分：「待你确认」「待你归档」两种取值没有在本仓库实际出现，只有单元测试覆盖。

### 6 确认人工证据

- `devflow resume` 提示 `AC4: unconfirmed 等待人工确认`。
- 人在审查台点「确认人工证据（1 条）」，弹层里显示步骤、预期、实际，点「确认所选」。
- 后台的 `devflow wait` 随即退出。
- `devflow task done T2` 之后状态变为 `ready_to_archive  任务 2/2  验证通过，等待人工归档`。

### 7 归档

- `devflow wiki lint` 通过；本仓库知识页为空，没有可更新的页面。
- 人点审查台的「归档」按钮，没有反应（见问题 1）。
- 人改在终端运行 `devflow archive 2026-11-13-status-owed` 并输入 `y`，归档成功。
- 归档后核对：
  - `devflow status --all` 显示 `2026-11-13-status-owed  archived  2026-11-13 09:00 UTC`。
  - `.devflow/specs/devflow-cli/spec.md` 第 228 行起多了「status 显示轮到人的操作」这条需求。
  - 变更目录已移到 `archive`，含 `execution.md` 和完整的 `events.jsonl`（11 条事件）。

## 与旧流程对比

旧流程的数字来自 gz-north-second-ring 的 datasource-ledger 变更（2026-11-12）。两个变更规模不同，只比较人的操作方式。

| 人的操作 | 旧流程 | 这次 |
| --- | --- | --- |
| 批准 | 终端命令，每次批准一条；共 4 次（1 次失败） | 审查台点 1 次 |
| 回对话说"已批准" | 每次批准后都要说 | 不需要，`devflow wait` 自动接上 |
| 确认人工证据 | 终端命令，每条证据一条，带 36 位编号 | 审查台点 2 次 |
| 归档 | 终端命令 1 条 | 终端命令 1 条（按钮缺陷，已修） |
| 待拍板事项 | 埋在 design.md，没有作答 | 首屏单选，结论记入批准事件 |

这次没有覆盖到的新功能：重新批准时的差异面板与证据沿用（这次只批准了一次）、`code_roots`（本仓库是单仓库）。这两项只有单元测试和临时仓库里的页面实测。

## 发现的问题

| # | 问题 | 现象 | 状态 |
| --- | --- | --- | --- |
| 1 | 归档按钮没有反应 | 按钮依赖浏览器原生确认框，内嵌浏览器不弹，请求没发出去 | 已修：改成同一按钮点两次。在临时仓库实际点过，归档成功 |
| 2 | 轮到 Agent 时页面不说明 | 确认证据后页面显示「applying · 还有 1 个任务未完成或验收证据失效」，看不出是在等 Agent | 已修：显示「现在不需要你操作，等 Agent 继续」，并每 5 秒自动刷新。有测试 |
| 3 | 令牌会进入 Agent 的上下文 | 在对话框用 `!` 或应用内终端面板启动审查台时，带令牌的地址也被 Agent 看到 | 未修。Agent 这次没有使用它。要彻底避免，需在应用外的终端启动 |
| 4 | 空日志提醒有误报 | 类型检查成功时本来就没有输出，也被标为「没有任何输出」 | 未修。可以让检查在 project.yaml 里声明"成功时无输出是正常的" |
| 5 | 选了非推荐项后方案文字对不上 | 规范正文按推荐项写的是"不输出待办"，人选了「显示 Agent 进行中」 | 未修。这次靠实施笔记说明；归档进规范的文字没有体现这个选择 |
| 6 | 批准后到开工隔了 3 分半 | 08:42:03 批准，08:45:35 开工，期间人问了一句"怎么没有继续" | 原因未完全确定。`devflow wait` 每 2 秒查一次；其余是 Agent 侧的响应，其中一条命令被命令改写钩子拒绝后重发 |

问题 1、2 的修复在变更归档之后做，没有走 devflow 变更。

## 当前状态

- 全量测试 132 项通过，类型检查通过。
- 已重新打包并全局安装，安装版包含本次功能和问题 1、2 的修复。
- 正在运行的两个审查台是旧进程，要重启才有新按钮。
- 所有改动都没有提交，包括这次归档产生的 `.devflow/changes/archive/2026-11-13-status-owed/`、`.devflow/reviews/` 和规范文件的变化。

## 验收时可以核对的地方

- 批准记录与拍板结论：`.devflow/changes/archive/2026-11-13-status-owed/events.jsonl` 第 1 行。
- 方案原文：同目录下的 `change.yaml`、`proposal.md`、`design.md`、`tasks.yaml`、`specs/devflow-cli/spec.md`。
- 合并后的规范：`.devflow/specs/devflow-cli/spec.md` 第 228 行起。
- 功能本身：运行 `devflow status`，未批准的变更行尾应显示 `← 待你批准`。
- 归档按钮：重启 `devflow review` 后，在下一个待归档的变更上点两次。
