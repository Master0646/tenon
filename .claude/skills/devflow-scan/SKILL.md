---
name: devflow-scan
description: 为本项目生成或更新 DevFlow 知识页（.devflow/knowledge/）。在用户要求"扫描项目""建立或更新项目知识""初始化 Wiki"时使用；在 devflow wiki lint 报告 stale 或 broken 页面需要修复时也使用。回答问题请用 devflow-ask。
---

# 生成与更新项目知识页

<!-- 由 devflow 生成；devflow update 会覆盖本文件 -->

知识页记录"代码现在是怎样的"，每条事实都要能在源码中核对。知识页不是规范（`.devflow/specs/` 只能经归档修改），也不是设计文档。

## 步骤

1. 运行 `devflow wiki lint --json`，读 `.devflow/knowledge/index.md`，了解已有页面和问题。
2. 若有 stale 或 broken 页面，先修：对照源码改正文与 `sources`，再更新 `verified_commit`。
3. 找出业务模块。一个业务模块一页，不要一个类一页。常用搜索：
   - Spring Boot：`rg -l "@RestController|@Controller" -g "*.java"`、`rg -l "@Service" -g "*.java"`、`rg -l "@Mapper|interface \w+Mapper" -g "*.java"`、`rg --files -g "*Mapper.xml" -g "application*.yml" -g "application*.properties" -g "*.sql"`
   - Vue：`rg --files -g "**/router/**" -g "*.vue"`、`rg -l "axios" -g "*.js" -g "*.ts"`
   - 其他技术栈：先读构建文件（`pom.xml`、`package.json` 等）和入口文件，再按目录划分。
4. 对每个模块读相关源码，写 `.devflow/knowledge/pages/<slug>.md`（slug 用小写字母、数字、连字符）。格式见下。
5. 每写完一页，在 `.devflow/knowledge/index.md` 加一行 `- [标题](pages/<slug>.md) — 一句话摘要`，在 `.devflow/knowledge/log.md` 末尾追加 `- <日期> 新增/更新 <slug>：<一句话>`。
6. 运行 `devflow wiki lint`。有错误（✗）就按提示改，直到没有错误；"正文引用了未列入 sources 的文件"这类警告（!）也要改掉。
7. 向用户报告：新增或更新了哪些页面，哪些内容没写及原因。

## 页面格式

```markdown
---
schema_version: 1
title: 用户管理
verified_commit: <git rev-parse --short HEAD 的输出>
sources:
  - path: backend/src/main/java/com/example/user/UserController.java
    symbol: UserController#list
  - path: backend/src/main/resources/mapper/UserMapper.xml
related_specs: []
---

# 用户管理

## 职责
一两句话。

## 调用链
前端页面 → API 封装 → Controller 方法 → Service → Mapper / SQL → 表。每一环写出文件与符号，例如 `UserController#list`。

## 关键规则
业务规则、默认值、校验、权限、状态取值。每条后面写出处（`path#符号`）。

## 配置与依赖
端口、数据源、外部服务、定时任务等，带出处。

## 已知限制
从代码能直接看出的限制或 TODO，带出处。
```

## 规则

- 只写从源码能直接核对的事实，每条带出处。看不出来的不写；推测的内容标"（未核实）"。
- `sources` 列出本页全部出处文件，包括正文中以路径引用的每个文件；漏列的文件改动时，本页不会被标为 stale。`symbol` 写成 `类名` 或 `类名#方法名`，与源码文字一致。
- 不猜测设计原因。已归档变更的设计原因，只链接到 `.devflow/changes/archive/<id>/design.md`。
- 不引用 `.devflow/project.yaml` 中 `exclude` 列出的文件。不把密码、密钥、Token、连接串写进页面，只写位置，例如"数据源配置在 application.yml 的 spring.datasource"。
- 不修改 `.devflow/specs/`、`.devflow/changes/` 和业务代码。
- `verified_commit` 填当前提交。若引用的文件有未提交的修改，先告诉用户：lint 会把该页标为 stale。
