# 需求转换环节

## 为什么

- 北二环项目两轮实践里，每个功能开工前都先把详设章节转成 md 和 html：人读 html 理解需求，Agent 读 md 写方案。
- 这一步现在靠临时会话手工完成，规则（修订痕迹、示意标记、图片）只存在聊天记录里，下次容易漏。
- Agent 直接读 docx 很费劲，而且会漏掉 WPS 修订：那次有 214 处删除，只读正文看不到。
- 变更和需求之间没有关联：审批人看不到方案依据的是哪份需求，需求改了方案也不会失效。

## 改什么

- 新增技能 `tenon-intake`：按用户指定的章节读 docx，产出 `requirement.md`（正文用接受修订后的版本）和 `revisions.md`（被删的内容）。
- 新增命令 `tenon req render <目录>`：把需求 md 渲染成离线 html。
- `change.yaml` 新增可选字段 `requirement`，validate 检查它，批准哈希包含它指向的文件。
- `tenon-propose` 技能：有需求 md 时以它为准，只在含糊处回查原文，并在 design.md 注明查了哪一节。

## 影响

- 已有变更不受影响：`requirement` 是可选字段，不写时行为不变。
- `tenon init` / `tenon update` 会多生成一个技能文件（Claude 和 Codex 各一份）。
- 入口说明（CLAUDE.md / AGENTS.md 的托管段）的技能列表多一项。

## 不做什么

- tenon 不解析 docx，不判断修订该接受还是拒绝。
- 不做需求与验收条件的逐条追溯。
- 不在审查台里显示需求页面；审查页只在被审文件列表里列出需求 md。
- 不嵌入原文图片：md 里写"见原文图 N"。
