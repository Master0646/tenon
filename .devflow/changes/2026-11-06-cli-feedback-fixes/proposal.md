# CLI 体验修复（体验反馈第 2 批）

## 为什么

- #1：两次以为批准了，状态仍是 draft；取消提示只有"已取消"，不醒目。
- #7：只运行 `devflow init`，Claude Code 与 Codex 两套文件都装上了。
- #8：`project.yaml` 在批准范围内，审查页却只显示它的哈希，看不到验证命令。
- #17：`devflow status` 看不到已归档的变更。
- #23：`validate` 通过，`render` 却因图语法失败，来回改了 3 次。
- #28：从没扫描过知识页，`wiki lint` 仍报"0 个知识页校验通过"，没有提醒。

## 改什么

- `approve` 取消时说明"未批准"和当前状态；成功时给出下一步。
- `init` 不带 `--agents` 时，只装项目里检测到的 Agent；都检测不到才两个都装。
- 审查页 E 面板增加验证命令表。
- 新增 `devflow status --all`，同时列出已归档的变更。
- `validate` 报出 `render` 会拒绝的所有写法，包括图语法错误，并定位到源文件行号。
- 知识页为空时，`wiki lint` 与 `doctor` 给出 warn。
- propose 技能、手册、README 同步更新。

## 影响

- `init` 默认行为变化：已有 `.claude/` 的项目不再生成 Codex 文件。
- `validate` 多一次 am 子进程调用，约增加 1 秒以内。

## 不做什么

- 不改 `check`：门禁不跑图语法检查，也不提醒空知识页（避免每次提交都提醒）。
- 不改批准方式本身（仍须在交互终端输入 y）。
- 不改 am（vendor）。
