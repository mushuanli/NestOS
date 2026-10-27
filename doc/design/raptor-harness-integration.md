# 在现有框架运行 RAPTOR 用例

本文的成功标准是：**用 `.flow` 承接 RAPTOR 用例的规则执行、分析、复核与汇总编排，Agent 绑定已发布 Flow 后真实执行规则并取得结果。** 执行不依赖 `raptor.py`、RAPTOR launcher 或额外业务脚本；确定性扫描仍由 Semgrep 规则引擎执行，规则、提示词、复核条件和报告声明保存在业务 Flow 资源中，核心只提供通用机制。边界遵循[应用策略与机制](application-policy-boundaries.md)。

RAPTOR 是机制与方法来源，不是此次交付链中的黑盒运行器。远程 harness 调用、Composite 和隔离后端围绕这条原生执行链讨论，不能替代 Agent → Flow → 规则真实执行的验收。

本文只讨论用例迁入与边界。可移植到通用编排层的机制、当前实现位置、缺口与闭环方式另见[Harness 通用原语](harness-borrowables.md)。

## 基线与交付状态

RAPTOR 分析基线固定为 [`2ac96303d5e382c196aa34b2984a3c6a218132a9`](https://github.com/gadievron/raptor/tree/2ac96303d5e382c196aa34b2984a3c6a218132a9)，避免将后续上游变化当成本次验证结果。本地临时 checkout 仅用于分析，不是应用运行依赖，也不能写进用户配置。

| 能力 | 当前状态与证据 |
| --- | --- |
| 确定性调用外部 Tool | 已有 `builtin.tool` → `kernel-adapters.tool` → `tool.call` 执行链，支持固定版本、结构化输出及工具恢复分派；见 [tool-plugin.ts](../../backend/llm-flow/src/flow/tool-plugin.ts)、[tool-call-effect.ts](../../backend/kernel-adapters/src/effects/tool-call-effect.ts) |
| 规则执行与 JSON 投影 | 已有 Write/Bash、输出 Schema、transform pick/batch 和内联函数多组调用。可直接写规则 YAML、执行 Semgrep、校验退出码、提取 findings 并分派原生模型节点，不需要 RAPTOR CLI 或新业务脚本 |
| 原生 RAPTOR 用例 Flow | [raptor-review.flow](../../apps/cli/examples/raptor/raptor-review.flow) 已由真实 Semgrep 与模型执行：6 条 RAPTOR Python 原始规则、扫描、按 finding 分派、初始分析、consensus、judge、一次修订和汇总；见[执行证据](fixtures/raptor-evidence.json) |
| Agent 绑定 Flow | [示例 Agent](../../apps/cli/examples/raptor/raptor-review.agent) 绑定已发布 Flow 的真实调用已成功；[flow-agent.ts](../../backend/llm-session/src/session/flow-agent.ts#L24) 固定定义、参数、连接与依赖，复用持久执行链。发布修订、摘要和结果见机器记录 |
| Composite | 已有协调 Agent 选择一批成员、隔离子上下文、汇总结果的通用编译；见 [agent-composition.ts](../../backend/app-core/src/configuration/agent-composition.ts)。通用本地主持者与远程成员已真实验收；尚未新增 RAPTOR 专用专家成员资源与业务验收 |
| 远程进程 | 已有 project-scoped shell、进程状态订阅、取消与清理；见 [project-process.ts](../../libraries/nestos-node-driver/src/project-process.ts)、[process.ts](../../libraries/nestos-node-driver/src/files/process.ts)。RAPTOR 在该路径上的真实节点执行仍须单独验收 |
| 原生远程 harness | 已有项目限定的 Claude/Codex/DSH 会话控制、事件、交互与 epoch 回执；见 [contracts.ts](../../libraries/nestos-node-driver/src/harness/contracts.ts)。已接入具名执行连接、普通 Agent、Flow 与 Composite 远程成员；详见[执行连接](remote-harness-connections.md) |
| `ExecutionConnection` | 已实现独立 HarnessExecutionConnection；复用原有节点凭据和项目授权，不加入 LLMConnection 模型档位 |

测试和真实运行结论应以 Semgrep 输出、模型响应、Flow 节点结果、Agent 绑定与持久记录为证。本文不把模拟模型、配置保存、规则文本存在、单独调用 Flow 或调用旧 CLI 原型成功当成完整验收。

首批业务范围为 6 条 Python 规则及其分析/复核流程；后续全规则、CodeQL、SMT、SCA 子例与固定探针验收见下文，仍不等于重建 RAPTOR 全部功能。RAPTOR 本身也不是一份统一工作流语法：扫描规则属于规则引擎，业务编排属于 Python，交互约定属于 Claude commands/skills/hooks。迁移必须把模型角色、finding 身份、复核条件和阶段结果逐项落实为可执行 Flow，不能把 `.flow` 套在外部 pipeline 上就称为替代。

## 全样例对比与性能审查

验收目录 `release/raptor-parity/20261023/` 实际保存上游文件清单、SHA-256、独立 reference、Flow 逐例输出、失败注入及 Agent 持久记录。[全量机器记录](fixtures/raptor-parity-evidence.json)汇总状态，[示例目录](../../apps/cli/examples/raptor/README.md)列出每份 `.flow` 的运行条件。业务逻辑均在 Flow 资源中；reference 与测试设施不参与业务执行链。

本地 Semgrep 验收加载 58 个 YAML、166 条规则，以 70 项用例扫描 87 个唯一静态目标；30 项正例、29 项负例、11 项观察项的独立结果与 Flow 完全一致，共 190 条逐用例 findings。比较包含规则 ID、路径、起止行列、message、severity、错误与扫描/跳过文件；同时检查 fixture 的正反预期。全部加载规则不意味着每条规则均有正反 fixture。上游两组规则测试实际执行，98/98 通过。

上游测试最终进程 exit 0 使用独立净化环境及 [Eio 官方支持的 POSIX 后端](https://ocaml-multicore.github.io/eio/eio_main/Eio_main/index.html)，未修改测试源码或关闭环境检查。首次 98 个断言虽通过，但继承代理被 session-end guard 拒绝；随后默认异步后端复验有两次 scanner validate 失败，最后 POSIX 后端完整 98 项成功。全部日志保留，主 Flow/Agent 性能验收的扫描配置未随此调整。

`raptor-registry-parity.flow` 对两个官方 Python/JS 目标直接执行本地规则及本次分类选出的 8 个 registry pack，与原版 RAPTOR CLI 的原始 30 条、去重 16 条逐字段一致；远端规则内容未 pin，不将这一次成功扩展为所有项目分类的完全迁移。CodeQL 独立对比使用官方工具和未修改的上游查询，Flow 为每个项目另建数据库，并比较全部 codeFlow 路径；5 种语言、6 个独立数据库的 11 条 findings 与 11 条路径完全一致。修改 finding message 与 codeFlow 列位置的负例被比较门禁拒绝。这不包含 RAPTOR 模型分析和自动 SMT 提取链。

SCA 的全部 15 项官方示例均有原版运行记录；4 项默认传递依赖解析因宿主缺少 netns 被拒绝，使用上游 `--no-resolve-transitive` 后验证直接依赖。Flow 已迁移危险 npm lifecycle 与 SCA delta 两项。SMT 的 9 个 guard 片段与上游 API 一致，但有 2 项不符合上游 README 的预期：`strlen` 被抽象为自由值，PARTIAL 的 `validate(ptr)` 未验证。fuzz 目标的三个固定输入已实际编译运行并对比退出码、ASAN 报告与结果分类；自动 AFL campaign、模型生成 exploit、Witness 和完整 SCA 引擎仍未迁移。

性能审查使用同一份 `raptor-parity.flow`、70 个用例和相同 Agent 发布调用链，优化前后分别建立独立磁盘工作区。优化前 Agent 完成 418 个持久 Task、143 次 shell 调用（其中 70 次 Semgrep），用时约 820 秒，SQLite 约 7.33 GiB。保留的共享状态记录约 5.34 GB，Task 记录约 2.47 GB；此前中途采样的共享状态占比更高，不能作为最终占比。主要放大来源为无赋值节点也冻结完整上下文、每次检查点重复保存定义和图、聚合状态重复包含初始检查点。

通用运行时进行了三项修复：变量快照仅冻结 assign 所需非 output 引用；检查点以不可变图组件加可变状态 envelope 持久化；根聚合仅复制其 reducer 消费的字段，初始恢复资料留在 Task input。未删历史记录，未跳过完成事件，未减小扫描范围或取消持久化。旧完整 v1 检查点与旧聚合状态仍可恢复，新版 v2 检查点须由新版宿主读取。冻结图仍需要序列化比较，Kernel Task 历史仍包含 input；本轮优化没有消除所有大对象复制。

进一步审查定位到高 fan-in 汇总的重复读取：Flow 每次 reduce 都重新注册完整依赖集，Kernel 补齐等待回执时先读取目标再检查已有事件。第四项优化使 Flow 仅等待尚未消费的依赖；Kernel 优先检查已有持久 task-exited 回执，再读取缺少回执的目标。Task 终态身份不复用，人工重做创建新身份；自等待和不存在目标仍拒绝。真实 Kernel 事务读计数回归覆盖 any/all/quorum：已有回执时读取目标为 0，混合缺失时仅读取缺失目标；重建后再次显式等待已消费目标仍可重新补齐，不依赖进程内缓存。

高 fan-in 仍会逐事件提交完整 Task 状态与历史；本轮没有合并 reducer 事件或删除审计。Node SQLite 适配器的预编译语句复用和批量字段读取是后续可评估方向，当前未修改，不能把其成本占比归为已测量事实。

最终实测使用同一份 Flow（SHA-256 `5075676d635d945cbf349deece0a5e28dc31bbb8757f900254bb0dbdf84136b4`）、相同 70 个用例与 418 个 Task；三轮均为 143 次 shell、其中 70 次 Semgrep，未调用模型。根 Task 时间采用 终态记录 `updatedAt - createdAt` 同一口径，数据库按磁盘实际字节计数，未 VACUUM 或删除历史。

| 指标 | 优化前 | 前三项优化 | 最终含等待优化 |
| --- | ---: | ---: | ---: |
| 根 Task 耗时 | 813.228 秒 | 550.171 秒 | 320.313 秒 |
| SQLite 文件字节 | 7,867,727,872 | 1,944,281,088 | 1,632,645,120 |
| 完成用例 / 逐例命中 | 70 / 190 | 70 / 190 | 70 / 190 |
| 成功 Task | 418 | 418 | 418 |
| 磁盘关闭重开 | 通过 | 通过 | 通过 |

最终耗时减少 **60.61%**，存储减少 **79.25%**。结果摘要 SHA-256 三轮均为 `cbc10189ae994949d818d5668d90ec9d2c35d4721ffd6bd0ee3aecbdc50e3743`；58 个实际写入的规则文件也逐字节匹配上游清单。最终 Agent 根任务为 `task_5956da62-2abb-41f3-9ddb-e599fbda5f83`。这些是共享宿主并发环境下的单次对照，不是隔离基准的统计结论。

独立 CLI 全量验收亦成功：优化前 Run `20261022202208-427f54eb`；前三项优化后的重跑 `20261022204632-d38361cf` 用时约 569 秒、exit 0。最后的等待优化由完整 Agent 轮次、Kernel/Flow 回归及最新真实崩溃恢复共同验证，未再次重复 CLI 70 项。另保留两项中间尝试和一次完整 CLI 失败轮次：并发压力下 Semgrep 的 `io_uring_queue_init` 无法分配内存，比较门禁正确返回失败；成功重跑使用新目录，没有覆盖失败证据。

回归包括 Flow 48 文件/584 项全通过，随后新增变量跨 Kernel 重开回归的 20 项定向测试通过；Kernel unit 356 项全通过；最新 Kernel 与 Flow 组合 121 项通过；参数调用和各阶段真实 SIGKILL 恢复通过。测试集合有重叠，不累加为独立用例总数。CLI/Agent 业务门禁、Tauri 工作区、Session/AppCore Flow 调用、类型检查与文档检查另有记录。

完整性证据还包括磁盘关闭重开、发布绑定身份、坏 JSON/字段差异的失败门禁、租约/CAS、旧记录、历史图组件、写入中断，以及真实进程 SIGKILL 恢复。耗时受并发测试与查询编译影响，实测数字用于本次工作负载比较，不作通用性能保证。

## 用例与职责

首批链路直接运行确定性扫描，在每个 finding 上执行原生模型分析与复核，再汇总给用户。[上游 agentic 定义](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/.claude/commands/agentic.md)用于提炼扫描、准备、分析、验证与报告之间的责任；尚未迁移的阶段必须保留未实现标记。

```mermaid
flowchart LR
    U[用户：目标与审查要求] --> A[绑定已发布 Flow 的 Agent]
    A --> F[原生 Flow：阶段与运行策略]
    F --> W[Write：规则 YAML]
    W --> S[Bash：固定 Semgrep 命令]
    S --> G[输出 Schema：退出码与完整性]
    G --> B[JSON pick 与 batch]
    B --> M[内联 Flow：分析与复核]
    M --> O[汇总：结果与证据]
    S --> E[宿主授权 shell]
    E --> L[本地宿主 / OCI / nestos-node 项目进程]
```

| 层 | 应负责 | RAPTOR 示例 |
| --- | --- | --- |
| 通用 Tool | 授权文件读写、命令执行、结构化结果与错误 | Write 保存规则数据；Bash 执行 Semgrep。没有新增 RAPTOR 专用运行脚本 |
| 业务 Flow 资源 | 规则内容、分析指令、模型角色、复核条件、阶段结果和报告要求 | 内联函数实现每个 finding 的初始分析、consensus、judge 与可选修订 |
| Flow 运行时 | 参数与具名输出、发布版本、连接固定、并发上限、持久 Task/Effect | 扫描通过门禁后分派 findings；失败阻止下游执行 |
| Composite | 根据用户要求选择专家、分配明确任务、控制成员数量、最终解释 | 可用于审查前后专家分工；当前不等同于本用例的固定分析面板 |
| nestos-node | 项目授权、文件与进程边界、原生 harness 协议、事件与停止核对 | 在远程工作区执行 Semgrep，或控制独立原生 harness session/turn |

不要将 RAPTOR 的策略复制进平台内置 Agent 循环。当前 Composite 编译器只接受普通 Agent 作为成员，拒绝已有 composition 或 `execution.kind=flow` 的成员；见 [compositionAgents](../../backend/app-core/src/configuration/agent-composition.ts#L51)。因此“将整个 RAPTOR Flow 直接选为 Composite 成员”目前并未实现。本用例直接由 Agent 绑定 Flow，固定专家面板使用内联函数和模型节点表达。

## RAPTOR 如何编排，现有 Flow 是否满足

RAPTOR 的编排不只发生在最外层 Claude 对话。`raptor_agentic.py` 顺序驱动扫描、去重、上下文准备、分析和可选后处理；[orchestrator.py](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/packages/llm_analysis/orchestrator.py) 根据阶段和预算选择分析、交叉家族复核、重试、consensus、judge、代码生成等任务。一个阶段结束后，后续阶段消费更新过的结果。具体任务与模型选择属于 RAPTOR 策略。

阶段内部的 [dispatch.py](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/packages/llm_analysis/dispatch.py#L412) 使用 `ThreadPoolExecutor(max_workers=max_parallel)` 提交任务，再用 `as_completed` 收集结果。任务可以形成“finding × model”的组合；模型故障、预算与断路器影响后续分派。这是进程内的同步阶段流水线和有界并发，不是跨主机的持久工作队列。

[review journal](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/core/coverage/journal.py) 用追加 JSONL 保存审查判断与源代码身份，并提供批次边界刷新。[core/run/resume.py](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/core/run/resume.py) 提供配置固定、worker 存活核对、源码漂移、花费证据与剩余预算；[/audit resume](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/core/audit/resume.py) 使用这些机制在原 run 内继续未完成工作。这些能力应复用，但不能由“有 JSONL”推出任意命令都有恢复，也不能把重新执行 CLI、业务 journal 续做与通用跨节点 durable scheduler 混为一谈。

现有 itookit Flow 已具备表达这批用例所需的阶段依赖、批量分派、条件分支与汇总结构。此次将所选 RAPTOR 策略迁入业务 `.flow` 资源：扫描引擎仍执行规则，分析、复核和汇总由原生节点编排，RAPTOR Python pipeline 不参与运行。

| RAPTOR 的编排需求 | itookit 当前能力 | 仍需补齐或明确 |
| --- | --- | --- |
| 扫描 → 准备 → 分析 → 报告 | `builtin.tool`、控制/数据边、参数与具名输出 | 用原生节点连接实际规则输出、每条分析与报告，不能保留隐藏 CLI pipeline |
| 多条 finding 的有界并行 | taskGroup、join、transform batch、多组 Flow 调用 | Semgrep JSON 投影为函数实参，finding 字段属于业务资源，不内置到核心 |
| finding × model 的分析面板 | 显式任务组/实参组、连接绑定、aggregate | 必须明确每对身份、阶段完成条件和原版投票策略；Composite 的一批成员任务不等于该面板 |
| 按争议、预算、验证结果选下一步 | route、loop、结构化条件和汇总 | RAPTOR 判定写入业务定义；平台预算不能代替供应商实际账本 |
| 人工检查或权限审批 | Human/Interaction 与持久 Task | 原生 harness 交互需转接，不能只依赖远程面板 |
| 中断恢复 | Kernel Task/Effect、图检查点和 `reconcile` | 远程 native turn 与 RAPTOR run 身份必须关联；不把已接纳调用再发一次 |

控制节点依据见[Flow 控制原语](flow-control-primitives.md)、[函数与组合调用](flow-invocation-composition.md)，持久实现见 [scheduler-checkpoint.ts](../../backend/llm-flow/src/flow/scheduler-checkpoint.ts)。这些通用能力不表示每种 RAPTOR 用例已有配置和真实验收。

当前 Composite 是“协调者选择一批成员任务 → 宿主持久派发 → 协调者总结”，编译限制 `maxDepth=1`，不是持续多轮自治团队。它适合在审查前后分配专家工作；多轮提出假设、机械验证和证据修订应明确建模为 Flow route/loop，不以调用原版 pipeline 代替此次迁移。

## 三种 Claude 用法

| 用法 | 谁编排、Claude 能做什么 | 接入含义 |
| --- | --- | --- |
| 交互式 RAPTOR framework | 原生会话加载 checkout 的指令、命令、skills、agents 和 hooks，Claude 驱动工具与业务命令 | 需要完整运行环境、原生会话和审批，属于 harness 执行 |
| 禁用工具的纯 LLM transport | Python pipeline 负责分派；Claude 只返回模型结果 | 可作为 RAPTOR 自己的模型后端，不是完整远程 Agent |
| 允许受限工具的 skill subagent | Python 明确指定 skill、输入、工具列表和目录，Claude 执行一段工具工作流 | 需要工具授权、目录边界、预算与子进程停止；不能按“纯模型请求”处理 |

[上游 LLM 文档](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/docs/llm.md)说明：纯模型子进程禁用内部工具，使用空 MCP 配置和中立 cwd，避免加载目标项目的 `CLAUDE.md`、设置与 hooks。它只为 RAPTOR Python 编排提供模型响应。

允许工具的子进程是另一条明确路径：[skill_dispatch.py](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/core/orchestration/skill_dispatch.py#L1099) 将 `tools`、RAPTOR/目标/上下文目录、预算与超时交给 `CCDispatchConfig`，在 RAPTOR 控制的 run 目录启动，并进入网络和文件系统隔离。[cc_dispatch.py](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/packages/llm_analysis/cc_dispatch.py#L98) 也展示了只允许 `Read,Grep,Glob` 的分析子代理。不能因为二者都使用 `claude -p` 就合并为相同执行权限。

完整交互式 RAPTOR 依赖 checkout 下的 `CLAUDE.md`、`.claude/commands`、skills、agents、hooks 与运行脚本。[上游 README](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/README.md)明确要求从 checkout 加载配置。只选择一个 Claude 模型连接，或向普通 Claude session 发 `/agentic`，不能证明已加载 RAPTOR。

对应当前框架：

- `LLMConnection` 继续表达 Provider、模型、档位和通信配置。
- 本次原生 Flow 的模型节点使用 itookit 连接槽和连接快照；上游 RAPTOR 的 provider/model 配置不会被自动继承。
- 完整原生 harness 拥有自己的会话、工具执行、审批、工作区与取消语义，应经独立的执行契约调用。

## 原生 `.flow` 实施路径

业务定义为 [raptor-review.flow](../../apps/cli/examples/raptor/raptor-review.flow)。它只携带规则数据与编排声明，不生成或调用 Python/JavaScript/shell 业务脚本；Bash 节点直接运行固定的 Semgrep 命令。实施步骤为：

1. Write 节点保存选定的 6 条 RAPTOR Python Semgrep 规则 YAML。规则来源和业务指令均随 Flow 版本固定。
2. Bash 节点在已授权工作区直接运行 `semgrep scan --json --strict` 及固定本地规则路径。stderr 写入诊断文件，stdout 保持完整 JSON；工作区由运行绑定选择，不将任意用户路径插入 shell 程序。
3. 节点输出 Schema 要求 `exitCode` 为 0、`truncated` 为 false；独立 `scan-errors` 节点还要求扫描 JSON 的 `errors` 是空数组。扫描器错误或输出不完整时阻止分析；这不改变 Bash 为 Agent 保留非零退出码的通用语义。[端口验证](../../backend/llm-flow/src/flow/port-contract.ts#L44)在输出供下游消费前执行，内联定义由 [run-catalog.ts](../../backend/llm-flow/src/flow/run-catalog.ts#L37) 注册。
4. transform `pick` 使用 `path: ["stdout", "results"]` 提取 Semgrep findings。[operations.ts](../../backend/llm-flow/src/flow/operations.ts#L210) 已支持路径遍历时解析上游 JSON 文本，无需新 parser 脚本。
5. transform `batch` 生成命名函数实参组，例如 `batchSize: 1, parameter: "findings"` 得到 `[{findings: [finding]}]`。`builtin.flow@2` 的 `parameterSets` 为每组创建隔离的内联分析函数，`maxConcurrency` 限制同时运行的组数；见 [function-batch.ts](../../backend/llm-flow/src/flow/function-batch.ts#L17)。
6. 内联函数以原生模型节点实现初始 A–D 分析、独立盲审 consensus、judge 和可选修订，再由主 Flow 确定性汇总。模型传输使用 `responseFormat: text`，由本地 `outputValidation.schema` 验证 JSON；每个模型节点最多补发 2 次格式修复，仍无效则失败。连接槽分别表达分析与复核角色，可绑定不同模型。
7. 将定义导入并发布到内部 Flow 库，保存 Agent 的 `execution.kind=flow` 绑定及所需参数/连接；通过该 Agent 的真实调用取得扫描、各模型阶段和最终输出。

[Semgrep 官方 CLI 文档](https://docs.semgrep.dev/cli-reference)区分 findings 与执行错误：`scan` 未启用 `--error` 时，存在 findings 不导致失败；`--strict` 让配置或扫描警告对应的错误产生非零退出码。这允许 Flow 明确区分“发现问题”和“扫描失败”，无需自行解释退出码文本。

现有 JSON pick 对坏 JSON 不会产出有效数组，后续 batch 会失败；合法 `results: []` 则生成空实参组。应保留这两个场景的区别，不能将解析失败转换为零 findings。当前 Bash 有输出容量上限；超限须失败或通过后续通用资产机制处理，不能静默截断后继续判定。

用户消息通过 `${input.prompt}` 与 Flow 的 `requirements` 策略参数一起进入各 finding 的模型输入和最终报告，不进入扫描 shell 命令。初审和盲审只共享 finding、源文件和审查要求，盲审不接收初判；Judge 显式接收两份结果。

Judge 要求修订、初判与盲审的 verdict/exploitability 不一致、Judge 的 agreement 不是 `agree`，或存在 unresolvedQuestions 时，进入最多一次语义修订。语义修订与 JSON 格式修复是两个独立限制。没有争议则保留初判，最终 JSON 同时保留原始 finding、各角色结论、修订状态和局限。

原生执行已由绑定已发布 Flow 的 Agent 真实跑通，不再只有原语连接证据。[结构化报告](fixtures/raptor-report.json)保留实际阶段结果；这证明所选规则与审查链成立，不表示已运行 exploit 或完整上游 `/validate`。

## 真实执行暴露并修复的通用问题

第一处是协议准入与实际调用不一致。连接未显式写 `protocol` 时，实际驱动会继承模型偏好或 Provider 默认协议，Flow 旧准入却将其判为未知。现在 [resolveModelProtocol](../../libraries/driver-llm/src/types/protocol.ts#L8) 按“显式连接 → 实际选中模型的 preferredProtocol → Provider defaultProtocol”解析，Flow 准入、快照、恢复与 [llm.chat 执行前复验](../../backend/kernel-adapters/src/effects/llm-chat-effect.ts#L104)使用同一规则。快照只保存实际准入模型的有效协议，默认或偏好变化后拒绝继续请求；未知协议仍拒绝，用户源配置不被回填或改写。

第二处是 Anthropic 协议的并行工具结果配对。模型同一轮发出多个 `tool_use` 时，旧转换器将各个 tool result 拆成多个 user 消息，后端据此拒绝下一轮。现在 [appendToolResult](../../libraries/driver-llm/src/providers/anthropic.ts#L353) 将相邻结果合入紧随 assistant 工具批次的同一个 user content，保留各自 `tool_use_id`，不跨 assistant 轮次合并；见[并行工具回归](../../libraries/driver-llm/tests/anthropic-regressions.spec.ts#L23)。真实 Flow 保留 Read/Grep，成功覆盖模型选工具后的后续请求。

## 两条远程执行路径

### 项目进程承接外部 Tool

现有 [createProjectProcess](../../libraries/nestos-node-driver/src/project-process.ts#L6) 把 native shell 的启动替换为 `ProjectClient.exec`，校验请求挂载与项目授权一致；[ProjectClient](../../libraries/nestos-node-driver/src/projects.ts#L16) 传递项目 ID、修订、epoch 和 requestId。进程生命周期继续由 [HttpProcessSession](../../libraries/nestos-node-driver/src/files/process.ts#L9) 管理：启动响应丢失后按 ID 尝试取消，不重放启动；SSE 订阅状态；释放时确认进程清理。

原生 `.flow` 的 Bash 扫描节点可以复用当前项目 shell，但需要同时满足：

1. 执行节点和隔离环境内存在 Semgrep 及其运行依赖；仅宿主安装不代表项目沙箱内可见。
2. Flow 的 Write 节点、Semgrep 扫描节点和后续文件读取必须使用同一授权项目及文件视图，规则文件与诊断文件才能互相可见。
3. 目标与产物目录属于授权项目挂载，读写模式与节点项目修订一致。
4. 模型节点使用已冻结的 itookit 连接；扫描器若另需网络，必须由执行节点授权，不假定本机配置自动传到节点或沙箱。
5. 单次远程进程的现有上限为 300000ms：客户端 [process.ts](../../libraries/nestos-node-driver/src/files/process.ts) 和服务端 [policy.rs](../../tools/nestos-node/src/plugin/process/policy.rs) 均有约束。更长的模型审查需要拆分阶段，或新增持久 start/status/结果核对能力；提高 Flow 的 `timeoutMs` 本身不能突破此边界。

现有进程 shell 处理一次命令的运行与停止，Flow 持久记录负责阶段和函数任务恢复。Bash 没有已实现的业务回执核对器，worker 丢失后不能因 Semgrep 通常只读而自动重放所有 Bash 命令；应保留通用 Effect 的结果未知语义，按实际副作用核对。

### 原生 harness 承接交互式 RAPTOR

[projectHarness](../../backend/app-core/src/projects/remote-mounts.ts#L379) 读取远程项目，核对授权后创建 project-scoped `HarnessClient`。该客户端已支持 profiles、commands、create/resume、turn、事件、交互和 operation；[HarnessConversation](../../libraries/nestos-node-driver/src/harness/conversation.ts#L18) 已区分提交接纳、原生执行状态和观察失败，并持久化 pending 与 submittedTurnId。

这条链适合运行 RAPTOR 的原生交互体验，但当前只接通远程会话控制。现有 [AgentExecution](../../backend/kernel-adapters/src/llm-management/contracts/agent.ts#L15) 只有 `agent/flow`；[RemoteHarnessAgent](../../backend/app-core/src/projects/remote-agent-catalog.ts#L4) 是发现目录，尚未成为 Flow/Composite 可持久调用的执行目标；[builtin.agent](../../backend/llm-flow/src/flow/builtin-plugins.ts#L106) 仍生成 `llm.agent`。工具箱中看得到远程 Agent，不能推导出已有编排桥梁。

## 上游交互式 harness 的兼容边界

本节用于解释完整外部 harness 如何加载环境，属于未来远程执行兼容研究；它不参与此次无外部脚本的 Flow 成功标准，也不能代替原生 Flow 验收。如果另行运行上游原版交互式 RAPTOR，应显式区分“执行项目”和“被审查项目”：

```text
NestOS 执行项目 root = RAPTOR checkout
原生 session.cwd = /projects/<execution-project-id>
目标仓库 = 该执行项目的显式附加挂载（通常只读）
报告目录 = 该执行项目的授权可写目录
运行绑定 = 执行项目身份 + 目标项目身份/修订/路径 + 输出位置
```

profile 使用 `kind=claude`、`command=claude`。实际 cwd 是 RAPTOR checkout 对应的项目路径，RAPTOR 配置与相对脚本能按原生规则加载；目标通过 `--repo` 或原生命令参数明确传入。不要把执行 cwd 伪装成被审查项目，也不要让 wrapper 私自切换 cwd 后仍保存原 cwd。

这与已有历史授权兼容：[Claude history](../../tools/nestos-node/src/plugin/harness/drivers/claude/history.rs#L35) 根据真实 transcript cwd 调用项目 `resolve_cwd` 核验，不能为了读到 RAPTOR 历史而放宽到任意宿主目录。执行项目与目标项目的双重绑定仍需在调用记录和产物索引中表达；当前尚未完成该模式的端到端验收。

必要运行条件包括：

- checkout 中的 `.claude`、`CLAUDE.md`、`libexec` 等必须完整可见；启动 hook 会写 env 文件和启动信息，不能简单把整个运行目录当成只读代码目录。
- [raptor-session-init](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/libexec/raptor-session-init) 依赖可用 Python 与 RAPTOR 依赖，负责写 `RAPTOR_DIR/PATH`；它并不替代 launcher 的全部预检、会话项目播种和 trust 流程。
- 原生 Claude 的配置 home、认证、Python 虚拟环境、工具链、证书与网络均须在沙箱内可用。当前 [ProjectLauncher](../../tools/nestos-node/src/plugin/projects/runtime.rs) 只额外挂载 harness 单个 executable 和 home，其他运行依赖须经已授权项目挂载或系统安装提供。
- 原版 `bin/raptor` 负责的预检、目标绑定和会话注册必须明确执行或以已验证的兼容方式替代；采用 plain Claude 只能声称加载原版配置，不能声称完整复现 launcher。

### 为何不能直接 `command=bin/raptor`

[Claude 驱动](../../tools/nestos-node/src/plugin/harness/drivers/claude/process.rs#L205) 给配置的 executable 追加 stream-json、stdio 权限协议、session ID/resume 等参数。[RAPTOR launcher](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/bin/raptor#L594) 使用自己的参数解析器：`-p` 是 RAPTOR project，未知 `--flag` 逐个透传，而后面的普通 token 被视为目标。`stream-json`、`stdio`、`manual` 和 session UUID 因而可能被误作目标，无法保证原生协议参数保持成对。

此外，项目沙箱只映射单个 executable 时，launcher 从自身位置定位的 checkout、Python 环境和脚本也未必存在。直接更改 `command` 既不能证明协议兼容，也不能证明运行环境完整。

可复用的后续能力是宿主受信 profile 的固定 args、显式 env 和只读 runtimeResources，统一进入沙箱装配并禁止覆盖项目、harness home 与系统目录。这些能力尚未新增；它们也不会自动将依赖 cwd 的原版 RAPTOR 变成可移植 bundle。任意 `launchCwd` 不是当前必要前置，不能以放宽 cwd 授权解决环境加载问题。

## 远程执行连接实施

`HarnessExecutionConnection` 已实施，定义位于 [harness-execution.ts](../../backend/kernel-adapters/src/llm-management/contracts/harness-execution.ts)。配置引用已有 `nodeConnectionId`、`projectId` 与 `profileId`；Agent 使用 `execution: {kind: 'harness', connectionId}`。连接具有 CAS 修订和删除墓碑，入队冻结项目授权，执行前重新核验，模型不能自行指定服务地址、可执行程序或新增挂载。

普通会话、Flow 的 `builtin.agent` 与 Composite 远程成员使用同一 Harness Program/Effect；Composite 主持者仍使用本地模型，远程主持者因缺少本地委派工具桥梁而明确拒绝。远端配置负责 native 模型、工具与审批，不注入本地默认模型或本地 Bash 授权。App、CLI 和应用 RPC 已接线，设置界面支持按授权项目/profile新建与编辑连接。配置步骤、可执行 `.flow` 示例、API 和限制见[远程 Harness 执行连接](remote-harness-connections.md)。

执行复用 `projectHarness(requireRegistered: true)` 和项目限定 HarnessClient。创建会话、提交 turn、回答交互及 interrupt 均在外部修改前持久化稳定 requestId，恢复查询原身份回执。一个长活 Effect 覆盖原生执行和人工等待，Program 通过持久 Interaction/响应通道桥接审批与输入；取消等待原生 turn 的权威终态，无法证明时保留 cleanup-pending。精确完成证据和该 turn 文本核对后才成功，返回 turnId 只表示接纳。

该实现是通用原生 harness 远程编排能力。它不代表完整 RAPTOR 已迁至远程，也不新增 Firecracker 或原版 RAPTOR launcher 的环境兼容层。真实验收使用安装的 Claude Code、真实 nestos-node、授权项目与 bubblewrap 沙箱，模型端为隔离的本地固定 Anthropic peer，不能据此宣称真实云模型审查。具体案例与故障证据随本轮机器记录归档。

本轮[机器记录](fixtures/remote-harness-evidence.json)将普通测试与真实网关证据分开：CLI的Agent引用与仓库原版 [remote-harness.flow](../../apps/cli/examples/remote-harness.flow) 均exit 0；AppRuntime普通Agent、并行Flow、Composite各完成两轮，输出与持久journal一致。实际Kernel丢提交回复后进入indeterminate，经显式核对继续成功，同一native session/turn保持不变，create/turn/receipt各一次；独立Provider测试另覆盖磁盘CAS状态关闭重开，不将其称为Kernel进程重启。

真实原生容量验收完成20个独立会话后恢复首会话并再执行一次，加载进程最高16，旧历史与精确回执保留。修复采用确认退出后的空闲会话回收，活动、待审批或被借用的进程不会被淘汰。旧空输出、容量、CLI授权/扩展和Effect包装层失败均保留；不能由最终成功反推早期尝试也成功。

后续[真实模型记录](fixtures/remote-harness-real-model-evidence.json)已补齐普通Agent、并行Flow、Composite和Kernel丢回复核对的实际推理：主持为 `deepseek-v4-flash`，原生Claude Code经用户兼容网关的usage实际返回 `deepseek-v4-pro`。模型读取隔离测试文件、复制未进入prompt的随机挑战值，并区分两项注入问题和安全实现。CLI原版远程 `.flow` 与Agent引用也通过，固定响应的早期记录继续独立保留。此成功仍不等于完整RAPTOR远程迁移或真实跨机器节点验收。

## 隔离加固与 Firecracker 的位置

该 RAPTOR 基线没有 Firecracker 执行后端。仓库中的 Firecracker 命中来自 [SCA 校准样本](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/packages/sca/calibration/project_samples.py#L373)和对应扫描数据，表示被扫描项目。RAPTOR 当前实际隔离依据是[官方 sandbox 文档](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/docs/sandbox.md)与 `core/sandbox`：namespaces、Landlock、seccomp、rlimits、受限环境、egress proxy，以及按能力探测确定的 containment floor。

最值得借鉴的是“要求的边界与实际交付的边界”一起记录，而不是添加一个配置枚举就声明安全：

| 机制 | 当前 itookit / nestos-node 基础 | 应采用的通用改进 |
| --- | --- | --- |
| 隔离最低要求与实际探测 | `ProjectLauncher`、bubblewrap 启动探测、固定项目挂载 | 运行准入冻结所需隔离能力，启动验证实际能力；达不到 floor 则给出具体原因，降级不能由模型自行接受 |
| 凭据边界 | 驱动清理环境并选择继承认证变量 | 将可信控制面与不可信工具进程区分；后者通过受限模型代理访问，不直接继承控制面密钥和 home |
| 网络出口 | 项目网络开关与宿主网络配置 | 增加按能力和操作绑定的出口约束、预算与诊断；“允许联网”不能等价为任意目标可达 |
| 进程树取消 | native process group、远程 process cancel、原生 interrupt | 核对整棵执行树或执行容器停止，保留未知结果；不能只杀父进程后报告完成 |
| 资源配额 | 超时、并发和部分平台预算 | 在实际执行边界约束 CPU、内存、进程数、磁盘和输出，持久化耗尽原因；Flow token 限额不是这些配额 |
| 产物回收 | 工作区文件和工具产物引用 | 停止后再核对与收集，禁止把未确认终态的输出标为最终报告 |

Firecracker 可作为未来 `ProjectLauncher`/远程执行 worker 的一种后端。依据 [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)，它提供 KVM microVM 的 VMM；[生产宿主要求](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)还要求宿主加固、隔离及维护。项目快照传入、guest worker、harness 协议、凭据代理、产物导出、配额与故障核对仍须由集成层实现。

建议的责任位置是宿主保留 nestos-node 控制面、授权和 operation 记录，guest worker 运行 RAPTOR 工具链及 harness；Flow 仍调用同一项目执行能力。guest 不持有宿主控制面凭据。节点取消要停止 worker/VM 并核对终态；VM 消失而结果未核对时保留未知，不能自动重复模型或外部副作用。此方案是后端提议，当前仓库没有相应实现与验收；Flow 节点不直接配置 hypervisor 操作或 RAPTOR 专用 VM 字段。

## 回执、审批与取消的验收边界

nestos-node [receipts.rs](../../tools/nestos-node/src/plugin/harness/receipts.rs#L22) 使用临时 SQLite，回执跨运行时替换保留，但节点进程退出后删除，新进程使用新 epoch。相同 epoch 内查到已提交回执可避免重放；epoch 变化后不能把找不到旧回执解释为“从未执行”。必须结合原生 session/turn 历史和 RAPTOR run 产物核对，无法核对则保留结果未知。

平台持久记录至少应关联执行绑定、稳定请求身份、native session/turn、原生等待交互、事件游标与产物引用。远程原生工具审批须转换为平台可恢复的 Interaction，回答时保留 nativeRequestId 和响应回执；发现命令能力不授予执行权限。

取消先发送原生 interrupt 或进程 cancel，再等待权威状态确认停止。关闭面板、客户端断网、AbortSignal 触发或 SSE 断开均不是停止证明。无法确认停止时不能重跑、释放执行资源并报告成功取消；原生 turn 完成但产物核对失败时也须保留原生已执行事实。

| 验收项 | 必须取得的证据 | 当前结论 |
| --- | --- | --- |
| 真实规则扫描 | Flow 写出的规则、Semgrep 进程、退出码、findings 和节点结果对应 | 已验证 6 条 Python 规则，命中 1 条 insecure-tempfile，扫描无错误 |
| 原生模型审查 | 每个 finding 的初始分析、consensus、judge、可选修订及汇总对应真实模型调用 | 已完成一次三个独立角色与修订的成功验收；再次执行遇到坏 JSON 时按修复上限失败，见各次机器记录 |
| Agent 绑定执行 | Agent 保存的发布 Flow 身份/修订、连接固定、真实调用和最终结果对应 | 已通过真实 Agent 调用，根 Task 为 succeeded；见[机器记录](fixtures/raptor-evidence.json) |
| Composite | 协调者真实分配成员任务、成员调用授权工具、隔离上下文、汇总产物 | 真实DeepSeek主持者与实际模型远程成员已贯通；RAPTOR业务专家团队待验收 |
| 远程项目进程 | 真 nestos-node 的授权、依赖可见性、产物读取、失败分类、取消确认 | 通用路径存在，RAPTOR 真节点待验收 |
| 原生 RAPTOR harness | 正确执行项目 cwd、原生 commands、startup hook、目标绑定与历史恢复 | 可行方案，尚未端到端验证 |
| 请求结果未知 | 丢启动/提交响应后按原身份核对，不自动二次执行 | 已实现稳定子操作 journal 与回执核对，mock故障矩阵覆盖；真实网关故障注入单独记录 |
| 节点重启 | epoch 改变后核对 native 历史与 RAPTOR 产物，不能依据回执缺失重放 | 尚无完整跨节点重启桥梁 |
| 审批恢复 | 平台与 native 交互身份、响应回执、重开后的等待状态一致 | 已实现长活 Effect、持久 Interaction 与原生响应回执；真实审批和审批中取消已通过，完整任意崩溃点矩阵不在本轮结论内 |
| 日志与错误 | 操作、阶段、结果、分类、耗时及稳定 ID；不记录正文或凭据 | Harness准入、执行、核对、未知与取消均有安全分类；mock日志脱敏、真实拒绝和丢回复已覆盖 |

本次原生用例的规则、模型与 Agent 绑定链已有成功证据，最终归档状态以机器记录中的各次尝试和最后验收为准。远程执行连接按独立真实网关证据验收；完整上游 RAPTOR 原生会话和业务专家团队继续单独核对，不从本地 Flow 或通用远程成功推导完整 RAPTOR 远程完成。

## 原生用例执行证据

[机器记录](fixtures/raptor-evidence.json)与[结构化报告](fixtures/raptor-report.json)分别承载执行证据和业务结果。真实验收使用隔离 profile、真实 Semgrep 和已配置默认连接，未改写日常配置。最终定义的成功记录时间为 `2026-10-22T17:38:42.251Z`：6 条原始规则命中 `raptor.python.insecure-tempfile`，初审、盲审、Judge 和一次 revise 完成，根 Task 为 `succeeded`，9 次模型 HTTP 响应均为 200。三个角色均为 `deepseek-v4-flash`，属于独立上下文的角色复核，不是不同模型家族的投票。

归档同时保留一次较早定义的真实失败：扫描、初审、盲审和 Judge 已完成，但 revise 在 2 次格式修复后仍返回无效 JSON，根 Task 明确失败；该次 13 个模型 HTTP 响应都是 200。最终定义收紧各阶段回复长度，并保留原有 Schema 与修复上限，随后真实复验成功。HTTP 成功不保证业务输出符合 Schema，真实模型也不保证每次生成合法结构；失败不能转换成空结论或成功报告。每次尝试应独立归档，保留成功与安全失败的区别；后续复验和最终状态以机器记录为准，不宣称重复运行必然成功。

成功记录的发布身份为 `raptor-review@1`，摘要 `wln6uk`，根 Task 为 `task_323ec09e-0abc-4284-b548-1689a1347587`。最终结论为 API 使用真实存在，可利用性为 `uncertain`，不把没有调用点的测试片段称为已验证可利用漏洞。

归档记录关联原生 Flow 定义摘要、规则来源与摘要、目标摘要、Agent/发布修订身份、任务状态、请求元数据和最终报告；凭据、请求正文与用户输入正文不写入证据。报告保留示例 finding 的审查判断，不能将模型判断等价为已完成动态漏洞验证。

[原生回归](../../apps/cli/tests/raptor-native-flow.test.ts)包含 12 项普通测试和 1 项显式开启的 live 验收。普通测试覆盖无修订/一次修订、上下文隔离、用户消息传入、无 findings、非零退出、超限、坏 JSON/错误结构/非空 errors、JSON 修复预算以及 Judge 分歧/未决问题触发修订；它们使用可控扫描器和模型响应。live 项单独启用真实扫描与模型，证明发布 Flow 的 Agent 调用；两类证据分别报告。

先前外部 CLI 包装原型已撤出工作树，其结果不参与本次交付判断。完整 RAPTOR、动态多模型面板、RAPTOR Composite 专家团队和 Firecracker 后端均未因本地用例成功而视为交付；通用远程执行连接的实施与独立验收见上文。
