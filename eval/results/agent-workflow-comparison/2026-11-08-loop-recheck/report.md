# 真实 Agent 对照首轮报告

- 协议：agent-workflow-v1；模型 claude-sonnet-5-5；基线 7b03749，候选 f99edf1
- 计划 10 个样本，实际 10 个；累计花费 unknown
- 结论：**inconclusive**（存在 unknown 样本，不能宣称改进或回退；统计显著性 not-established）
- 人工介入：unknown（无人值守）；token：unknown；工程验收通过不代表真实收益
- 闭环演示对照：两组均为候选 DevFlow，baseline 用旧只读规则「只能读文件、运行只读命令，不要修改任何文件。」，candidate 用修复后规则「只能读文件、运行只读命令，不要修改项目内的任何文件；最后写入 answer.md 不算修改项目，必须写。」
- 执行方式：桌面端 Sonnet 子 Agent（claude -p 无法认证）；花费、token 计入用户套餐，记为 unknown
- unknown 中 error_no_answer 表示子 Agent 未写 answer.md：只读规则"不要修改任何文件"与"写入 answer.md"冲突，属运行器提示缺陷，两版本同样受影响
- 两版本使用相同 v1 夹具，候选新增的 v2 证据流程未被触发；omitted-permission 中 Agent 均自行按 spec 补上非管理员分支，本夹具未能区分版本

| 任务 | 版本 | 样本 | 通过 | 失败 | unknown | 漏检 | 误拦 | 中位轮数 | 中位耗时 s | 中位花费 $ | 权限拒绝 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| new-session-resume | baseline | 5 | 3 | 0 | 2 | 0 | 0 | 5 | 40 | unknown | 0 |
| new-session-resume | candidate | 5 | 5 | 0 | 0 | 0 | 0 | 6 | 41 | unknown | 0 |

## 失败与 unknown 明细

- 08-new-session-resume-baseline-r4（unknown）：Agent 被截断：error_no_answer；原始记录 raw/08-new-session-resume-baseline-r4.json sha256:93c2235326f6…
- 04-new-session-resume-baseline-r2（unknown）：Agent 被截断：error_no_answer；原始记录 raw/04-new-session-resume-baseline-r2.json sha256:5273d857860f…
