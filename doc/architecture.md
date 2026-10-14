# 架构设计 — 系统全貌

> 基于当前代码（2026-09-08 重构后）：执行内核 `durable-kernel`、LLM 任务单元 `llm-tasks`、DAG 编排 `llm-flow`、会话语义 `llm-session`。

## Agent 与模型连接

- `AgentDefinition` 描述共享系统提示词引用、专属补充指令、Skills、Tools、MCP 和执行约束，不绑定 Connection 或模型层级。共享提示词在工具箱集中管理，后续运行读取最新内容；已提交运行保留执行快照。
- Provider 管理服务端和模型目录；Connection 管理该服务商的模型映射。会话的 `settings.connectionId` 显式选择连接，未设置则读取全局 `defaultConnectionId`。
- 全局默认由工具箱「模型」的连接菜单或编辑器设置，持久化到 `/etc/llm/.connection-settings.json`。不按 ID 或列表顺序猜测默认；删除默认连接会清空此设置，保留独立的 Agent。
- `/connection` 打开选择器，`/connection <id>` 设置当前会话，`/connection --reset` 恢复跟随全局默认。显式连接失效时要求重新选择。
- Flow 运行表单将连接选择与业务参数分开：节点显式连接 > 本次运行选择 > Flow 默认配置 > 会话连接 > 全局默认。运行选择不改写 Flow 定义或会话设置；已提交任务保留已解析连接。

## 1. 分层总览

```
┌────────────────────────────────────────────────────┐
│  apps/{web-app(mind-os), cli, tauri-app}   入口   │
├────────────────────────────────────────────────────┤
│  app-shell（Web/Tauri UI shell） │ app-core（无 UI 组合） │
├──────────────┬──────────────┬──────────────────────┤
│  llm-ui      │  vfs-ui      │  mdxeditor           │  UI 层
├──────────────┼──────────────┼──────────────────────┤
│ llm-session  │  llm-flow    │ llm-tasks         │  LLM 业务层
├──────────────┼──────────────┼──────────────────────┤
│  durable-kernel             │                      │  执行内核
├──────────────┼──────────────┼──────────────────────┤
│ kernel-adapters    │  driver-llm  │ device-tty   tools   │  能力/引擎层
├──────────────┴──────────────┴──────────────────────┤
│  vfs-core (VFS)                  vfsdriver-*          │  存储层
├────────────────────────────────────────────────────┤
│  能力包 contracts / common    契约层                │
└────────────────────────────────────────────────────┘
```

依赖铁律：**上层可依赖下层，下层永不知上层**。跨层通过接口注入：装配下沉在 `app-core/src/runtime/create-application-runtime.ts`（`createApplicationRuntime()`），`app-shell/src/bootstrap.ts` 只是调用方。

上下文实现独立于执行内核，位于零运行时依赖的 `@itookit/llm-context`。接口与 v2 持久执行见 [Context API](context-api.md)，设计依据与扩展边界见 [Context 模块设计](design/context-module.md)。

## 2. Kernel — 持久化执行内核

`@itookit/durable-kernel` 是唯一的执行引擎：一个 Task 一个持久化状态机。

**核心抽象：**

| 抽象 | 职责 |
|---|---|
| `DurableTaskProgram<S,I,O>` | `init(input)` 初始化状态 → `reduce(state, event)` 逐事件推进。每次返回 `Decision{ state, actions, next }`，state 必须 JSON 可持久化 |
| `EffectAdapter` | 副作用执行器：`execute`/`reconcile`（worker 丢失恢复）/`cancel` |
| `KernelAction` | 程序声明的副作用：`effect`/`spawn`/`request-interaction`/`set-shared`/`delete-shared`/`emit` |
| `WaitSpec` | 等待条件：`signal`/`effect`/`task`/`interaction`/`all`/`any`/`quorum`/`child` |

**执行流程（drain 循环）：**
```
SessionHandle.submit(TaskSpec) → store.createTask（依赖未满足则 blocked）
  → queueDrain → claimReady → TaskProgram.init/reduce → applyDecision
      ├─ 声明 effect → store 记 pending → dispatchEffect → claimEffect → EffectAdapter.execute
      ├─ 声明 spawn → 创建子 Task（patch-graph 动态扩展）
      └─ request-interaction → 等待 respondInteraction
  → effect 完成 → completeEffect → 事件入列 → 触发等待该 task 的下游
```

**关键机制：**
- **持久化**：`SeqFileKernelStore`（seqfile 顺序日志 + snapshot），Task 状态/事件/effect 全部落盘，重启后 `recover()` 恢复（lease 过期任务重新入队）。
- **Effect 幂等**：`idempotencyKey` + `reconcile`，worker 丢失后避免重复副作用。
- **资源与预算**：`createResource`（类型化 handle + rights: read/write/execute/grant/admin）、`setBudget`/`chargeBudget`（token 预算账户）。
- **能力绑定**：`bindCapabilities(task, bindings, onHandle?)` — 创建资源 → 发 `capabilities` signal → `start()`。
- **交互**：`request-interaction` → `interaction-resolved`（HITL 审批/输入），`interactionApproved()` 统一判定。

**内核类比（session = 容器 / task = 进程 / kernel = 内核）：**

| kernel 职责 | 对应 OS 概念 |
|---|---|
| drain / claimReady / lease / maxConcurrent | 调度器 |
| 事件日志 + `WaitSpec` + wake | 信号量 / 通知 |
| seqfile store（task/effect/resource 落盘 + `recover()`） | 文件系统 + journal（崩溃恢复） |
| `createResource` + rights（read/write/execute/grant/admin） | 文件描述符 + 权限 |
| `setBudget` / `chargeBudget` | 资源配额 |
| `request-interaction` / `respondInteraction` | 阻塞等待外部输入 |

> 命名说明：`durable-kernel` 的 `package.json` 自述是 `"Durable Session/Task scheduling and resource kernel"`。它不止是 `scheduler`（调度），而是同时承担持久化、IPC、权限、配额、崩溃恢复的**执行内核（kernel）**。

**两级同步机制：**

| 级别 | 机制 | 落点 |
|---|---|---|
| task 私有 | 每个 task 独立 state + snapshot | `tasks/<taskId>/record`（仅 kernel 写，task 是纯函数） |
| session 内（task 间） | ① 事件日志（`task-exited` 唤醒等待者）② 依赖边 ③ `setShared/getShared` | `events/<sequence>`、`edge/<dep>/<dependent>`、`shared/<key>` |
| session 间 | `sendCrossSession(source,target,topic,payload)` → outbox/inbox 消息队列 | 事件 `session.message.queued/delivered/received` |

## 3. LLM 子系统（llm-tasks → llm-flow → llm-session）

```
llm-session ──▶ llm-flow ──▶ llm-tasks ──▶ durable-kernel ──▶ vfs-core
（会话/持久化） （DAG 编排） （LLM 任务单元）  （执行内核）
```

### 3.1 llm-tasks — LLM 任务单元

平台无关的 durable programs：`llm.agent`（带工具循环）、`llm.chat`（单轮）、`llm.plan`（规划）。

- **输入**：`DurableAgentInput`（sessionId/roundId/messages/connectionId/model/approval/tools/…），统一由 `buildLlmTaskInput` 装配。
- **依赖收集**：`collectDependency`/`dependenciesReady`/`dependencyWait` — 等待上游 task-exited → 提取输出（`extractNodeOutput`）→ 注入消息。
- **能力**：LLM/tool 通过 `capabilities` signal 获得 handle，走 `llm.chat`/`tool.call` effect。
- **上下文**：`@itookit/llm-context` 的 `IContextAssembler`（历史/记忆装配）与 `IContextService`（窗口、Notes、原文检索、持久请求）；llm-tasks 仅保留兼容导出与 Program bridge。

### 3.2 llm-flow — DAG 编排

`DurableFlowExecutor` 把 LLM 任务连成动态图：

| 能力 | 说明 |
|---|---|
| Sequence / Branch(route) | 数据边 + 控制边，`route` 节点按 `SerializableExpression` 激活/禁用边 |
| Loop | 回边（`findCycles` 检测）+ `max_iterations`，环上节点重入 |
| Spawn | `patch-graph` effect 运行时动态加节点/边 |
| Compensate | Saga 回滚（`compensate` 配置 + 反向补偿链） |
| on_failure | `fail/skip/continue` 下游行为 |
| Budget | 节点级 `budget.tokens` → `setBudget` + effect 扣减 |

内置插件（7 个）：`builtin.transform`/`builtin.reduce`/`builtin.route`/`builtin.spawn`/`builtin.flow`（复合 Flow，执行前展开）/`builtin.human`/`builtin.agent`；Flow 程序：`FlowValueProgram`（transform/reduce/route/spawn）、`FlowHumanProgram`、`FlowAggregateProgram`（汇聚为 `{nodes}` 输出）。

> **llm-flow 不替代 llm-tasks，而是编排它。** agent 节点（`builtin-plugins.ts agentTask()`）不重新实现 LLM 逻辑，而是生成 `llm.agent` 的 spec（`buildLlmTaskInput`）交给 llm-tasks 的 `DurableAgentProgram` 跑。llm-flow 自己的程序只有图原语（`flow.value/human/aggregate`）。llm-tasks 之所以独立存在：它同时被 **llm-session 的 Direct Chat**（不走 DAG，直接用 `llm.chat`/`llm.agent`）和 **llm-flow 的 agent 节点**共享——若并进 llm-flow，纯对话也要拖入 route/loop/spawn 等图语义。

### 3.3 llm-session — 会话语义 + 持久化

用户可见的对话层：

- **Round**：只表达对话历史（`historyParentIds`），Run 通过 `executions` 附着。
- **Branch / merge / context fold**：会话分支语义。
- **持久化**：`SessionRepository`（会话资产门面，VFS 存储）、`FlowEngine`（`FlowStore` 实现，Flow 定义/修订）、`RoundLog`（round 增量日志 + 投影）、`RoundGraphService`。
- **调度**：`SessionManager`/`ConversationRunCoordinator`（Direct Chat 走 llm.chat，Flow 走 `DurableFlowExecutor`）。
- **控制面**：`CommandBus` + `ExtensionRegistry` + 插件（session/vcs/history）；`initializeConversationSystem` 装配入口。

### 3.4 联网搜索（Server-side Web Search）

统一三态决策 + `citations[]` 返回（详见 [web-search.md](./web-search.md)）：

- **单一决策点** `resolveWebSearchStrategy`（llm-session/contracts 纯函数）→ `WebSearchMode`（`builtin | client-tool | disabled`）。
- **下发**：`AgentResolver` 存 `ExecutorConfig.webSearchMode` → `ConversationRunCoordinator` 派生 `webSearch` 布尔（仅 builtin）+ 剥离客户端 WebSearchTool。
- **执行**：provider 按 `ChatCompletionParams.webSearch` 注入内置工具（Responses `web_search` / Gemini `googleSearch`）。
- **返回**：citations 经 `Chunk.citations` → `AgentEventCitations` → `message:citations` → UI 渲染。

## 4. 能力/引擎层

| 包 | 职责 |
|---|---|
| `kernel-adapters` | Kernel 能力适配器：`LlmChatEffectAdapter`（含预算扣减）、`ToolCallEffectAdapter`、`SkillLoadEffectAdapter`、`BashEffectAdapter`、`TtyEffectAdapter`；`LLMServiceAdapter`（ILLMService → LLMDeviceDriver）；`createKernelAdaptersRuntime` 装配。 |
| `driver-llm` | 独立模型通信、Provider 协议、SSE、取消和注入式传输；无运行时依赖。 |
| `kernel-adapters/llm` | `LLMDeviceDriver`、`LLM_IOCTL`、配置、费用、Skill、MCP 和 MindOS VFS 接入。 |
| `device-tty` | TTY 驱动（node-pty 交互 shell）。 |
| `tools` | 内置工具 `buildTool()` 工厂：FileRead/Write/Edit、Glob、Grep、Bash、Skill、Agent、AskUserQuestion 等。 |

**LLM 调用链**：`LlmChatEffectAdapter` → `ILLMService.chatStream` → `LLMServiceAdapter` → `LLMDeviceDriver.ioctl(CHAT)` → provider（OpenAI/Anthropic/…）→ SSE 流式返回。

## 5. VFS 子系统（@itookit/vfs-core）

- **协议层**：`IFileSystem`/`IFileSystemDriver`/`IFSDriver`/`IVFSManager`/`IStorageBackend`/`FSNode`/`IDeviceDriver`（`https://github.com/mushuanli/vfs-core/blob/main/src/protocol.ts`）。
- **引擎层**：`VFSEngine`/`VFSManager`/`FileSystemView`/`createVFS`（唯一初始化入口）。
- **存储后端**：`vfsdriver-indexeddb`（浏览器）、`vfsdriver-local`（SQLite+本地 FS）。
- **通用 IO**：`IIOStream` + `pipe`（文件↔LLM↔TTY 流互拷）。
- **事件总线**：通用 `EventBus`（LLM/UI 共用）+ VFS `FSEventBus`。

## 6. UI 与装配

- **`llm-ui`**：Chat UI（流式历史、Session 渲染、DagWorkbench 可视化）。
- **`vfs-ui`**：文件树 UI；**`mdxeditor`**：CodeMirror MDX 编辑器；**`ui-common`**：共享 UI 契约。
- **`app-core`**：无 UI 应用核心 — MindOS profile、RunDefinition、共享 Session 文件/目录服务，以及 `createApplicationRuntime()`（VFS/LLM/Kernel/Session/Flow 统一装配）；Web/Tauri/CLI 共用。详见 [Runtime 架构](runtime-architecture.md)。
- **`app-shell`**：Web/Tauri UI shell — `initApp()` 消费宿主注入的 `services` 与 `localBackend`，装配设置界面、路由、Workbench/编辑器。执行 Runtime 由宿主调用 app-core 创建；前后端实现不互相加载，见[前后端模块边界](design/frontend-backend-modules.md)。

## 7. 入口

- **`mind-os`（apps/web-app）**：浏览器 SPA（IndexedDB 后端）。
- **`@itookit/cli`（apps/cli）**：MindOS profile + Session VFS 挂载 → YAML/.flow 编译为 RunDefinition/DagRunSpec → `app-core/createKernelRuntime` 装配 Kernel/Flow → 运行 → 结果落盘（RunStore 投影）。
- **`tauri-app`**：桌面壳。

## 8. 核心数据流

```
CLI:   YAML → config.ts 编译 → runtime.ts 装配(durable-kernel+kernel-adapters+flow)
       → DurableFlowExecutor.submit → 每节点 session.submit(TaskSpec)
       → bindCapabilities → start → drain 循环 → effect → 聚合 → selectFinalResult → result.txt

App:   bootstrap → initializeConversationSystem → SessionManager
       → sendMessage → ConversationRunCoordinator → (llm.chat | DurableFlowExecutor)
       → 事件经 TaskHandle.events() / SessionEventBus 渲染到 llm-ui
```

同步与 VFS 的模块依赖、端口边界及插件可行性见 [同步模块与 VFS 边界](design/sync-vfs-module-boundaries.md)，包含 C4 与预览、提交、恢复事件流。
