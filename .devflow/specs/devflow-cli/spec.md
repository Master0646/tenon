# devflow-cli

## Purpose

devflow 命令行的安装与自检行为。

## Requirements

### Requirement: 安装后可直接运行
用 `npm pack` 得到的包安装后，`devflow` 命令 SHALL 在 Node 22 及以上版本直接运行，不依赖 TypeScript 类型剥离。

#### Scenario: 从打包文件安装
- WHEN 在干净目录中执行 `npm install <devflow-x.y.z.tgz>`
- THEN `npx devflow help` 输出命令列表，退出码为 0

### Requirement: 版本号
`devflow --version` SHALL 输出与 package.json 一致的版本号。

#### Scenario: 查看版本
- WHEN 运行 `devflow --version`
- THEN 输出 package.json 中的 version 字段

### Requirement: 环境自检
`devflow doctor` SHALL 逐项报告 Node 版本、git、仓库初始化、pre-commit hook、Agent 文件、验证命令声明的状态，每个问题 MUST 附带修复命令。存在 error 级问题时退出码 MUST 为 1，否则为 0。

#### Scenario: hook 指向的 devflow 已不存在
- WHEN pre-commit hook 中记录的 devflow 路径已被删除
- THEN doctor 报告 error，并提示运行 `devflow init` 重新安装 hook

#### Scenario: Agent 文件过期
- WHEN 某个 Agent 的技能文件与当前版本的模板不一致
- THEN doctor 报告 warn，并提示运行 `devflow update`

#### Scenario: 不在 Git 仓库中
- WHEN 在非 Git 目录运行 doctor
- THEN 只报告环境项，说明其余检查已跳过，不抛出未捕获异常
