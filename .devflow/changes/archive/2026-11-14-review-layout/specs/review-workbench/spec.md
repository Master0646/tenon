## ADDED Requirements

### Requirement: 变更页目录
审查台变更页 SHALL 提供一直可见的目录，列出每个面板和它的状态；点击目录项 MUST 展开该面板并滚动到它。

#### Scenario: 跳到折叠的面板
- WHEN 设计面板处于折叠状态，人点目录里的「C 设计」
- THEN 设计面板展开，页面滚动到它的标题

#### Scenario: 面板状态
- WHEN 重新批准时 design.md 没有改动
- THEN 目录里「C 设计」旁显示「与上次批准相同」

### Requirement: 操作栏固定在顶部
审查台变更页的操作栏 SHALL 固定在页面顶部，滚动到任何位置都可见。

#### Scenario: 滚动到底部
- WHEN 人滚动到被审文件面板
- THEN 顶部仍能看到批准按钮和 Agent 等待状态

### Requirement: 首屏显示进展与待办
审查页首屏 SHALL 只显示当前进度与工作节点、需要人做的事，以及待拍板事项。

#### Scenario: 实现中
- WHEN 变更处于「实现中（任务 2/5）」
- THEN 首屏的进度条停在「实现」一段，并写明现在不需要你操作

#### Scenario: 待你批准
- WHEN 变更待批准且有 2 个待拍板事项
- THEN 首屏写明「选好 2 个待拍板事项后点批准」，并显示这 2 个事项

### Requirement: 变更页显示批注记录
审查台变更页 SHALL 列出这个变更已发送的全部批注，每条标明是否已被 Agent 读取；批注内容 MUST 按纯文本显示。

#### Scenario: Agent 读过一次
- WHEN 人发过两次批注，第一次已被 `devflow wait` 读取
- THEN 批注记录里第一次的各条标为「Agent 已读」，第二次的标为「未读」

#### Scenario: 批注里有 HTML
- WHEN 某条批注的意见里写了 `<script>`
- THEN 记录里原样显示这段文字，不被当作页面代码执行
