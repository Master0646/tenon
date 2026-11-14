# 设计

## 多仓库路径

现状：

- `validate` 拒绝含 `..` 的影响路径（`src/validate.ts:176`）。
- 派生状态只在本仓库比对基线之后的提交（`src/status.ts:69`）。
- 批准事件只有一个 `base_commit`（`src/status.ts:114`）。

```flow LR
change.yaml 的 affected_paths -> {以某个 code_root 开头?}
{以某个 code_root 开头?} -> 归到该仓库，去掉前缀后作为 glob: 是
{以某个 code_root 开头?} -> 归到本仓库: 否
归到该仓库，去掉前缀后作为 glob -> 按仓库比对基线之后的提交
归到本仓库 -> 按仓库比对基线之后的提交
```

- 新函数 `splitPaths(root, globs)`：返回 `{ 仓库相对路径 → glob 列表 }`，本仓库的键为 `.`。
- `validate`：含 `..` 的路径必须以某个 `code_roots` 项加 `/` 开头，否则报错；其余规则不变。
- 批准事件新增 `base_commits`：键是 `code_roots` 项，值是该仓库当时的 HEAD。没有提交的仓库拒绝批准。
- 派生状态：对每个仓库调用现有的 `changedPaths`；任一仓库有改动即 `rebase_required`，原因里带上仓库前缀。

## 代码仓库的提交门禁

现状：`init` 只给 devflow 所在的仓库装钩子（`src/init.ts:64`），钩子运行 `check --staged`。

```flow LR
代码仓库的 pre-commit -> devflow check --staged --project <devflow 仓库>
devflow check --staged --project <devflow 仓库> -> 读 devflow 仓库里进行中的变更
读 devflow 仓库里进行中的变更 -> 取出属于当前仓库的影响路径
取出属于当前仓库的影响路径 -> 与当前仓库的暂存文件比对
```

- 钩子内容：`exec <node> <cli> check --staged --project <devflow 仓库的绝对路径>`，带 `# devflow-hook` 标记。
- `check` 带 `--project` 时，当前目录是代码仓库：
  - 只运行暂存代码检查（`src/check.ts` 的 `checkStagedCode`），不检查规范锁与事件日志。
  - 影响路径用 `splitPaths` 取出属于当前仓库的那部分。
  - 当前目录不是该项目 `code_roots` 里的仓库时报错。
- 规则与本仓库一致，共两条：

| 情况 | 结果 |
| --- | --- |
| 暂存了某个未开工变更影响路径内的文件 | `enforce: warn` 时警告，`strict` 时拒绝提交 |
| 有已开工的变更，暂存了不在任何进行中变更影响路径内的文件 | 警告 |

- "事件日志未暂存"那条规则不适用：事件日志不在代码仓库里。
- 安装时机：`devflow init`（可重复运行）。`code_roots` 是后来才加的，就再运行一次 `init`。
- 已有不带标记的钩子：不覆盖，输出要手工加的那一行，与现有做法相同（`src/init.ts:68`）。
- `devflow doctor`：逐个代码仓库报告钩子缺失、被别的钩子占用，或指向的文件不存在。
- 钩子里写的是 devflow 仓库的绝对路径：仓库挪了位置要重新 `init`，`doctor` 会报出来。

## 证据文件位置

- 现状：`safeFile` 只接受本仓库内的相对路径（`src/evidence.ts:28`）。
- 改法：路径以某个 `code_roots` 项开头时，按该仓库根做同样的越界、符号链接、大小检查。
- 附件仍复制进本仓库的 `.devflow/evidence/`，校验方式不变。

## 自动证据核对

```sequence
Agent -> devflow: evidence add（带 log_quote）
devflow -> 验证日志: 读取该次运行、该检查的日志
devflow -> devflow: 日志哈希等于 verified 事件里的 log_hash?
devflow -> devflow: 日志包含 log_quote?
devflow --> Agent: 记录成功，quote_checked 为 true
```

- `log_quote`：单行，最长 300 字节。
- 日志路径由 `verified` 事件的时间戳定位，核对前先比对 `log_hash`（`src/exec.ts:107`），防止日志被改。
- 日志已丢失或哈希不符：拒绝带 `log_quote` 的记录，提示重新 verify。
- 验收矩阵新增一列：`已核对` / `未核对` / `—`（人工项）。
- 技能模板要求：能引用日志的自动证据都带 `log_quote`，优先引用测试名那一行。

## 停滞提醒

| 条件 | 显示 |
| --- | --- |
| 状态为 approved、applying、needs_fix，且最后一条事件早于阈值 | `status` 行尾追加「· 停滞 N 天」或「N 小时」；审查台首页「最后活动」变为琥珀色 |
| 其他 | 不变 |

- 阈值：`project.yaml` 的 `stale_hours`，正数，默认 24；`validate` 校验它是正数。
- 最后一条事件的时间已经在审查台首页读取（`src/review.ts:94`），`status` 复用同一个函数。

## 使用手册

- 第 2、3 步合并为「在审查台审查并批准」，终端批准作为备选。
- 第 5 步的人工确认、第 8 步的归档改为审查台为主。
- 新增小节：`devflow wait`、`code_roots`、重新批准后的证据沿用、`summary` 与 `decisions`。
- `docs/使用手册.html` 用 `npm run docs:html` 重新生成。

## 已拍板

| 事项 | 结论 |
| --- | --- |
| 兄弟仓库路径的写法 | 沿用 `code_roots` 的相对写法 |
| 没有日志引文的自动证据 | 允许记录，标为未核对 |
| 兄弟仓库的提交钩子 | 这次一起做 |
| 停滞阈值 | 在 `project.yaml` 里可配置 |

## 风险

- 往别的仓库写钩子：只在 `code_roots` 明确声明的仓库里写，且不覆盖已有钩子。

- 每个代码仓库多一次 `git diff`：只在未开工的已批准变更上发生。
- 旧的批准事件没有 `base_commits`：兄弟仓库的检测从下一次批准开始生效。
