# 设计

## #33 重叠路径

`checkStagedCode`（src/check.ts:107）现在逐个变更判断。改为两遍：

```flow TB
(开始) -> 第一遍收集已开工变更的 affected_paths
第一遍收集已开工变更的 affected_paths -> 第二遍处理未开工变更
第二遍处理未开工变更 -> {暂存文件被已开工变更覆盖?}
{暂存文件被已开工变更覆盖?} -> 跳过: 是
{暂存文件被已开工变更覆盖?} -> 计入未开工警告: 否
```

- 覆盖判断复用 `stagedFiles(root, globs)`（src/check.ts），与"超出影响路径"警告用同一套 glob 匹配。
- 未开工变更剩余文件为空时不报。

## #35 draft 行

- am 在失败时打印 `  draft: <路径>`（vendor/answer-me-with-html/am.mjs:13240）。
- `reviewIssues` 拼接提示的循环（src/render.ts:296）跳过 `draft:` 开头的行。

## #36 哈希提示

src/cli.ts:189 的错误改为：

- 消息：`--hash 与当前内容哈希不一致，未批准`
- 提示：`可能是审查后被审文件又被修改，或命令没有复制完整；重新运行 devflow render <id>，从新页面复制命令`
