# @itookit/kernel-adapters

内核**能力适配层**：把 `driver-llm`（模型）、`tools`（工具与原生 shell）、Skill 目录、TTY 驱动接到 `durable-kernel` 的 Effect 面与工具面上，并托管 Skill 的加载身份与提示注入。它是 Kernel 与具体能力实现之间的唯一粘合层。详见 [架构设计](../../doc/architecture.md)、[事件流](../../doc/event-flows.md)、[Skill 设计](../../doc/design/skill-design.md)。

## 定位与铁律

- **只依赖下层**：`llm-context`、`driver-llm`、`durable-kernel`、`vfs-core`、`tools`；不得依赖 `llm-session` / `llm-flow` / `llm-tasks` / `app-core` / UI 包或任何 app。
- **Effect 必须可取消且确认停止**：能力适配器（`llm.chat`、`llm.media`、`tool.call`、`skill.load`、`skill.unload`、`process.exec`、`tty.command`）全部实现 `EffectAdapter.cancel`；`effects/in-flight.ts` 从执行或恢复入口记录整个在途过程（含能力获取），`cancel` 必须等它结束才确认。取得能力后再次检查取消状态，不能在取消确认后启动外部核对。
- **装配即接线**：`createKernelAdaptersRuntime` 只做组合与生命周期；策略（工具白名单、Skill 触发、项目规则）由注入的 `SkillSource` / `configureSession` / `additionalTools` 决定，调用方（CLI / app-core）负责宿主差异。
- **Skill 身份持久化**：成功 `load_skill` 后把身份写入 `kernel-adapters.skills.loaded`（`skill/loaded-state.ts`）；身份写入失败必须回滚（新加载卸载、已加载保留），回滚自身失败以 `AggregateError` 保留原始错误。

## 结构

```
src/
├── index.ts                     公共导出
├── runtime/create-kernel-adapters-runtime.ts  装配入口：LLM 服务、工具/Skill catalog、
│                                Session 能力注册表、Effect 注册、释放顺序
├── plugin/kernel-adapters-plugin.ts            注册进 Kernel 的 KernelPlugin
├── effects/                     Effect 适配器（全部支持 cancel）
│   ├── llm-chat-effect.ts       llm.chat：模型调用 + 服务端断开
│   ├── llm-media-effect.ts      llm.media：图片/语音生成、回执恢复与用量结算
│   ├── media-result-store.ts    媒体资产及回执存储，复用内核任务寻址
│   ├── tool-call-effect.ts      tool.call：工具执行（含 skill 加载器/卸载器的持久身份）
│   ├── bash-effect.ts           process.exec：原生 shell 命令
│   ├── tty-effect.ts            tty.command：交互式 shell 的 write/close
│   ├── skill-load-effect.ts     skill.load
│   ├── skill-unload-effect.ts   skill.unload
│   └── in-flight.ts             在途执行登记（cancel 等待结束）
├── llm/llm-service-adapter.ts   driver-llm 驱动 → ILLMService
├── skill/                       Skill 子系统
│   ├── skill-device-driver.ts   Skill 目录的持久实现（save/delete + 变更通知）
│   ├── session-skill-controls.ts 面板/编辑器操作（load/unload/mountByGlob/onChange）
│   ├── session-prompt-context.ts resolveSessionSkillContext（两宿主共用）
│   ├── prompt-context.ts        Skill 指令 → 提示块（正文/compact/关键规则）
│   ├── compact-extractor.ts     aggregateCompactInstructions
│   ├── loaded-state.ts          kernel-adapters.skills.loaded 读写与回滚
│   ├── restore-loaded-skills.ts  批量身份恢复与失败时撤销本次新增加载
│   ├── operation-queue.ts       同一 Session 的 Skill 操作串行化
│   ├── session-file-source.ts   Session VFS 作为 Skill 来源
│   └── glob-matcher.ts          mountByGlob 匹配
├── tool/                        load_skill / unload_skill / human_input 工具
├── tty/                         TTY 工具（shell_session / tty_write / tty_close）
│                                + TTYSessionManager
├── programs/                    ExecProgram / ApprovedEffectProgram / ToolProgram / MediaProgram（能力程序）
└── ports/capabilities.ts        CapabilityResolver / SessionCapabilityRegistry / SkillSource
```

## 入口

```ts
const runtime = await createKernelAdaptersRuntime({
    llmDriver,
    fileContextForSession,        // 每个真实 Session 独立获取 VFS/cwd/nativeShell/tty
    skillSourceForSession,        // 仅用已获取的 Session 文件视图构造 Skill 来源
    configureSession,             // 注入 Session 级工具/skill 服务
    additionalTools,
});
kernel.use(runtime.plugin);       // 注册 Effect/工具/Skill catalog
await runtime.disposeSession(sessionId);
await runtime.dispose();
```

## 约束

- MCP 后端启动连接默认启用（autoConnect:false 显式关闭），空配置与宿主禁用的 stdio 跳过；连接和标准/扩展发现异步运行，不阻塞 LLM 就绪。initializeMCPServer 复用按 ID 串行队列，发布运行时目录后通过 configurationChanged 通知宿主，启动发现不重写持久配置。服务器可以调用 waitForMCPStartup 等待首轮尝试全部结束，不改变交互模式的 LLM readiness，远端失败以连接状态保留。已有配置 autoConnect 从 false 开启后，在保存完成后排队复用 initializeMCPServer；连接失败通过运行时状态发布，不把网络失败当成配置保存失败。关闭开关不主动断开。

- 工具/Skill catalog 只暴露**元数据**（`getToolDefinitions`/`getSkillMeta`），可执行服务只经 Session 作用域取得。
- KernelAdaptersRuntime.registerTools 接收宿主已验证的 Tool 实例，先准备全批描述及每个 driver 的元数据副本，再同步发布到 catalog、当前 Session/Run 作用域和未来作用域；不替换已有工具，不重建会话或重启运行时。批量准备失败不发布任何一项，作用域释放时解绑动态工具目录，运行时关闭后拒绝注册。
- Context 的 `createTaskContextStorage` 使用 Task SeqFile 独立内容命名空间，发布和 GC 与 Kernel 提交共用后端事务。GC 只接受终态且 Effect 清理已确认的 Task，根包含保留的 Task/shared 历史；不得按文件年龄直接删除可达内容或解除固定目录保护。
- Task SeqFile 路径只通过 durable-kernel 的公开 taskStoragePath(sessionRoot, taskId) 获取；媒体和 Context 不再自行编码 Task ID 或拼接任务布局。媒体协议、工具版本与业务副作用核对继续留在适配层，不进入内核。
- 可选 `scopeForEffect`/`fileContextForScope` 由宿主选择并获取 Run 独立能力，注册表按 Session + scope 缓存；普通 Session API 保持默认作用域。选择或获取失败不回退；`disposeScope` 合并并发清理并禁止迟到 Effect 重建，Session/运行时关闭释放所有子作用域。
- 所有 Skill 操作（load/unload/编辑器挂载）经 `runSessionSkillOperation` 串行化，避免同一 Session 竞态。
- 身份 CAS 只重试 Kernel CONFLICT；提交前/后其他存储错误直接报告。批量恢复失败撤销本次新增加载，保留原有选择；清理失败逐项聚合，不修改持久身份。
- 变更通知只在宿主进程内传播（`SkillDeviceDriver.notifyChange`）；跨进程直改 Skill 文件不触发，新定义在下次上下文组装时生效。
- `createKernelAdaptersRuntime` 的创建失败清理逐项执行并聚合错误（`runCleanup`），`release` 失败不跳过 driver dispose，原始初始化错误不被覆盖。

## 运行

```bash
pnpm --filter @itookit/kernel-adapters test        # vitest run（测试与实现同目录）
pnpm --filter @itookit/kernel-adapters typecheck
```

## 相关文档

| 文档 | 内容 |
|---|---|
| [架构设计](../../doc/architecture.md) | 能力层在整体分层中的位置 |
| [事件流](../../doc/event-flows.md) | Agent / HITL / TTY 事件消费链 |
| [Skill 设计](../../doc/design/skill-design.md) | 触发策略、作用域、四层路由、类型系统 |
| [Durable 证据映射](../../doc/design/durable-harness-evidence.md) | Effect 取消与清理的持久证据 |

持久身份恢复在 `runtime/create-kernel-adapters-runtime.ts` 的注册表 `restoreScope` 中实现。关闭 Session/运行时时先失效排队操作，等待当前 Skill 操作与身份恢复结束，再释放能力；清理未完成时不能重建作用域。

加载记录支持 format:2 的 ids/snapshots/drifts。默认 require-reload，keep-old 只保留内容而不恢复撤销权限；旧 ID 记录在执行入口要求显式 reload。resolveSessionSelectedSkills 将直接聊天/Flow 初始选择接到同一版本存储和 Session 队列。

## 模型管理子入口

`@itookit/kernel-adapters/llm/core` 提供 LLMDeviceDriver、LLM_IOCTL、配置、费用、Skill 与 MCP 管理；Provider 支持目录归独立的 `@itookit/device-llm`。源码在 `src/llm-management/`，回归在 `tests/llm-management/`；不是额外 npm 包。公开通信客户端与契约来自 driver-llm，禁止其反向依赖本包。MCP stdio 保留 browser/default 条件入口。详见 [模型集成](./doc/llm-management/README.md)。

## 配置契约入口

ModelRequirements.responseFormats 声明所需 text/json_object/json_schema 模式；assertModelConnection 通过 device-llm/contracts 的纯能力 helper 校验实际协议与模型正向声明。格式不兼容必须在连接准入时失败，不自动切协议、换模型或丢弃 responseFormat。

ModelDefaults / ModelOperation / modelForOperation 属于模型管理契约。ConnectionManager 串行读写对话、绘图、语音默认表；旧默认 API 仅表示对话，旧文档不推断媒体默认。配置保存不发起网络验证，配置和用途能力校验不替代执行准入。详见 [用途默认](../../doc/design/model-purpose-defaults.md)。

`@itookit/kernel-adapters/contracts` 定义 Agent、连接管理、恢复与定价契约及纯策略，不加载适配器运行时、VFS、YAML 或 MCP SDK。Session 与设置 UI 直接消费此入口；适配层不得反向依赖 Session、Flow 或 Tasks。模型事件来自 driver-llm/contracts 的 LlmCommunicationEvent。

`resolveChatModelTiers` 统一工具箱与聊天菜单的模型档位解析：只返回 Provider 目录中存在的聊天模型，保留缺省 category 的聊天语义，不为 standard/fast 添加未配置档位；optimal 缺省时沿用连接 model。未知 ID 和媒体模型不可作为聊天候选，执行准入继续由 assertModelConnection 校验。`resolveChatModelForTier` 复用执行档位的回退规则，解析任意指定档位的实际聊天模型；显式配置的媒体/未知模型返回 undefined，不能跳过它回退到其他聊天档位。

模型管理机制使用 `/llm/core`，预设经 `presets` 快照注入，自动连接经 `providerConnectionPolicy` 注入。MindOS 目录与默认连接策略只在可选 `/llm/presets`；旧 `/llm` 聚合入口已删除。禁止机制入口加载产品目录。

配置格式与目录组合只从 `/llm/config` 提供，不依赖产品目录或设备实现。MCP 宿主桥从 `/llm/mcp-host` 的 createMCPStdioTransportFactory 创建，通过驱动 options.mcp.stdioTransport 注入。机制入口禁止读取全局桥；不提供全局桥注册或兼容构造器。

构建自动运行 [入口检查](../../scripts/check-llm-entrypoints.mjs)，递归检查 ESM/CJS 配置与机制导入图，并验证核心入口不加载旧 MCP 全局注册模块。

MCP 日志与客户端身份经 MCPConnectionOptions.logger/clientInfo 实例注入；机制默认空日志与通用身份，禁止读取 common 全局日志或内置 MindOS 身份。

诊断日志与进程不可用提示通过实例选项注入；禁止重新引入 common 全局日志/翻译、MCP 全局注册或旧 /llm 聚合。设备 ioctl 分为管理分派表与 MCP/Skill/Chat 会话处理。

设备 ioctl 在分派前验证身份、配置、消息和调用参数；Connection/Provider 直接保存路径也验证，加载时跳过无效配置并保留合法删除回执。模型 URL、密钥和协议字段不允许依赖 JavaScript 隐式转换；配置身份禁止路径分隔符。Skill 定义和 MCP 配置继续由各自管理器检查语义。

ChatConfigurationView 是聊天选择器的只读聚合观察契约；Snapshot 仅包含 Agent 展示字段及 systemPromptId、预设提示词、ConnectionMeta 与 Provider 模型目录，不含凭据和系统提示词正文。宿主实现聚合和订阅，契约入口不加载服务。

AgentDefinition.execution 可声明普通 Agent 或 Flow 引用（flowId、可选 revision、默认参数与连接绑定）；契约只使用基础数据，不依赖 llm-flow。availability 是宿主派生的只读可用性，禁止写回 Agent 源文件；ChatConfigurationSnapshot 保留 execution/availability 供通用入口展示，Flow 执行、Schema 和版本冻结由上层负责。

豆包语音产品目录与只读 API 资料在 ../device-llm/src/catalogs/doubao-speech.json；运行目录仅派生已实现的资源模型/格式/音色。模型请求体变体与资源 ID 分开，文档支持不代表适配器实现或账号授权。getProviderReferences 返回预设资料副本，不混入用户 Provider 存储或覆盖已有配置；不得让机制入口反向加载产品目录。

模型 supportedOperations 表示目录明确声明的可发现操作，序列化与配置验证保留该字段；执行仍须完整 operations 约束。completeModelDeclaration 仅按精确模型 ID 补齐宿主目录声明，远程发现还须匹配预设地址和实现，禁止从名称猜测能力。Seedream 官方模型与约束在 ../device-llm/src/catalogs/volcengine-images.ts，不为未知版本杜撰能力。

厂商参考价统一记录在 ../device-llm/src/catalogs/model-prices.json，覆盖全部内置 Provider，保留来源、reviewedAt、原币种/单位及价格条件；只经可选 presets 注入 reference_catalog。getPricingConfig 返回参考目录副本，与可编辑 model_pricing 账本费率独立；精确匹配 Provider/模型 ID，不换汇、不套用名称相似项或上游直供价。无可核实价格时记录 unverified/account/subscription/variable，不当作零价。新增 Provider 须补参考目录记录，厂商网页不进入 UI 或机制入口依赖。

Provider 支持目录、模型/价格/接口资料的权威定义在 device-llm；kernel-adapters/contracts 复用 device-llm/contracts 的纯契约。禁止在本包重新建立同一厂家目录或全局注册器，MindOS 的 Agent、默认连接及宿主存储保持应用策略。

- Harness 上下文契约在 contracts/context-binding：Invocation、绑定、原生 thread 和操作身份分开。HarnessProgram 的 host-assembled 输入必须持久保存同 ID/摘要的 contextSnapshot 依据，并核对实际 canonical messages 的 SHA-256；native-continuation 只允许增量 prompt 与附件，不能再注入完整 messages。有附件的增量摘要覆盖规范化 prompt 和实际附件字节；无附件保持旧 prompt 摘要。上下文已冻结时禁止自动追加未计入快照的依赖输出，须在装配前显式纳入。绑定持久状态及原生能力协商由宿主实现，不把本地 CAS 或 resume/fork 布尔能力当作原生 head 条件写保证。
