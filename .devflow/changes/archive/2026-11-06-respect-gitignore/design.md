# 设计

## 现状

```flow LR
check -> listFiles
reviewedFiles -> listFiles
validate -> listFiles
wiki lint -> listFiles
listFiles -> 磁盘上的全部文件
```

`listFiles(dir)` 用 `readdirSync` 递归列出目录下的所有文件，不知道 git 的忽略规则。

## 方案

在 `core.ts` 新增 `repoFiles(root, relDir)`：

```text
git ls-files -z --cached --others --exclude-standard -- <relDir>
```

- `--cached`：已跟踪的文件（即使后来被加入忽略规则，也照常参与）；
- `--others --exclude-standard`：未跟踪、且没有被 `.gitignore` / `.git/info/exclude` / 全局忽略规则忽略的文件；
- 结果再过滤掉磁盘上已不存在的文件（已从工作树删除、但还在索引里的），去掉 `relDir` 前缀后排序返回，与 `listFiles` 的返回格式一致。

四个调用点改用 `repoFiles`：

```flow LR
check -> repoFiles
reviewedFiles -> repoFiles
validate -> repoFiles
wiki lint -> repoFiles
repoFiles -> git ls-files
```

`listFiles` 保留，供不在 Git 仓库中的场景使用（例如评测脚本读取演示项目目录）。

## 兼容性

- 删除已跟踪的规范文件时：`repoFiles` 不返回它（磁盘上不存在），`check` 仍报"specs.lock 中有记录，但文件被删除"，行为不变。
- 规范目录里手动新加、但没有被忽略的文件：`repoFiles` 返回它，`check` 仍拒绝提交，行为不变。
