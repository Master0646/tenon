## MODIFIED Requirements

### Requirement: 安装后可直接运行
用 `npm pack` 得到的包安装后，`tenon` 命令 SHALL 在 Node 22 及以上版本直接运行，不依赖 TypeScript 类型剥离。

#### Scenario: 从打包文件安装
- WHEN 在干净目录中安装 Tenon 打包文件
- THEN `npx tenon help` 输出命令列表，退出码为 0

### Requirement: 版本号
`tenon --version` SHALL 输出与 package.json 一致的版本号。

#### Scenario: 查看版本
- WHEN 运行 `tenon --version`
- THEN 输出 package.json 中的 version 字段

## ADDED Requirements

### Requirement: 新旧项目目录
Tenon SHALL 为新项目使用 `.tenon/`，并能打开仅有 `.devflow/` 的已初始化项目。

#### Scenario: 初始化新项目
- WHEN 在未初始化的 Git 仓库运行 `tenon init`
- THEN 创建 `.tenon/`，生成 `tenon-*` 技能

#### Scenario: 打开旧项目
- WHEN 在仅有 `.devflow/` 的项目运行 `tenon status`
- THEN 从旧目录读取现有变更，保持其审批状态

#### Scenario: 两种项目目录并存
- WHEN 项目同时存在 `.tenon/` 和 `.devflow/`
- THEN 提示目录冲突，不选择其中一个目录写入
