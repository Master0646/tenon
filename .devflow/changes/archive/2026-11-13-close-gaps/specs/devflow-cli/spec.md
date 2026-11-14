## ADDED Requirements

### Requirement: 影响路径可以指向代码仓库
`affected_paths` SHALL 接受以 `code_roots` 中某一项开头的路径；批准后这些路径被提交改动时，变更 MUST 进入 rebase_required。

#### Scenario: 兄弟仓库路径
- WHEN `code_roots` 含 `../backend`，`affected_paths` 写 `../backend/src/**`
- THEN validate 通过

#### Scenario: 未声明的外部路径
- WHEN `affected_paths` 写 `../other/src/**`，而 `code_roots` 没有 `../other`
- THEN validate 报 error

#### Scenario: 批准后兄弟仓库有提交
- WHEN 变更已批准未开工，`../backend` 里有新提交改动了 `src/` 下的文件
- THEN 状态为 rebase_required，原因里带 `../backend/` 前缀的文件路径

### Requirement: 代码仓库的提交门禁
`devflow init` SHALL 为 `code_roots` 中的每个仓库安装 pre-commit 钩子；在这些仓库里暂存了未开工变更影响路径内的文件时，提交 MUST 按 `enforce` 被警告或拒绝。

#### Scenario: 安装钩子
- WHEN `code_roots` 含 `../backend`，运行 `devflow init`
- THEN `../backend` 的 pre-commit 钩子带 devflow 标记，并指向本项目

#### Scenario: 已有其他钩子
- WHEN `../backend` 已有不带 devflow 标记的 pre-commit 钩子
- THEN 不覆盖，输出需要手工加入的命令

#### Scenario: 提交未开工变更的代码
- WHEN `enforce` 为 strict，变更未开工，在 `../backend` 暂存了它影响路径内的文件并提交
- THEN 提交被拒绝，提示先批准并开工

#### Scenario: 开工后
- WHEN 同一变更已开工，再次提交
- THEN 提交通过

### Requirement: 提示停滞的变更
`devflow status` SHALL 对已批准或已开工、且最后一条事件早于阈值的变更标出停滞时长；阈值 MUST 取 `project.yaml` 的 `stale_hours`，未设置时为 24 小时。

#### Scenario: 停滞一天多
- WHEN 变更状态为 applying，最后一条事件在 30 小时前，没有设置 `stale_hours`
- THEN 该行末尾带「停滞 30 小时」

#### Scenario: 调小阈值
- WHEN `stale_hours` 为 2，最后一条事件在 3 小时前
- THEN 该行末尾带「停滞 3 小时」

#### Scenario: 刚有活动
- WHEN 最后一条事件在 1 小时前
- THEN 不带停滞标记
