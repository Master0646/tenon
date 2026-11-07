# 设计：让完成可核对，让改进可评测

## 目标与边界
- 覆盖分析报告 02 证明边界、03 审批粒度、04 工作范围、05 审查成本、06 故障评测，并增加持续使用反馈闭环。
- 本文所有新增命令、字段与目录均为拟实施设计，不代表当前已存在。
- 本变更按五阶段、十二任务交付；每阶段有独立验证门槛，全部通过后才归档本变更。

## 当前事实与代码入口
| 已核实事实 | 出处 | 本次调整 |
| --- | --- | --- |
| 被审文件为变更目录除 events.jsonl 的全部文件及 project.yaml | src/core.ts:117 | v1 保留；v2 仅额外排除固定名称 execution.md |
| 完成任务累计全部历史事件，开工与验证按最新批准计算 | src/status.ts:39 | 全部按最新批准周期计算 |
| task done 仅校验任务与依赖，verify 执行项目命令 | src/exec.ts:29、src/exec.ts:53 | 增加验收编号与证据关联 |
| 工作树哈希排除 .devflow/ | src/core.ts:212 | 保留全工作树范围，另校验其内证据附件 |
| 归档以能力规范基线检测冲突 | src/archive.ts:44 | 状态提前报告冲突并允许重新审批恢复 |
| 审查页按提案、规范、设计、任务组织 | src/render.ts:68 | 前置决策摘要、批准差异与验收矩阵 |
| apply 要求实际检查，但完成事件未保存依据 | templates/skills/devflow-apply/SKILL.md:17 | 技能使用证据命令并报告缺口 |
| 知识页索引为空 | .devflow/knowledge/index.md:1 | 不将全仓 scan 纳入本次验收 |
| 生命周期评测曾将前端构建改为静态条件 | eval/lifecycle.ts:79 | 冻结评测契约，受限环境记 unknown |
| 已有评分以引用与结论正则为主 | eval/score.ts:1 | 保留原题库，另增流程故障评测 |

## 五阶段交付
| 阶段 | 交付 | 离开本阶段的条件 |
| --- | --- | --- |
| P0 可观测基线 | T1–T2：记录格式、固定评测协议、低侵入使用记录 | 旧流程全套通过；记录失败不改变业务命令结果 |
| P1 验收证据 | T3–T5：v2 条件、周期、自动与人工证据、完成门槛 | 旧证据不能满足新批准；遗漏验收阻止归档 |
| P2 审批与工作范围 | T6–T7：实施笔记、批准快照、单工作树串行、冲突恢复 | 契约变更必重批；无关笔记不重批；并发开工被拦截 |
| P3 审查与恢复 | T8：差异审查、证据矩阵、继续工作摘要 | 新会话可确定下一步，缺失证据明确展示 |
| P4 持续改进 | T9–T12：故障套件、趋势报告、候选、对照评测、文档发行 | 所有确定性故障可检出；完成一轮问题到复测的演示 |

## 总体路径
```flow LR
使用命令 -> 本地使用记录 -> 周期报告 -> 优化候选 -> 人工审查
人工审查 -> 实现变更 -> 故障回归 -> 对照评测 -> 周期报告
```
- 业务状态仅由契约文件、受控事件与代码决定，使用记录不得参与批准或归档判定。
- 为每个优化候选记录来源报告哈希和评测案例 id；正式提案记录 candidate_id，完成后的 improve resolve <candidate-id> --report <path> 关联结果，不从归档成功推断优化有效。
- 故障回归不调用模型；真实 Agent 对照评测由维护者显式启动，使用独立临时项目。

## 1. v2 变更与兼容策略
- 新 CLI 的 new 默认生成 schema_version: 2；change.yaml 和 tasks.yaml 必须同版本，project.yaml 仍为 v1。
- 当前本提案使用现有 v1 格式，以便现有 CLI 完成校验、批准与实施；它自身按 v1 生命周期收尾。
- v1 不自动转换，不重写历史日志，不重新计算旧批准哈希；未归档 v1 的 task-done 也只认最新批准后的记录，这是明确的正确性修复。
- v2 的 acceptance 使用对象数组：id、text、method、check；id 在变更内唯一，method 为 automated 或 manual，automated 的 check 引用 project.yaml.verify.name。
- 每个 v2 任务至少有一个验收条件；任务依赖、验收文本、method、check、affected_paths 与 project.yaml 均属于批准契约。
- v2 的最小兼容 CLI 版本写入 change.yaml.min_cli_version；本次发布升级到 0.2.0，doctor 输出已发现的格式与兼容性错误。
- CLI 支持显式 new --schema 1 以便旧流程测试；不提供隐式降级，旧 CLI 无法读取 v2 时应明确升级。

```yaml
schema_version: 2
tasks:
  - id: T1
    title: 后端禁用权限校验
    acceptance:
      - id: AC1
        text: 普通用户直接调用禁用接口返回 403 且数据不变
        method: automated
        check: unit-tests
      - id: AC2
        text: 管理员可在页面完成禁用并看到状态刷新
        method: manual
```

## 2. 证据与完成判定
- 新增 devflow evidence add <id> --file <json>，只接收结构化结果，不执行文件内的命令或链接。
- 新增 devflow evidence confirm <id> <evidence-id>，由人在交互终端确认 manual 记录；沿用现有人的命令约束，其不是防恶意篡改的安全边界。
- agents.ts 与 templates/devflow.rules 为 evidence confirm 生成与 approve/archive 相同的人专属禁止规则；升级后由 update 同步，不允许 Agent 代确认。
- 自动证据引用已有 verify 运行中的 check；verify 为每次运行分配 run_id 并返回各 check 日志摘要与哈希。
- verify 事件新增 run_id 与 check 摘要；每条 evidence-recorded 包含规范化输入及其哈希，单条摘要上限 4 KiB、每个验收条件最多引用 10 个附件。
- 输入字段：task、acceptance、kind、verify_run/check（自动）、procedure/expected/observed（人工）、artifacts（仓库内文件）、summary；输出字段由 CLI 写入，包含 evidence_id、approval_id、worktree_hash、at、artifact_hashes。
- 自动证据只能来自本轮批准、同一工作树、执行成功的指定 check；CLI 验证关联存在，不声称理解测试覆盖的业务语义。
- 自动证据必须附一个仓库内测试文件定位及对应断言说明；人工证据展示操作、期望与实际观察，明确记录确认人。
- 原始输出留在 runtime；证据中只存短摘要，必要附件复制到 .devflow/evidence/<id>/<evidence-id>/，使用内容哈希验证并受 check 检查。
- 附件只接受仓库内普通文件，拒绝越界、符号链接、exclude 命中和单文件超过 1 MiB；不自动采集截图、凭据、命令输出或整个源码文件。
- 新证据与人工确认由事件追加；事件类型为 evidence-recorded、evidence-confirmed，引用稳定 evidence_id；禁止 Agent 手写事件。
- task done <id> <task> 要求本轮批准下每个验收条件有有效证据；重复标记保持明确报错，旧事件保留为历史。
- v2 可归档条件：当前批准有效、已开工、当前工作树 verify=pass、每个任务完成、每个验收条件证据有效、附件哈希一致、manual 已人工确认。
- verify 可以在任务标记前运行，避免“先完成才能验证、先验证才能完成”的循环；所有代码完成后跑 verify，再关联证据并标记完成。
- 代码变化后完成事件仍可展示，但证据标为 stale、done/total 只统计当前有效完成；重新运行 verify 并重新关联自动证据，人工证据重新确认，不自动继承。
- 删除 runtime 原始日志不撤销已落盘的摘要证据；报告明确原始日志不可用；删除或修改受控证据附件必须阻止归档。
- verify pass 的 UI 用语为“配置检查通过”；只有条件证据齐全时展示“验收证据齐全”，不声称已自动证明需求正确。

## 3. 审批周期与实施调整
- 每次新批准生成 approval_id（UUID）；旧 approved 事件无 UUID 时以其在日志中的顺序索引作为只读周期标识。
- 开工、任务完成、证据、人工确认与验证全部绑定最新批准；重新批准后清空当前有效进度，历史可查看。
- 不对文件做自然语言语义判断，也不放宽 design.md、tasks.yaml 的批准保护。
- v2 仅允许 execution.md 作为非契约实施笔记，不参与批准哈希；内容用于记录实施顺序、探索结果和障碍，不能添加验收条件、改变影响范围或声明完成。
- CLI 不从 execution.md 读取任何执行配置；笔记与批准内容冲突时，批准内容优先，Agent 必须回到提案重批。
- 每次批准保存完整受审文件清单和内容到 .devflow/reviews/<id>/<approval_id>/，approved 事件记录 snapshot_hash。
- 快照由批准命令生成，不计入本次批准输入；check 校验其内容与事件哈希，丢失时阻止 v2 继续执行并提示从 Git 恢复。
- v1 没有旧快照时，审查页明确无法还原上次批准全文，绝不把 Git HEAD 冒充批准快照。
- 审批前后再次核对哈希；快照先写临时目录后原子发布，最后追加批准事件，失败留下的无引用快照不得视为批准。

## 4. 工作树与冲突
- v2 apply --start 在当前工作树已有其他 applying、needs_fix、ready_to_archive 变更时拒绝，并列出阻塞变更；允许多个 draft/approved 等待。
- 对同一工作树的状态改变命令使用 Git 工作树私有目录下的互斥锁，覆盖状态读取与事件写入；不同 worktree 使用不同锁。
- 锁失败不等待无限时长，返回持锁命令与恢复提示；验证持锁期间仍通过前后哈希检测外部编辑，禁止自动抢占存活进程锁。
- 继续工作只读取当前工作树；跨工作树和跨分支没有全局调度，不承诺自动解决合并冲突。
- 保留全工作树内容哈希，不将 affected_paths 当作验证隔离边界；并行工作由用户/Agent 用现有 worktree 能力隔离。
- status 在本轮批准的 spec_base 与当前能力规范不一致时优先返回 rebase_required，即使已开工或已验证。
- 恢复步骤为更新 delta、重新审批、重新开工与验证；approve 允许此状态，避免“归档要求重批但状态禁止重批”的死路。
- 归档的检查与事务提交期间持锁；保留现有中断前滚语义，新增证据与快照不随变更目录移动而失效。

## 5. 审查页与恢复入口
- render 的首屏展示业务变化、影响范围、验收方式、未决事项及本次批准范围；旧 A–E 面板继续保留详情。
- 重新审批从上次批准快照计算逐文件 diff，突出验收、验证配置和影响范围的变化；仅有 execution.md 更新时提示无需重批。
- 新增 devflow resume <id>：输出状态、当前批准、有效任务、失效/缺失证据、阻塞原因与下一条具体命令；支持 --json。
- render 在实现阶段展示验收矩阵（条件、证据、代码哈希、结果、人工确认），没有材料就显示缺失，不生成推测结论。
- 人工审查保留 approve/archive，manual 证据确认可逐条执行；本轮不增加第三套审批层级。

## 6. 本地持续使用记录
- 新增 src/usage.ts；默认初始化仓库内启用，可通过 DEVFLOW_USAGE=off 或 devflow usage configure --off 关闭，配置保存在 runtime/usage/config.json。
- 只记录面向业务的命令，usage/report/eval 自身不计入二十调用触发，避免统计递归。
- 业务命令进入及退出各记录一条 start/end，以 invocation_id 关联；每次调用一个独立 JSON 文件并原子替换，避免并发 JSONL 交叉写入。
- 路径为 .devflow/runtime/usage/YYYY-MM-DD/<invocation_id>.json；遵循现有 runtime 忽略规则，不污染代码哈希与批准哈希。
- 白名单字段为 schema_version、tool_version、UTC at、duration_ms、command/subcommand 枚举、change_id、approval_id、状态前后、outcome、error_code、reason_code。
- 不记录任意 argv、命令正文、stdout/stderr、环境变量、用户名、仓库绝对路径、源文件内容；Agent/token 字段默认 unknown。
- 开工到归档只称墙钟耗时，不能称人工耗时；命令执行耗时单独统计；进程中断缺少 end 时记 interrupted/unknown，不虚构失败或成功。
- 写入失败仅向 stderr 提示，不改变业务命令退出码或 JSON stdout；读取报告不能改变业务事件。
- 原始记录默认保留 30 天，启动新记录时最多清理 100 个到期文件；未清理项交给 usage prune，下次继续；不清理业务证据或审批快照。
- 新增 devflow usage feedback <id> --file <json>，字段为 category、impact、note、related_invocation；分类固定为 blocked、confusing、false-positive、missed-defect、other。
- 人工反馈与自动记录分开保存，note 限长且标明用户填写；任何导出需要显式命令，默认仅导出聚合计数与分类，不含自由文本与标识。
- devflow usage export --since YYYY-MM-DD --out <file> 导出默认聚合结果，usage prune --before YYYY-MM-DD 只清理 runtime/usage；原始反馈默认保留 90 天，报告保留 180 天，未解决候选保留到显式删除。
- 使用记录默认不上传；也不探测聊天历史，不把账号级 token 或费用分摊给单个变更。

## 7. 报告、触发与优化候选
- 新增 devflow usage report --since YYYY-MM-DD，生成 JSON 与离线 HTML 到 runtime/reports；支持按版本及变更格式筛选。
- 指标包括命令成功/失败/中断数、重批原因、证据失效原因、重复验证次数、任务完整率、反馈分类、命令耗时分位数及墙钟周期。
- 每项指标给出计数、分母、时间窗、版本和缺失数据量；反馈数量不是缺陷总数，无法算真实漏检率时明确 unknown。
- 每累计 20 个结束调用，或首次新调用发现距上次报告已超过 7 天，生成本地汇总；没有新调用时不启动后台任务。
- archive 成功后生成该变更摘要；自动报告失败不得回滚已成功归档，错误可在下次 report 中看到。
- 自动报告的首次时间窗从第一条调用开始，成功写入报告后原子更新游标，失败不推进；同一触发由非阻塞报告锁去重。
- 同类结构化问题出现至少 3 次时生成候选，候选指纹为 category+reason_code+tool_version；同一时间窗内去重，不自动新建正式变更。
- 新增 devflow improve draft <candidate-id> <change-id>，调用现有 new 骨架生成器并填入问题计数、来源和待验证假设；不会批准、执行或改规则。
- 候选固定包含现象、证据、假设、期望指标、回归案例、结果链接；propose 技能负责核查与补齐，不将统计相关性写成因果关系。
- 闭环为：记录 → 聚合 → 人/Agent 诊断 → 正式提案 → 人批 → 实现 → 固定回归与对照 → 记录有效/无效/证据不足。

## 8. 持续评测
- 新增随包 templates/eval/ 故障夹具与 src/evaluate.ts；devflow eval run --suite workflow 在临时 Git 仓库执行确定性用例，绝不在用户仓库制造故障。
- 每个用例有稳定 id、fixture_hash、期待输出/状态/退出码和安全类别；版本变更不允许在同一对照实验中改评分规则。
- 首批至少 10 个用例：缺失条件证据、失效代码哈希、旧批准完成记录、伪造/缺失附件、缺人工确认、并发开工、规范基线变化、归档中断、恢复摘要、记录写入失败。
- 行为漏实现但泛化测试通过的案例必须作为 Agent 行为评测，不把核心 CLI 通过格式校验错误报告为业务已检出。
- 错误配置、遗漏权限分支、新会话恢复进入 eval/ 的显式 Agent 对照；保持原始验收，不因依赖缺失改成静态检查，受限时记 unknown。
- eval/protocol.yaml 固定项目快照、任务、可用工具、模型标识、评分器版本、随机种子（适用时）、重试与预算上限；基线/候选交替运行，每任务每版本至少 5 次。
- 同协议比较漏检率、误拦率、成功完成率、人工介入次数、工具调用数与端到端耗时；报告样本数、分布和失败明细，不把一次变快写成确定改进。
- token 与费用只接受运行器明确提供的原始值及来源；无法取得则 unknown，不从上下文占用推算。
- devflow eval compare <baseline-report> <candidate-report> 拒绝夹具/协议不一致的可比结论；结果为 improved、regressed、inconclusive，保留指标明细。
- compare 判定固定为：关键故障出现新增漏检或完成率下降则 regressed；协议一致、每组至少 5 次且关键结果不退化、目标中位耗时或介入次数下降至少 10% 则 improved（仅表示本批样本）；其余 inconclusive，明确不代表统计显著。
- 真实 Agent 人工介入次数只计显式确认事件与运行器记录的用户响应，拿不到运行器数据时为 unknown；不可用命令次数不代替人工次数。
- 确定性套件随 npm test 进入维护者日常门禁；真实 Agent 实验需显式运行，不由用户业务 verify 或自动报告触发费用。

## 9. 验收门槛与验证方式
| 类别 | 门槛 |
| --- | --- |
| 兼容性 | 全部现有测试通过，v1 批准哈希不变，归档历史不被修改 |
| 正确性 | 10 个确定性故障全部符合预期；缺证据/旧周期/失效哈希均不能归档 |
| 并发与恢复 | 同工作树并发仅一个开工成功；两个独立 worktree 不互锁；中断归档可恢复 |
| 数据边界 | 使用记录关闭/磁盘失败不影响命令；无敏感 argv 与自由文本进入默认导出 |
| 成本 | 500 次无模型夹具调用测开关记录的中位数与 p95；中位附加耗时不超过 20ms，p95 不超过 50ms |
| 真实收益 | 首轮 Agent 对照每任务每版本至少 5 次，样本不足只报告证据不足；不以性能提升作为伪造通过依据 |
| 发行 | npm test、npm run typecheck、打包安装冒烟、旧项目读取和新项目完整流程均通过 |
- 效果推广条件建议为关键漏检不增加、任务成功率不降低；耗时与介入次数展示变化及样本不确定性，由维护者决定推广。
- 实现过程中可直接运行 node --test 与本地 tsc 定位环境问题，但最终须跑通文档声明的安装和命令入口。

## 10. 实施边界与发布策略
- 新增模块只限 evidence.ts、usage.ts、evaluate.ts；事件、状态、归档和审查复用现有模块，不建设插件框架或数据库层。
- 开发阶段按 T1–T12 顺序依赖推进；P0–P3 可在本地验收，但在完整测试和迁移验证前不推广 0.2.0 给其他项目。
- v2 行为写入新能力 evidence-workflow；既有 devflow-cli 的展示规范继续满足，增加首屏和矩阵不删除既有内容。
- 在已有 v1 调用中可生成 usage 数据，但不要求补写 v2 证据；针对旧批准周期的修复应在发布说明突出。
- 预计工作量需以 P0 基线及 P1 夹具复杂度再估算；不以未验证的人天数字作为承诺，阶段验收是推进依据。

## 11. 回滚与停止条件
- P0 记录可即时关闭；runtime 数据可以单独清理，不删除业务日志或受控证据。
- 对尚未使用 v2 的项目可回退 CLI；已有 v2 项目保留兼容版本，不使用旧 CLI 继续追加其日志。
- 真正需要回退 v2 行为时，以新的修复变更迁移或恢复隔离分支，不重写已提交事件与已归档规范。
- 当五阶段门槛和完整闭环演示通过，本次停止扩展；云端平台、模型自动优化、自动 worktree 调度留待独立需求。
