# 设计

## 流程

```flow LR
(原始 docx) -> tenon-intake 技能: 用户指定章节
tenon-intake 技能 -> requirement.md
tenon-intake 技能 -> revisions.md
requirement.md -> tenon req render: 人读
tenon req render -> 需求 html
requirement.md -> tenon-propose 技能: Agent 读
tenon-propose 技能 -> change.yaml: requirement 字段
change.yaml -> 批准哈希
```

## 目录与文件

```tree
.tenon/
  requirements/ | 新增，进 git，由 Agent 写
    4.4.1.2-access-channel/ | 一个章节一个目录：<章节号>-<英文短名>
      requirement.md | 正文：接受修订后的版本
      revisions.md | 可选：被删的修订内容，按小节分组
  runtime/rendered/requirements/ | 新增，已被 gitignore（src/init.ts:77）
    4.4.1.2-access-channel.html | tenon req render 的输出
```

- 目录名用 `CHANGE_ID` 同样的规则（`src/core.ts:98`），另允许 `.`，便于写章节号：`/^[a-z0-9][a-z0-9.-]*$/`。
- 数据目录用 `dfOf(root)`（`src/core.ts:15`），旧项目落在 `.devflow/requirements/`。
- 提交门禁不检查数据目录下的文件（`src/check.ts:130`），需求文件不会触发"超出影响路径"的提醒。

## requirement.md 写法

- 第一行 `# <章节号> <标题>`；第二段是一个列表，写来源：原始文件名、章节号、版本或修订日期、取用的是接受修订后的版本。
- `##` 一个小节对应页面上的一个面板；`###` 及以下为小节内标题。
- 允许的写法与审查页相同（`src/render.ts:27` `toPanelBody`）：普通 Markdown、表格、`flow` / `sequence` / `tree` / `er` 图、只写语言名的代码块。不允许 html / svg 块、`:::` 块、图片。
- 示意内容：代码块前一行写 `**示意**：`，正文说明哪些值是编的。
- 原文的图：写"见原文图 N：<图题>"，不嵌入。
- 被删的整节：在正文对应位置写一行"本节在修订中删除，原文见 revisions.md"。

## tenon req render

```sequence
人 -> tenon: tenon req render .tenon/requirements/4.4.1.2-access-channel
tenon -> tenon: 读 requirement.md 与 revisions.md，按 ## 切成面板
tenon -> am: doc 模板草稿（vendor/answer-me-with-html/am.mjs）
am --> tenon: html
tenon --> 人: ✓ <输出路径>
```

- 新文件 `src/requirement.ts`，导出 `renderRequirement(root, dir, out?)`。
- 草稿：`template: doc`、`theme: paper`、`lang: zh`，标题取 `#` 行；`##` 各成一个面板，正文经 `toPanelBody` 同样的检查与转义；有 `revisions.md` 时追加最后一个面板"修订记录"。
- 复用 `runAm` 和 `decorate`（`src/render.ts:286`、`src/render.ts:451`），渲染器与审查页一致。`runAm` 当前未导出，改为导出。
- 有不允许的写法时不出页面，按 `文件:行号 问题` 列出，与 `renderHtml` 的报错一致（`src/render.ts:466`）。
- 参数可以是目录，也可以是其中的 `requirement.md`；目录不在 `<数据目录>/requirements/` 下时报错。
- `-o` 指定输出文件，与 `tenon render` 一致（`src/cli.ts:414`）。
- 命令写入 `src/cli.ts` 的 switch，形式同 `wiki lint`（`src/cli.ts:248`）：`req` 只接受子命令 `render`。

## change.yaml 的 requirement 字段

```yaml
requirement:
  - .tenon/requirements/4.4.1.2-access-channel/requirement.md
```

- 可选，字符串数组；写单个字符串也接受。
- validate（`src/validate.ts:156`）：每项必须是 `<数据目录>/requirements/` 下已存在的 `.md` 文件，不能含 `..`。
- `ChangeMeta`（`src/validate.ts:110`）加 `requirement: string[]`，`loadChangeMeta` 给出空数组作默认。
- `reviewedFiles`（`src/core.ts:126`）把这些文件加进被审文件：批准哈希、审查页 E 面板的被审文件、批准快照都随之包含它们。
- 已归档的变更不移动需求目录，路径继续有效。

## 技能

- `templates/skills/tenon-intake/SKILL.md`（新）：
  1. 问清原始文件路径和章节号；缺一项就问。
  2. 读文档：有 officecli 就用它，并单独取出修订（插入、删除）；没有就用 `pandoc --track-changes=all`；都没有就停下，告诉用户安装命令。
  3. 正文按接受修订后的版本写 requirement.md；删除的段落、表格行、整节写进 revisions.md，注明所在小节。
  4. 按上面的写法规则写，运行 `tenon req render <目录>`，把 html 路径告诉用户。
  5. 不改原始文档；临时文件放系统临时目录，用完删掉。
- `templates/skills/tenon-propose/SKILL.md`：步骤 1 加一条：用户点名章节或存在对应需求目录时，以 requirement.md 为需求来源，在 change.yaml 写 `requirement`；只在含糊处回查原文，并在 design.md 注明查了哪一节。
- `templates/entry.md`：技能列表加 `tenon-intake`（把需求文档章节转成 md 与 html）。
- `installAgents` 按模板目录复制全部技能（`src/agents.ts:87`），新技能不用改代码。
