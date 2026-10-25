# llm-session 开发说明

本包管理用户可见的对话语义与运行协调，不实现执行内核（Task 执行由 `@itookit/durable-kernel` 负责）；DAG 编排由 `@itookit/llm-flow` 负责。详见 [llm-session API](../../doc/llm-session-api.md)。

## 目录

```text
src/
├── session/        会话语义：SessionManager / BranchService / ConversationRunCoordinator /
│                   SessionRunCoordinator / AgentResolver / SessionState
├── persistence/    持久化与投影：RoundLog / RoundGraphService / SessionRepository /
│                   FlowEngine（flows VFS 模块）/ 会话与对话投影
├── services/       Agent 配置契约 / PromptHistoryService / VFSAgentService
├── plugins/        history / session / vcs 命令插件
├── core/           类型、CommandBus、ExtensionRegistry
└── utils/          日志、错误格式化、VFS 实体存储
```

## 约束

- `llm-session/contracts` 拥有会话、命令/扩展和配置管理契约及纯策略函数，入口不加载 Session 运行时、VFS 或 YAML。
- 实现不依赖 common/llm-common；模型、上下文、工具和编排契约直接来自所属模块。
- 翻译、日志、启动追踪经 `ConversationSystemOptions.hostPorts` 实例注入。工厂返回独立 SessionManager、提示词历史和幂等异步 dispose；禁止通过全局配置覆盖其他实例。不提供单例工厂或全局 getter。默认英文提示、空日志和直接启动操作。
- Agent 缺失行为经 `agentResolution` 注入；精确解析、授权和持久执行模式约束保持严格。业务提示词、评分阈值与预设留在宿主，不进入本包。
- session.check-flow-connections 复用宿主插件目录、Flow 编译和连接准入作只读预检，支持草稿快照或发布修订；session.create-from-flow 在创建任何会话前重检。必选、可选和能力需求来自 Flow 声明，不按业务名称分支，正式运行保留完整准入。

- Round 只表达对话历史，使用 `historyParentIds`。
- Run 引用通过 `executions` 附着到 Round。
- Branch/merge 拓扑归本包；Context 历史选择、Profile 规则和装配经 `@itookit/llm-context` 接口执行，`RoundLog` 只提供存储和缓存。
- 共享 Round 的修改通过 branchMeta.roundOverrides 写时复制内容文档，逻辑 ID 与父子拓扑保持稳定；快照、Context 与分支读取必须按目标 ref 解析内容，不能直接修改其他分支共享的文档。
- Chat/Agent 与 Flow 的提交统一经过 llm-flow 的 `submitRun(CompiledRunDefinition)`；上下文组装和结果解析保留各自策略，运行成员使用 `RunExecution.tasks()` 实时读取。
- 普通 Chat 走 `ConversationRunCoordinator` 的直接任务路径（`directTaskSpec`），不包装成单节点 DAG。
- 首次显式模式的直接运行通过准入后，将 executionMode 与 executionModeLocked 在设置事务中一并保存；后续发送/重新生成校验固定模式，省略模式时继承。持久化层拒绝改模式并忽略解锁补丁；旧有历史会话保留已保存模式。Flow 不参与该锁。
- `session/execution-mode-policy.ts` 统一模式校验和合并规则；`session/session-execution-mode.ts` 通过最小仓储端口解析任务模式；`persistence/session-settings.ts` 负责旧数据解码和设置合并。事务与时间戳留在持久化侧，工具选择留在 `direct-execution-mode.ts`。
- `SendIntent.execution.mode` 优先于 `ExecutionOverrides.executionMode`；提交前复制并固定。chat 只保留已授权 WebSearch；agent 在未配置 `capabilityPolicy.toolIds` 时经宿主 `resolveHarnessToolIds` 获取默认工具，显式白名单（包括空数组）优先。执行模式无可用工具时拒绝提交，保持 external 审批及 Session 挂载边界；Flow 不消费该偏好，无 mode 的旧 API 调用保持兼容。
- DAG/Flow 依赖 `@itookit/llm-flow`（本包通过它编排，不直接持有动态图语义）。
- 只通过 `@itookit/durable-kernel` 公开类型（`Kernel` / `SessionHandle` 等）与 Effect 访问内核，不触碰内核内部实现。

Flow 重新运行通过 `FlowRerunService` 校验参数并创建替代分支，调用参数固定在 `Round.flow`。`FlowHistory` 将 Task 事件投影为 History 交互并存入 `RoundResult.flowInteractions`，与模型 history 独立；编译到路由内的汇总/判断通过 `flow.logic.completed` 逐轮展示条件与结果，流式内容按 Task 隔离。见 [Flow 能力与输出](../../doc/design/flow-capabilities-and-output.md)。

FlowInvocationService 通过注入的 prepareRun/submitPrepared 端口先完成完整 DAG 准入，再持久化 preparedGraph 与调用意图，最后提交根 Task。准入图覆盖最终连接选择及子 Flow，提交重试不重新读取模型配置；根 Task 持有执行快照后删除临时图。编译与任务提交仍归 llm-flow，会话层不实现第二套 DAG 编译器或执行器。

SessionRepository.createSession 的可选 initialState 与新会话身份在同一记录事务提交，并在首次变更通知前可读；入口复制调用方数据，不把文件引用或项目选择策略放入 Session 持久化。

## 观察生命周期

指令队列归 Session 后端，通过 Kernel shared version CAS 持久接纳与领取。SessionExecutionActivity 持有 Runtime 唯一 SessionInstructionRuntime；所有视图共用接纳串行入口、队列、回执与版本投影，视图只登记上下文端口和观察者。空闲发送也先持久接纳；原始摘要保存到 Round，历史身份缺少可信摘要时不能静默接纳。收尾必须按原 instructionId 确认，不按当前队首删除；持久排空后清除恢复索引。UI 只消费快照与队列编辑命令，未知执行结果不自动重发。Flow 槽位需求推导由 contracts/flow-connection-policy 统一提供给表单与准入。详见 [Session 指令队列](../../doc/design/session-instruction-queue.md)。

SessionViewPort.onEvent 允许绑定前登记，多个观察者独立拥有 disposer，并随当前绑定重新挂接。解绑只释放自身转发，不清除其他所有者的通道监听；视图取消订阅不停止执行。生命周期回归位于 __tests__/session-observation.test.ts，完整 RPC/页面回归位于 app-shell 的 draft-promotion.test.ts。

## 联网搜索

- 三态 `ExecutorConfig.webSearchMode`（`WebSearchMode`）由 `AgentResolver.resolveWebSearch` 经 `resolveWebSearchStrategy` 解析。
- `session/direct-conversation.ts` 的 `directTaskSpec` 派生 `webSearch` 布尔（仅 builtin）+ 按 mode 剥离客户端 WebSearchTool。
- `applyOverrides` 中 `webSearchEnabled=false` → `webSearchMode='disabled'`。
- citations 投影为 `message:citations`（投影后不重复发射原始 citations）。
- 详见 [web-search.md](../../doc/web-search.md)。

运行：

```bash
pnpm --filter @itookit/llm-session typecheck
pnpm --filter @itookit/llm-session test
```

Memory 默认使用 Session shared；显式 sharedMemory 引用经 SharedMemoryStore 的独立 SeqFile 与 Session/scope grants 授权。数据、操作回执、审计在同一事务写入；管理权限不暴露为模型工具。memory_compact 复验源版本与读写授权，保留原文和来源引用。语义检索仍延期。

CLI 使用共享 `FlowRunProjection` 按根 Task 幂等写入 History Round；节点、工具、输入和批准携带 `FlowActor` 身份。Skill 作为节点/工具来源展示，工具调用按 Task 和 call ID 隔离；分支切换保留 Flow 交互。验证见 [CLI 能力验收](../../doc/design/flow-cli-capabilities-verification.md)。

Flow 重跑以 Session manifest/持久 Round 索引为来源，空分支或无历史也能运行；新分支从空历史创建。`flowBranchExecutions` 按分支 Round 引用生成输出成员，禁止用 Session 全部 Task 代替分支成员。

Agent 定义的 `capabilityPolicy` 位于顶层；`AgentResolver` 读取 `agentDef.capabilityPolicy`，不是 `agentDef.config.capabilityPolicy`。

VFSAgentService 的 `configureFlowAvailability` 接受宿主提供的最小 Flow 观察端口，列表与精确读取返回派生 `availability`；该字段不写入 Agent 源文件，也不计入 Agent 身份。FlowEngine 发布资产后通知观察者，底层资产不发普通 VFS 节点事件；文件删除、移动和恢复继续由宿主资源事件驱动刷新。绑定缺失、未发布、修订缺失和定义无效分别呈现，不删除失联 Agent。

Flow 指令接纳通过 llm-flow 的 prepareFlowRun 生成图，在 flowBinding.plan 保存图、引用身份与摘要。对话历史和宿主上下文在派发时绑定；静态引用与批量子模板不能重读源定义。派发仍复验当前连接/授权，动态新身份在扩展时准入并随图持久化。计划损坏拒绝恢复，无计划的旧队列沿用兼容路径。可用性按 Flow ID/修订缓存并合并在途检查，资源事件失效，单个 Agent 读取不刷新整个目录。

flow-agent-connections 统一预检与上下文绑定的连接选择规则；完整准入的连接选择通过 freezePlannedFlowConnections 写回源图，递归覆盖委派模板和批量子调用，保持源指令与上下文策略。派发只重建消息并复验已冻结的连接，不根据新的默认值重选。VFSAgentService 按 Agent ID 串行执行准备及保存，接纳时复制输入，关闭时等待已接纳保存结束。

flow-connection-policy 从节点 responseFormat 推导 responseFormats，合并节点及共享槽位声明，写入连接准入和 frozenConnection.requirements。协议/格式不兼容使用 FLOW_CONNECTION_OUTPUT_FORMAT_UNSUPPORTED，保留具体槽位、协议与格式原因；连接预检日志只记录 operationId、阶段、结果、错误分类和耗时，不请求模型或记录消息/参数。

Agent、连接管理、恢复与定价的权威契约位于 kernel-adapters/contracts。本包为既有 Session API 保留具名转发，构建必须内联其 JavaScript 与声明，发布产物不得保留对适配器包的导入；它仅列为开发依赖。

DirectAgentPolicy 控制显式 Agent 模式的附加提示与 maxExchanges。构造时验证预算、复制并冻结；附加提示必须在 Context 装配前加入并参与 token 计量，不得在 Task 构造时绕过预算追加消息。实际预算写入 Task，Chat/Flow 与旧模式不消费附加提示。

ConversationContextBuilder 负责 Round/Branch 选择、宿主材料与 Context 装配；direct-conversation 负责直接运行工具/MCP/Skill 准备和 TaskSpec。协调器保留提交、Round 持久化与事件投影。初始 Round 写入失败时取消已提交 Run，防止脱离历史的任务继续执行；产品策略仍通过已有宿主端口和 DirectAgentPolicy 注入。

会话创建可传 `creation.agentId`，首次身份事务保存不可变 `createdWithAgentId`，摘要与项目导航索引保留此字段。改变当前轮 settings.agentId、幂等 ensureSession 或普通 manifest patch 不改变创建来源；已有无来源会话不推断。项目草稿转正由宿主捕获，导入导出保留该来源。

连接准入的缺失绑定和能力错误携带稳定 code 与 field（槽位名）；前端不解析错误消息。session.check-flow-connection-slots 独立返回槽位配置问题，复用完整图准入的 admitFlowConnectionSlot，不构造空节点的临时 Flow。必需槽位未覆盖时可继承用途默认连接，可选槽位的空字符串表示显式解绑。

Agent 发布修订与回执位于既有 VFS 定义平面。显式发布冻结共享提示词与实现依赖，AgentResolver 读取发布身份；普通 Agent 队列接纳保存策略摘要，连接凭据和实际上下文不进入该快照。诊断异常不能覆盖已持久结果或原拒绝；新身份元数据不得改变旧接纳 Task 指纹。

session.submit 将 Agent/Flow 根调用送入既有队列，外部字段不授予内部计划或 Invocation。编辑从冻结定义重编译，claim 先持久分配根调用身份；用户重跑新建身份并保留原终态。submission.inspect 只读显式 Session 的接纳事实，不激活视图或执行。附件接纳冻结不可变字节，派发核验后通过 Context.resolveMessage 装配；完整子调用身份、默认工作台台账和通用文件传输继续分批验收。

validateCallAssets 由宿主注入，贯通 Flow/Flow Agent 根接纳、实际队列实参编辑及 DagCommandService 准备；独立 FlowInvocation 使用同一准备边界。新派发在创建 Task 前再次核验，消费时仍按 Task 授权读取。原提交与无变更编辑先核对持久事实，不能因文件后来丢失抹掉接纳或自动重发。
