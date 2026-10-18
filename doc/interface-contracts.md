# 跨包接口契约

调用方只依赖接口，不依赖实现。契约按能力归属：driver-llm/contracts（模型通信与服务端口）、llm-context（领域消息与上下文）、tools/contracts（Tool/TTY 执行）、vfs-core（文件系统）；llm-tasks/contracts、llm-flow/contracts 和 llm-session/contracts 分别承载执行、编排与会话契约；kernel-adapters/contracts 承载配置管理与定价；common 不再转发 LLM 契约。

独立 `@itookit/llm-ui` 的 ChatOptions/ConversationSource/ConversationActions/OperationLedger 定义于 [contracts.ts](../libraries/llm-ui/src/contracts.ts)，FlowSource/FlowActions 定义于 [flow-contracts.ts](../libraries/llm-ui/src/flow-contracts.ts)。两者只依赖展示数据与 mdxeditor；MindOS 接线位于 `llm-ui-adapter/independent`，原工厂兼容入口迁至适配包。Flow 通过 `features.flow` 与 `setFlowEnabled` 控制，默认关闭。

`SessionChatBindingOptions.hasCommittedSubmission(submission)` 由宿主注入，委托 llm-session 的公开持久提交查询；不再注入仓储或在 UI 解析 Round。Send 入队后的回执与后续 confirmed 投影均依据同一后端证据；unknown 的 edit/retry 锁定目标消息，respond 锁定请求 ID/revision。Flow 的恢复 submitting 操作可显式核对，检查器保存后从新节点快照获取下次编辑版本。

## VFS 体系（@itookit/vfs-core）

| 接口 | 核心方法 | 定义 | 实现 | 消费 |
|---|---|---|---|---|
| `FileStorageBackend` / `OperationOptions` | `files` + 可选 `mutations`，signal/timeoutMs，opaque revision | `https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/storage/file-storage.ts`、`https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/core/operation.ts` | `piagent-driver` | `FileStorageAdapter` → VFS |
| `IStorageBackend` | `stat/list/read/write/mkdir/delete/rename` | `https://github.com/mushuanli/vfs-core/blob/main/interfaces/storage/` | `vfsdriver-indexeddb`、`vfsdriver-local` | `vfs-core (VFSEngine)` |
| `IVFSManager` | `openFileSystem()/mounts/devices/plugins` | `https://github.com/mushuanli/vfs-core/blob/main/interfaces/services/vfs-manager.ts` | `vfs-core (VFSManager)` | `app-core`、`app-shell`、`kernel-adapters` |
| `IFileSystem` | `openFile()/driver/meta/capabilities/capabilitiesAt()/discoveryRoot?()` | `https://github.com/mushuanli/vfs-core/blob/main/interfaces/services/file-system.ts` | `vfs-core (FileSystemView)` | `vfs-ui`、`llm-ui`、`llm-session`、`app-core` |
| `IFSDriver` | `getNode/getChildren/readContent/writeContent/createFile/createDirectory/rename/move/delete/search` | `https://github.com/mushuanli/vfs-core/blob/main/interfaces/services/fs-driver.ts` | `FileSystemView.driver` | `vfs-ui`、`mdx-adapter`、`llm-session` |
| `IFSMetaDriver` | `assets/tags/seq/refs/watcher` | `https://github.com/mushuanli/vfs-core/blob/main/interfaces/services/fs-meta-driver.ts` | `FileSystemView.meta` | `llm-session`、`mdx-adapter` |
| `IFile` | `read()/write()`（extends `IIOStream`） | `https://github.com/mushuanli/vfs-core/blob/main/interfaces/IFile.ts` | `FileHandle`、`MDXFileHandle` | `mdx-adapter`、`llm-session` |
| `FileDiscoverySource` / `FileDiscoveryOptions` | `list/stat/readIgnoreFile/rootFor`；`includeIgnored/excludeDirectories/signal` | `https://github.com/mushuanli/vfs-core/blob/main/interfaces/services/file-discovery.ts` | VFS 适配器、tools Node 适配器 | `discoverFiles` → 工具搜索及 llm-ui 文件候选 |
| `IIOStream` | `read()/write()/readStream?/close?` | `https://github.com/mushuanli/vfs-core/blob/main/interfaces/` | 文件/设备句柄 | 文件↔LLM↔TTY 互拷 |
| `IDeviceDriver` | `open()/ioctl()/close()` | `https://github.com/mushuanli/vfs-core/blob/main/interfaces/device/` | `LLMDeviceDriver`、TTY driver | `kernel-adapters`、`app-core` |

## LLM 契约（能力包公开入口）

`ProviderAuthorizationService` 的状态查询、开始/完成/取消/退出授权属于安全的配置端口，定义在 `kernel-adapters/src/llm-management/contracts/provider-authorization.ts`，从 `/contracts` 导出。私有 `ProviderAuthorizationHost` 只由宿主经 `/llm/core` 注入，不对外导出凭据方法。`ConnectionMeta.credentialsReady` 可选字段由宿主解析授权状态；旧实现缺省仍依据 API Key/Codex 判断。

| 接口/类型 | 核心字段/方法 | 定义 | 实现 | 消费 |
|---|---|---|---|---|
| `SessionPresentationState` | 可选 taskAttachment/flowInvocations/skills；应用启动组合读模型 | `app-contracts/src/ports/session.ts` | `app-core/host/open-view.ts` | `app-shell/lifecycle/opened-view.ts`，向编辑器注入领域初始数据 |
| `TaskAttachmentRecovery` / `ReadTaskAttachment` | 活动任务与待审批候选 ID；显式 Session、共享键，只读恢复线索，附着前核对实时状态 | `durable-kernel/src/ports/task-control.ts` | `app-core/host/task-attachment.ts`，由 ApplicationBackend.taskAttachment 提供 | `llm-ui` 可选恢复回调 |
| `EditorTaskControlPlane` / `AttachedTask` | openTask/openSession/listSessionTasks；共享挂接身份、Task 事件及控制 | `durable-kernel/src/ports/task-control.ts`，从 Kernel 根入口导出 | Kernel 或宿主远程客户端 | 聊天编辑器、任务挂接及 pending 恢复 |
| `SessionViewBinding` / `LLMFactoryDependencies` | 显式 sessionManager 或 resolveSessionView；仓储及可选宿主端口 | `llm-ui-adapter/src/chat.ts` | 宿主组合根 | createLLMFactory |
| `ILLMService` | `chat()`、`chatStream()`、`abort()`、`getConnection()` | `https://github.com/mushuanli/driver-llm/blob/main/src/types/service.ts` | `kernel-adapters LLMServiceAdapter` | `llm-tasks`（经 effect）、`llm-session` |
| `ChatMessage` | `role/content/attachments?` | `https://github.com/mushuanli/driver-llm/blob/main/src/types/message.ts` | driver-llm | 宿主通信适配 |
| `ChatCompletionParams/ChatCompletionResponse/ChatCompletionChunk` | `messages/model/tools/stream/webSearch`… | `https://github.com/mushuanli/driver-llm/blob/main/src/types/response.ts` | driver-llm providers | `llm-tasks`、`kernel-adapters` |
| `Citation` | `text/source/title/url`（联网搜索引用） | `https://github.com/mushuanli/driver-llm/blob/main/src/types/response.ts` | driver-llm providers | `kernel-adapters`、`llm-ui` |
| `TokenUsage` | `prompt_tokens/completion_tokens/total_tokens` | `https://github.com/mushuanli/driver-llm/blob/main/src/types/response.ts` | driver-llm | `llm-tasks`、预算扣减 |
| `LLMConnection/ConnectionMeta` | `id/name/providerId/tiers/model/protocol/credentialsReady?` | `https://github.com/mushuanli/driver-llm/blob/main/src/types/connection.ts` | `driver-llm` | `llm-session AgentResolver` |
| `WebSearchMode` | `'builtin'\|'client-tool'\|'disabled'` | `kernel-adapters/src/llm-management/contracts/connection.ts` | `resolveWebSearchStrategy`（纯函数） | `llm-session` |
| `SettingsAutoSave` / `requestSettingsSave` | 设置表单延迟保存、串行写入、失败重试与安全释放；不重建编辑 DOM | `ui-common/src/components/SettingsAutoSave.ts` | `BaseSettingsEditor`、`configuration-form.ts` | 七类 LLM 设置编辑器 |
| `ChatConfigurationView` / `ChatConfigurationSnapshot` | getConfigurationSnapshot/subscribe/dispose；安全展示配置，先安装快照再通知 | `kernel-adapters/src/llm-management/contracts/agent.ts` | `app-core/configuration/chat-configuration.ts` | `llm-ui` 选择器，HTTP workbenchView 注入 |
| `IConnectionService.listProviderModels` | 接受完整未保存 Provider，返回归一化模型目录；无持久化副作用 | `kernel-adapters/src/llm-management/contracts/agent.ts` | `LLMDeviceDriver` → `providers/model-catalog.ts`，`VFSAgentService` 转发 | `ProviderSettingsEditor` |
| `LLMProvider.supportedProtocols/defaultProtocol/modelsPath`、`LLMModel.preferredProtocol` | Provider 协议集合与默认、模型目录覆盖、模型首选；连接显式协议优先 | `https://github.com/mushuanli/driver-llm/blob/main/src/types/connection.ts`、`https://github.com/mushuanli/driver-llm/blob/main/src/types/protocol.ts` | `driver-llm` registry / Driver / `.llm` 转换 | Provider / Connection 设置页 |
| `LLMProvider.capabilities.serverSideWebSearch` | 服务端内置联网搜索能力（唯一事实源） | `https://github.com/mushuanli/driver-llm/blob/main/src/types/connection.ts` | `kernel-adapters/src/llm-management/constants/providers.ts` | `resolveWebSearchStrategy` |
| `ToolCall` / `ToolDefinition` | `id/name/arguments` | `https://github.com/mushuanli/driver-llm/blob/main/src/types/message.ts` | driver-llm | 宿主通信适配 |
| `ToolInvokeResult` | `success/output/durationMs`；可选 `data/errorCode/recoverable/truncated` | `tools/src/contracts/tool-types.ts` | `tools`、`kernel-adapters` | `llm-tasks`：显式 recoverable 失败反馈模型，其余失败终止任务 |
| `DagNodeDefinition/DagEdgeDefinition/DagRunSpec/DagNodeOutcome` | `id/plugin/config/outputs/effects` | `llm-flow/src/contracts/dag-plugin.ts` | `llm-flow` | `llm-session`、`cli` |
| `FlowDraft/FlowRevision/FlowNodeDefinition` | `nodes/edges/layout` | `llm-flow/src/contracts/flow-definition.ts` | `llm-flow FlowDefinitionStore` | `llm-ui`、`llm-session` |
| `SerializableExpression` | `kind: eq/neq/in/and/or/not/…` | `llm-flow/src/contracts/flow-definition.ts` | `llm-flow operations` | `cli` 编译路由条件 |

## Kernel 执行内核（@itookit/durable-kernel）

| 接口/类型 | 核心方法/字段 | 说明 |
|---|---|---|
| `DurableTaskProgram<S,I,O>` | `init(input) → Decision`、`reduce(state, event) → Decision` | 持久化状态机（Program 定义） |
| `EffectAdapter<R,O>` | `execute(request, ctx)`、`reconcile?`、`cancel?` | effect 执行适配器（能力面） |
| `Decision<S,O>` | `state + actions + next`（`complete/fail/wait/continue`） | 程序推进的返回结构 |
| `KernelAction` | `effect/spawn/request-interaction/set-shared/delete-shared/emit` | 程序声明的副作用 |
| `WaitSpec` | `signal/effect/task/interaction/all/any/quorum/child` | 等待条件 |
| `TaskHandle<O>` | `wait()/poll()/signal()/start()/respond()/createResource()/cancel()/events()` | 任务句柄 |
| `SessionHandle` | `submit()/signal()/respond()/createResource()/setBudget()/chargeBudget()/commitContext()/events()` | 会话句柄 |
| `TaskSpec<I>` | `program/input/dependsOn/retry/deferStart` | 提交任务的规格 |
| `TaskInputEvent` | `signal/task-exited/effect-completed/effect-failed/interaction-resolved` | 程序收到的输入事件 |
| `EffectExecutionContext` | `grants/abortSignal/emit()/chargeBudget()/sessionState` | effect 执行上下文 |
| `CapabilityBinding` / `bindCapabilities` | `kind/uri/rights/signalKey` | 能力绑定（createResource+signal+start） |
| `assertEffectGrant` / `interactionApproved` | — | effect 授权断言 / 审批判定 |
| `bindCapabilities(task, bindings)` | — | 上层能力绑定统一入口（独立函数，非 `TaskHandle` 方法） |

## LLM 任务单元（@itookit/llm-tasks）

| 接口/类型 | 说明 |
|---|---|
| `DurableProgramInput` | `sessionId/roundId/messages/connectionId/model/temperature/…` |
| `DurableAgentInput` | + `maxExchanges/workingDirectory/approval/tools/externalToolIds` |
| `DurableAgentOutput` / `DurableChatOutput` | `{ message, usage, finishReason, exchanges }` |
| `DurableDependencyBinding` | `taskId/input/output?`（跨节点数据边） |
| `buildLlmTaskInput` | 统一装配 llm.agent/chat 的 input |
| `extractNodeOutput` | `outputs[name].content → message.content → raw` 统一提取 |
| `collectDependency/dependenciesReady/dependencyWait` | 依赖收集状态机 |
| `ContextTaskProgram` | v2 执行 bridge：Context 写集、Task 状态与下一 Effect 联合提交 |
| `ContextAssembler` / `ProviderMessageAdapter` | 兼容转发至 `@itookit/llm-context` |

## 上下文（@itookit/llm-context）

独立接口为 `IContextAssembler`、`IContextProfiles`、`IContextEngine`、`IContextService`、`IContextReader`、`IContextContentStore`、`IContextGcStore`。`PreparedContext` 返回 cursor、explanation 和 CAS writes；消费方通过 Kernel 通用 action 提交，Context 不依赖 Kernel。GC 端口提供与发布和根提交串行化的原子视图，默认仅回收静止终态 Task 的过期孤儿。完整字段与调用链见 [Context API](context-api.md)。

## DAG 编排（@itookit/llm-flow）

| 接口/类型 | 说明 |
|---|---|
| `DagPlugin` / `DagPluginRegistry` / `DagPluginCatalog` | 插件契约与注册表 |
| `DurableFlowExecutor` | 动态图调度（route/loop/spawn/compensate/on_failure/budget） |
| `FlowValueProgram` / `FlowHumanProgram` / `FlowAggregateProgram` | flow 内置 durable programs（`flow.value/human/aggregate`） |
| `FlowDefinitionStore` / `FlowStore` | Flow 定义持久化（依赖最小 asset 存储面） |
| `DagCommandService` | DAG 控制面命令（run/snapshot/…） |
| `findCycles` | 环检测（回边 + 环上节点） |

## 会话层（@itookit/llm-session）

| 接口/类型 | 说明 |
|---|---|
| `ISessionRepository` | 会话持久化门面（VFS 资产/消息/会话清单），由 SessionRepository 实现 |
| `ConversationManifest` / `ConversationUIState` / `BranchTreeNode` | 会话清单/UI 状态/分支树 |
| `RoundManifest` / `RoundProjection` / `BranchMeta` | Round 持久化投影 |
| `SessionManager` / `SessionRegistry` / `SessionState` | 会话生命周期与状态 |
| `IAgentConfigService` | Agent/Connection 配置服务（供 AgentResolver 解析） |
| `CommandBus` / `ExtensionRegistry` / `ILLMPlugin` | 控制面命令与插件系统 |
| `ConversationSystem` / `initializeConversationSystem` | 装配入口（session + flow + programs + kernel） |

## 能力实现（@itookit/kernel-adapters）

| EffectAdapter | kind | 说明 |
|---|---|---|
| `LlmChatEffectAdapter` | `llm.chat` | LLM 对话（流式/非流式 + token 预算扣减） |
| `ToolCallEffectAdapter` | `tool.call` | 工具调用 |
| `SkillLoadEffectAdapter` | `skill.load` | Skill 加载 |
| `SkillUnloadEffectAdapter` | `skill.unload` | Skill 卸载 |
| `BashEffectAdapter` | `process.exec` | Shell 命令 |
| `TtyEffectAdapter` | `tty.command` | TTY 会话 |

## UI 体系（Ports/Adapters）

| Port 接口 | 关键方法 | 实现 |
|---|---|---|
| `IChatInputPresenter` | `setLoading()/setConfig()/getConfig()/restoreInput()/focus()` | `ChatInput` |
| `IHistoryPresenter` | `renderFull()/processEvent()/scrollToBottom()/getSessionElement()` | `HistoryView` |
| `IEditor`（抽象类） | `init()/destroy()/getText()/setText()/setTitle()/updateNodeId?()/flushPendingSave?()/cancelPendingRender?()` | `MDxEditor`、`FlowsEditor`、`LLMWorkspaceEditor` |
| `IStreamingController` | `enterStreamingMode()/exitStreamingMode()` | `HistoryView`（经 `StreamController`） |
| `ICollapseManager` | `toggleSessionCollapse()/setAllCollapsed()/toggleAllFold()` | `HistoryView`（经 `CollapseController`） |
| `INavigationPresenter` | `toggle()/update()` | `FloatingNavPanel` |
| `IStatusPresenter` | `update()/updateFromSnapshot()/updateBackground()` | `StatusIndicatorView` |

### 会话目录配置

`EditorHostContext.chatFromFile(reference, association?)` 由宿主注入。MDX 仅提供当前文件路径、当前内容或选区快照；项目文件宿主补充 projectFolder，Session 文件宿主补充 sessionId。app-shell 负责项目归属、新建会话、持久化 main 分支输入草稿和导航，不自动发送。

`EditorHostContext.directoryCommands.configureWorkspace(mode)` 由 SessionWorkbench 注入，llm-ui 的 WorkspaceDirectoryMenu 消费。`workspaceReadOnly` 表示主目录设置仅供查看，不改变文件权限：项目会话的 `workspace` 模式展示项目目录，`mount` 模式管理额外挂载；未归属项目的会话仍可设置主目录。界面不直接接触宿主文件路径 API。运行时向 `DirectoryMountService.fixedWorkspace(sessionId)` 注入所属项目的目录，服务在写入授权前校验主挂载来源、权限和 cwd，拒绝替换、移除或借附加挂载改变主目录；继续复用 Session 授权 revision 和挂载变更守卫。

文件搜索可通过 `ToolVFSContext.walkFiles(dir, options)` 增量消费路径；`createVFSToolContext` 同时实现惰性接口和兼容的 `listFiles`，两者共享忽略规则。Grep/Glob 必须优先使用惰性接口，达到结果上限立即关闭迭代器，避免桌面 IPC 完整遍历导致工具超时。

## Tool / Skill / MCP 能力配置

`ILLMManagementService` 的 `testMCPServer`、`readMCPResource`、`getMCPPrompt` 由 LLMDeviceDriver 实现，VFSAgentService 转发给设置 UI。`SessionCapabilityScope.resolveMCPToolIds` 经 app-core 注入 AgentResolver 与 Harness/Flow 提交层；最终授权固定在 Task 输入。`ToolExecutionContext.onProgress` 与 `INativeShell.exec` 的 `onOutput` 连接进度生产者和 History 投影。详细语义与验证见 [能力配置与执行](./design/tool-skill-mcp-capabilities.md)。


### 文件编辑展示与读取

`EditorOptions.contentFormat` 区分 `markdown` 与 `text`。AppShell 根据统一文件注册表声明文档别名；默认编辑器将其他文件视为源码，保留编辑与保存能力，禁止 Markdown 预览。大 Markdown 默认源码模式，但仍允许用户显式预览。源码策略不改变 `readOnly` 或文件视图授权。

桌面 `fs_read_file` 和 `directory_read_file` 使用 Tauri 原始 `ArrayBuffer` 响应；后者缺失文件返回 `null`，越界、符号链接或已关闭 grant 仍拒绝访问。旧的完整文件 JSON 数字数组不再是这两个客户端入口的协议。

`EditorOptions.signal` 用于编辑器初始化期间的视图取消；完成初始化后解除绑定。宿主隐藏已创建的编辑器时调用 `cancelPendingRender`，独立于 `flushPendingSave`。取消预览不取消保存或持久任务。

HTTP 外挂的条件写入、取消与项目授权见 [HTTP VFS 设计](design/vfs-http-driver.md)；调用方必须使用读取字节时返回的 revision，不使用保存前 stat 替代读取版本。

`EditorHostContext.openFile(path, anchor?)` 打开编辑器文件命名空间中的文档。MDX 使用当前文件路径解析普通 Markdown 相对链接，宿主映射到所属项目/会话路由并打开标签；收藏入口仍以实际文件路径为基准，移动与重命名通过 updateNodeId 更新解析基准。外部 URL、附件与 mention 保留各自行为。

## 独立编辑器宿主接口

[mdxeditor 的 editor/contracts.ts](https://github.com/mushuanli/mdxeditor/blob/main/src/editor/contracts.ts) 定义并从 `@itookit/mdxeditor` 导出 `AssetProvider`、`StoreFactory`、`EditorHost`、`EditorOptions` 与 `IEditor`。核心不持有 `IFileSystem`，附件与插件存储按需注入，保存通过 `onSave` 注入。`@itookit/mdx-adapter` 将 `ui-common` 的 target/files/hostContext 转成上述公共端口，在构造编辑器前校验 namespace 与 Session；消息和会话标识保留在宿主，核心只使用可选 `documentPath`。

### 独立 VFS UI 接入

`vfs-ui` 仅依赖 `vfs-core`。`BrowserSource` / `BrowserAction` 接收自定义资源与动作；`VFSPresentationOptions` 按实例注入翻译、SVG 和启动跟踪；`TagEditorFactory` / `ContextMenuConfig` / `UIPersistencePort` 接收宿主组件、菜单和存储。消费方从 vfs-ui 导入这些类型，或提供结构兼容实现，无需依赖 common/ui-common。MindOS 展示适配位于 `app-shell/src/browser/vfs-presentation.ts`。

通信契约的权威实现已迁到 `https://github.com/mushuanli/driver-llm/blob/main/src/types/`，原 llm-common 和 common 的 LLM 兼容转发已删除。通信消息 DTO 由 `https://github.com/mushuanli/driver-llm/blob/main/src/types/message.ts` 定义；上下文领域消息仍归 `llm-context/src/domain/message.ts`。两包互不依赖，宿主将上下文结果映射为通信请求；目前兼容字段可直接按结构赋值。模型设备与配置实现已迁到 `kernel-adapters/src/llm-management/`，通过 `@itookit/kernel-adapters/llm` 公开。

## 外部 harness 端口

`PiAgentDriver` 由宿主装配并注入远程来源服务，统一凭据，暴露文件/进程 provider、sync 与 harness。`HarnessClient`、`HarnessProfile`、`HarnessSession`、`HarnessEvents`、`HarnessReceipt` 位于 piagent-driver `/harness` 公共入口，app-core 只使用类型并转发给 app-shell。

创建仅使用服务端声明的 workspaceId；继续先核对 native cwd 授权并拒绝抢占活跃会话；发送、响应和中断必须属于本服务接管的会话。只读历史不触发 resume。修改必须使用当前 epoch/requestId，未知结果查询 operation 收据，禁止自动重放。事件有独立 epoch、递增 seq 与 cursor；gap 要求刷新历史，不能宣称完整输出。客户端关闭不代表原生 turn 停止。

`MCPServer.auth` 保存 basic/bearer 类型、username 和 credentialRef，密钥由 `MCPConnectionOptions.resolveCredential` 在每次请求解析。`beforeSave/beforeDelete/configurationChanged` 由应用注入授权与投影刷新；机制不依赖 app-core。`MCPConnectionOptions.extensions` 注册 `MCPConfigurationExtension`，其 `matches` 本地筛选标准发现结果，`discover` 通过 `MCPConfigurationExtensionContext` 消费 `MCPDiscovery.metadata` 或复用当前连接的 `callTool`。验证结果放入 `MCPDiscovery.extensions`，管理器负责测试/保存复用与连接身份变更后的重新验证。

pi-agent 可直接使用标准 `MCPServer.apiKey`（Bearer，无 username）。app-core 注册的扩展优先验证 `server/discover._meta['itookit/pi-agent']`；旧服务通过已声明的能力工具验证，不为普通 MCP 发专用探测。结果保存于 `MCPServer.extensions['itookit/pi-agent']`，绑定须匹配当前 MCP endpoint 及已知 fileProtocol。`MCPRemoteConnections` 从已验证配置恢复驱动凭据，API Key 不复制到项目挂载记录。旧 basic/bearer credentialRef 仍支持。配置展示名自由修改，不用名称判断能力；设置 UI 控件只呈现已识别扩展。

`ProjectFolder.displayName` 是当前服务器名与项目名的组合；持久身份 name 与可选 navigationName 区分人类名称和稳定路由。`MCPRemoteConnections` 是 MCP 目录的只读投影及旧连接迁移适配，不在挂载目录保存第二份连接配置。


`PiAgentDriver.projects` 暴露 ProjectClient/RemoteProject/ProjectMount/RegisterProject；服务端目录项目与 sync 数据项目是不同身份。项目文件请求使用项目 ID、revision 与只读衰减 headers，project_exec/harness 从服务端同一份授权获取 mounts。ProjectLauncher 是进程/harness 共用启动端口，当前 bubblewrap，VMM 尚未实现。详见 [项目模型](design/pi-agent-project-model.md)。

`ProjectRemoteMountService.remountProject` 修改客户端项目权限，必要时经可选 `ProjectClient.remount` 调用 `project_remount` 提升服务端项目根授权；所有写入均校验当前权限与版本，不修改项目身份。客户端降为只读只衰减本地绑定。`ApplicationBackend.unmountProject` 是本地卸载用例，允许远端离线，不通过远程文件删除或服务端 `project_forget` 执行。

### 远程项目会话展示端口

`ui-common` 的 `ConversationControls` 由宿主注入，提供 read/poll/send/respond/interrupt/reconcile/close 及能力限定的 rename/archive，返回规范化历史、待交互卡片及操作可用状态。`piagent-driver` 的 `HarnessConversation` 按结构实现；app-core 的 `ProjectRemoteMountService.projectConversation` 注入项目授权和持久回执 journal；llm-ui 只消费该端口。`RemoteAgentControls` 提供项目范围内目标列表及发送路由，远程选择不进入本地 SessionCommand.Send。原生会话引用、输入草稿和待确认回执位于 `/etc/fs/harness-conversations.seq`，不复制原生历史。 `ConversationSnapshot` 可携带 `canFork` / `hasEarlier`，对应可选 `fork` / `branches` / `loadEarlier`；分支切换仍由宿主导航处理。`HarnessHistory.nextCursor` 与 `HarnessHistoryOptions.cursor` 描述只读历史分页；`HarnessClient.inspect` 读取元信息，`fork` 是带 epoch/requestId 的原生修改。

`ModelConfigurationCommands.inspectMCPDeletion` 返回配置和项目挂载引用的删除预览；`deleteMCPServers` 校验预览并要求有引用时显式 force。`MCPDeletionPort` 由 ProjectRemoteMountService 实现，预览由 ProjectService 提供远程项目与本地会话信息；经 SessionLifecycleService 清理以目标 MCP 为根来源的本地远程项目及其本地会话，再批量移除引用并释放视图。普通本地项目只解除附加挂载，服务器内容和原生会话保留。普通 MCP 删除仍禁止有引用的配置。

`MCPRemoteConnections.diagnostic(connectionId)` 返回不含凭据和端点的 `MCPConnectionDiagnostic`（名称、验证原因、catalog revision、当前配置身份）。`ProjectRemoteMountService.resolveConnection` 在异步访问前恢复当前引用，缺失连接抛出 `RemoteConnectionUnavailableError`，保留 ENOENT 错误码并附带诊断及引用项目 ID。宿主本地化展示；`reportRemoteFailure` 记录 `pi-agent` 模块日志和时间在前的控制台错误，按异常实例去重，只输出身份、阶段、结构化错误码。详见 [项目模型](design/pi-agent-project-model.md)。


`HarnessClient.search`、`ProjectClient.search` 是可选的能力协商读取端口，返回有界 matches/truncated/nextCursor；项目搜索默认仅当前项目。`ProjectSearch` 统一本地文件及 PI Agent 文件/原生会话检索，完整绑定身份随结果传播，在点击导航时再次核对。`ConversationSnapshot.observation` 与 driver 的 `HarnessObservation` 结构兼容；`conversationStatus` 为正文/侧栏/标签提供统一状态文案。`RemoteSessionStatus` 是按项目引用计数的只读观察用例；其 provider 在 driver 实现，无 app-core DOM/Node 依赖。`exportRemoteSession` 输出原生只读 JSON；`remoteSessionSources` 只匹配已注册且完整授权的附加项目来源。


`HarnessProfile.capabilities` 可声明 rename/archive/unarchive 和 attachments（text/image）；`HarnessSession.archived` 表示原生归档。管理调用沿用 epoch/requestId/receipt，不以 VFS rename/delete 替代原生操作。`ConversationSnapshot` 暴露 canRename/canArchive/canUnarchive 与附件种类；`send` 和 `saveDraft` 接受有界内联附件，`draftAttachments` 只保存未发送的输入，不复制原生历史。未知 turn 回执确认后清空已提交草稿，保留后续编辑，不自动重发。`HarnessStatusRow` 带可选 title/archived/fileVersion，宿主通过共享订阅更新标签及有限目录刷新；普通文本 delta 不推进 fileVersion。


`HarnessClient.directoryVersion`、`HarnessStatusPort.fileVersion` 是可选的目录观察端口。发现元数据 `PiAgentDescriptor.fileWatch` 协商 project_watch/project_unwatch，使用项目 revision 和私有 watchId；响应只返回版本、gap 及覆盖不足标记。`RemoteSessionStatus.fileVersion` 合并独立目录版本与原生文件事件，零会话仍可通知，授权变更失效。Claude 与 Codex 共用公共会话契约；Claude 子进程断线的 harness/disconnected 携带 threadId，只影响该会话。Claude capability 不声明未实现的分支、重命名或归档操作。

## 数字分身宿主接口

扫描公开契约为 app-core 的 `TwinScanPlanInput`、`TwinScanPlan`、`TwinScanRun`、`TwinScanState`；命令由 `DigitalTwinService.saveScanPlan`、`setScanPlanEnabled`、`removeScanPlan`、`runScanPlan`、`cancelScanRun`、`waitScanRun`、`scanOnce` 提供。`snapshot().scans` 返回计划、运行、下次检查和宿主信息。UI 只调用服务，工具箱资源仍按原协议管理；扫描不注册绕过来源授权的通用工具。扫描守卫在预算预留、模型发送和结果提交核对计划版本、来源范围、提取类型、运行状态与宿主 fence，预算和检查点与结果原子提交。

`DigitalTwinService.getSettings()` 仅读取设置及其 revision，供 UI 自动保存使用，不枚举来源、会话或运行记录。`configure(patch, revision)` 保持版本条件更新，UI 串行提交变更字段并在预算等后台写入冲突时重新读取版本。

`DigitalTwinService.snapshot(progress?)` 只读取已保存的知识与任务状态，不触发来源校验或清理；可选回调用于诊断读取阶段，`diagnostics()` 返回初始化位置。后台扫描持有租约后恢复清理并校验来源，完成后通知视图读取新状态。

`DigitalTwinService` 位于 `app-core/src/digital-twin/service.ts`，公开 `snapshot/addSource/analyze/review/retrieve/forget/forgetScope/linkExecution/selectionInfo/selectSource/removeSelection` 等宿主管理方法；`selectSource` 保存显式范围和分析类型后立即请求后台扫描，`selectionInfo` 返回来源状态/知识/任务，`removeSelection` 停用并清理来源提取结果且保留原文；配置支持提取模型与用户姓名/别名，snapshot.prompt 返回基础提取提示词。owner 和来源/消费权限不由模型参数提供。`TwinStore` 位于 `app-core/src/digital-twin/contracts.ts`，公开版本条件提交、固定页枚举、原子失效与可恢复清理，仍由 VFS 的同后端 SeqFile 事务承载。

`KernelAdapterDiagnostics.authorizeLlm(request, context)` 位于 `kernel-adapters/src/ports/diagnostics.ts`：宿主可异步拒绝发送，或设置通用请求诊断 `_label`；LLM 适配器在持久请求事件前和实际发送前调用，发送参数在第二次校验后生成。底层不导入分身领域类型。该钩子是发送时授权校验，不能撤回已经发送的网络请求，也不代表跨网络/数据库的原子事务。

数字分身新扫描入口：`DigitalTwinService.saveScanRule(id, revision, {name, include, exclude, intervalMinutes, enabled, focus?, kinds?})`，`previewScanRule({include, exclude})` 不提取/不新增来源；`TwinSourceReader.discover()` 返回资源、项目与完整范围，`probe()` 可提供文件版本。模型和全局排除通过 `configure` 保存；`budgetUnlimited?: boolean` 控制累计预算是否无限，不改变 `tokenLimit: 0` 的原语义。自动规则将无限标记写入运行记录，并在下一次预留/结算时核对最新全局预算，实际用量继续记账；旧 `saveScanPlan` 的独立额度保留兼容。

`snapshot().graph` 返回由有效事实派生的 `TwinGraph`（节点、带类型的关系及记忆引用）。`mergePeople(from, to)` 保存显式人物身份映射，不改写来源证据；`previewScanRule` 返回匹配的 `resources` 与排除的 `excluded`。扫描 scope 固化 `focus`，同一来源按关注点复用或区分提取检查点。

单用户知识消费默认对已接入的 Chat/Agent 开放，不再读取 grant 作为许可；使用总开关与全局忽略在检索及发送前生效。`local:` / `remote:` 匹配文件目录，`session-name:` 匹配会话名；规则级忽略不覆盖其他规则的包含范围。历史 grant 记录保留但不再生效。

## 初始文件恢复

`app-settings` 的 `InitialFilesPort` 注入 `list()` 与 `restore(ids)`；列表包含稳定 ID、分组、文件名、目标路径和存在状态，恢复返回逐文件 restored/preserved/failed。`app-core` 的 `MindosInitialFiles` 提供产品模板，宿主将当前笔记文件系统和 CommandBus 注入；笔记只创建缺失文件，Flow 复用 DraftLoad/DraftRestore。文件系统及系统恢复页复用 `InitialFilesSection`，默认全选、分组折叠，保留勾选和展开状态，不把文件恢复等同于覆盖或模型分析。 系统恢复页将初始文件与配置勾选统一计入顶部“恢复选中项”，确认时分别说明补缺失文件与覆盖内置配置的影响；“刷新全部状态”覆盖所有分组并保留勾选和展开状态；各折叠组标题旁的“全选”仅作用于本组。“重置全部内置配置”仅针对 Provider/Connection/Agent，不包含初始文件。

数字分析的 selectionInfo 返回关联扫描 runs 与分析结果。用户修正将知识转为独立陈述，originSourceId 仅保留文档归属，不作为事实证据；对话框据此继续显示修正结果。显式 removeSelection 一并清理这些关联修正，普通来源变更不覆盖用户陈述。旧记录无需迁移。

数字分身 job 与 scan-run 可选 errorDetail 保存经过凭证过滤和长度限制的失败原因，error 仍保留稳定错误码。提取任务分别报告失败、超时、取消、JSON 格式不符和输出截断；历史记录无详情时可重新扫描获取原因。UI 将任务状态与未确认用量分开显示，预算入口位于自动更新的通用设置“用量与预算”。

分析 job 可选 createdAt/startedAt/finishedAt 记录创建、附着执行任务和终止时间；历史记录不伪造时间。Web Console 的 [DigitalTwin] 日志记录阶段、连接、任务 ID、字符数、耗时及过滤凭证后的错误摘要，模型输入和响应正文不进入该日志。诊断可按任务 ID 对照对话框中的任务详情。

提取请求显式设置 thinking=false、maxTokens=8192、stream=false；预算预留包含输入字节数、8192 token 输出额度及提示词余量，并按返回的 total_tokens 结算。截断/格式错误带有已知 total_tokens 时，job、settings 和 scan-run 原子结算，失败不推进来源游标；重复结算不重复计费。无任务时间的历史记录仅展示其 scanScope.runId 对应扫描时间，并明确标注，不从其他任务或当前时间推断。

数字分析当前使用非流式提取。通过 Kernel 公开任务事件记录 requestStartedAt、responseReceivedAt 和 responseCompletedAt；请求启动不代表服务端接收确认。驱动超时单独标记 TWIN_EXTRACTION_TIMEOUT；非流式未返回完整响应时不能推断网络链路或服务端生成的具体阶段。界面独立展示当前更新、下次调度与全部可展开的历史扫描/任务记录。

`ApplicationBackend.openView` 返回 `OpenedApplicationView`（UI 文档、工作台、可选初始会话、事件水位与观察句柄）；由 app-core 的 host/open-view 实现，app-shell 的 lifecycle/opened-view 消费。`ApplicationViewObservation.observeView(after, listener)` 在登记时有界重放并持续分发；快照水位仅属于当前客户端，已有编辑器切换保留 openSessionView/activate 屏障。详见 [HTTP 打开与观察聚合](./http-app.md#打开与观察聚合已实现)。

HTTP v14 的 bootstrap 可携带 OpenViewRequest 并返回 HostedApplicationClient.initialView，先登记观察再导出能力；HttpViewClient 将 SSE viewEvents 适配为本地 ApplicationViewObservation。纯数据按 SHA-256 校准，句柄每个连接独立，见 [一次打开同步握手](./http-app.md#一次打开同步握手与首帧v14)。

`ApplicationViewObservation.getSessionBaseline` 返回成对快照/水位，调用者只读使用；传输按公开 `observeView` 的事件更新行投影，不读取具体宿主的内部会话源。`KernelInspectionPort` 仅供 `LocalApplicationServices` 的宿主聚合使用，不属于前端 `KernelViewPort`，也不注册为远程能力。

工作台 `SessionBrowserPort.setSessionFilter(agentId?)` 只改变该观察实例的会话投影；RPC 显式登记此方法。项目会话列表在分页前匹配不可变 `ConversationManifest.createdWithAgentId`，`ProjectSearchQuery.agentId` 对会话搜索执行同一条件，文件检索不受影响。宿主 `EditorOptions.mountSettings` 挂载默认项目偏好并参与保存/销毁；`SessionDraftControls.scope` 为草稿提供项目选择候选及切换回调。

项目草稿原地转正：`ProjectDraftComposer.id` 提供草稿 UUID，显式 clear 返回替代 UUID（RPC 字段为句柄创建时的快照，宿主使用返回值更新身份），`ProjectDraftPromotion.remote` 携带已确认的原生会话引用。`projectConversation` 可接收草稿 UUID，并通过 `ProjectConversationPort.conversationId` 返回稳定的宿主身份；RPC 显式传递此字段。首次原生提交 journal 与正式重开使用相同 UUID，只有已确认首 turn 才推进草稿；原生创建和 unknown 不能替代接纳证据。`SessionDraftControls.inPlace` / materialize 的 container 将同一挂载点交给正式控制器，接纳后宿主原地更新标签。详见[项目会话导航](design/project-session-navigation.md)。

`SessionDraftControls.scope.select` 的可选 SessionDraftPreferences 在项目切换前捕获当前输入偏好，导航层仅转交；目标草稿编辑器按当前候选验证智能体与连接/模型后应用，不携带源文本或附件。待接纳控制器及隐藏/关闭视图不接收迟到偏好，执行锁和 Flow 引用不跨项目复制。

## 原生 Harness 斜杠命令

ConversationControls 的可选 commands/command 端口承接当前原生会话的命令目录和执行；snapshot.supportsSlashCommands 只在宿主声明能力时启用。piagent-driver 通过 profile.capabilities.slashCommands 协商，目录为纯数据，具体命令名与原生 RPC 留在 pi-agent 对应插件内。Claude 使用 SDK 目录及 slash prompt，Codex 将 compact/review 映射为专用控制调用，DSH 使用原生 commands/list 与 commands/execute。

原生会话输入使用 NativeSlashCommandPlugin 提供候选，不混入本地 Kernel slash 操作；选择只填入输入，发送时再次验证当前目录。command 沿用 epoch、requestId、项目 revision、操作队列和 reconcile，可接纳但不产生 turnId；只有 prompt 类命令产生原生用户消息时才按该消息身份呈现。DSH command/run、command/done 以稳定 commandId 进入系统记录。未知操作跨视图保留，接纳不清除提交后的新草稿；关闭输入释放插件并拒绝迟到目录恢复弹层。


## 原生 Harness 模型与推理能力

`profile.capabilities.models` 协商可选的 `HarnessClient.models(profileId, sessionId?)` / `ConversationControls.models()`。目录只包含模型 ID、显示名称、该模型支持的 reasoningEfforts、可选默认值与已知当前选择；推理 ID 保留原生值，不映射为本地 Connection 的 modelTier。当前值未知时不伪造会话配置。旧节点不查询新工具，不提供选择入口。

`harness_models` 是带项目/授权范围的只读查询；`harness_turn.selection` 为 `{modelId, reasoningEffort?}`。客户端和对应原生适配器均按模型目录校验，配置与提示词沿用同一次 epoch/requestId 提交及回执核对，禁止自动重放。Codex 使用 model/list 和 turn/start 的 model/effort；Claude 使用 SDK initialize.models、set_model 及只作用于本会话的 apply_flag_settings.effortLevel；DSH 使用 session/modelCatalog、session/selectModel，再 session/prompt。Claude 未附着会话的目录发现使用不持久化的临时 SDK 进程，不发送模型请求。

模型菜单复用 ChatInput 的 PopupPanel，只有一个紧凑入口；先选模型，再展示这个模型的推理选项，也可以跟随原生配置。项目草稿的选择按 executorId 保存，切换执行器不继承过期选择；草稿转正前捕获配置并传入第一条消息。关闭或切换绑定拒绝迟到目录恢复弹层。发送后的配置修改只影响下一次提交。prompt 类原生命令可携带选择，action 类控制命令按原生语义执行，不强行覆盖模型。


独立 llm-ui 输入新增 ConversationSnapshot.commands、ConversationActions.command 和 composeCommandCatalogs；命令的 source / commandId / id / revision 与 prompt/action 语义分开表示来源、路由目标和展示。NativeChatBindingOptions.commandProviders 聚合 UI、宿主与当前 harness 的有效贡献；SessionChatBindingOptions.composerCommands 接入应用命令目录及自己的操作核对。selectors.variants 支持按独立父选择器切换选项，模型改变时推理选择不跨模型遗留。当前工作台兼容输入与独立 ChatView 分别验收，迁移边界见 [独立模块设计](./design/llm-ui-independent-module.md#10-输入能力连接与命令聚合)。


`ConversationControls.command(name, args?, selection?, inputText?)` 的 inputText 保留提交时的原始草稿，独立于用于执行的解析参数；两个输入入口共享 independent/native-command。`ProjectConversationPort.send` 同步传递 selection，command 同步传递 inputText。`ProjectRemoteMountService.projectModels(projectId, profileId)` 是只读应用用例，由 app-core 管理查询客户端，HTTP 传输登记为 query。

`HarnessRecovery.draftRevision` 与 pending.draftRevision/inputText 共同限制接纳清理；commandResults 保存最近 64 条有 commandId 的本地系统结果，原生同 ID 历史优先。Claude 未接管的已有会话仍可发现目录和别名；compact 是不要求用户消息回显的 action。首条 prompt 命令与消息共用会话准备及草稿转正，会话级 action 在尚无会话的草稿中禁用。流程与 C4 职责见[原生提交与恢复](design/llm-ui-independent-module.md#104-原生提交与恢复的共同路径)。
