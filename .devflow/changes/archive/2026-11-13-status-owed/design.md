# 设计

## 现状

- 审查台首页的待办由 `owed()` 计算，定义在 `src/review.ts:26`，没有导出。
- `devflow status` 的输出在 `src/cli.ts` 的 `case 'status'` 分支，逐行打印 `id 状态 任务 原因`。

## 改法

```flow LR
status.ts#humanTodo -> cli.ts status 分支: 文本与 JSON
status.ts#humanTodo -> review.ts 首页: 轮到你一列
status.ts#humanTodo -> review.ts 操作栏: 待确认证据数量
```

- 把 `owed()` 移到 `src/status.ts`，改名 `humanTodo(root, id, status)` 并导出。
- 待确认证据的数量直接取验收矩阵中 `unconfirmed` 的行数。
- `review.ts` 删除自己的 `owed()`，改为调用 `humanTodo`。

## 待办的取值

| 派生状态 | 条件 | todo |
| --- | --- | --- |
| draft、rebase_required | 无 | 待你批准 |
| applying、needs_fix | 有 N 条未确认的人工证据 | 待你确认 N 条人工证据 |
| ready_to_archive | 无 | 待你归档 |
| 其他 | 无 | null |

## 输出格式

- 文本：`<id>  <状态>  任务 a/b  <原因>`，有待办时在末尾追加两个空格和 `← <todo>`。
- JSON：进行中的变更对象增加 `todo`，字符串或 null；已归档的对象不变。

## 风险

- 读取验收矩阵要算一次代码哈希。`status` 本来就为每个变更算过，新增开销是每个 `applying` 变更多算一次。
