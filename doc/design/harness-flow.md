# llm-flow 的 Flow / Node 定义与 Harness 覆盖分析

## 2026-10-22 当前实现复验

此前章节保留历史核查背景；组合调用以当前 `builtin.flow@2` 为准。它已提供显式实参、命名返回、参数与变量作用域、上下文隔离和依赖版本锁定。旧文中的“没有输入/输出签名映射”不适用于该版本。当前仍没有独立子 Run 生命周期：子流程运行策略以及调用级 retry/compensate/assign/budget/capabilities 会明确拒绝，不能视为独立资源容器。

| 需求 | 当前实现与边界 |
| --- | --- |
| 确定性函数/工具调用 | `builtin.flow@2` 和 `builtin.tool@1`；Agent 的模型工具循环是另一入口 |
| 串联与并行 | 依赖边、全局并发、静态 taskGroup；动态任务使用有界 spawn |
| 同步汇合 | join all/any/first-success/quorum，剩余任务 continue/cancel；OR 条件不等于抢先汇合 |
| 循环 | 显式反馈边、有界 loop、每轮独立任务身份与同轮数据绑定 |
| 与／或／非 | SerializableExpression 及 YAML 条件支持 and/or/not；可视 FlowCondition 只有 all/any 与比较，没有直接 NOT |
| 多组参数函数调用 | `builtin.flow@2.parameterSets` 接收运行时参数对象数组，公共参数可复用；整次调用有界并发、每组作用域隔离、按输入序返回，空集合返回空数组。仍不支持嵌套 taskGroup 或独立子 Run |
| 图片与文本分批 | 通用 `builtin.transform.operation: batch` 接收任意内容数组或原组，按大小合并分批或保留组界，再调用同一个 Flow 函数；图片持久为输入资产 |
| 单文件函数定义 | `functions` 内嵌完整 Flow，按定义处词法作用域解析，主文件发布递归冻结与锁定依赖，恢复和归档保留内联内容 |
| Agent 调用内部 Flow | Agent.execution 引用任意注册的已发布定义，默认跟随最新发布或固定修订；文件缺失禁用新调用，prompt 与其他参数分离，接纳请求冻结 Flow 和安全连接选择 |
| 耐久执行 | Kernel 事务、租约与 fencing、持久等待、结果核对；外部副作用不自动获得 exactly-once |

此前 Anki 的两个入口是当时的业务预设划分，不能归因为引擎缺少 OR；现在已合并成应用资源层的单一主文件及内联函数，业务 Tool 保留在外部包。本次多级分支实测发现了真实调度缺陷：未选分支的后继误执行，以及整个函数跳过后共同汇合不执行。修复与回归见 [控制节点](flow-control-primitives.md)。本次还解除整批 20 张及工具结构化结果固定 100k 的限制，并修复跨单元同名身份；目前业务定义限制总量最多 1000 张、模型每批最多 20 张。完整图片验收逐项核对来源与包内笔记，不能用“产生了 apkg 文件”作为充分证据。

与其他 harness 的对照采用官方源码或文档：

- [Codex 工具并行调度](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/parallel.rs) 使用工具并行声明及读写锁门控；图并发额度不能替代共享资源互斥。
- [Claude Code 执行循环](https://code.claude.com/docs/en/how-claude-code-works) 与[子 Agent](https://code.claude.com/docs/en/sub-agents) 是模型驱动的工具调用和隔离上下文协作，固定业务分支仍应由 Flow 明确表达。
- [pi agent-loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts) 分离校验、并发执行与按调用顺序记录结果；全局和单工具执行模式共同决定是否串行。
- [DeepSeek Harness 工具调度](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/tool-calls.ts) 使用有界池和独占屏障，取消后收敛在途调用并保留调用结果配对；[DSH Workflow](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow/README.md) 的 JS 条件、循环、parallel/pipeline 更直接，但契约明确不提供 journaling/resume。不能用它替换本项目已有耐久保证。

本轮基础证据：durable-kernel 全包 15 文件 402 测试通过，包含真实 LocalFS/SQLite、多进程竞争、SIGKILL、等待注册竞态、消息回执与物理清理恢复；CLI 独立崩溃矩阵 23 测试通过，覆盖已提交循环不重放、动态扩图、委派汇合、预算、调度检查点，以及结果未知的媒体请求不自动重发。测试证明其覆盖的不变量，不证明所有外部设备或任意分布式存储正确。

本次批量图片运行发现并修复的通用问题：

- 分支跳过传播至稳定态；自动引用边以 `dependencyOnly` 保留数据等待，不重新激活未选分支。函数输入屏障不作为额外分支入口。
- 已失败依赖在模板解析前交给 Kernel 的依赖事务处理，避免 `Missing Flow reference` 遮盖原始错误。函数返回纳入同作用域的动态成员，动态任务失败或取消时不能先发布成功结果；显式容错和 detached 策略保持原契约。
- 动态节点可回连 spawn 尚未启动的直接下游汇合节点；整批绑定后检查越权、闭环与幂等，恢复不会重复扩图。
- 未使用的可选连接允许无 `connectionId`，检查点解码不再阻止图片校对后的恢复；损坏字段仍明确报错。
- 工具结构化结果尊重工具声明的大小上限，平台最高 16 MiB 字符；超限明确失败，禁止把截断展示数据交给下游。Context GC 区分输入图片资产和上下文内容引用，真实损坏的内容引用仍阻止删除。
- 条件路径安全读取数组的长度与索引，空图片数组走文本分支；只读对象自身属性，不读取原型。`outputValidation.schema` 独立于模型协议执行本地校验和有界修复，`json_object` 也能在批次内修复漏字段；诊断记录错误路径与数量，不记录模型正文。

已终结 Run 的根 Task 不可原地复活。图级 retry 仅支持仍可恢复的非终态 Run；终态失败应建立新 Run，不能改写检查点伪装恢复。真实模型漏字段时，严格汇总会阻止打包，这属于正确的失败传播；模型语义正确性和任务持久执行正确性需要分别验收。

此前 llm-flow 全包 36 文件 458 测试、llm-tasks 73 测试、llm-context 35 测试通过。真实图片执行与最终 312 笔记/624 复习卡证据见 [Anki 验收](anki-flow.md)；18 个动态补全任务的实测并发峰值为 4，校对恢复和终态恢复均没有重复模型请求。

随后解耦修订曾将 Anki 初始恢复项一并移除；按用户要求已纠正：单一声明源回到 `app-core/src/presets/anki-generate.json`，产品目录和系统恢复提供一个 `anki-generate.flow`，业务 Tool 仍在外部包且核心没有业务分支。多组输入建模为同一 Flow 函数的多组实参；分批由通用 transform 完成，新定义不依赖 `anki.batch`。调用模板、参数作用域与运行图通过同一 Kernel 检查点恢复，损坏的参数组索引或输入结构明确拒绝，不能回退默认参数继续执行。

最终核心全包 42 文件 529 项通过，覆盖函数串/并行、按序返回、多命名参数、内联词法定义与 digest、嵌套调用、变量隔离、循环、路由、动态 spawn、整批校验、模板冻结和恢复。应用层 114 文件 709 项通过；CLI 通用调用、混合图片文本及实际 SIGKILL 恢复共 5 项通过。外部单文件新定义的 16 项集成和孤立目录完整模拟 CLI 验收通过，实际生成媒体及 Rust 包，验证 combined/grouped 与恢复不重复请求；此前真实模型证据仍对应其当时冻结的定义。命令、范围和源码摘要见[验收记录](fixtures/flow-parameter-calls-evidence.json)。

随后完成通用 Agent→内部 Flow 入口：Agent 只保存引用，Flow 不反向声明 Agent；发布变更供后续新请求使用，删除文件禁用新调用，已接纳的队列与运行保留原定义。`${input.prompt}` 是只读运行输入，其他参数按 Flow 签名校验；图片表单、连接覆盖、归档依赖和损坏快照拒绝均接入。最新 llm-flow 全包 43 文件 543 项、llm-session 41 文件 326 项、app-core 117 文件 731 项通过；真实发送表单和连接配置变更使用本地模拟服务验收。具体范围与实际 Run 构造时的间接身份解析边界见[Flow Agent 验收记录](fixtures/flow-agent-evidence.json)。

系统恢复清单现包含新版作文与单一 Anki Flow。旧启动逻辑同时播种两代作文；当前新版统一命名为 `essay-review`，停止新装 `essay-review-isolated`。两种已有文件、发布版本和历史引用保留，同名旧版不自动覆盖。真实系统恢复页面覆盖 Anki 可见、单主文件及三个内联函数、重复恢复保留修改；外部 16 项集成和完整本地模拟 CLI 均使用迁回应用的同一 JSON 源通过，覆盖文本/多图、combined/grouped、实际打包与校对恢复，无付费模型请求。

以下为此前核查记录。

当前新图采用独立的 route、taskGroup、join、aggregate@3、loop 控制节点；作文评审模板已迁移。实现、策略默认值及边界见 [Flow 控制节点](flow-control-primitives.md)。下文 route@2/@3 的派发模型保留用于旧定义兼容。

2026-09-16 补充：已接通 CLI/UI 的 MCP/tools/Skill 装配、隔离任务 Skill 上下文与批准恢复，并新增会话「流程输出」入口。当前能力、边界及验证见 [Flow 能力与输出](flow-capabilities-and-output.md)。下文核查记录保留当时的测试范围。

构建产物及真实模型的复验见 [CLI 能力与持久化实测](flow-cli-capabilities-verification.md)：修复 MCP stdio 的 ESM require 问题；CLI 已保存 Kernel 交互和结果，并通过幂等投影生成聊天 History Round，包含节点、工具、Skill 来源及用户交互身份。

2026-09-21 补充：编码工具执行与 Agent 错误修正链路已补齐第一批实现，见本文末尾「Coding harness 第一批实现」。这一批不改变 Flow 的编排职责与文件写入的并发保证。

> 核查日期：2026-09-15。依据当前工作树源码与包内测试；这是现状分析，不是新增功能承诺。
> 范围：`backend/llm-flow`，以及它公开的 `llm-flow/contracts` 类型。规范依据为 [Harness Core](durable-harness-core.md)、[Protocol](durable-harness-protocol.md)、[Storage](durable-harness-storage.md)、[Resources](durable-harness-resources.md)、[Cache](durable-harness-cache.md)；跨包验收边界见 [Durable 证据映射](durable-harness-evidence.md)。

## 1. 结论

具体需求推演与已实现的结构化派发方案见 [作文四维评审 Flow](essay-review-flow.md)：输入补全、显式轮次、分支汇合及同版本评分。

**当前 llm-flow 已具备本地 durable harness 所需的主要图编排能力，但不能判定完整满足所有 Harness 目标。**

- 已实现：静态依赖、条件路由、有界循环、动态扩图、结构化委派、人工等待、失败策略、重试、调度恢复、Run 所有权隔离和工作区收尾。
- 分层满足：Task 状态事务、Effect 回执与未知结果处理、资源授权、共享数据和 Session 生命周期由 `durable-kernel` 提供；LLM/tool 循环由 `llm-tasks` 提供；会话上下文与设备装配由上层负责。缺少独立 cache/resource 节点不等于缺少这些内核能力。
- 尚有边界：子 Flow 只是图展开；预算不是运行前预留的全局硬额度；补偿提交不等于严格串行回滚；声明端口与实际输出有差异；定义存储接口不提供原子 CAS；真实跨主机与设备故障不能由本包测试证明。

若要求是“在已装配 Kernel、存储和设备的本地宿主中，执行并恢复多 Agent 工作流”，当前实现有较充分证据。若要求是“任意 Flow 均具备独立资源域、严格预算与完整故障保证”，目前仍不满足。

## 2. 当前定义哪些 Flow

本包提供通用定义、编译和执行设施，并提供可配置的 [作文评审示例](../../backend/app-core/src/presets/essay-review.json)。示例使用通用节点配置，不在运行器中硬编码作文业务。

### 2.1 三种表示与运行身份

| 表示 | 内容与用途 | 源码 |
|---|---|---|
| `FlowDraft` | 可编辑定义：nodes/edges/layout、参数、连接槽、Agent 默认值、runPolicy、draftVersion | [flow-definition.ts](../../backend/llm-flow/src/contracts/flow-definition.ts) |
| `FlowRevision` | 发布版本：revision/digest，冻结节点、边及默认配置；不含编辑布局 | 同上；[flow-definition-store.ts](../../backend/llm-flow/src/flow-definition-store.ts) |
| `WorkflowTaskSpec[]` | 声明式工作流 DSL，字段兼容 CLI 的 snake_case；编译出 nodes/edges | [types.ts](../../backend/llm-flow/src/flow/workflow/types.ts)、[compile.ts](../../backend/llm-flow/src/flow/workflow/compile.ts) |
| `DagRunSpec` | 执行输入，包含展开后的图及运行策略；不是新增业务 Flow 类型 | [to-dag.ts](../../backend/llm-flow/src/flow/to-dag.ts)、[executor.ts](../../backend/llm-flow/src/flow/executor.ts) |
| Run / 根 Task | 每次执行以 `flow.aggregate` 根 Task 为持久锚点；节点每次迭代有独立 Task 身份 | [programs.ts](../../backend/llm-flow/src/flow/programs.ts)、[scheduler-checkpoint.ts](../../backend/llm-flow/src/flow/scheduler-checkpoint.ts) |

`.flow` 保存草稿，revision 保存为该文件的 assets。`saveRevision` 校验图和 digest，拒绝覆盖同版本的不同内容。恢复使用已保存的执行图和检查点，不重新读取最新草稿。

```mermaid
flowchart TD
    D[FlowDraft] --> R[FlowRevision]
    R --> C[flowToDag：默认值、连接槽、子图展开]
    W[WorkflowTaskSpec：agent / route / spawn / supervisor / node] --> K[compileWorkflow + agentFactory]
    C --> S[DagRunSpec]
    K --> S
    S --> E[DurableFlowExecutor]
    E --> A[flow.aggregate 根 Task]
    E --> N[每个节点 / 迭代的 Task]
    E --> P[调度检查点与租约]
    N --> H[Kernel：状态、等待、Effect、授权]
```

### 2.2 能表达的编排模式

| 模式 | 当前表达方式 | 语义边界 |
|---|---|---|
| 顺序、并行、fan-in | nodes/edges；DSL `depends_on` 与输出引用 | 静态依赖主要为 all-of；控制边不注入上游数据 |
| 条件分支 | `builtin.route` | exclusive / multicast / fallback；产生边激活、禁用指令 |
| 有界循环 | 回边 + `config.maxIterations`；DSL `max_iterations` | 图不再是数学意义上的纯 DAG；执行器识别回边并创建迭代实例 |
| Supervisor / worker | DSL `supervisor.workers/max_rounds` | 展开为主管 Agent、route、worker 回边；不是独立插件 |
| 静态模板的动态扩图 | `builtin.spawn` | 运行时应用事先声明的 nodes/edges，不等于 LLM 自行生成任意代码 |
| LLM 动态委派 | Agent `delegation`；兼容旧 `subtasks` | LLM 声明 payload，执行器按模板创建有界子任务 |
| 组合 Flow | `builtin.flow` 引用 flowId/revision/parameters | 编译时加 id 前缀并接入子图入口/出口；不创建子 Run |
| 人工参与 | `builtin.human` | 持久 interaction，响应后继续 |
| 失败与补偿 | 边 `onFailure`、节点 `retry/compensate` | fail/skip/continue；补偿不是数据库事务回滚 |

DSL 定义 `agent | route | spawn | supervisor | node` 五类任务。`node` 直接携带版本化 plugin/config，可接入 input、route@2、aggregate 等通用节点；旧 spawn 内的子任务仍交给 `agentFactory`，不递归编译所有控制结构。

## 3. 当前定义哪些 Node

### 3.1 十一个内置插件 ID、十四个版本化定义

注册入口：[builtin-plugins.ts](../../backend/llm-flow/src/flow/builtin-plugins.ts)。route 提供 `1.0.0`、`2.0.0`、`3.0.0`，aggregate 提供 `1.0.0`、`2.0.0`，其余版本为 `1.0.0`；插件 id 是可扩展字符串，不是封闭枚举。

| 插件 | 底层 Program | 当前行为 | 主要配置 |
|---|---|---|---|
| `builtin.agent` | `llm.agent@1` | LLM/tool 执行、结构化输出、上下文压缩、委派声明 | agentId、instruction、模型/连接、tools/skills、上下文策略、delegation |
| `builtin.human` | `flow.human@1` | 等待依赖后发起人工输入 interaction | requestId、prompt、schema |
| `builtin.transform` | `flow.value@1` | identity 或按 path 提取字段；不是任意脚本变换 | operation、value、path、outputName、type |
| `builtin.reduce` | `flow.value@1` | 收集输入并展平一层，返回数组或用 separator 拼接文本 | outputName、type、separator |
| `builtin.route@1.0.0` | `flow.value@1` | 解释可序列化条件，激活/禁用分支；输出 selectedEdgeIds/selectedValue | mode、rules、defaultEdgeId |
| `builtin.spawn` | `flow.value@1` | 产出值，并附带 `patch-graph` 图修改指令 | spawn.nodes/edges/idempotencyKey；支持 `$parent`、`$upstream:<id>` |
| `builtin.flow` | 无独立 Program | 必须先经 `flowToDag` 展开；直接创建运行任务会抛错 | flowId、revision、parameters |

新增插件如下：

| 插件 | 底层 Program | 行为及配置 |
|---|---|---|
| `builtin.input@1.0.0` | `flow.input@1` | fields/prompt/initial；校验命名输入，持久等待缺项，合并多次回复 |
| `builtin.route@2.0.0` | `flow.dispatch@1` | branches/mode/maxRounds/maxConcurrency/context/until；独立 Task、隔离 history、本批汇合、按类型跨轮保留结果 |
| `builtin.aggregate@1.0.0` | `flow.value@1` | previous + updates 按键合并，输出 result；与派发控制器共用合并逻辑 |

`flow.aggregate@1` 仍是运行器内部根 Program，与公开 `builtin.aggregate` 节点不同。它等待调度结束和成员任务结果，形成 `{ nodes, failures? }`。`registerDurablePrograms` 还注册 llm-tasks 的 Chat/Agent/Plan Program；注册了 Program 不代表存在同名 Flow 节点插件。

### 3.2 公共字段与配置边界

- 节点定义具有 id/name、plugin/pluginVersion、config/inputs、portSchemas、priority、capabilities、budget、retry、compensate。传统内置 manifest 声明可选的 `maxIterations`；route@2 使用独立 `maxRounds`，拒绝进入旧回边循环。节点还可用 `outputPolicy` 分别控制 Run 输出和会话发布。
- `FlowAgentNodeConfig` 复用 `LlmNodeConfig`，增加 agentId、instruction、delegation；`prompt/model/subtasks` 为兼容字段。Agent 引用、Session history 等完整解析依赖宿主 binder，不能仅凭插件的配置 schema 就断言生效。
- `flowToDag` 应用 Flow 默认值、连接槽和 binder；执行器注入工具、skill 上下文并绑定 Kernel capabilities。配置中的工具名称与已授权的运行能力应分别检查。
- 端口 schema 可按节点声明并随 Run 固定；恢复拒绝宿主 manifest/schema 漂移，但插件可执行代码仍由宿主加载。相同版本与相同 manifest 不能证明代码字节一致。

相关实现：[task-capabilities.ts](../../backend/llm-flow/src/flow/task-capabilities.ts)、[run-catalog.ts](../../backend/llm-flow/src/flow/run-catalog.ts)、[port-contract.ts](../../backend/llm-flow/src/flow/port-contract.ts)。配置继承的跨包契约见 [Flow 执行模型](flow-execution-model.md)。

## 4. 对照 Harness 要求

下表的“已覆盖”只表示存在对应实现与测试，不扩展为任意后端、设备均已验收。

| 要求 | 判断 | 当前证据与边界 |
|---|---|---|
| 可序列化任务状态、声明式等待和外部操作 | 分层覆盖 | FlowValue/Human/Aggregate 使用 Durable Program；Agent 交给 llm-tasks；事务和 Effect 由 Kernel 保证 |
| Run 从节点派发前具备持久身份 | 已覆盖 | 先创建 aggregate root 并保存 initialScheduler，再提交节点；检查点保存图、实例、边状态、委派组、预算统计等 |
| 提交成功但检查点未写时恢复不重复节点 | 已覆盖 | 提交 requestId 包含 root/node/iteration/generation；恢复同代复用 Task；executor 测试覆盖提交与检查点间隙 |
| 多恢复者不能同时写同一 Run | 已覆盖，本地证据 | scheduler lease + fenced Session 写入；测试覆盖活拥有者拒绝、接管和旧拥有者失效。不能代替跨主机时钟/后端验收 |
| 动态扩图可恢复、同键冲突拒绝 | 已覆盖 | patch 指纹、appliedPatches、动态身份绑定、节点数限制；委派检查点恢复不重复子任务 |
| 有界 structured / detached 子任务 | 已覆盖，但非通用 TaskGroup API | fanout 限制数量/并发/深度；wait 支持 all/any/first-success/quorum；detached 强制 timeout，隔离工作区要求 cleanup=keep |
| 等待、结果收集与生命周期独立 | 已覆盖 | `join.mode=none` 控制结果收集，不自动 detached；提前满足等待条件时取消未完成兄弟；detached 由 execution.mode 显式声明 |
| 人工暂停后可恢复 | 已覆盖 | flow.human 持久 interaction；命令服务按 Run 成员选择响应对象，拒绝歧义；停止外部操作的确认由 Kernel 管理 |
| 失败传播、自动重试、人工重做 | 分层覆盖 | onFailure/retry；人工 retry 创建新 Task，图级 retry 使下游重算；不得把终态 Task 原地改为未完成 |
| 补偿 | 部分覆盖 | 可提交失败节点及上游的补偿任务；严格完成顺序与外部撤销保证见下一节 |
| 预算和并发限制 | 部分覆盖 | Run maxNodes/maxConcurrency/timeout/maxTokens；节点 budget 绑定 LLM handle。单请求限制、累计统计、资源消费账本是不同语义 |
| 资源、cache、跨 Session 协作 | Kernel/宿主职责 | 本包未提供通用 acquire/release/cache/message/shared-wait 节点；可通过自定义 Program/plugin 接入，不能把缺插件表述为 Kernel 未实现 |
| 工作区隔离与收尾恢复 | 已覆盖，需宿主装配 | workspace manager、持久 lease/finalization、恢复同一 worktree；根 Task 终态不代表外部工作区清理已完成 |
| 可观察、可控制、可审计 | 已覆盖主要接口 | commands、restore-handle、run-members、transcript；保留 Run 成员、迭代、goal、usage。goal/acceptanceCriteria 是描述字段，不是自动验收引擎 |
| 外部结果未知、真实 SIGKILL、持续恢复 | 需跨包证据 | 本包依赖 Kernel/adapter 与宿主恢复循环；真实 CLI/LocalFS 证据及剩余缺口见 Durable 证据映射 |

## 5. 已确认的限制与后续建议

### 5.1 组合 Flow 缺少独立运行策略边界

`expandCompositeNodes` 搬入子图 nodes/edges、默认值及连接信息，返回外层 spec；没有把 child.runPolicy 合成为独立预算、并发、超时或工作区域，也没有子 Flow 输入/输出签名映射。外层边接到所有子图入口/出口。

因此 `builtin.flow` 适合图复用，不能作为独立 harness 子运行容器。建议明确 UI/API 语义；如果要求独立生命周期，再设计子 Run 调用协议。子策略不能静默给用户造成已受约束的印象。

### 5.2 端口声明与实际产出不完全一致

传统通用 manifest 声明 `input → result`，但 `FlowHumanProgram` 实际产出 `response`，route@1 现已输出选路元数据；transform/reduce/spawn 允许自定义 outputName，却不随之更新 manifest。静态 data edge 校验会按 manifest 检查端口名。

建议统一 human 的输出名称，明确 route 为控制节点，并让可配置 outputName 与端口契约同步。此处是源码层面的契约差异；本轮未新增连接这些端口的端到端回归，不能断言所有现有接线都会失败。

### 5.3 预算不能解释为全局硬消费额度

执行器在节点终结后累计 `outputTokens`，当 `consumedTokens > maxTokens` 时取消剩余任务；并行请求已经发生的消耗可能越过上限。图级 retry 还会移除被废弃下游结果的 token 统计，所以这是当前计算图的用量统计，不能当作供应商实际总账。

delegation.budget.maxTokens/timeoutMs 只是子任务单次请求默认限制；`maxCostUsd` 已明确不支持。detached 实例不计入主循环的 activeCount，不能把 Run maxConcurrency 理解为包括所有后台工作的总并发额度。

若要求强消费边界，需要在 Kernel 资源账户/adapter 消费结算层实施预留与计量，并明确 detached 和 retry 的计费口径；不能只增加一个 Flow 配置字段。

### 5.4 补偿并不保证严格串行回滚

`compensateChain` 按失败节点、上游遍历顺序调用 `submitNode`，没有在提交下一补偿前等待前一个补偿成功；同一补偿节点已有实例时会跳过。它还没有在此处过滤“上游必须成功”的条件。

因此不能从“逆序提交”推导“逆序完成”，更不能推导循环每轮都有一次完整撤销。若业务要求严格 Saga，应补上明确补偿依赖、实例级记录、失败后恢复与外部幂等协议，并增加故障回归。

### 5.5 定义版本检查不是存储原子 CAS

`saveDraft` 先读取并比较 draftVersion，再调用 writeFile；`saveRevision` 也是先查旧版本再创建 asset。最小 FlowStore 接口没有 CAS/事务入口，因此包本身不保证并发作者之间的原子版本竞争与 revision/latest 一起提交。

这与执行器的 Run fencing 是不同层面的保证。需要多写者编辑/发布时，应在存储适配或接口层补原子条件写，并验证并发发布和发布中断恢复。

### 5.6 扩展能力与验收范围

本包没有通用资源分配、共享状态等待、跨 Session 消息、cache 控制及自动 acceptance 检查节点。现有核心能力足以组合很多 Agent 工作流；只有出现明确业务场景时再增加插件，不必为每个 Kernel API 都增加节点。

现有包内测试不能证明真实设备结果未知时的核对、任意跨主机存储一致性或桌面重启体验。相关验收继续沿用 [Durable 证据映射](durable-harness-evidence.md)，不重复把这些项目当成本包代码缺失。

## 6. 核验记录

本轮执行 `pnpm --filter @itookit/llm-flow test`：**18 个测试文件、240 个用例通过**。包括 executor 的 116 个用例，以及 scheduler lease、图重试、端口契约、运行目录、工作区收尾和定义存储测试。

主要定位入口：

- [durable-flow-executor.test.ts](../../backend/llm-flow/__tests__/durable-flow-executor.test.ts)：静态图、路由、循环、委派、恢复、授权与图重试。
- [scheduler-lease.test.ts](../../backend/llm-flow/__tests__/scheduler-lease.test.ts)：租约、并发拥有者与 fencing。
- [port-contract.test.ts](../../backend/llm-flow/__tests__/port-contract.test.ts)、[run-catalog.test.ts](../../backend/llm-flow/__tests__/run-catalog.test.ts)：schema 与恢复契约。
- [workspace-finalization.test.ts](../../backend/llm-flow/__tests__/workspace-finalization.test.ts)、[run-workspace-drain.test.ts](../../backend/llm-flow/__tests__/run-workspace-drain.test.ts)：任务停止与工作区收尾。

本轮只修改分析文档与包说明，未修改运行时代码；未重跑全仓、CLI SIGKILL 或真实设备验收。测试通过不消除第 5 节的契约限制。

## 7. 结构化派发的实现与证据

新 `input → route@2 → report` 是普通 DAG；route 内部以 durable controller 保存轮次、选中集、子 Task 身份和按 key 的结果。路由后通过 Kernel spawn 创建新 Task，默认不继承 Session/父 Task history；prompt 只由目标自己的指令、分支 instruction 与显式 input 绑定构造。结果持久化与写入主会话 history 是两个独立开关。

- `maxRounds`（1–1000）、并发、exclusive/multicast、选择顺序、停止表达式、输入 schema、目标插件、prompt、输出解析/校验均可配置。
- 每批全部成功并校验后提交 keyed results；未选择类型保持原值，新返回即使降分也覆盖旧值。修改输入后旧结果保留，但 `current=false`。
- 子任务加入 Run 查询、取消/暂停/恢复和权限装配；全局并发对活动执行任务生效。静态及动态扩图校验保守预留最大子 Task 数；这不是 token 硬额度预留。
- 当前不支持 route@2 目标再嵌套 route@2 或 builtin.flow；需要单独图作用域。旧 delegation 没有被改写为新协议。
- 自动测试覆盖输入补齐、实际模型请求的 history 隔离、跨轮合并、降分、1/10 轮边界、恢复不重复 spawn、修订失效、并发、取消及真实 .flow 配置编译运行。模型 Effect 使用测试替身；不声称完成真实 Provider/桌面验收。

详细契约和源码索引见 [作文四维评审实现](essay-review-flow.md)。


## 分节点编辑图

`builtin.route@3`、`builtin.check@1`、`builtin.aggregate@2`、`builtin.judge@1` 将派发作用域拆成独立可配置的可视节点。编译器从连线生成 route@2 的 branches、结果累积和停止条件，保留既有持久执行语义。检查节点数量由图决定；非法内部连线、孤立算子、重复结果 key 会阻止执行。旧紧凑草稿在编辑时自动展开，保存前不改变原文件。详见 [作文评审设计](essay-review-flow.md)。

统一节点契约已接入：公共 invocationDefaults、运行前 param/命名输出解析、条件配置、版本化 reducer 与输入字段表单。执行及兼容边界见 [作文评审设计第 9 节](essay-review-flow.md)。

## 自动修改与运行版本

`builtin.revise@1.0.0` 将判断节点的 repeat 分支接回 route；它通过独立 Task 返回 fields 指定的输入更新，支持 prompt、systemPrompt、context.history、outputContract、工具与模型配置。详见 [版本与自动修改闭环](./flow-capabilities-and-output.md#版本与自动修改闭环)。Session 重新运行使用最新保存定义，新 Round 固定 flowId/revision/parameters；恢复执行使用原快照。

## Flow 内部变量

通用 variables/assign、运行隔离、依赖排序、原子写回、检查点及 UI 行为见 [Flow 内部变量设计](./flow-variables.md)。新作文模板用 `${param.essay}` 保存输入，用 `${vars.essay}` 读取当前稿件。

## Coding harness 第一批实现（2026-09-21）

编码入口复用现有 `Read / Glob / Grep / Edit / Write / Bash`，`fd` 和 `rg` 保留为搜索实现细节。单 Agent 的模型—工具循环由 `DurableAgentProgram` 承担；Flow 只在需要编码、验证、评审等任务编排时参与，不为每次文件操作新增节点。

### 调用与失败契约

- `ToolDeviceDriver` 在执行前检查工具启用状态，执行 Zod schema、`validateInput` 和 `checkPermissions`。权限回调返回的更新参数需要再次通过 schema 和语义校验；等待校验后重新检查工具是否被禁用、替换或注销。注册的 `ToolHandler` 也按其 JSON Schema 校验。当前工具权限回调支持 allow/deny，人工批准继续由 Agent 的持久 interaction 管理。
- `ToolInputError` 表达已知且可纠正的失败，驱动返回 `success=false`、`errorCode`、`recoverable=true`。参数错误、禁用/缺失工具、权限拒绝、Edit 未匹配/多处匹配和明确的文件读取路径错误属于此类。
- `ToolCallEffectAdapter` 将这类结果作为已完成的 Effect 保存，Agent 发出 `tool:error`，将工具文本反馈给模型并继续现有轮次循环。`maxExchanges` 仍限制修正次数；不同调用仍需按原审批策略获批。
- 未声明可纠正的失败、取消及未知执行结果保持原故障语义。Skill 加载失败不提交 Skill 上下文；卸载已经修改持久身份后发生的失败仍交给 Effect 收尾。未知写操作继续返回 `TOOL_INDETERMINATE`，不自动重放。

### 文件与输出行为

- Edit 拒绝空目标和相同替换，默认要求唯一匹配，替换内容始终按字面量写入（包括 `$&`、`$$` 等）；结构化结果包含实际匹配文本、替换文本和次数。
- Write 判断文件是否存在时，不再把任意读取失败当成文件不存在；仅明确 ENOENT 或 stat 的不存在结果允许按创建记录。
- Read 的 offset/limit 必须为正整数，单次最多 2000 行。模型调用模式的文本和 data 遵循工具上限且最多 100000 字符；超大文本带截断提示，超大 data 省略并标记 truncated。确定性 structured 模式完整返回 JSON，遵循工具声明的 `maxResultSizeChars`，缺省 100000，平台硬上限为 `16 * 1024 * 1024` 字符；超限返回 `OUTPUT_TOO_LARGE`，不静默截断。invoke 与 reconcile 使用相同规则，错误只包含数量和限额。此限制不等于底层文件读取或进程输出的内存上限。
- `ToolInvokeResult` 保留兼容的 output 文本，新增可选 data/errorCode/recoverable/truncated。Bash 结构化结果保留 exitCode；命令非零退出作为已完成命令返回给模型。请求的 Bash 超时不能超过宿主调用超时。
- 已取消请求不会进入工具；取消监听器在调用结束后移除，Edit/Write 在异步读取后、写入前检查取消。实际进程停止仍依赖宿主 Shell 和 Effect cancel 的确认协议。

实现入口：[工具调用驱动](../../backend/tools/src/adapters/tool-device-driver.ts)、[调用校验与结果封装](../../backend/tools/src/adapters/tool-invocation.ts)、[工具 Effect](../../backend/kernel-adapters/src/effects/tool-call-effect.ts)、[Agent Program](../../backend/llm-tasks/src/durable/agent-program.ts)。

### 验证和后续边界

[跨包编码验收](../../apps/cli/tests/coding-harness.test.ts) 使用真实临时文件和原生 Shell，脚本化模型响应依次触发错误 Edit、Read、正确 Edit、Bash 验证。每次 reducer 调用前序列化并恢复状态，每个工具调用重新走审批；最终文件与执行退出码共同证明修正成功。它不等价于真实 Provider、Kernel 存储重启或 SIGKILL 验收。

文件端口仍为 read/write，不提供原子条件写；本批不能保证多个 Agent、编辑器或外部进程之间的并发覆盖安全。后续应在后端实现条件提交与操作核对，再增加版本前提、持久变更记录和 diff 展示。搜索的授权视图加速、进程输出流式限额、只读策略与独立编码 Flow 模板也不在本批保证范围内。
