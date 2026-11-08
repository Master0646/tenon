# 真实 Agent 对照首轮报告

- 协议：agent-workflow-v1；模型 claude-sonnet-5-5；基线 7b03749，候选 f99edf1
- 计划 30 个样本，实际 30 个；累计花费 unknown
- 结论：**inconclusive**（存在 unknown 样本，不能宣称改进或回退；统计显著性 not-established）
- 人工介入：unknown（无人值守）；token：unknown；工程验收通过不代表真实收益
- 执行方式：桌面端 Sonnet 子 Agent（claude -p 无法认证）；花费、token 计入用户套餐，记为 unknown
- unknown 中 error_no_answer 表示子 Agent 未写 answer.md：只读规则"不要修改任何文件"与"写入 answer.md"冲突，属运行器提示缺陷，两版本同样受影响
- 两版本使用相同 v1 夹具，候选新增的 v2 证据流程未被触发；omitted-permission 中 Agent 均自行按 spec 补上非管理员分支，本夹具未能区分版本

| 任务 | 版本 | 样本 | 通过 | 失败 | unknown | 漏检 | 误拦 | 中位轮数 | 中位耗时 s | 中位花费 $ | 权限拒绝 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wrong-config | baseline | 5 | 5 | 0 | 0 | 0 | 0 | 7 | 52 | unknown | 0 |
| wrong-config | candidate | 5 | 3 | 0 | 2 | 0 | 0 | 6 | 51 | unknown | 0 |
| omitted-permission | baseline | 5 | 5 | 0 | 0 | 0 | 0 | 7 | 56 | unknown | 0 |
| omitted-permission | candidate | 5 | 5 | 0 | 0 | 0 | 0 | 7 | 55 | unknown | 0 |
| new-session-resume | baseline | 5 | 2 | 0 | 3 | 0 | 0 | 6 | 36 | unknown | 0 |
| new-session-resume | candidate | 5 | 4 | 0 | 1 | 0 | 0 | 6 | 39 | unknown | 0 |

## 失败与 unknown 明细

- 17-new-session-resume-baseline-r3（unknown）：Agent 被截断：error_no_answer；原始记录 raw/17-new-session-resume-baseline-r3.json sha256:58081c12393f…
- 14-wrong-config-candidate-r3（unknown）：Agent 被截断：error_no_answer；原始记录 raw/14-wrong-config-candidate-r3.json sha256:e589cda2053e…
- 24-new-session-resume-baseline-r4（unknown）：Agent 被截断：error_no_answer；原始记录 raw/24-new-session-resume-baseline-r4.json sha256:94f89b7dbb0a…
- 23-new-session-resume-candidate-r4（unknown）：Agent 被截断：error_no_answer；原始记录 raw/23-new-session-resume-candidate-r4.json sha256:ac35066ad772…
- 29-new-session-resume-baseline-r5（unknown）：Agent 被截断：error_no_answer；原始记录 raw/29-new-session-resume-baseline-r5.json sha256:62110ebced78…
- 26-wrong-config-candidate-r5（unknown）：Agent 被截断：error_no_answer；原始记录 raw/26-wrong-config-candidate-r5.json sha256:901c2ca36e37…
