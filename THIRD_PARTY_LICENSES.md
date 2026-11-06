# 第三方许可证

devflow 发行包包含或依赖以下第三方软件。

| 名称 | 版本 | 用途 | 许可证 | 随包方式 |
| --- | --- | --- | --- | --- |
| [yaml](https://github.com/eemeli/yaml) | ^2.9.1 | 解析 YAML | ISC，Copyright Eemeli Aro | npm 依赖，安装时下载 |
| [Answer me with HTML](https://github.com/QingYunA/answer-me-with-html) | 0.5.11 | `devflow render` 生成离线审查页 | MIT，Copyright (c) 2026 Answer me with HTML contributors | 随包附带：`vendor/answer-me-with-html/am.mjs`，全文见 `vendor/answer-me-with-html/LICENSE` |
| [Bangers](https://github.com/googlefonts/bangers) 字体 | — | 内嵌于 am.mjs | SIL Open Font License 1.1，Copyright 2010 The Bangers Project Authors | 全文见 `vendor/answer-me-with-html/OFL-Bangers.txt` |

am.mjs 是打包后的单文件。据 Answer me with HTML 的说明，它打包了 [marked](https://github.com/markedjs/marked)（MIT）与 [@dagrejs/dagre](https://github.com/dagrejs/dagre)（MIT）；文件中还包含 MathJax Consortium 与 Ron Kok 的版权声明（数学公式渲染代码）。

**已知缺口**：marked、dagre 与上述数学渲染代码的许可证全文没有随 am.mjs 单独提供，am.mjs 中也找不到 marked、dagre 的版权行。对外正式分发前，需要从上游补齐这些许可证全文。

开发依赖 `typescript`（Apache-2.0）与 `@types/node`（MIT）不随包分发。
