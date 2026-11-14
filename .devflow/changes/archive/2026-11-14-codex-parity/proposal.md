# 提案

## 为什么

- Tenon 要同时支持 Claude Code 和 Codex，但 Codex 一侧从没被端到端测过。
- 在 Codex 默认沙箱里 `tenon status`、`tenon resume` 直接崩溃，主流程走不通（codex-cli 0.154.0 实测）。
- Codex 的防线比 Claude 弱：没有文件编辑防线，命令规则换个写法就绕过，交互终端检查也能绕过。
- 技能里有只适用于 Claude Code 的指令：后台等待、用 Read 读文件。

## 改什么

- tenon 自身不再向 `.git/` 写文件：工作树哈希用临时对象目录计算，工作树锁移到数据目录的 `runtime/`。
- 新增 `tenon guard` 子命令，作为 Codex 的 PreToolUse 钩子；`init` / `update` 为 Codex 生成 `.codex/hooks.json`。
- 人专属命令（approve、archive、evidence confirm、review）检测到 Agent 环境变量时拒绝。
- 技能与入口说明给出前台等待的做法，去掉 Claude 专属的读文件要求。
- `doctor` 检查防线文件：Claude 的 deny 规则，Codex 的 rules 与 hooks。
- README 与使用手册更新 Agent 对比和安全说明。

## 影响

- 工作树哈希值不变，已有的批准、验证、证据记录继续有效。
- Codex 用户升级后要运行一次 `tenon update`，并在 Codex 的 `/hooks` 里确认新钩子。
- 从 Agent 应用内置终端运行人专属命令的人可能被误拒（见待拍板事项）。
- 新旧版本 CLI 的锁文件位置不同，升级期间两者不互斥。

## 不做什么

- 不写 Codex 评测脚本（`codex exec` 版的 eval），只加单元测试和一次真实会话的人工验收。
- 不改 Claude Code 的 deny 规则。
- 不让 `tenon update` 在沙箱里运行：`.codex/`、`.agents/` 在沙箱里只读，它本来就该由人运行。
- 不拦截用 shell 重定向改写 `specs/` 的做法；这一层仍由 `tenon check` 把关。
