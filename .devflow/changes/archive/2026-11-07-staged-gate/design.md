# 设计

只改 `src/check.ts`。现状：`appendOnly`（`src/check.ts:38`）与 `checkSpecLock`（`src/check.ts:54`）读工作树；`checkStagedCode`（`src/check.ts:79`）只管"未开工"。

```flow LR
check --staged -> {staged?}
{staged?} -> 读暂存区: 是
{staged?} -> 读工作树: 否
读暂存区 -> checkSpecLock
读暂存区 -> appendOnly
check --staged -> checkStagedCode
checkStagedCode -> 未开工警告
checkStagedCode -> 记录未暂存警告
checkStagedCode -> 超出影响路径警告
```

## #16 读暂存区

- 新增一个读取源：`staged` 时列文件用 `git ls-files -z --cached -- <dir>`，读内容用 `git show :<path>`；否则沿用 `repoFiles`（`src/core.ts:69`）与 `readFileSync`。
- `checkSpecLock(root, staged)`：specs.lock 本身、文件列表、内容哈希都走该读取源。
- `appendOnly(root, rel, staged)`：当前内容取暂存区版本；暂存区没有该文件时视为空。
- `sha256` 接受字符串，`git show` 输出按 UTF-8 读取；规范文件都是文本，与按字节哈希结果一致。

## #29 变更记录未暂存

- 在 `checkStagedCode` 的循环里，状态属于 `STARTED`（`src/check.ts:12`）时：比较 events.jsonl 的暂存区版本与工作树版本（暂存区没有视为空）。
- 不一致：warn，消息"变更 <id> 的记录未暂存：批准与验证记录（events.jsonl）不会随这次提交进入仓库"，hint `git add .devflow/changes/<id>`。

## #30 超出影响路径

- 收集所有进行中变更的 affected_paths；至少一个变更状态属于 `STARTED` 才检查。
- 全部已暂存文件：`git diff --cached --name-only --diff-filter=d`；被覆盖的：同一命令加上所有 glob 的 `:(glob)` pathspec。
- 差集再去掉 `.devflow/` 下的文件，非空则 warn，列出前 5 个，hint"确认这些文件应该随本次提交；属于本变更的话，下次在 change.yaml 的 affected_paths 中写上"。

## 文档

- 使用手册第 10 节的规则表补三行，并说明 `--staged` 以暂存区为准。
- 删除 `src/check.ts:2` 的 shortcut 注释。
