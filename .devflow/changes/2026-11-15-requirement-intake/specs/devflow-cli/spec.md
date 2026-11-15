## ADDED Requirements

### Requirement: 渲染需求文档
`tenon req render <目录>` SHALL 把数据目录 `requirements/` 下的需求 md 渲染成离线 html，写法不合规时不出页面。

#### Scenario: 正常渲染
- WHEN 目录里有 requirement.md（含若干 `##` 小节）和 revisions.md，运行 `tenon req render <目录>`
- THEN 在 `runtime/rendered/requirements/<目录名>.html` 生成页面，每个小节一个面板，最后一个面板是修订记录

#### Scenario: 不允许的写法
- WHEN requirement.md 含 html 块、图片或 `:::` 块
- THEN 不生成页面，报错列出文件与行号

#### Scenario: 参数不对
- WHEN 参数不在 `requirements/` 下，或目录里没有 requirement.md
- THEN 报错并给出用法

### Requirement: 变更关联需求文档
change.yaml 的可选字段 `requirement` SHALL 只接受 `requirements/` 下已存在的 md 文件，且这些文件计入批准哈希。

#### Scenario: 合法关联
- WHEN requirement 指向 `requirements/` 下已存在的 md，运行 `tenon validate`
- THEN 校验通过，审查页的被审文件包含该 md

#### Scenario: 非法路径
- WHEN requirement 指向不存在的文件、`requirements/` 外的文件、非 md 文件，或路径含 `..`
- THEN validate 报错

#### Scenario: 批准后需求被改
- WHEN 变更已批准，之后修改了 requirement 指向的 md
- THEN 批准失效，状态回到 draft

#### Scenario: 不写该字段
- WHEN change.yaml 没有 requirement
- THEN 校验与状态和原来一致

### Requirement: 安装需求转换技能
`tenon init` 与 `tenon update` SHALL 为每个安装的 Agent 生成 tenon-intake 技能，入口说明的技能列表包含它。

#### Scenario: 初始化
- WHEN 运行 `tenon init --agents claude,codex`
- THEN `.claude/skills/tenon-intake/SKILL.md` 与 `.agents/skills/tenon-intake/SKILL.md` 都存在，CLAUDE.md 与 AGENTS.md 的托管段提到 tenon-intake
