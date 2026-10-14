# llm-ui 开发说明

本包负责 Conversation 展示和 Run 控制，不直接控制 Engine。

原生远程 harness 会话经 `ConversationControls` 注入，复用 `LayoutTemplates`、`HistoryView`/`SessionRenderer`、`ChatInput` 和 `WorkspacePaneController`，不另写历史卡片和 textarea。`RemoteConversationEditor` 仅适配原生分页、分支、审批、回执和草稿；`remote-rounds` 按原生 turnId 投影每轮独立的用户 MDx 与响应 MDx，保留请求数组、全部助手回复及思考。用户数组的文字项由 contentParts 保留边界，展示和复制时用 `\n\n---\n\n` 分隔；单条文本内部换行不拆项。工具显示名称、操作、首个非空命令行（最多 240 个字符）和目标路径，不展示完整参数、后续代码或输出；助手正文的代码块继续使用共享折叠控件。仅去除 submitted 乐观消息的原生回显，不按文本去重真实请求。时间使用原生毫秒时间，未知时间留空；branchName 独立于会话标题。缺少 turnId 的旧数据按用户消息边界投影。更早历史在首屏之后自动逐页补齐，顶部显示进度；失败保留提示与手动重试入口，不随轮询重复请求。快照更新保留 MDx 实例。原生历史只读，隐藏未声明的本地编辑/重生成功能；发送与中断直达远程控制端口，不调用本地 Session 或 Kernel。

原生会话标题栏复用 EventBinder 的响应式菜单与事件、StatusIndicatorView、BranchIndicatorTemplates、FloatingNavPanel 和 LLMPrintService。侧栏按钮由宿主 toggleSidebar 决定可用性，与原生执行能力无关。ConversationHistoryNavigation 消费渲染后的轮次，不调用本地 Session 命令；导航只读模式保留复制、滚动和折叠，移除上下文修改、历史删除及轮次分支操作。原生分支切换使用 ID，名称只作显示；创建入口收进共享下拉列表。打印通过带 literalHtml 扩展的 MDxRenderer 保留屏幕上的 HTML 字面显示策略。

Web 首屏仅通过 `@itookit/llm-ui/startup` 加载 Flow 模板和菜单；完整入口 `@itookit/llm-ui` 在首次打开聊天、Agent、Flow 或 Skill 正文时异步加载。`vite.startup.config.ts` 为发布包生成独立的 `dist/startup.js`。

ChatInput 工具栏的「对话 / 执行」由 `ExecutionModeControl` 呈现，通过具名 `ExecutionModeViewState` 接收展示状态；模式及 executionModeLocked 随 Session settings 保存；首次直接运行获准入队后固定，停止或失败不解锁，新草稿仍可选择。发送/重新生成显式携带模式，Flow 会话禁用开关。工具由宿主与 llm-session 装配：未配置白名单时执行模式使用宿主默认工具，显式白名单优先；UI 不自行枚举工具或改变目录授权。Task 过滤与预算由 llm-session 固定。相关回归在 app-shell 的 `chat-execution-mode.test.ts`。

## 关键边界

- 会话标题栏共用 `llm-btn-refresh`，宽屏优先展示、窄屏收进响应式菜单。普通会话通过 `SessionCommand.GetSnapshot` 刷新当前内存投影的历史、状态、分支与导航，不重新绑定会话、不恢复草稿、不启动执行；远程会话调用原生 `ConversationControls.read()`。刷新期间去重，销毁或会话切换后丢弃旧结果。回归见 app-shell 的 `conversation-refresh.test.ts` 和 `remote-conversation-editor.test.ts`。

- `RunAttachmentController` 经 `TaskControlPlane.openTask()` 取得 `AttachedTask`（`TaskHandle` 子集）后 attach、消费事件流，并转发 signal / cancel / resume。
- `ChatInput` 的 `InteractionPanel` 常驻显示审批/简单人工回复，备注与聊天草稿独立；经 `respondApproval` / `respondInput` 校验固定 interaction id、attachment revision 和非终态 pending 状态后提交。失败留在卡片内，解除挂接/解决/终态清理；复杂 Flow 输入沿用参数表单。DOM 与实际 Kernel Exec 审批回归在 app-shell 的 `input-interaction.test.ts`、`input-approval-exec.test.ts`。
- 会话打开时除恢复特权任务外，还用 `src/shell/pending-interaction.ts` 的 `restoreWaitingAttachment` 重新挂接「仍有 pending interaction 的非终态 Task」，以重放其 `task.interaction.requested`（宿主崩溃期间的批准通道恢复）；回归 `ui/app-shell/tests/pending-interaction-restore.test.ts`。
- `DagWorkbench` 从 `FlowCommand.Presentations` 返回的插件呈现（manifest + `ui.palette`）构建 Palette、端口和表单。
- UI 不 import DAG Runtime；对 `@itookit/durable-kernel` 只有 `import type`。
- `/skills` 独立对话框中的 Skill 面板列表经 `src/shell/skill-refresh.ts` 的 `bindSkillRefresh(controls, sessionId, refresh)` 与 `SessionSkillControls.onChange` 保持同步：绑定后拉取一次、每次目录变更通知重新拉取，`LLMWorkspaceEditor.destroy()` 解绑（无轮询）。通知仅在宿主进程内传播，在途 Task 的上下文不变。
- TTY 面板（`TtyPanel` / `TtyController`）只展示运行输出，输出块以文本节点写入（禁止拼接未转义 HTML）；交互输入必须通过 Kernel 控制面。 终态语义：`finalize(exitCode)` 如实报告退出码，`null`（`tty_close` 未观测到退出码）显示 `Process stopped (exit code unknown)`，且终态后到达的输出被忽略。回归在 `ui/app-shell/tests/tty-panel.test.ts`（jsdom；llm-ui 的 vitest 无 jsdom）。

## 联网搜索 citations

Harness 工具卡片由 `node:appended` 立即挂载，再消费 `tool:running/success/error`；名称、参数、状态和结果在 History 中显示。结果保留换行并作文本转义，恢复失败卡片读取 `data.error`。`tool:progress` 展示有界活动和结果快照；终态隐藏活动并覆盖预览，迟到进度不能改写终态。Grep 提供实际 cwd、路径、扫描数量和匹配预览；工具驱动消费通用 `getActivityDescription`，Bash 提供 stdout/stderr 快照，MCP 提供协议 progress。回归见 app-shell `tool-history-live.test.ts`。

- `HistoryView` 订阅 `message:citations`（`immediateTypes`）→ `StreamController.updateCitations`。
- `NodeTemplates.renderCitations` 渲染引用块（图标用 `ACTION_ICONS.search`，禁止硬编码 emoji）。
- 详见 [web-search.md](../../doc/web-search.md)。

斜杠命令链见 [slash-commands.md](./doc/slash-commands.md)。

`commands/direct-command.ts` 分离输入策略 `parseDirectCommand`、宿主执行分派 `dispatchDirectCommand` 与终态读取 `readDirectCommandOutcome`；发送、用户重发、助手重试（追溯关联用户输入）、编辑重跑及会话重新运行共用该规则。`CommandContext.executeDirectCommand` 连接已有 exec 控制面；`resolveSubmission` 仅普通发送使用。普通消息仍走各自轮次/分支命令，直接命令不会回退到 LLM，也不锁定对话模式。编辑器仅装配端口，不识别输入语法。

直接命令没有会话轮次：`LLMWorkspaceEditor.handleRunEvent` 在 `task.succeeded/failed/cancelled` 时经 `RunAttachmentController.current()` 读取 `task.exit`，把 stdout/退出码或失败原因渲染到 `ChatInputView.showToolOutput`（`ToolOutputPanel`，图标来自 `FEEDBACK_ICONS`）；输出不写回会话历史，失败不再只留在 console。

## 运行

```bash
pnpm --filter @itookit/llm-ui typecheck
pnpm --filter @itookit/llm-ui build
```

测试用例为 `src/**/*.test.ts`：`pnpm --filter @itookit/llm-ui test`（vitest run）或 `test:watch`。

Skill 列表通过 bindSkillRefresh 返回的 refresh/dispose 与 SessionSkillControls.onChange 保持一致；菜单请求共用刷新队列，销毁时 dispose。/sk-<id> 发送前重新核验定义，action/silent 仅走显式用户请求。测试入口为 pnpm --filter @itookit/llm-ui test（vitest run）及 test:watch。

恢复边界：`restoreWaitingAttachment` 只恢复当前 Session 仍待交互的非终态 Task；编辑器关闭、新挂接或会话身份改变后丢弃旧恢复结果。RunAttachmentController 在异步打开前捕获 revision，事件重放前核验审批仍为 pending。SendMessageCommand 不按轮次差集删除发送记录，失败可能只是回复丢失。TTY finalize 保留首次结束信息；未知退出码显示本地化的未知状态。回归见 app-shell 的 pending-interaction-restore、attachment-restore-race、send-failure-consistency、tty-panel、terminal-node-reason 测试。

## Flow 定义库与运行

Flow Session 标题栏「流程输出」挂接当前 Session 的持久 Run，显示最终结果、各节点返回及作文评分；打开不自动恢复执行。输出契约、工具/Skill 装配及验证入口见 [Flow 能力与输出](../../doc/design/flow-capabilities-and-output.md)。

「重新运行」预填当前分支参数，经 SessionCommand.FlowRerun 创建新分支；History 直接展示 user/assistant 交互及独立流式输出，内部逻辑节点不展开。`message:updated.content` 表示替换最终内容，EventBatchProcessor 必须先刷新已缓存的 delta，再应用替换，避免旧增量回填。Flow 交互子卡片不提供普通消息的编辑/重新生成操作。

- `src/flows/library.ts` 只提供安装/恢复机制，模板数组由宿主显式传入；不携带业务模板。MindOS 通过 app-core 的 `createMindosFlowLibrary` 提供模板，Web/Tauri 在装配时注入，保留安装记录和用户草稿。
- `src/flows/context-menu.ts` 提供 `.flow` 文件右键「运行」菜单；`FlowLauncher` 与 FlowsEditor 工具栏共用参数 → 固定 revision → CreateFromFlow → 导航流程。
- 参数校验在关闭对话框前执行；取消不创建 Session，草稿版本冲突不启动。新入口通过 CreateFromFlow 的 invocation 模式直接创建持久调用，旧 manifest.flow 会话保持兼容。
- `/flow` 在当前 Session 启动独立调用；`InvocationPanel` 按 root Task 显示各调用及人工确认，结果可放入聊天草稿。`builtin.flow@2.0.0` 提供参数与命名返回值组合。契约见 [Flow 调用与组合](../../doc/design/flow-invocation-composition.md)。
- UI 通过命令总线接入，不读写 Kernel 存储。DOM 回归见 `ui/app-shell/tests/flow-launch.test.ts`，实际模板 DAG 执行见 llm-flow 的 structured-flow 测试。

内置模板安装通过 `flow.draft.install` 保存独立安装记录；删除 `.flow` 后记录仍在，重启不再恢复该模板。聊天侧栏将同一 FlowEngine 挂到 `/@flows`，支持展开、打开和右键运行/删除。新增作文文件统一名为 `essay-review-isolated.flow`。

作文评审图按路由、检查、汇总、判断分节点编辑；打开旧 route@2 草稿时请求 `expandScopes`，仅显式保存才持久化。插件端口按 id + version 匹配，判断回路自动使用 repeat 控制边。数字表单支持运行参数引用。

`InvocationEditor` 提供 schema 字段引用、继承来源与提示词预览；`InputFieldsEditor` 编辑 param 字段。运行缺项复用 FlowParameterForm，提交通过 RunAttachmentController.respondInput 校验 attachment revision 与 pending interaction；切换任务关闭旧表单。

会话右键与顶部重新运行共用编辑器 `commands.rerunSession`，经 `shell/rerun-session.ts` 分流：关联 Flow 使用参数表单；普通 Chat/Harness 选择当前分支最后一条用户消息并调用 `RegenerateFromUser`，冻结当前执行模式，Agent 沿用原轮次。已有回复时创建替代分支和新 Task，旧结果保留，文件修改不回退。准入期间去重，切换会话/销毁取消未提交操作，空分支给出明确提示。流程输出提供只读分支选择，按 `session.flow-branch-executions` 返回的 Task 引用筛选。切换为空分支时必须清空上一分支结果并取消旧刷新。

`WorkspaceDirectoryMenu` 在标题栏按钮及标题栏/输入工具栏右键提供工作目录和挂载管理，经 `EditorHostContext.directoryCommands.configureWorkspace` 调用宿主；输入文本的原生右键菜单保持可用，运行中禁止修改。

聊天 `@` 文件候选通过 `FileSearchService` 消费 vfs-core 的 `discoverFiles`，过滤发生在 20 条候选上限之前。MentionPlugin 面板提供“包含忽略文件”复选框；取消旧请求后不得用过期结果重新打开面板。Grep/Glob 的 `includeIgnored` 是独立工具参数，候选框开关不改变 Agent 工具或目录授权。

Skill 面板区分指令加载与 Agent 工具授权，配置入口通过 Agent 的真实资源路径导航；Flow 模式导航到节点配置。授权计数表示配置声明，不能替代运行时目录权限和工具审批。见 [能力配置与执行](../../doc/design/tool-skill-mcp-capabilities.md)。

ChatInput 设置按对话、OCR、高级分组；高级项默认折叠。Skills 和授权管理不嵌入设置，显式 `/skills` 打开独立管理器。OCR 只选择连接并提供当前识别提示词编辑入口。

项目新会话 UI 位于 `src/shell/drafts/`：编辑器只消费 ui-common 的 `SessionDraftControls`，输入序列化与保存队列独立。materialize 返回明确的编辑器/提交标识/恢复行为，不能修改宿主 options 传递状态；项目转正策略、持久化和接受判定不进入 UI。

- `/chat` 是聊天/Flow 展示入口，`/settings` 承载可选设置编辑器；共享展示源码不得加载 llm-settings-ui。根入口等同 `/chat`；已删除 `/legacy` 聚合入口。
- UI 经结构化 `SessionViewPort` 接收会话实例，默认工具列表由宿主注入，不从适配器读取产品默认值。Web/Tauri 不使用全局 SessionManager 装配聊天。

`/chat` 的正式会话编辑器必须注入 SessionViewPort，提示词历史仅由实例提供。Session/Flow 命令常量来自各自 `/contracts`，共享 UI 禁止导入 Session 实现根入口；禁止全局单例回退。

声明由 tsup.types.config.ts 打包，再由 scripts/bundle-contracts.mjs 按 npm 公开 exports 解析并内联 driver 契约，Kernel 和 UI 公共类保持外部身份。build 自动执行 check-llm-ui-entrypoints.mjs，检查默认入口无设置/单例，四个开发契约包不泄漏到 JS 或公开声明，应用宿主依赖不泄漏，以及发布入口对应的文件存在。禁止只移动 package.json 依赖而不验证产物。

`/conversation` 仅消费 ui-common 的 ConversationControls 和 EditorOptions，不依赖 app-core 或 HTTP。SessionViewPort 的定义归 llm-session/contracts，TaskControlPlane 等任务端口归 durable-kernel；UI 直接导入所属模块的公共契约。发布这些新声明前必须先发布包含对应端口的领域包，不能用旧 npm 版本代替新契约。

Slash 命令描述在 slash-command-catalog.ts，弹出交互在 SlashCommandPlugin，执行按 SlashCommandRouter 的领域回调分组。输入创建状态只接收 initialInputState，禁止恢复 app_create_params 或全局创建缓存。

公开 EditorTaskControlPlane 位于 durable-kernel/src/ports/task-control.ts，Kernel 和远程客户端均可按结构实现，不要求继承 Kernel。工厂依赖类型要求 sessionManager/resolveSessionView 至少一个。task-attachment-lifecycle 负责共享挂接身份与异步恢复；editor-disposal 顺序尝试全部资源清理并汇总失败，destroy 返回同一 Promise。加载后的配置记录已保存快照，未修改时刷新/销毁不覆盖外部更新。
