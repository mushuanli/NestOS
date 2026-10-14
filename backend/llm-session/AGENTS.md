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

- Round 只表达对话历史，使用 `historyParentIds`。
- Run 引用通过 `executions` 附着到 Round。
- Branch/merge 拓扑归本包；Context 历史选择、Profile 规则和装配经 `@itookit/llm-context` 接口执行，`RoundLog` 只提供存储和缓存。
- Chat/Agent 与 Flow 的提交统一经过 llm-flow 的 `submitRun(CompiledRunDefinition)`；上下文组装和结果解析保留各自策略，运行成员使用 `RunExecution.tasks()` 实时读取。
- 普通 Chat 走 `ConversationRunCoordinator` 的直接任务路径（`directTaskSpec`），不包装成单节点 DAG。
- 首次显式模式的直接运行通过准入后，将 executionMode 与 executionModeLocked 在设置事务中一并保存；后续发送/重新生成校验固定模式，省略模式时继承。持久化层拒绝改模式并忽略解锁补丁；旧有历史会话保留已保存模式。Flow 不参与该锁。
- `session/execution-mode-policy.ts` 统一模式校验和合并规则；`session/session-execution-mode.ts` 通过最小仓储端口解析任务模式；`persistence/session-settings.ts` 负责旧数据解码和设置合并。事务与时间戳留在持久化侧，工具选择留在 `direct-execution-mode.ts`。
- `SendIntent.execution.mode` 优先于 `ExecutionOverrides.executionMode`；提交前复制并固定。chat 只保留已授权 WebSearch；agent 在未配置 `capabilityPolicy.toolIds` 时经宿主 `resolveHarnessToolIds` 获取默认工具，显式白名单（包括空数组）优先。执行模式无可用工具时拒绝提交，保持 external 审批及 Session 挂载边界；Flow 不消费该偏好，无 mode 的旧 API 调用保持兼容。
- DAG/Flow 依赖 `@itookit/llm-flow`（本包通过它编排，不直接持有动态图语义）。
- 只通过 `@itookit/durable-kernel` 公开类型（`Kernel` / `SessionHandle` 等）与 Effect 访问内核，不触碰内核内部实现。

Flow 重新运行通过 `FlowRerunService` 校验参数并创建替代分支，调用参数固定在 `Round.flow`。`FlowHistory` 将 Task 事件投影为 History 交互并存入 `RoundResult.flowInteractions`，与模型 history 独立；编译到路由内的汇总/判断通过 `flow.logic.completed` 逐轮展示条件与结果，流式内容按 Task 隔离。见 [Flow 能力与输出](../../doc/design/flow-capabilities-and-output.md)。

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

Agent、连接管理、恢复与定价的权威契约位于 kernel-adapters/contracts。本包为既有 Session API 保留具名转发，构建必须内联其 JavaScript 与声明，发布产物不得保留对适配器包的导入；它仅列为开发依赖。

DirectAgentPolicy 控制显式 Agent 模式的附加提示与 maxExchanges。构造时验证预算、复制并冻结；附加提示必须在 Context 装配前加入并参与 token 计量，不得在 Task 构造时绕过预算追加消息。实际预算写入 Task，Chat/Flow 与旧模式不消费附加提示。

ConversationContextBuilder 负责 Round/Branch 选择、宿主材料与 Context 装配；direct-conversation 负责直接运行工具/MCP/Skill 准备和 TaskSpec。协调器保留提交、Round 持久化与事件投影。初始 Round 写入失败时取消已提交 Run，防止脱离历史的任务继续执行；产品策略仍通过已有宿主端口和 DirectAgentPolicy 注入。
