# 核心集成链

独立 llm-ui 的 Chat/Flow 通过宿主 source 发布事实、actions 提交意图，操作结果进入宿主持有的 OperationLedger；视图关闭只释放 UI。以下原产品的 Session/Kernel 接线与编辑器兼容实现位于 llm-ui-adapter。

> 详细架构参见 [architecture.md](./architecture.md)

## 1. VFS 全栈链（@itookit/vfs-core）

```
vfs-ui (VFSUIShell)
  → IFileSystem (vfs.openFileSystem(rootPath))
     → FileSystemView.driver (IFSDriver) → VFSEngine → IStorageBackend
```

| 步骤 | 组件 | 关键文件 |
|---|---|---|
| 1. 创建 | `createVFS({ rootBackend, additionalMounts, devices, plugins })` | `https://github.com/mushuanli/vfs-core/blob/main/src/impl/factory.ts` |
| 2. 引擎 | `VFSEngine` — 路径解析、系统节点映射 | `https://github.com/mushuanli/vfs-core/blob/main/src/impl/engine/` |
| 3. 管理器 | `VFSManager` — 挂载/设备/插件 | `https://github.com/mushuanli/vfs-core/blob/main/src/impl/services/` |
| 4. 文件视图 | `FileSystemView`（组合多个挂载点，按路径归一化） | `https://github.com/mushuanli/vfs-core/blob/main/src/impl/services/` |
| 5. 存储 | `IStorageBackend`（IndexedDB / LocalFS） | `vfsdriver-*/src/` |

重命名使用路径型节点 ID，因此必须同步整条运行链：

```
node:renamed
  → VFSStore 原子迁移节点、后代路径和 active/selected/expanded 状态
  → app-shell/browser/editor-connector.setTitle() + updateNodeId()
  → LLMWorkspaceEditor
      ├─ StateManager / HistoryView 内嵌 MDX owner
      ├─ SessionRegistry / active task
      └─ RoundLog / manifest 路径缓存
```

## 2. LLM Chat 链（Direct 会话）

HTTP 冷启动会话深链由 `workbenchView({initialSessionId})` 并行准备工作台和一个 `initialSession`，旧视图保存后才 `activate`。配置选择器消费 `chat.configuration` 的已就绪快照与共享订阅；主题和工作台 UI 文档按路由合并预取。事件注册后直接消费同会话的已观察快照，避免额外 GetSnapshot；普通切换保持 openSessionView → 保存/释放旧视图 → activate 的顺序。

后台 Task 恢复通过宿主注入的 `readTaskAttachment` 回调一次读取活动任务和待审批 ID，不改变前端会话绑定；无候选跳过重复 Flow 列表读取，有候选继续新鲜读取 Flow 归属并校验编辑器代次后附着。未注入时使用原 Kernel 端口。Flow 列表属于只读命令，不触发全域失效或等待写入的订阅屏障。

打开 Session 时，`SessionService.loadSession` 只绑定一次，完成目标分支选择后复用 manifest；输入状态在 HistoryView 创建前读取。新建 API 的侧栏刷新与编辑器打开并行。历史链读取和首屏 Markdown 去重的证据见 [Session 性能审查](./design/llm-ui-session-performance.md)。

工作台侧栏标题区通过 npm 包 `@itookit/vfs-ui` 的工具栏动作定义呈现创建和刷新入口：“所有项目”只提供新建项目，进入项目后隐藏新建项目及切换器中的创建选项，仅提供新建会话；创建会话继续校验项目归属。导入、导出统一收进宿主标题区的“…”菜单，所有项目及项目内均可使用，操作读取点击时的选择与当前项目，导入完成只刷新列表，不自动打开首个结果。项目内菜单保留“项目操作”，继续使用原项目资源菜单。刷新经 `SessionWorkbench.refresh` 使导航缓存失效并刷新资源树、项目切换器与当前目录列表，等待现有刷新队列完成，复用工具栏的去重与禁用状态，不重新创建已打开的编辑器或恢复输入草稿。

从顶层导航或开始页进入工作台时显示所有项目，不恢复缓存的项目或会话正文；历史标签仍可主动选择。项目行单击只选择，双击、键盘 Enter、菜单“进入项目”或项目切换器的明确选择才进入项目；展开、勾选、创建项目、导入及后台刷新不切换项目。异步项目选择在工作区隐藏、切换项目或销毁时失效，旧结果不得发起导航。明确的深链接和历史前进/后退保留其资源目标。

远程项目根的菜单保留重命名，提供“重新挂载为…”的只读/读写选择和“卸载项目”，隐藏复制、移动和通用删除。重新挂载先保存并关闭本项目标签，调用 `remountProject` 校验服务端导出权限、更新持久绑定并撤销旧视图；若原先打开了本项目资源则重建该资源，否则保持所有项目视图。卸载走独立后端 `unmountProject`，仅移除本地接入和本地会话，远端目录与原生会话保留，离线不阻止卸载。MCP 详情通过项目服务订阅显示当前挂载及客户端权限，不复制权威状态。

远程原生会话类型目录（如 codex · codex-main）的目录工具栏和侧栏提供“新建会话”，目标绑定当前项目及 profile，不回退本地会话。按钮复用后端投影的 `@new` 条目，无额外 profile 探测；只有可写挂载且 profile 声明 create 时返回该入口，归档页不显示。点击仅打开持久草稿，首条消息发送时经 ProjectConversationPort 执行原生 create/turn。分页和多个类型的侧栏路由缓存有界，后端仍在执行时检查授权。

```
ChatInput.send (llm-ui)
  → SendMessageCommand
    → llm-session SessionManager.sendMessage()
      → ConversationRunCoordinator
        → 对话：仅保留联网检索能力；执行：保留 Agent 已授权工具
          → session.submit(llm.chat / llm.agent，优先 v2)
          → bindCapabilities(llm[/tool] handle)
          → kernel drain → DurableAgentProgram.reduce → llm.chat effect
            → kernel-adapters LlmChatEffectAdapter（assertEffectGrant + chargeBudget）
              → ILLMService.chatStream
                → LLMServiceAdapter → LLMDeviceDriver.ioctl(CHAT)
                  → provider（OpenAI/Anthropic/Gemini）→ SSE 流式
```

| 步骤 | 组件 | 关键文件 |
|---|---|---|
| 输入 | `ChatInput.triggerSend()` | `llm-ui-adapter/src/components/input/` |
| 命令路由 | `SendMessageCommand` / `SlashCommandRouter` | `llm-ui-adapter/src/commands/`, `shell/` |
| 会话 | `SessionManager.sendMessage()` | `llm-session/src/session/session-manager.ts` |
| 编排 | `ConversationRunCoordinator`（Direct / Flow 分流） | `llm-session/src/session/conversation-run-coordinator.ts` |
| 程序 | `DurableChatProgram` / `DurableAgentProgram` | `llm-tasks/src/durable/` |
| 能力绑定 | `bindCapabilities` → capabilities signal | `durable-kernel/src/application/capabilities.ts` |
| Effect | `LlmChatEffectAdapter`（llm.chat） | `kernel-adapters/src/effects/llm-chat-effect.ts` |
| LLM | `ILLMService.chatStream` → provider | `kernel-adapters/llm/llm-service-adapter.ts`、`https://github.com/mushuanli/driver-llm/blob/main/src/` |

输入工具栏提供「对话 / 执行」：`executionMode` 随 Session settings 保存，发送时写入 `SendIntent.execution.mode`，在异步上传/任务准入前复制。Task 固定 `labels.executionMode`、工具列表和预算；执行中的模式按钮禁用，程序恢复不重新读取 UI 设置。对话模式只允许已授权的 WebSearch 客户端工具或 Provider 内置搜索；执行模式使用 llm.agent，最多 50 次模型交换，外部操作继续审批。Flow 选择后禁用该开关，按 Flow 定义执行。两种模式均使用既有 Context/GC。

执行模式工具链：app-core 的 `resolveHarnessToolIds` 从 Session 工具目录选择已启用的 Read/Glob/Grep/Write/Edit/Bash → llm-session 仅在 Agent 未配置 toolIds 时采用该默认集 → `resolveTools` 装配定义 → Task 固定 tools/allowedToolIds。显式空白名单不回退，无工具时显示错误。ToolDeviceDriver 将内置工具编码为 `type: function` + `function.name/description/parameters`，供模型适配器使用；文件操作仍经 Session VFS。

工具结果回传：OpenAI 兼容适配器必须保留 assistant 的 `tool_calls`，并把 `thinking` 映射为 `reasoning_content`，随后才能发送带 `tool_call_id` 的 tool 消息；丢失前者会使 DeepSeek 拒绝第二轮请求。CLI 流式工具往返回归见 [prompt-harness.test.ts](../apps/cli/tests/prompt-harness.test.ts)。

会话右键/顶部「重新运行」统一调用 `LLMWorkspaceEditor.commands.rerunSession`：关联 Flow 进入参数表单；Chat/Harness 从当前分支最后一条用户消息调用 `SessionCommand.RegenerateFromUser`。已有回复时创建替代分支，新的 Task 重新执行工具，保留旧 Task；使用当前工作区文件状态，不撤销旧文件修改。执行模式在点击时固定，重复点击只提交一次，切换会话或关闭编辑器取消尚未提交的操作。消息旁「重新生成」仍可选择指定轮次。回归见 [session-rerun.test.ts](../ui/app-shell/tests/session-rerun.test.ts) 和 [harness-default-tools.test.ts](../backend/app-core/tests/harness-default-tools.test.ts)。

## 3. DAG Flow 链（CLI 工作流）

```
cli run (apps/cli)
  → config.ts: loadWorkflow（YAML → validate）
  → run-definition.ts: compileRunDefinition → runtime.ts compileDag（编译 tasks/edges/route 条件）
    → toDagRunSpec（RunDefinition → DagRunSpec）
  → runtime.ts: createCliRuntime
      ├─ openLocalFSBackend → createVFS
      ├─ createKernelRuntime（createKernelAdaptersRuntime + new Kernel + registerDurablePrograms）
      └─ DurableFlowExecutor（core.dagPlugins = createBuiltinDagPluginRegistry）
  → DurableFlowExecutor.submit(sessionId, DagRunSpec)
      → 就绪节点逐个 session.submit(TaskSpec) → bindFlowTaskCapabilities → start
      → kernel drain → 节点 program（llm.agent / flow.value / flow.human …）
      → 数据边经 extractNodeOutput 注入下游
      → route/loop/spawn/compensate/on_failure 动态调度
  → FlowAggregateProgram 汇聚 {nodes} → selectFinalResult → RunStore 落盘（result.txt/artifacts）
```

| 步骤 | 组件 | 关键文件 |
|---|---|---|
| 配置 | `loadWorkflow`（YAML → validate） | `cli/src/config.ts` |
| 编译 | `compileRunDefinition` → `compileDag` → `toDagRunSpec` | `cli/src/run-definition.ts`、`cli/src/runtime.ts`、`app-core/src/run/run-definition.ts` |
| 装配 | `createCliRuntime`（vfs + `createKernelRuntime` + flow） | `cli/src/runtime.ts` |
| 调度 | `DurableFlowExecutor.submit` | `llm-flow/src/flow/executor.ts` |
| 插件 | `createBuiltinDagPluginRegistry`（transform/reduce/route/spawn/agent/human） | `llm-flow/src/flow/builtin-plugins.ts` |
| 结果 | `selectFinalResult` → `RunStore.writeResult` | `cli/src/run-store.ts` |

## 4. App 装配链（app-shell）


正常入口为 `#/start`，只读取主题；`onShellReady` 结束全局启动提示。选择工作区后创建侧栏，用户点击或显式深链才进入正文加载链；持久展示偏好和历史标签不代表打开意图。工作区创建 Promise 共享，旧导航完成后不打开资源或写回当前 URL。后台恢复随 runtime 启动，不依赖用户进入工作台。

```
apps/web-app (entry)
  → createApplicationRuntime() (app-core)
    → createVFS() → LLMDeviceDriver → createKernelRuntime()
      → createKernelAdaptersRuntime（注册 effect/tool/skill）
      → new Kernel() + registerDurablePrograms（llm-tasks 的 agent/chat/plan + llm-flow 的 flow.*）
    → initializeConversationSystem({ agentService, sessionEngine, promptHistoryFiles, kernel, flowStore, dagPlugins })
      ├─ SessionManager / CommandBus / DagCommandService 装配
      └─ 插件激活（session / vcs / history）
  → initApp({ services, backend, ui, startPage: true, ... }) (app-shell)
    → 主题 + 路由就绪 → onShellReady → #/start 或显式深链
    → 选择模块 → WorkspaceConfig → Workbench / SessionWorkbench
    → 明确资源打开意图 → restoreWorkspaceResource
```

| 步骤 | 关键文件 |
|---|---|
| 入口 | `apps/web-app/src/main.ts` |
| 运行时装配 | `app-core/src/runtime/create-application-runtime.ts::createApplicationRuntime()` |
| 内核装配 | `app-core/src/runtime/create-kernel-runtime.ts::createKernelRuntime()` |
| 启动 | `app-shell/src/bootstrap.ts::initApp()` |
| VFS | `https://github.com/mushuanli/vfs-core/blob/main/src/impl/factory.ts::createVFS()` |
| 内核 | `durable-kernel/src/application/kernel.ts::new Kernel()` |
| 能力 | `kernel-adapters/src/runtime/create-kernel-adapters-runtime.ts::createKernelAdaptersRuntime()` |
| LLM 系统 | `llm-session/src/index.ts::initializeConversationSystem()` |
| 工作区 | `app-shell/src/workspaces/`（`WorkspaceConfig`）+ `bootstrap.ts` 的 factories map |

## 5. TTY / 工具链（能力注入）

```
DurableAgentProgram.tool 调用（tool.call effect）
  → kernel-adapters ToolCallEffectAdapter（assertEffectGrant → resolveCapability）
    → tools 的 buildTool 实例（FileRead/Bash/…）
      → 经 vfs-core IDeviceDriver / VFS 访问实际资源
TTY：TtyEffectAdapter → device-tty（node-pty）
```

## HTTP 项目外挂

工作台项目 → ProjectRemoteMountService → 项目组合视图 → FileStorageAdapter → HttpFSBackend → fetch → Rust fs-server 的导出别名。Session 将同一项目视图挂到 `/workspace`。凭据由宿主 provider 持有；项目配置只保存 credentialRef。服务端源码位于 `tools/mindos-node/`（独立 git 仓库，`tools/` 另放部署产物），协议与边界详见 [设计与实现边界](design/vfs-http-driver.md)。

命名连接入口：工具箱 → MCP → `MCPSettingsEditor` → MCPManager 标准发现及已注册扩展验证 → 保存统一配置及运行期凭据引用。宿主注入 `MCPConfigurationControlsRegistry`，只为已识别 mindos-node 显示 `MindOSNodeMCPControls` 控制中心。工作台新建项目 → `ProjectService.createRemote` → `bindProject`，以服务地址和别名内路径去重，将远程根组合到项目 `/` 及 Session `/workspace`。连接名称可改，引用使用稳定 ID；Basic 密码仅存宿主凭据 provider。

## mindos-node 与外部 harness 控制链

Web/Tauri/CLI → `createMindOSNodeClient` → 同一命名连接和凭据解析器。文件/远程进程交给 mindos-node-client HTTP；同步交给 mindos-node-client 的 HttpSyncClient；外部会话交给 MCPHarnessClient → mindos-node `/mcp` → 通用 Harnesses/收据表 → Codex HarnessDriver → `codex app-server --stdio`。

Web/Tauri 在“工具箱 → MCP → 对应 mindos-node 配置 → 控制中心”打开 profile/workspace、会话和归档分页、历史、消息、输出、审批与中断。app-core 只解析连接并暴露 HarnessClient 类型端口；原生协议、主机目录和启动命令不进入 UI。外部会话不写入 MindOS 的 llm-session/Kernel，不共享其恢复日志或 Session 租约。

详情见 [mindos-node-client](../libraries/mindos-node-client/README.md) 和 [mindos-node](../tools/mindos-node/README.md)。

远程项目绑定为 MCP 配置 ID + 导出 alias/规范化路径 → 项目 ID。只有经过 mindos-node 能力发现的 HTTP MCP 配置进入绑定列表，显示名不能冒充类型。标准发现元数据优先提供同源 HTTP 文件端点、fileProtocol 与 serverId；旧服务复用通用连接调用其已声明的能力工具。测试成功后保存、改名复用结果，地址或认证变化重新验证；普通 MCP 不发 mindos-node 探测。同一安装身份（或规范化地址）、账号和路径只创建一个远程项目。

MCP 配置是唯一连接权威，`/etc/fs` 只保存项目授权；旧连接迁到 `/llm/.mcp`，保留 ID 与 credentialRef，清除旧配置和密码记录。旧文件服务作为 legacy mindos-node 配置继续访问，升级并测试后开放 harness。删除或改指向已绑定配置由宿主注入的管理器钩子拒绝。跨窗口配置重载更新远程连接投影，不维护第二份连接目录。

远程项目 `displayName` 动态组成“服务器名:项目名”，导航 path 与项目 ID 不依赖服务器名；同名项目创建时可使用带项目 ID 的 navigationName 消除内部路径冲突。配置重命名刷新侧栏、切换器、标题和传输目标，不移动会话或远程目录。

聊天冷启动链：`app-shell.initApp` → `backend.openView` → 先登记源观察、并行文档/工作台、无旧绑定时激活、并行恢复读模型 → 返回快照及水位 → `OpenedViewProjection.start` 登记一次 observeView → 宿主补发并经 SSE 持续更新 → 本地分发给组件。已有编辑器切换继续走 openSessionView/保存/activate；不同 HTTP 客户端保持各自绑定。详见 [HTTP 打开与观察聚合](./http-app.md#打开与观察聚合已实现)。

HTTP v14 轻入口并行启动 SSE/初始 POST、Shell 模块与当前编辑器代码；POST 携带目标与已知数据摘要，宿主一次完成准备、激活、观察登记和能力导出。前端安装缓存校准后的服务图，再将 initialView 交给 initApp；首帧骨架保持至当前导航完成，后续变化复用同一 SSE。
