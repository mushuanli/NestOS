# llm-ui-adapter 开发说明

本地和远程 Session 指令队列通过 InstructionQueuePanel 绑定独立 llm-ui 的 InstructionQueueView，支持正文编辑；发送与自动续发归宿主后端。忙时保留发送与停止按钮，确认持久接纳后清除本次输入；排序、合并、删除携带已展示 revision，冲突时刷新，不自动重试写命令。

NativeCommandOutput 在原命令消息锚点展示截断预览和按需完整读取；默认工作台与独立 extension 共用该组件。优先逐页 readCommandOutput，每页至多64KiB，页前后检查本视图的取消信号；不把 AbortSignal 序列化过应用 RPC。复用 Artifact 的有界拼接与 SHA/字节核验，完整验证后只挂载当前64Ki字符文本页，UTF-8及surrogate边界不得漏字或替换；销毁/隐藏取消后续页和迟到DOM并回收URL。读失败只在该结果卡片提供重试，不写全局refreshError、不消费输入、不改变执行终态。resultError 使用原 operationId 查询，不能以重新发送或合成成功恢复。

正式 Session 与本地项目首次草稿通过 session.targets.list 读取公开 Agent/Flow 目录，TargetRef 与旧 agentId 偏好分开，按分支保存 inputTarget；Flow 不伪装为 Agent，首次提交复用草稿 UUID 及输入 DOM。参数表单确认后走 session.submit，arguments 是执行输入，presentation 只用于历史。WorkspaceArgumentDraft 的 JSON、修订、签名和目标随分支 inputArguments 保存；composerText 仅为预填依据，重开保留用户实际确认的参数。OperationLedger 经既有 Session UI 的 operationRecords 持久保存，登记完成后才派发；队列通知触发完整摘要核对，同一台账的接纳可以释放仍悬挂的发送 RPC。独立核对条经 session.submission.receipt 查询原冻结请求，不重填表、不重发；session.submission.committed 仍只证明真实历史提交。原回执不消费新文字、新参数或其他分支草稿；已提交附件草稿经 token、文件身份和摘要核对后恢复消费；同分支多视图草稿并发写入与独立视图替换仍在迁移；UI 不导入 Session 运行时或读取 Round 协议。

项目草稿的 `selectDraftAgent` 命令只切换明确指定且仍可用的智能体，沿用 ChatInput 的配置通知与保存队列，保留文字、附件和模型偏好；不创建正式 Session、不发送内容。工作台快捷入口消费此命令，项目选择和资源列表不进入聊天组件。

本包承接 NestOS 的 Session、Task、原生会话、配置和权限接线，保留原业务编辑器兼容入口。独立聊天库位于 ../../libraries/llm-ui，通用 Flow 视图位于 ../../libraries/llm-ui 的 /flow 子入口；新的统一 ChatView 适配从 /independent 导出。

原生会话的斜杠候选由 ConversationControls.commands 按当前绑定提供，NativeSlashCommandPlugin 只负责候选和插入，不注册本地 Kernel 命令。RemoteConversationEditor 在发送时重新校验目录并委托 command；命令接纳与普通消息分别呈现，未知结果保留输入并走原 reconcile。ChatInput 拥有 registerPlugin 激活的插件，销毁须逐一 deactivate；关闭后迟到目录不能恢复弹层。

用户提问下方分别提供编辑和分支图标：编辑替换提问并运行，手动分支保留完整所选轮次后继续，不自动发送。原生历史仍只读，RemoteHistoryBranches 单独挂接分支动作，使用原生 messageId/turnId，不能发送渲染 ID。forkSupport 表达 none/latest/turn，canFork 表达当前可用性；历史位置不支持时明确确认是否改从末尾分叉，不能自动退化。原生宿主 /branch [name] 与 /branches 由编辑器处理，不透传为模型提示词或原生命令；分支命令失败保留输入。隐藏、销毁或绑定变化后不得执行待确认的分支动作。小屏分支切换器移入顶部更多菜单。

本地与原生会话的标题栏共享 `EventBinder` 更多菜单；宿主可通过 `EditorOptions.mountMoreMenu` 注入资源动作并返回清理函数。会话归属与关联创建由 app-shell 提供，不进入聊天或 Markdown 组件；关闭编辑器须释放注入菜单。

HistoryView 经 `mountHistorySearch` 按展示顺序向独立 llm-ui 投影已加载正文；历史卡片与滚动归适配层，Markdown 内部展开归 mdxeditor。生命周期与流程见 [独立模块设计](../../doc/design/llm-ui-independent-module.md#7-markdown扩展与生命周期)，回归见 app-shell 的 conversation-content-search。

本地、原生和草稿标题栏均消费 `mountCompactNavigation`，仅在小屏替代原标题区并通过公开 data-editor-mobile-navigation 标记通知宿主；桌面标题与菜单保持可用。项目标签、窗口切换和返回业务归宿主。小屏输入从一行增长，长草稿限于可视高度的 22%（最多 160px）后内部滚动；触屏 Return 换行，发送按钮或 Ctrl/Meta+Enter 提交，IME 确认不发送。焦点标记 data-editor-composing 供宿主调整导航，销毁清理。历史视口随键盘或输入增长改变时，仅在原本跟随末尾时继续贴底，阅读旧消息时保留位置。

本地模型输入通过 `ConnectionReadiness` 提前呈现配置读取、缺少默认连接、停用、凭据未就绪及缺少聊天模型，提供选择连接、定位 Provider 授权/连接设置和读取重试入口。发送前刷新安全元数据，失败保留文字及附件；不探测密钥有效性，不自动重发。原生执行器使用自身配置，Flow 使用各槽位校验，直接命令和插件消费的斜杠命令保持可用。停用连接仍可见但不可选择。`EditorOptions.executorUsage` 由宿主注入，智能体列表在类别内按成功提交时间排序；选择、编辑、直接命令和失败提交不记使用时间。`onSend` 返回 false 表示宿主拒绝提交；本地与原生共用提交确认逻辑，确认前保留原输入，确认后仅移除已提交附件，且不覆盖等待期间的新文字或附件。回归见 app-shell 的 connection-readiness、executor-usage 与 toolbox-workbench。

标题栏「提问目录」由 `PromptNavigator` 提供，按钮仅显示图标；宽屏与折叠/展开所有按钮并列，窄屏两者进入顶部更多菜单，只保留搜索和更多两个常驻入口。菜单在右上角就近展开，不移到底部；历史始终可见，不恢复旧隐藏状态。目录打开即显示最近提问在前的列表及过滤框，不分页；默认展示全部（超过 100 条时先展示最近 100 条，可继续展开），过滤查询全部已加载提问，重开清除旧过滤。保留开头/中间/最近定位、单行/三行摘要；宽屏浮层、窄屏底部面板。点击仅展开目标用户卡片，再在历史容器内滚动、聚焦和高亮；引用 details 保持折叠。原生摘要依据 contentPartKinds 排除明确来源的注入上下文。若打开目录时已加载片段没有用户提问，RemoteConversationEditor 按需最多向前读 3 页，找到提问即停；错误停止并保留手动重试，其余更早历史仍由用户加载，不随通知/轮询自动补齐。本地目录与批量导航共享历史快照和在途读取；两面板均关闭时变更只标脏，可见时合并刷新，打开时读取最新数据，迟到响应不能覆盖新快照。目录语义属于 llm-ui，不进入 mdxeditor 或 nestos-node。回归见 app-shell 的 prompt-navigation、remote-conversation-editor 和 http-full-shell。

项目草稿工具栏按「项目 → 对话/执行 → 智能体」排列；项目选择由宿主 scope 注入。本地项目只显示本地智能体，远程项目只显示当前项目可创建的远程 harness，无候选时禁止发送；原生会话的 harness 创建后固定。切换项目先保存再打开目标项目独立草稿，正式会话隐藏项目和已固定模式的选择。项目选择在导航前捕获输入偏好，通过宿主转交目标草稿；draft-preferences 按目标智能体候选、连接启用/凭据与模型档位校验后应用，保留目标文字和附件，不复制执行锁、Flow 或分支引用。继承期间有新编辑或视图切换时丢弃迟到结果；恢复草稿时刷新项目候选。工作流入口位于标题栏更多菜单，先保存草稿再导航现有流程库；参数与连接槽继续由 FlowLauncher 和 FlowParameterForm 提交。Agent 不按 Provider 派生新类型。

模型菜单按连接及 Provider 分组，展示该连接配置的聊天模型，一次选择原子更新 connectionId/modelTier；`auto` 持久值显示「跟随默认」，不宣称智能选模。模型档位与推理强度独立。harness 按 profile 的 models 能力显示原生模型菜单，目录与每个模型的推理档位由宿主提供；旧节点继续显示只读「原生配置」。选择绑定 executorId，草稿保存且第一条消息在转正前捕获；普通发送与 prompt 类原生命令将选择冻结到提交，action 命令沿用原生控制语义。Flow 显示节点模型并导航流程定义，不展示本地智能体或全局模型设置。智能体指令/工具通过宿主导航配置；设置凭据仍在连接管理。

普通 Agent 聊天连接按会话显式 connectionId → 当前 Agent.modelDefaults.chat → 系统默认连接解析。“跟随默认”保持 connectionId 未设置，切换智能体或刷新配置仅更新继承来源与显示，不把继承值写回会话。Agent 指定的默认连接缺失、停用、凭据未就绪或无聊天模型时显示具体原因，不跳过它改用系统默认。原生 harness 继续使用自身模型配置。

聊天候选复用 kernel-adapters/contracts 的纯函数 resolveChatModelTiers，各档位的真实解析由 resolveChatModelForTier 提供，显式无效模型不回退掩盖；排除目录中不存在或明确非聊天的模型；构建将该纯契约代码内联到独立入口，不增加发布时的后端依赖。

会话中通过更多菜单切换执行方式，宿主注入 `onStartConversationDraft`。编辑器先保存原输入，再将输入及附件交给项目草稿；已存在的草稿追加内容，不覆盖原文字/附件，不自动发送，不中断当前任务，也不自动迁移跨执行器历史。普通模型、连接和智能体选择继续在两轮之间生效，当前轮执行配置保持冻结。回归见 app-shell 的 execution-configuration、project-workbench-ui 与 remote-conversation-editor。

远程会话快照和渲染更新异常显示「会话更新失败」及原因，不推断连接断开；连接状态消费端口 observation。成功更新清除临时错误，失败保留输入草稿且不自动重发。

原生会话的被动运行状态、累计 token 和估算费用收进标题栏「更多 → 会话信息」，由 ConversationInformation 消费已有快照，不额外请求或改变执行状态。基础信息与本地会话统一为创建时间、最后活动，复用 project 字段文案及 ui-common.setTimePresentation；远端缺失时间显示「暂无记录」，不以页面刷新时间代替。详情说明未加载与外部活动不可见的含义，区分累计用量、正文长度和实际账单；金额通常保留两位小数，非零分以下估算保留必要精度。运行和等待状态保留标题栏指标，错误、离线、历史缺口及未知回执继续在正文显示；打开或更新详情不重建历史和输入，关闭编辑器清理弹层。回归见 app-shell 的 remote-conversation-editor、session-toolbar 与本包 conversation-usage。

原生远程 harness 会话经 `ConversationControls` 注入，复用 `LayoutTemplates`、`HistoryView`/`SessionRenderer`和 `ChatInput`，不另写历史卡片和 textarea。`RemoteConversationEditor` 仅适配原生分页、分支、审批、回执和草稿；`remote-rounds` 按原生 turnId 投影每轮独立的用户 MDx 与响应 MDx，保留请求数组、全部智能体回复及思考。用户数组的文字项由 contentParts 保留边界，展示和复制时用 `\n\n---\n\n` 分隔；单条文本内部换行不拆项。工具显示名称、操作、首个非空命令行（最多 240 个字符）和目标路径，不展示完整参数、后续代码或输出；智能体正文的代码块继续使用共享折叠控件。仅去除 submitted 乐观消息的原生回显，不按文本去重真实请求。时间使用原生毫秒时间，未知时间留空；branchName 独立于会话标题。缺少 turnId 的旧数据按用户消息边界投影。更早历史由顶部加载入口或明确的定位请求按需逐页读取，不自动补齐全部历史；失败保留提示与手动重试入口，不随通知或轮询重复请求。宿主提供订阅时读取本地快照，缺少订阅才使用轮询回退。快照更新保留 MDx 实例。原生历史只读，隐藏未声明的本地编辑/重生成功能；发送与中断直达远程控制端口，不调用本地 Session 或 Kernel。

原生会话标题栏复用 EventBinder 的响应式菜单与事件、StatusIndicatorView、BranchIndicatorTemplates、FloatingNavPanel 和 LLMPrintService。侧栏按钮由宿主 toggleSidebar 决定可用性，与原生执行能力无关。ConversationHistoryNavigation 消费渲染后的轮次，不调用本地 Session 命令；导航只读模式保留复制、滚动和折叠，移除上下文修改、历史删除及轮次分支操作。原生分支切换使用 ID，名称只作显示；创建入口收进共享下拉列表。打印通过带 literalHtml 扩展的 MDxRenderer 保留屏幕上的 HTML 字面显示策略。

`remote-rounds` 将系统/工具事件编码为专用 fenced block，`transcript-markup` 的 createTranscriptMarkup 扩展渲染有来源标签的辅助信息：系统提示淡紫色、默认折叠，工具灰色标签与命令/目标摘要，保持轮内顺序；原始内容全部转义。llm-ui 将原生消息身份编码为通用 `data-mdx-disclosure-key`，由 mdxeditor 在快照更新时保留展开状态；普通回答仍使用 Markdown，未知代码语言继续走共享代码块控件，历史和打印均设置公共 `htmlPolicy: 'literal'`，打印复用同一视图的登记与扩展。仅视图投影登记的块允许角色呈现，并核对块正文；普通消息中的同名代码围栏继续按代码显示。回归见 app-shell 的 remote-conversation-editor 测试。

Web 首屏仅通过 `@itookit/llm-ui-adapter/startup` 加载 Flow 模板和菜单；完整入口 `@itookit/llm-ui-adapter` 在首次打开聊天、Agent、Flow 或 Skill 正文时异步加载。`vite.startup.config.ts` 为发布包生成独立的 `dist/startup.js`。

ChatInput 工具栏的「对话 / 执行」由 `ExecutionModeControl` 呈现，通过具名 `ExecutionModeViewState` 接收展示状态；模式及 executionModeLocked 随 Session settings 保存；首次直接运行获准入队后固定，停止或失败不解锁，新草稿仍可选择。模式固定后隐藏输入区选择器，经 ChatInputOptions.executionModeInfo 在顶部更多菜单显示只读模式与说明，销毁释放外部挂载；原生执行器不显示本地模式。发送/重新生成显式携带模式，Flow 会话禁用开关。工具由宿主与 llm-session 装配：未配置白名单时执行模式使用宿主默认工具，显式白名单优先；UI 不自行枚举工具或改变目录授权。Task 过滤与预算由 llm-session 固定。相关回归在 app-shell 的 `chat-execution-mode.test.ts`。

## 关键边界

- 会话标题栏共用 `llm-btn-refresh`，宽屏优先展示、窄屏收进响应式菜单。普通会话通过 `SessionCommand.GetSnapshot` 刷新当前内存投影的历史、状态、分支与导航，不重新绑定会话、不恢复草稿、不启动执行；远程会话调用原生 `ConversationControls.read()`。刷新期间去重，销毁或会话切换后丢弃旧结果。回归见 app-shell 的 `conversation-refresh.test.ts` 和 `remote-conversation-editor.test.ts`。

- `RunAttachmentController` 经 `TaskControlPlane.openTask()` 取得 `AttachedTask`（`TaskHandle` 子集）后 attach、消费事件流，并转发 signal / cancel / resume。
- 任务事件订阅携带观察专用 AbortSignal；detach / 视图关闭先 abort 释放挂起的 next，再归还迭代器，不取消后台 Task。重挂接使用新的控制器，旧代次的预期取消不呈现为业务失败。
- `ChatInput` 的 `InteractionPanel` 常驻显示审批/简单人工回复，备注与聊天草稿独立；经 `respondApproval` / `respondInput` 校验固定 interaction id、attachment revision 和非终态 pending 状态后提交。失败留在卡片内，解除挂接/解决/终态清理；复杂 Flow 输入沿用参数表单。DOM 与实际 Kernel Exec 审批回归在 app-shell 的 `input-interaction.test.ts`、`input-approval-exec.test.ts`。
- Agent 的 `questions[].options[]` 经 `components/input/agent-questions.ts` 投影为独立 llm-ui 的交互字段，复用其单选、多选、描述和自填答案控件；聊天挂接和 InvocationPanel 共用 inputInteraction。所有问题一起校验，答案按问题文案形成 answers，重复文案加题号，多选值用 JSON 数组字符串表达；整个对象序列化为字符串交给既有 respondInput，避免 Agent 的字符串回应契约收到对象后丢失内容。相同挂接重复通知保留选择，失败可重试，隐藏/销毁/终态清理。回归见 input-interaction.test.ts 与 app-shell 的 agent-question-interaction.test.ts。
- 会话打开时除恢复特权任务外，还用 `src/shell/pending-interaction.ts` 的 `restoreWaitingAttachment` 重新挂接「仍有 pending interaction 的非终态 Task」，以重放其 `task.interaction.requested`（宿主崩溃期间的批准通道恢复）；回归 `ui/app-shell/tests/pending-interaction-restore.test.ts`。
- `DagWorkbench` 从 `FlowCommand.Presentations` 返回的插件呈现（manifest + `ui.palette`）构建 Palette、端口和表单。
- `builtin.flow@2` 单次调用按子 Flow 声明展示命名输出；`parameterSets` 多组调用仅展示按组返回的 `result` 端口。参数组数组或整值引用、共享 `parameters` 和 `maxConcurrency` 通过通用 SchemaForm 编辑，切换函数签名及保存须保留这些字段；DOM 回归见 app-shell 的 flow-function-authoring。
- 函数选择与签名优先读取当前草稿的 `functions`，同名全局定义只作外部回退。内联函数不请求全局 RevisionGet；设计器、Controller 的编辑、撤销、重做及保存完整保留嵌套函数表，不能为展示签名将其拆成全局资源。
- UI 不 import DAG Runtime；对 `@itookit/durable-kernel` 只有 `import type`。
- `/skills` 独立对话框中的 Skill 面板列表经 `src/shell/skill-refresh.ts` 的 `bindSkillRefresh(controls, sessionId, refresh)` 与 `SessionSkillControls.onChange` 保持同步：绑定后拉取一次、每次目录变更通知重新拉取，`LLMWorkspaceEditor.destroy()` 解绑（无轮询）。通知仅在宿主进程内传播，在途 Task 的上下文不变。
- TTY 面板（`TtyPanel` / `TtyController`）只展示运行输出，输出块以文本节点写入（禁止拼接未转义 HTML）；交互输入必须通过 Kernel 控制面。 终态语义：`finalize(exitCode)` 如实报告退出码，`null`（`tty_close` 未观测到退出码）显示 `Process stopped (exit code unknown)`，且终态后到达的输出被忽略。回归在 `ui/app-shell/tests/tty-panel.test.ts`（jsdom；llm-ui 的 vitest 无 jsdom）。

## 联网搜索 citations

Harness 工具卡片由 `node:appended` 立即挂载，再消费 `tool:running/success/error`；名称、参数、状态和结果在 History 中显示。结果保留换行并作文本转义，恢复失败卡片读取 `data.error`。`tool:progress` 展示有界活动和结果快照；终态隐藏活动并覆盖预览，迟到进度不能改写终态。Grep 提供实际 cwd、路径、扫描数量和匹配预览；工具驱动消费通用 `getActivityDescription`，Bash 提供 stdout/stderr 快照，MCP 提供协议 progress。回归见 app-shell `tool-history-live.test.ts`。

- `HistoryView` 订阅 `message:citations`（`immediateTypes`）→ `StreamController.updateCitations`。
- `NodeTemplates.renderCitations` 渲染引用块（图标用 `ACTION_ICONS.search`，禁止硬编码 emoji）。
- 详见 [web-search.md](../../doc/web-search.md)。

斜杠命令链见 [slash-commands.md](./doc/slash-commands.md)。

`commands/direct-command.ts` 分离输入策略 `parseDirectCommand`、宿主执行分派 `dispatchDirectCommand` 与终态读取 `readDirectCommandOutcome`；发送、用户重发、智能体重试（追溯关联用户输入）、编辑重跑及会话重新运行共用该规则。`CommandContext.executeDirectCommand` 连接已有 exec 控制面；`resolveSubmission` 仅普通发送使用。普通消息仍走各自轮次/分支命令，直接命令不会回退到 LLM，也不锁定对话模式。编辑器仅装配端口，不识别输入语法。

直接命令没有会话轮次：`LLMWorkspaceEditor.handleRunEvent` 在 `task.succeeded/failed/cancelled` 时经 `RunAttachmentController.current()` 读取 `task.exit`，把 stdout/退出码或失败原因渲染到 `ChatInputView.showToolOutput`（`ToolOutputPanel`，图标来自 `FEEDBACK_ICONS`）；输出不写回会话历史，失败不再只留在 console。

## 运行

```bash
pnpm --filter @itookit/llm-ui-adapter typecheck
pnpm --filter @itookit/llm-ui-adapter build
```

测试用例为 `src/**/*.test.ts`：`pnpm --filter @itookit/llm-ui-adapter test`（vitest run）或 `test:watch`。

Skill 列表通过 bindSkillRefresh 返回的 refresh/dispose 与 SessionSkillControls.onChange 保持一致；菜单请求共用刷新队列，销毁时 dispose。/sk-<id> 发送前重新核验定义，action/silent 仅走显式用户请求。测试入口为 pnpm --filter @itookit/llm-ui-adapter test（vitest run）及 test:watch。

恢复边界：`restoreWaitingAttachment` 只恢复当前 Session 仍待交互的非终态 Task；编辑器关闭、新挂接或会话身份改变后丢弃旧恢复结果。RunAttachmentController 在异步打开前捕获 revision，事件重放前核验审批仍为 pending。SendMessageCommand 不按轮次差集删除发送记录，失败可能只是回复丢失。TTY finalize 保留首次结束信息；未知退出码显示本地化的未知状态。回归见 app-shell 的 pending-interaction-restore、attachment-restore-race、send-failure-consistency、tty-panel、terminal-node-reason 测试。

## Flow 定义库与运行

Flow Session 标题栏「流程输出」挂接当前 Session 的持久 Run，显示最终结果、各节点返回及作文评分；打开不自动恢复执行。输出契约、工具/Skill 装配及验证入口见 [Flow 能力与输出](../../doc/design/flow-capabilities-and-output.md)。

SessionRunsPanel 为工作台及独立 ChatView 显示同 Session 未关联聊天分支的 Flow 执行；既有分支引用决定归属，不能把 CLI/底层运行猜测归入 main 或伪造 Round。流程输出为这类运行提供独立分组，打开只读、不恢复执行。隐藏/销毁停止轮询并关闭所属输出窗口，迟到读取不能恢复面板。正式 CLI session send 与 UI 提交仍共用 Session 历史入口；不同用户或数据根的 Session 不自动合并。

「重新运行」预填当前分支参数，经 SessionCommand.FlowRerun 创建新分支；History 直接展示 user/assistant 交互及独立流式输出，内部逻辑节点不展开。`message:updated.content` 表示替换最终内容，EventBatchProcessor 必须先刷新已缓存的 delta，再应用替换，避免旧增量回填。Flow 交互子卡片不提供普通消息的编辑/重新生成操作。

- `src/flows/library.ts` 只提供显式恢复机制，模板数组由宿主显式传入；不携带业务模板。NestOS 通过 app-core 的 `createNestosFlowLibrary` 提供模板，Web/Tauri 在装配时向恢复菜单注入；普通安装由 app-core 完成，保留安装记录和用户草稿。
- `src/flows/context-menu.ts` 提供 `.flow` 文件右键「运行」菜单；`FlowLauncher` 与 FlowsEditor 工具栏共用参数 → 固定 revision → CreateFromFlow → 导航流程。
- Flow 编辑器右侧默认显示「运行参数」，「节点与连线」切换到原编辑能力；参数表单 DOM 在节点选择、画布重绘和面板切换时保留，参数/连接声明变化或更换 Flow 时重建。运行按钮位于参数面板顶部固定栏，参数和节点内容各自滚动；错误仅滚动参数区域，不调用跨祖先 scrollIntoView。运行先校验参数、图片，并通过 session.check-flow-connections 校验当前连接和模型能力，再保存发布并通过 FlowLauncher 直接提交；提交去重，销毁/切换草稿后不得启动旧提交。
- 其他入口的参数对话框在关闭前校验；取消不创建 Session，草稿版本冲突不启动。新入口通过 CreateFromFlow 的 invocation 模式直接创建持久调用，旧 manifest.flow 会话保持兼容。
- `/flow` 在当前 Session 启动独立调用；`InvocationPanel` 按 root Task 显示各调用及人工确认，结果可放入聊天草稿。`builtin.flow@2.0.0` 提供参数与命名返回值组合。契约见 [Flow 调用与组合](../../doc/design/flow-invocation-composition.md)。
- InvocationPanel 的“再次调用”捕获原 Invocation/Session 身份，以新提交建立 retryOf 关联；调用卡片保留兼容 requestId 标记，另有稳定 invocationId 标记。DagWorkbench 只为非终态 Run 提供新的节点/图重试，终态展示从调用卡片或运行入口新建调用的提示；迟到快照与程序调用也须经过同一限制。
- UI 通过命令总线接入，不读写 Kernel 存储。DOM 回归见 `ui/app-shell/tests/flow-launch.test.ts`，实际模板 DAG 执行见 llm-flow 的 structured-flow 测试。

内置模板安装通过 `flow.draft.install` 保存独立安装记录；删除 `.flow` 后记录仍在，重启不再恢复该模板。聊天侧栏将同一 FlowEngine 挂到 `/@flows`，支持展开、打开和右键运行/删除。新增作文文件统一名为 `essay-review.flow`。

作文评审图按路由、检查、汇总、判断分节点编辑；打开旧 route@2 草稿时请求 `expandScopes`，仅显式保存才持久化。插件端口按 id + version 匹配，判断回路自动使用 repeat 控制边。数字表单支持运行参数引用。

`InvocationEditor` 提供 schema 字段引用、继承来源与提示词预览；`InputFieldsEditor` 编辑 param 字段。运行缺项复用 FlowParameterForm，提交通过 RunAttachmentController.respondInput 校验 attachment revision 与 pending interaction；切换任务关闭旧表单。

会话右键与顶部重新运行共用编辑器 `commands.rerunSession`，经 `shell/rerun-session.ts` 分流：关联 Flow 使用参数表单；普通 Chat/Harness 选择当前分支最后一条用户消息并调用 `RegenerateFromUser`，冻结当前执行模式，Agent 沿用原轮次。已有回复时创建替代分支和新 Task，旧结果保留，文件修改不回退。准入期间去重，切换会话/销毁取消未提交操作，空分支给出明确提示。流程输出提供只读分支选择，按 `session.flow-branch-executions` 返回的 Task 引用筛选。切换为空分支时必须清空上一分支结果并取消旧刷新。

`WorkspaceDirectoryMenu` 在标题栏按钮及标题栏/输入工具栏右键提供工作目录和挂载管理，经 `EditorHostContext.directoryCommands.configureWorkspace` 调用宿主；输入文本的原生右键菜单保持可用，运行中禁止修改。

聊天 `@` 文件候选通过 `FileSearchService` 消费 vfs-core 的 `discoverFiles`，过滤发生在 20 条候选上限之前。MentionPlugin 面板提供“包含忽略文件”复选框；取消旧请求后不得用过期结果重新打开面板。Grep/Glob 的 `includeIgnored` 是独立工具参数，候选框开关不改变 Agent 工具或目录授权。

Skill 面板区分指令加载与 Agent 工具授权，配置入口通过 Agent 的真实资源路径导航；Flow 模式导航到节点配置。授权计数表示配置声明，不能替代运行时目录权限和工具审批。见 [能力配置与执行](../../doc/design/tool-skill-mcp-capabilities.md)。

ChatInput 设置按对话、OCR、高级分组；高级项默认折叠。Skills 和授权管理不嵌入设置，显式 `/skills` 打开独立管理器。OCR 只选择连接并提供当前识别提示词编辑入口。

会话呈现以正文为主：共享 780px 阅读列，用户浅色气泡、智能体无外框，操作放在正文下方；成功回答不显示状态标签，运行/失败状态保留。工具参数和结果由原生 details 默认折叠，失败自动展开，进度在摘要外显示；思考默认折叠。输入栏的模型选择器统一连接与档位，更多菜单收纳搜索、设置、预设提示词和帮助，模式说明随模式菜单展开，用量随输入区下方 details 展开。菜单需支持键盘退出及点击外部关闭；远程会话不暴露本地设置。DOM 回归位于 app-shell 的 conversation-layout、chat-input-settings、chat-connection-refresh 与 tool-history-live 测试。

项目新会话 UI 位于 `src/shell/drafts/`：编辑器只消费 ui-common 的 `SessionDraftControls`，输入序列化与保存队列独立。materialize 返回明确的编辑器/提交标识/恢复行为，不能修改宿主 options 传递状态；项目转正策略、持久化和接受判定不进入 UI。inPlace 路径以 workspace-handoff 在同一 mount 内交接控制器，复用 ChatInput 与原输入 DOM，失败回滚输入绑定；外层编辑器委托正式能力，confirmDraft 接收宿主接纳事实及必要的恢复构造回调。跨视图接纳不重新提交，隐藏接纳不抢焦点。旧草稿 renderer 的 release 必须早于正式 HistoryView 创建子容器，不能在正式视图建立后清空共享历史根节点；首次发送回归必须核验临时提问和后续回复实际出现在已挂载 DOM 中，不能只校验外层容器身份。

- `/chat` 是聊天/Flow 展示入口，`/settings` 承载可选设置编辑器；共享展示源码不得加载 llm-settings-ui。根入口等同 `/chat`；已删除 `/legacy` 聚合入口。
- UI 经结构化 `SessionViewPort` 接收会话实例，默认工具列表由宿主注入，不从适配器读取产品默认值。Web/Tauri 不使用全局 SessionManager 装配聊天。

`/chat` 的正式会话编辑器必须注入 SessionViewPort，提示词历史仅由实例提供。Session/Flow 命令常量来自各自 `/contracts`，共享 UI 禁止导入 Session 实现根入口；禁止全局单例回退。

适配包通过 Vite 生成 JS 与声明，公开引用领域契约并声明真实依赖，不再通过声明内联伪装独立。独立 llm-ui 在自己的构建中执行 check-llm-ui-entrypoints.mjs，检查仅依赖 mdxeditor。适配包仍不得加载后端实现或隐藏 Runtime 所有权。

`/conversation` 仅消费 ui-common 的 ConversationControls 和 EditorOptions，不依赖 app-core 或 HTTP。SessionViewPort 的定义归 llm-session/contracts，TaskControlPlane 等任务端口归 durable-kernel；UI 直接导入所属模块的公共契约。发布这些新声明前必须先发布包含对应端口的领域包，不能用旧 npm 版本代替新契约。

Slash 命令描述在 slash-command-catalog.ts，弹出交互在 SlashCommandPlugin，执行按 SlashCommandRouter 的领域回调分组。输入创建状态只接收 initialInputState，禁止恢复 app_create_params 或全局创建缓存。

公开 EditorTaskControlPlane 位于 durable-kernel/src/ports/task-control.ts，Kernel 和远程客户端均可按结构实现，不要求继承 Kernel。工厂依赖类型要求 sessionManager/resolveSessionView 至少一个。task-attachment-lifecycle 负责共享挂接身份与异步恢复；editor-disposal 顺序尝试全部资源清理并汇总失败，destroy 返回同一 Promise。加载后的配置记录已保存快照，未修改时刷新/销毁不覆盖外部更新。

Session 编辑器可消费泛型 EditorOptions.initialData 的已激活读模型，不重复 Bind。activate 恢复缓存标签的会话绑定；destroy 只在仍持有当前绑定时 Unbind，避免关闭后台标签影响前台。

聊天提交反馈共用 `HistoryView` 的 `SubmissionFeedback`，本地 `SendMessageCommand` 与远程编辑器只提供状态和显式消息身份。临时用户卡片不写入持久历史；本地沿用 `SendIntent.submission.id` 对齐 round，远程使用已确认的 `submittedTurnId` 对齐原生 turn。不按文字相等去重，不把提交中显示为运行中，失败保留输入。直接命令仍无聊天轮次。历史顶部控件使用 `HistoryViewOptions.header`，位于滚动区内、消息 renderer 之外，分页保留已有 MDx 实例。远程分支删除由宿主调用既有管理服务，后端保护当前分支及其祖先；当前分支不显示删除按钮。

历史卡片销毁由 `MDxController` 等待在途初始化及 MDx 的异步销毁，`SessionRenderer` 汇总回收 Promise，`HistoryView.destroy` 返回可等待的结果。临时卡片被原生回显替换后，关闭编辑器仍会等待其完整释放。

Markdown 嵌入统一通过 MDxController 设置 `scrollMode: 'host'`，正文背景、文本色和留白使用 `--mdx-content-*` 公共变量；不覆盖编辑器内部模式容器。系统/工具角色、编码、摘要长度和配色属于 llm-ui；mdx-adapter 仅转发公共显示选项。

用户上下文折叠仅消费 `ConversationMessage.contentPartKinds` 的明确原生来源，和 contentParts 对齐后将已知项目指令、环境及附加上下文编码为 `nestos-context`；真实正文、未知来源、长度不匹配和旧服务数据继续直接显示。引用邻接处仅空行，相邻普通正文项之间保留原有 Markdown 分隔线，跨原生消息亦然。引用原文转义显示并可独立复制，展开状态沿用 mdxeditor 通用 disclosure key。来源判定不按文本内容、文件名或数组位置猜测；不得改变发送语义。Codex rollout 元数据由 nestos-node/driver 保留，Claude 缺少同类元数据时不推断。

- 编辑器 cancelPendingRender 暂停不可见视图的消息订阅、任务附着与 FlowInvocation 轮询；activate 读取当前快照并恢复观察，每个异步阶段核验激活代次和销毁状态，旧请求不得恢复隐藏视图；保留原 DOM、输入和草稿，不重发写入、不取消运行。RemoteConversationEditor 的迟到轮询和通知不更新隐藏视图。

- 本地与项目草稿提交先在历史区显示临时用户气泡，提交或首条历史追加时移除欢迎区；仅按提交身份与持久消息关联去除临时气泡。发送回执返回时用宿主 isGenerating 同步按钮，任务 lease/control/compaction 等事件不能推导为 running。SessionDraftEditor.refresh 通过宿主刷新外部替换的草稿，激活与刷新共享在途请求；本视图原地转正由 confirmDraft 固定控制器并隐藏项目选择，不把原视图替换成下一份草稿；未保存输入和检查期间的新编辑优先保留，隐藏编辑器不刷新或抢焦点。

- 可选 ChatConfigurationView 由宿主注入；Agent、预设提示词和连接选择器读取该快照，共享一个订阅并在变更时重建选项；每个缓存句柄释放自身监听，最后一个句柄释放源订阅。无注入时沿用配置服务。事件绑定后优先读取 SessionViewPort 的同会话快照，缺省才调用 GetSnapshot；激活、分支选择和保存顺序不变。

- 宿主可注入 readTaskAttachment 读取活动/待审批候选 ID；无候选跳过额外 Flow 查询，活动候选先核对同一 Session 及实时非终态，过期后继续待交互候选；待交互候选核对 Flow 归属、实时非终态及 pending interaction，跳过已解决任务。异步打开和状态读取后仍检查视图和附着代次。不注入时沿用 Kernel 端口，不改变附着和审批语义。

- 草稿控制器创建通过 SessionDraftMaterialization.createEditor 显式注入，不使用模块全局 DOM/WeakMap 交接表。保留输入时仍应用后端固定的 executionMode/Flow 约束；confirmDraft 不根据旧输入推断模式锁。ChatInput 绑定配置不能触发用户配置保存，附件粘贴/拖拽按当前能力动态判断。

独立入口 independent/native 经 NativeComposerCapabilities 将当前原生模型目录投影为 selector/variants，并聚合宿主 NativeCommandProvider 与 harness 命令；commands 的来源 id、局部 commandId、revision 与绑定一起校验。UI/项目/Flow/Agent provider 由宿主显式贡献，不把所有 MCP 工具自动改成 slash。界面 provider 不依赖远程 refresh；原生命令先刷新核对，参数与模型选择直达原生端口。independent/session 的 composerCommands 由命令拥有者核对操作，不能用 Session.Send 的提交证据替代。此路径与仍在工作台使用的兼容编辑器区分验收，不宣称工作台迁移已完成。


兼容输入与独立绑定通过 independent/native-command 共享命令解析、原始草稿和 prompt/action 提交语义。独立命令复核只刷新目录，不重读历史及无关模型；目录失败按有界退避重试。模型查询的项目授权与客户端生命周期归 app-core.projectModels。草稿首条 prompt 命令共用原生会话准备及转正，action 的 turnId 不推导用户消息。

图片编辑统一使用 independent/createImageEditingPort，兼容 File 输入经 file-image-editing 桥接；面板 commit 保存成功后才关闭。远程 ConversationComposer 保存原图和参数到宿主不透明存储，输入设置一起恢复；新草稿按 harness attachmentKinds 开放附件。保存使用版本 CAS 和 operationId 核对，不自动重放未知写入。独立视图的 images 配置自动装配端口并拥有其释放，不关闭宿主存储或借入的 processor。

图片处理共用 ImageProcessingSession；renderAttachments 只渲染，输入与策略变化显式调度。独立图片宿主通过 subscribeResize 通知变化，getRevision 同步提供策略版本。ConversationComposer 独立保存可变草稿和冻结提交；拥有 composer 存储时不双写原生草稿，仅按相同 submissionId 的回执清理匹配版本，不以最近 turn 或空草稿推断接纳。

FlowParameterForm 的 images/json 字段通过 FlowImageFields 按 imageConstraints 校验可选 MIME、总字节和数量限制，返回标准 image_url 或宿主不透明资源引用并显示预览；Flow 核心没有固定上传上限，宿主上传预算独立生效。数量、总大小、格式、文件读取、上传和预览失败显示具体原因。flow-images 内存日志只保存 operationId、requestId、阶段、错误分类、数量、字节和格式，不记录文件名、正文或原始异常消息；上传错误 requestId 可关联宿主审计。提交等待当前文件读取完成，清除或关闭后忽略迟到结果。库恢复通过 app.flow-library.restore 交给应用层协调，UI 不自行发布修订。

Flow 文件的更多菜单将「运行…」放在首项，随后才是分组、导出和编辑操作；宿主把完整资源菜单交给 Flow 菜单扩展排序，子流程分组内的文件共用同一入口。

普通输入选择 execution.kind=flow 的 Agent 时，发送前按绑定读取当前发布或固定 Flow，复用 FlowParameterForm 收集额外参数及连接；默认顺序为 Flow → Agent → 本次输入，提示词由 input.prompt 提供。发送透传 flowParameters/flowConnectionBindings/flowExpectedSignature，后端重新解析 Agent 绑定，不相信 UI 的 flowId。availability=disabled 保留原选择和草稿、禁选禁发并显示原因，配置通知更新可用性；隐藏、销毁及删除 Flow 时取消尚未提交的参数表单。Flow Agent 不要求全局聊天模型，图片经共享 input-assets 端口持久化。DOM 回归见 app-shell/tests/agent-flow-input.test.ts。

Flow Agent 允许空文字打开参数表单；参数表单返回 flowExpectedSignature，发送、草稿转正和 Session 队列均支持参数/默认/零参数调用，后端复核真实 Agent 绑定与签名。FlowLauncher 和 promptInvocation 也携带发布签名，CreateFromFlow 先核对后创建会话。独立 Session binding 可由宿主注入 inputContract/subscribeInput，将 ChatSubmission.input 转为同一 Session.Send 参数及签名；这不代表工作台已全部迁移。原生目标未声明结构化映射时明确拒绝，不丢弃参数后继续发消息。InvocationPanel 显示及重新填写使用冻结 inputResolution.parameters，原 parameters 保持原始提交。

Flow Agent 参数预填使用点击发送时的文字与附件快照，只消费 FlowParameter.inputSource 的 composer.text/composer.attachments 声明，不按字段名或工具业务猜测；文字覆盖声明字段的默认值，附件经 FlowParameterExtension.initialFiles 在初始弹窗内校验、预览并导入，取消或失败不清除聊天草稿。只有显式 inputGroups.mode=oneOf 的组要求用户选择一个来源；未声明互斥组保留多来源输入。flowImageAssets 按命令总线缓存公开资产端口，导入缓存不能跨运行时复用；条件连接验证将当前参数传给宿主重新核对。
右侧 Flow 工具栏以「流程名称 → 运行记录」开头，不重复显示 Flow Design；「运行」移至参数面板顶部固定栏，与菜单共用 ACTION_ICONS.run 和主题绿色提示，禁用态恢复中性色。连接表单标注必选/可选，设置可编辑 required、tier 和 requirements；需求由 Flow 声明，不按业务名称推断。文案走中英文 i18n。
运行表单的缺项提示区分填写参数、选择图片/选项和选择模型连接；参数优先显示 label，连接优先显示 description，缺省回退 name，与表单标签保持一致，不按业务或槽名映射文案。

Flow 参数表单只收集连接覆盖；必需槽位留空表示继承声明或用途默认连接，是否可运行由后端准入决定。槽位错误消费结构化 field，经本地或 HTTP 同样定位，不匹配英文错误正文。

原生取消使用独立 OperationContext.operationId 和冻结 sessionId/turnId，经 interrupt/reconcileControl 结算对应控制台账，不借用输入接纳回执。工作台停止与控制核对不受原发送 working 锁限制；停止待确认与输入待确认分别展示。取消不清草稿、不增加用户气泡、不隐式暂停队列，实际终态以原生事实为准。

原生 canQueryCommand 与输入 canCommand/canSend 分离；独立 llm-ui 将 query 分类和报告接纳交给同一 OperationLedger，reconcileQuery 不调用修改回执核对。旧工作台只读查询不占 working/ConversationComposer 提交槽，不清原 remoteSubmission；文字只按匹配修订清理。ChatInput 在原发送 Promise 悬挂时只为明确只读命令放行，计数保留仍在途的其他提交。

Session 附件发送经 AssetService.prepareUpload 取得 Markdown 引用及同批内容摘要元数据，再由同一冻结 Submission 发送。上传采用不可变命名，同身份同内容可读取核对，内容变化必须新提交；不得覆盖已排队文件。日志只记录身份、阶段、结果、索引、大小、错误码及耗时，不记录文件名、正文和原始存储错误。原 uploadFiles 仅保留引用返回兼容入口。

TaskArtifactBrowser 为运行页及正式 Session 的终态助手历史提供按需目录、预览和下载；scope 来自真实 Session/ExecutionRef，不解析气泡文本。它逐页校验引用、范围、总大小和摘要，完整下载再次核验内容；文字转义显示，图片使用宿主字节创建对象 URL。缓存和 URL 归单个视图，重绘不重发读取，目标切换/清空/销毁取消后续读取并回收 URL，旧 scope 的迟到回复不得污染新执行。产物读取走只读命令，不消费草稿或修改 OperationLedger 接纳状态。远程原生 URI 尚未导入时显示不可用，不能自行抓取。

原生输入的纯附件提交保留原始空正文，不由视图填充本地化 prompt 或 trim 后改写提交；原生端口负责派生实际 turn 提示。文本 UTF-8 传输保留 BOM。独立 native binding 将 not-committed 的具体 remoteCode 投影为 rejected，未知结果仍只核对；新增提交日志仅含 operationId、阶段、结果分类和耗时，不记录正文或附件内容。

Flow 通用 files 控件与 images 共用 input-assets 上传端口，稳定 uploadId 在取消重开和失败重试时保留；取消只结束当前观察，重新使用必须 Inspect 实际内容。文件选择捕获固定 signal/修订，不使用新选择的取消信号继续旧批次。多个 composer 附件字段不自动复制全批文件；逐文件核对冻结实参，未绑定保留并提示。确认的 Flow 文件不重复走 Session 聊天附件上传或追加引用文本；清除是显式 []。

默认原生工作台的 NativeInstructionQueuePanel 直接适配 ConversationControls 与独立 InstructionQueueView，不伪造 SessionCommandBus。awaitNativeAdmission 只缩短当前 UI 的接纳等待：订阅原 operationId 的持久事实后再派发，接纳可先于 RPC 返回，迟到结果不参与后续草稿消费；销毁只终止视图等待，不取消或重发原生操作。

独立 native binding 的 send/串行命令使用当前快照 canQueue 决定 enqueue，不能仅检查方法存在；原生首轮仍可走 send。OperationContext.operationId 贯穿原生接纳与队列回执，同一 OperationLedger 接收持久接纳；队列记录不伪造成历史消息。历史只按实际 turn 关联同 conversation 的发送或 prompt 命令，action 命令不能归属用户轮次。

独立原生视图通过 nativeQueueToolbar 挂载同一 NativeInstructionQueuePanel；仅暴露队列 read/edit 端口，不把 native controls 注入独立聊天库。队列结果按绑定代次投影，隐藏时只读，恢复后重新依据 canQueue；编辑采用已展示修订，控制与队列编辑不写提交台账。组合工具栏保留宿主生命周期，destroy 复用同一 Promise。

原生命令查询不占普通输入提交槽；暂停中的发送计数仍保留，只有明确 query 可以独立提交。取消携带实际 sessionId/turnId 并核对独立 operationId。NativeCommandOutput 在原锚点按需分页读取，失败留在结果卡片，隐藏/销毁停止后续页；通用字节拼接与摘要核验在 utils/verified-content，DAG 和原生各自校验协议，不相互导入业务模块。

SessionRenderer 使用消息 Map 同时维护身份与包装 DOM，已知消息查找不扫描整段历史。historyId/Flow 窗口别名仅从当前视图持有的引用解析；删除先撤销引用再动画，重复内容中的同名属性不抢占归属，clear/destroy 释放引用。产物与其他可选展示不能通过逐消息全树扫描放大恢复耗时。

正式 Session 和本地项目草稿通过已发布 Agent/Flow 目录保持平级目标。默认工作台先在现有 OperationLedger 持久保存冻结请求再提交；独立 ChatView 在同一台账保存原 Session/分支的 sessionRequest。队列通知只触发完整摘要核对，恢复使用原请求的只读 inspect，不重新填表或重发。晚回复不消费新修订或其他分支草稿；已保存附件草稿复用 DraftFilesCodec 和原上传身份，匹配 token 与内容后消费；同分支多视图草稿并发写入和独立子会话路由继续按计划验收。

OperationPersistence 只在 UI 适配层按 llm-ui 的纯规则合并 operationRecords，经 Session.compareAndSetUIState 对现有修订条件写入，并返回实际保存快照。未知写回执只读核对；条件冲突有界重读合并，不重发业务。缺少条件写能力不降级覆盖。台账合并不代表同分支正文可自动合并，草稿冲突继续独立处理。

分支输入的持久数据仍归 SessionRepository。StateService/DraftPersistence 仅持有本编辑器的已读基线，复用现有 Session 修订条件写入；冲突保留 dirty 输入，经 WorkspaceDraftRecovery 显式加载或替换，期间新编辑、分支切换和隐藏使迟到恢复失效。台账与草稿共用 conditional-ui-state，不重放业务操作；读取失败不可当作空草稿。共享偏好在草稿检查后仅按实际修改保存。独立 llm-ui 继续只消费展示、输入控制和宿主持久化端口，不依赖文件系统。


工作台上下文选择由 WorkspaceContextPicker 消费可选 ContextOptionsPort，按显式 Session/分支/目标查询，只保存用户确认的 InputContextDraft。选择通过既有分支与项目草稿恢复，OperationLedger 分别保存执行请求和 UI 消费证据；捕获的 draftConfig 优先于当前输入框。旧接纳不得消费新修订、其他分支或目标的草稿；清除后重选同点也产生新修订。目录静态兼容不替代宿主派发复验，无端口的普通聊天保持可用。流程和限制见 [功能合入计划第 34 节](../../doc/design/functional-merge-plan.md#34-f22-工作台上下文选择草稿与提交证据)。

手机与桌面的聊天输入区不重复显示当前会话标题；上下文选择、调用 Flow 和独立运行收入输入更多菜单，默认不展示宿主装配等实现术语。上下文错误展开菜单以保留可操作反馈。正式 Session 回复的产物入口收入该回复的更多菜单，不单独显示 LLM 按钮，也不放入输入菜单；只读回复保留产物读取入口。展开菜单不自动读取目录，点击查看产物才读取。

显式 `/run` 携带参数且没有待上传附件时，复用参数表单解析、字段约束、输入组选项及后端连接准入检查；完整有效输入直接提交，不重复弹启动确认。空 `/run`、缺参数或待配置连接保留原表单入口，网络/权限错误不能退化成确认弹窗。oneOf 显式输入先清理其他成员的默认值，运行中 builtin.input 仍由 Flow 自身决定。

Flow 参数表单按 inputGroups 声明展示关系：oneOf 仅提交单选来源并预选唯一有值成员；anyOf 用页签切换显示，保留并提交所有已填来源，至少提供一种。隐藏来源的校验错误自动切回对应页签。非来源的可选参数收起到“更多设置”，字段索引与默认值保持不变。
