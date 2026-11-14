# review-workbench

## Purpose

本地审查台（`devflow review`）：人在浏览器里审查变更、批注、批准、确认证据与归档。

## Requirements

### Requirement: 选中文字批注
审查台的变更页 SHALL 允许人选中同一面板内的任意文字并附上意见；未发送的批注 MUST 在页面刷新后保留。

#### Scenario: 添加批注
- WHEN 人在设计面板选中一句话，点「批注」，输入意见并保存
- THEN 操作栏显示「发送批注（1 条）」

#### Scenario: 选区跨面板
- WHEN 选区从提案面板开始、在设计面板结束
- THEN 不出现「批注」按钮

#### Scenario: 有未发送的批注
- WHEN 页面处于等待 Agent 的状态，且有 1 条未发送的批注
- THEN 页面不自动刷新

### Requirement: 批注直接送达等待中的 Agent
人发送批注后，对该变更运行中的 `devflow wait` SHALL 退出并打印每条批注引用的原文与意见；没有 Agent 等待时，批注 MUST 保留到下一次 `devflow wait`。

#### Scenario: Agent 正在等待
- WHEN `devflow wait <id>` 在运行，人发送 2 条批注
- THEN `devflow wait` 以退出码 0 结束，输出 2 条批注的面板、原文与意见

#### Scenario: 没有 Agent 在等待
- WHEN 人发送批注时没有 `devflow wait` 在运行，之后 Agent 运行 `devflow wait <id>`
- THEN 该命令立即返回并打印这些批注

#### Scenario: 不重复送达
- WHEN 批注已被一次 `devflow wait` 打印过
- THEN 之后的 `devflow wait` 不再打印它

#### Scenario: 无效批注
- WHEN 提交的批注为空、单条意见超过 2000 字节或超过 50 条
- THEN 审查台拒绝，不落盘

### Requirement: 审查台只有一种意见入口
审查台的变更页 SHALL 只提供「批注」一种提意见的方式：渲染器自带的「回复」、标注模式与面板评论框 MUST 隐藏；每个面板 MUST 提供对整个面板写批注的按钮。

#### Scenario: 对整个面板批注
- WHEN 人点设计面板标题旁的「批注」，输入意见并保存
- THEN 待发送列表多一条，面板为设计面板，引用原文为「整个面板」

#### Scenario: 没有回复按钮
- WHEN 人在审查台打开变更页
- THEN 页面上看不到「回复」按钮

### Requirement: 验收矩阵只显示人关心的内容
验收矩阵 SHALL 显示验收条件、中文状态、依据与说明四列；MUST NOT 显示证据 ID 与代码版本哈希。

#### Scenario: 自动项已核对日志
- WHEN 一条自动证据带有已核对的日志原文
- THEN 依据列显示测试文件与该日志原文，并标明已核对

#### Scenario: 人工项待确认
- WHEN 一条人工证据已记录、未确认
- THEN 状态列显示「待你确认」，依据列显示实际观察

### Requirement: 显示是否有 Agent 在等待
审查台的变更页 SHALL 显示当前是否有 `devflow wait` 在等待该变更。

#### Scenario: 正在等待
- WHEN `devflow wait <id>` 在运行
- THEN 操作栏显示「Agent 正在等待」

#### Scenario: 等待进程已退出
- WHEN `devflow wait` 被杀掉、等待标记残留
- THEN 操作栏显示没有 Agent 在等待

### Requirement: 首页显示工作节点
审查台首页 SHALL 为每个进行中的变更显示它所处的工作节点；需要人操作的节点 MUST 与 Agent 正在做的节点在样式上区分。

#### Scenario: Agent 实现中
- WHEN 变更已开工，5 个任务完成了 2 个，还没有验证
- THEN 工作节点显示「实现中（任务 2/5）」

#### Scenario: 验证通过但缺证据
- WHEN 最近一次验证通过且之后代码没变，但还有任务的验收证据缺失或失效
- THEN 工作节点显示「补证据中」

#### Scenario: 轮到人确认
- WHEN 变更有 2 条已记录、未确认的人工证据
- THEN 工作节点显示「待你确认 2 条」，并按需要人操作的样式高亮

#### Scenario: 验证通过、知识页待更新
- WHEN 变更验证通过，但知识页检查（wiki lint）有错误
- THEN 工作节点显示「归档准备中」；检查没有错误时显示「待你归档」

### Requirement: 查看已归档的变更
审查台首页 SHALL 列出已归档的变更，最新归档的在前；每个已归档变更 MUST 有一个只读页，页面上没有批准、确认、归档或批注的入口。

#### Scenario: 打开已归档变更
- WHEN 人在首页「已归档」列表点一个变更
- THEN 打开该变更的只读页，显示它的方案与拍板结论

#### Scenario: 只读页没有操作
- WHEN 人打开已归档变更的只读页
- THEN 页面上没有任何操作按钮，向该变更提交的批准、确认、归档请求被拒绝

### Requirement: 状态变化先提示再刷新
审查台的首页和变更页 MUST NOT 定时整页刷新；页面 SHALL 在后台查询状态，状态变化时显示「有新进展，点此刷新」，由人点击后才刷新。

#### Scenario: Agent 推进了变更
- WHEN 人正停在变更页中间，Agent 完成一个任务
- THEN 5 秒内页面出现「有新进展，点此刷新」，滚动位置不变

#### Scenario: 状态没变
- WHEN 状态和被审内容都没有变化
- THEN 页面不出现提示，也不刷新

### Requirement: 刷新后恢复视图
审查台变更页刷新后 SHALL 恢复刷新前的滚动位置和展开的面板。

#### Scenario: 展开设计面板后刷新
- WHEN 人展开设计面板、滚动到中间，然后点「有新进展，点此刷新」
- THEN 刷新后设计面板仍是展开的，页面停在原来的位置附近

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
