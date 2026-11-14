# 设计

## 工作节点

新函数 `workNode(root, id, st)`（`src/status.ts`）返回 `{ label, human }`。它和 `humanTodo` 放在一起（`src/status.ts:101`），`humanTodo` 本身不改，`devflow status` 继续用它。

```flow TB
(派生状态) -> {有未确认的人工证据?}
{有未确认的人工证据?} -> 待你确认 N 条: 是
{有未确认的人工证据?} -> {状态}: 否
{状态} -> {validate 有错误?}: draft
{validate 有错误?} -> 写方案中: 是
{validate 有错误?} -> 待你批准: 否
{状态} -> 待你批准: rebase_required
{状态} -> 待开工: approved
{状态} -> {applying 的原因}: applying
{applying 的原因} -> 实现中 任务 x/y: 未验证，或验证后代码有改动且任务没做完
{applying 的原因} -> 待重新验证: 验证后代码有改动，任务都做完了
{applying 的原因} -> 补证据中: 验证通过、代码没变，任务证据缺失或失效
{状态} -> 修复中: needs_fix
{状态} -> {wiki lint 有错误?}: ready_to_archive
{wiki lint 有错误?} -> 归档准备中: 是
{wiki lint 有错误?} -> 待你归档: 否
```

- applying 有三种原因，现在只写在 `reason` 文字里（`src/status.ts:84`–`87`）。`ChangeStatus` 加一个可选字段 `stage`（`unverified` / `code-changed` / `tasks-left`），由 `deriveStatus` 在这三个分支里填。不按文字匹配。
- 「修复中/待重新验证」是同一个节点，按上面的条件显示其中一个词。
- 知识页检查用现有的 `lintWiki`（`src/wiki.ts:45`），只看 `level: 'error'`。
- 首页表头改为「变更 · 工作节点 · 任务 · 最后活动」（按拍板结果决定是否保留「状态」列）。`human` 为真的节点用现在 `.todo` 的高亮样式（`src/review.ts:81`），其余用灰色。原因文字放在节点下方。
- 排序不变：需要人操作的排在前面（`src/review.ts:100`）。

## 已归档列表与只读页

- 首页表格下方加「已归档（N）」，数据来自现有的 `listArchived`（`src/status.ts:15`），按归档时间倒序。用 `<details>` 折叠，默认收起。
- 只读页地址为 `/<令牌>/a/<id>`。`id` 必须满足 `CHANGE_ID`，并且是 `listArchived` 里有的。
- 新函数 `renderArchived(root, id)`（`src/render.ts`）从 `changes/archive/<id>/` 读文件，组成页面草稿：
  - 概要：标题、方案要点、归档时间、拍板结论（取归档目录里事件日志最后一次 `approved` 的 `decisions`，没作答的按推荐项）。
  - A 提案、B 规范增量、C 设计、D 任务：复用 `toPanelBody`、`formatRequirement` 和任务卡片的写法。
  - 事件时间线：每条事件一行，写时间、类型、操作人。
- 只读页不加操作栏、批注脚本和状态轮询。`/a/` 下的 POST 一律返回 404。

## 先提示再刷新

```sequence
页面 -> 审查台: GET /令牌/c/id/state（每 5 秒）
审查台 --> 页面: 版本号 v 与 waiting
页面 -> 页面: v 与打开时不同则显示提示条
人 -> 页面: 点「有新进展，点此刷新」
页面 -> 页面: 记下滚动位置和展开的面板，刷新
```

- 新增两个只读接口：`GET /<令牌>/state`（首页）和 `GET /<令牌>/c/<id>/state`（变更页），返回 `{ v, waiting }`。
  - 首页的 `v` 是首页各行（id、节点、原因、任务数、最后一条事件时间）和已归档 id 列表的 sha256。
  - 变更页的 `v` 是状态、原因、节点、任务数、最后一条事件时间和被审内容哈希的 sha256。被审文件改了也会提示。
  - `waiting` 不进 `v`：等待进程起停很频繁。页面直接用它更新「Agent 正在等待」那行字。这也修掉了「发送后要刷新才变」的已知问题。
- 页面打开时 `v` 写在 `data-v` 上。去掉首页的 `<meta http-equiv="refresh">`（`src/review.ts:55`）和变更页的定时 `location.reload()`（`src/review.ts:198`）。
- 提示条出现后停止轮询。有未发送批注或对话框开着时（`dfHold`），点提示条只给出说明，不刷新。
- 恢复视图：每次刷新前，把滚动位置和已展开面板的 id 写进 `sessionStorage`，键为 `df-view:<路径>`。包括批准、确认之后的 `location.reload()`。页面加载后，在折叠脚本之后读出并恢复，然后删掉这个键。
- 新脚本仍按 `decorate` 的方式登记哈希进内容安全策略（`src/render.ts:413`）。
