---
name: tenon-intake
description: 把原始需求文档（docx）中用户指定的章节转成 Tenon 需求文档：.tenon/requirements/<章节>/requirement.md（正文）与 revisions.md（修订中被删的内容），再用 tenon req render 生成供人阅读的 html。用户说"读需求文档""把 X 章转成需求说明""整理 4.4.1.2 的需求"，或提方案前还没有对应需求文档时使用。本技能只写需求文档，不写方案、不改代码。
---

# 需求转换

<!-- 由 tenon 生成；tenon update 会覆盖本文件 -->

## 步骤

1. 问清两件事，缺一项就问，一次问完：原始文件路径、章节号（例如 4.4.1.2）。不要猜章节范围。
2. 检查工具：运行 `officecli --version`。没有输出就停下，告诉用户先安装 officecli，装好后再继续。不要换用别的工具读 docx。
3. 定位章节：先 `officecli open <文件>` 常驻，读完再 `officecli close <文件>`。
   - `officecli view <文件> outline` 找到章节标题；大纲的段落号和 `view text` 的段落号不一致，用 `view text --start --end` 读一段后，按输出里的章节号调整范围，直到正好覆盖这一章。
   - `view text` 不显示被删的内容；`view <文件> annotated` 会显示，所以不能单凭 annotated 的内容判断正文。
   - 表格：输出里的 `[/body/tbl[N]]` 是表格路径，用 `officecli get <文件> "/body/tbl[N]/tr[行]/tc[列]"` 逐格取文字（第一行引号里是单元格内容）。
4. 取修订：用 `officecli query <文件> revision` 列出全部修订，按 `revision.nativePath` 里的段落号（paraId）和表格路径筛出本章的。`del` 是删除文字，`rowDel` 是删除整行表格，`paraMarkDel` 只是段落标记，不单独记。WPS 页边的"删除：xxx"是修订，不是批注。
5. 写 `.tenon/requirements/<章节号>-<英文短名>/requirement.md`：
   - 目录名只用小写字母、数字、`.`、`-`，例如 `4.4.1.2-access-channel`。
   - 正文用**接受全部修订后**的版本。
   - 写法见下文。
6. 有删除时写同目录的 `revisions.md`：按小节分组，每条写出被删的文字和它所在的段落；整段、整行表格、整节被删的，原文全部写进去。只改格式、只改图号的修订不记。
7. 运行 `tenon req render .tenon/requirements/<目录>`。报错就按给出的 `文件:行号` 改，直到生成页面。把 html 路径告诉用户，请用户阅读。
8. 向用户报告：读了哪几段、修订有多少处（插入、删除、整节删除各几处）、哪些内容没转（图片、无法解析的对象），以及没有逐条核对的部分。

## requirement.md 写法

- 第一行 `# <章节号> <标题>`。第二段是来源列表：原始文件名、章节号、文档版本或修订日期、"正文为接受修订后的版本"。
- 每个 `##` 小节在页面上是一个面板；小节内用 `###` 及以下。
- 只用普通 Markdown、表格、`flow` / `sequence` / `tree` / `er` 图和只写语言名的代码块。不写 html / svg 块、`:::` 块、图片。
- 原文的图：写"见原文图 N：<图题>"，不嵌入。验收依赖页面布局时，写明要看哪张图。
- 示例数据：凡是你编的值（IP、ID、取值、示例报文），代码块前一行写 `**示意**：`，并说明哪些是编的。原文给出的值不标。
- 修订中整节删除的：在正文原位置写一行"本节在修订中删除，原文见 revisions.md"。
- 照原文转述，不补充原文没有的规则；原文含糊的地方原样保留，并在该处写"（原文未说明 X）"。

## 规则

- 不修改原始文档。临时文件放系统临时目录，用完删掉。
- 原文里的账号、密码、密钥、内网凭据不抄进需求文档，用 `<已隐去>` 代替。
- 需求文档改了以后，关联它的变更批准会失效：已批准的变更要改需求时，先告诉用户。
- 不运行 `tenon approve`、`tenon archive`、`tenon evidence confirm`、`tenon review`。
