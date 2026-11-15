# 实施笔记

- 拍板"页面样式 → 另写一套仿 Stripe 文档的样式"与 design.md 的"复用审查页渲染器"不同，按拍板实现：仍用随包的 am 解析 Markdown 和图，但装入 Tenon 自带的 `stripe` 主题（`src/requirement.ts#STRIPE_THEME`，`am theme check` 0 错误 0 警告），页面默认使用它；不注入审查页的折叠脚本。
- 拍板"读 docx → 只用 officecli"：tenon-intake 技能没有 officecli 时停下请用户安装，不写 pandoc 兜底。
- 经用户同意，改了 affected_paths 之外的文件：`test/tenon-rename.test.ts`（写死的技能列表加 tenon-intake）；在本仓库运行 `node src/cli.ts update`，刷新 `.claude/skills/`、`.agents/skills/`、`CLAUDE.md`、`AGENTS.md` 托管段，保持与模板一致。
- `docs/使用手册.html` 未重新生成。
