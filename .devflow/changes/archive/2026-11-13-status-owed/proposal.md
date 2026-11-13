# 提案

## 为什么

- 审查台首页有「轮到你」一列，终端里的 `devflow status` 没有，只能从状态和原因自己推断。
- gz-north-second-ring 的 access-channel 变更停在 `applying` 一天多，`status` 没有提示是在等人还是等 Agent。

## 改什么

- `devflow status` 文本输出：需要人操作的行标出待办。
- `devflow status --json`：每个进行中的变更增加 `todo` 字段。
- 审查台首页改用同一个函数，不再自己判断。

## 影响

- `status` 文本输出的行尾可能多出一段文字；按空格切分前几列的脚本不受影响。
- `--json` 只增加字段，不改已有字段。

## 不做什么

- 不改派生状态的规则。
- 不给已归档的变更加待办。
- 不做「停滞多久」的提醒。
