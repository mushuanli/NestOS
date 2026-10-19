# 文件索引 — 场景 → 关键文件

## Kernel 执行内核（@itookit/durable-kernel）

| 场景 | 文件 |
|---|---|
| 内核实现（drain/submit/dispatchEffect/recover） | `durable-kernel/src/application/kernel.ts` |
| 领域类型（DurableTaskProgram/EffectAdapter/KernelAction/WaitSpec/TaskSpec） | `durable-kernel/src/domain/types.ts` |
| 能力绑定（bindCapabilities） | `durable-kernel/src/application/capabilities.ts` |
| effect 工具（assertEffectGrant/interactionApproved/normalizeEffect） | `durable-kernel/src/application/effect-utils.ts` |
| 决策/durability/actions 工具 | `durable-kernel/src/application/{decision,durability,actions}.ts` |
| seqfile 存储（session/task/effect/resource/budget） | `durable-kernel/src/infrastructure/seqfile/store.ts`、`store-helpers.ts` |
| 注册表（Program/Effect/Storage/Workspace） | `durable-kernel/src/ports/registry.ts` |

## LLM 任务单元（@itookit/llm-tasks）

| 场景 | 文件 |
|---|---|
| Agent 状态机（llm.agent） | `llm-tasks/src/durable/agent-program.ts` |
| Chat 状态机（llm.chat） | `llm-tasks/src/durable/chat-program.ts` |
| Plan 状态机（llm.plan） | `llm-tasks/src/durable/plan-program.ts` |
| program 辅助（llmEffect/extractNodeOutput/capabilitySignal） | `llm-tasks/src/durable/program-helpers.ts` |
| 依赖收集（collectDependency/dependenciesReady/dependencyWait） | `llm-tasks/src/durable/dependency-collector.ts` |
| TaskSpec 装配（buildLlmTaskInput） | `llm-tasks/src/durable/task-spec.ts` |
| 输入/输出类型（DurableAgentInput 等） | `llm-tasks/src/durable/types.ts` |
| 上下文装配（ContextAssembler） | `llm-context/src/assembly/context-assembler.ts` |
| provider 消息适配 | `llm-context/src/assembly/provider-message-adapter.ts` |

## DAG 编排（@itookit/llm-flow）

| 场景 | 文件 |
|---|---|
| 动态图调度（DurableFlowExecutor） | `llm-flow/src/flow/executor.ts` |
| 内置插件（transform/reduce/route/spawn/agent/human） | `llm-flow/src/flow/builtin-plugins.ts` |
| Flow 程序（value/human/aggregate） | `llm-flow/src/flow/programs.ts` |
| 纯操作（transform/reduce/route/spawn/表达式求值） | `llm-flow/src/flow/operations.ts` |
| FlowDraft → DagRunSpec | `llm-flow/src/flow/to-dag.ts` |
| Flow 校验 / 环检测（findCycles） | `llm-flow/src/flow/validation.ts`、`graph.ts` |
| 插件注册表 | `llm-flow/src/flow/plugin-registry.ts` |
| DAG 控制面命令（DagCommandService） | `llm-flow/src/flow/commands.ts` |
| Flow 定义持久化（FlowDefinitionStore/FlowStore） | `llm-flow/src/flow-definition-store.ts` |

## 会话语义 + 持久化（@itookit/llm-session）

| 场景 | 文件 |
|---|---|
| SessionManager / SessionRegistry | `llm-session/src/session/session-manager.ts`、`session-registry.ts` |
| SessionState（消息/分支状态机） | `llm-session/src/session/session-state.ts` |
| RoundOperations / BranchService | `llm-session/src/session/round-operations.ts`、`branch-service.ts` |
| ConversationRunCoordinator（Direct/Flow 分流） | `llm-session/src/session/conversation-run-coordinator.ts` |
| SessionRunCoordinator（DAG 运行协调） | `llm-session/src/session/session-run-coordinator.ts` |
| AgentResolver（connection/model 解析） | `llm-session/src/session/agent-resolver.ts` |
| SessionEventBus | `llm-session/src/session/session-event-bus.ts` |
| SessionRepository（ISessionRepository 实现，会话资产） | `llm-session/src/persistence/session-repository.ts` |
| FlowEngine（FlowStore 实现，Flow 定义/修订） | `llm-session/src/persistence/flow-engine.ts` |
| RoundLog（round 增量日志 + 投影） | `llm-session/src/persistence/round-log.ts` |
| RoundGraphService | `llm-session/src/persistence/round-graph-service.ts` |
| ISessionRepository / ConversationManifest / RoundManifest 类型 | `llm-session/src/persistence/types.ts`、`round-types.ts` |
| 装配入口（initializeConversationSystem） | `llm-session/src/index.ts` |
| 控制面（CommandBus/ExtensionRegistry/插件） | `llm-session/src/core/`、`plugins/` |
| PromptHistoryService / VFSAgentService | `llm-session/src/services/` |

## 能力实现（@itookit/kernel-adapters）

| 场景 | 文件 |
|---|---|
| 运行时装配（createKernelAdaptersRuntime） | `kernel-adapters/src/runtime/create-kernel-adapters-runtime.ts` |
| LLM effect（llm.chat + token 预算扣减） | `kernel-adapters/src/effects/llm-chat-effect.ts` |
| 工具/技能/bash/tty effect | `kernel-adapters/src/effects/{tool-call,skill-load,bash,tty}-effect.ts` |
| ILLMService 适配（→ LLMDeviceDriver） | `kernel-adapters/src/llm/llm-service-adapter.ts` |
| Skill 设备驱动 / 技能加载 | `kernel-adapters/src/skill/` |
| 工具定义（human-input/shell-session/tty-write） | `kernel-adapters/src/tool/`、`kernel-adapters/src/tty/` |
| Kernel 插件注册 | `kernel-adapters/src/plugin/kernel-adapters-plugin.ts` |

## LLM 设备（@itookit/driver-llm）

| 场景 | 文件 |
|---|---|
| LLMDeviceDriver（IDeviceDriver + LLM_IOCTL） | `kernel-adapters/src/llm-management/device/llm-device-driver.ts` |
| Provider 基类 + OpenAI/Responses/Anthropic/Gemini | `https://github.com/mushuanli/driver-llm/blob/main/src/providers/` |
| Responses API（web_search/reasoning/citations） | `https://github.com/mushuanli/driver-llm/blob/main/src/providers/responses.ts` |
| Gemini grounding citations | `https://github.com/mushuanli/driver-llm/blob/main/src/providers/gemini.ts` |
| MCP 客户端 | `kernel-adapters/src/llm-management/skills/mcp-client.ts` |
| LLM 错误族 | `https://github.com/mushuanli/driver-llm/blob/main/src/errors.ts` |

## VFS（@itookit/vfs-core）

| 场景 | 文件 |
|---|---|
| 协议 barrel（接口/类型/常量） | `https://github.com/mushuanli/vfs-core/blob/main/src/protocol.ts`、`interfaces/` |
| createVFS 工厂 | `https://github.com/mushuanli/vfs-core/blob/main/src/impl/factory.ts` |
| VFSEngine / VFSManager / FileSystemView | `https://github.com/mushuanli/vfs-core/blob/main/src/impl/engine/`、`impl/services/` |
| 通用 IO（IIOStream + pipe） | `https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/`、`impl/file-io/` |
| 事件总线（EventBus/FSEventBus） | `https://github.com/mushuanli/vfs-core/blob/main/src/eventbus/`、`impl/event/` |
| IndexedDB 后端 | `https://github.com/mushuanli/vfsdriver-indexeddb/blob/main/src/` |
| HTTP 外挂驱动 | `https://github.com/mushuanli/mindos-node-driver/blob/main/src/files/` |
| 远程连接与项目 | `app-core/src/projects/remote-mounts.ts`、`app-core/src/projects/remote-mount-store.ts`、`app-core/src/projects/remote-connections.ts`、`app-core/src/projects/mcp-remote-connections.ts`、`app-shell/src/toolbox/mindos-node-controls.ts`、`app-shell/src/files/remote-project-fields.ts` |
| LocalFS 后端 | `https://github.com/mushuanli/vfsdriver-local/blob/main/src/localfs-backend.ts` |

## CLI（@itookit/cli）

| 场景 | 文件 |
|---|---|
| YAML 工作流加载/校验/编译 | `cli/src/config.ts` |
| 运行时装配（durable-kernel+kernel-adapters+flow） | `cli/src/runtime.ts` |
| 命令入口（run/graph/runs/status/logs/resume/respond/cancel/rerun/fork 等） | `cli/src/cli.ts`、`cli/src/commands.ts` |
| 运行结果落盘（RunStore） | `cli/src/run-store.ts` |
| 工作区授权 | `cli/src/workspace.ts` |

## UI

| 场景 | 文件 |
|---|---|
| ChatInput（发送/插件/i18n） | `llm-ui-adapter/src/components/input/` |
| 流式历史 / Session 渲染 | `llm-ui-adapter/src/components/history/` |
| 会话事件消费 | `llm-ui-adapter/src/shell/SessionEventHandler.ts` |
| DagWorkbench（流程可视化） | `llm-ui-adapter/src/components/DagWorkbench.ts` |
| VFSUIShell（文件树） | `https://github.com/mushuanli/vfs-ui/blob/main/src/shell/` |
| 资源浏览契约与数据源 | `https://github.com/mushuanli/vfs-ui/blob/main/src/browser/`、`https://github.com/mushuanli/vfs-ui/blob/main/src/contracts/source.ts` |
| 文件编辑器装配与预览 | `app-shell/src/browser/` |
| MDX 编辑器 | [mdxeditor/src](https://github.com/mushuanli/mdxeditor/tree/main/src) |
| MDX 宿主/VFS 适配 | `ui/mdx-adapter/src/` |
| 设置（Provider/Connection/Agent/MCP/Skill/Cost） | `ui/llm-settings-ui/src/editors/` |

## 装配 / 入口

| 场景 | 文件 |
|---|---|
| initApp 装配 | `app-shell/src/bootstrap.ts` |
| App 类型（AppKernelRuntime 等） | `app-shell/src/types.ts` |
| 特权命令服务（plan 等） | `backend/app-core/src/kernel/privileged-command-service.ts` |
| web-app 入口 | `apps/web-app/src/` |
| 工作区挂载配置（WS_*/createWsMount、文件注册表） | `app-shell/src/workspaces/`、`app-shell/src/config/` |
| 全量测试矩阵（`pnpm test`，含 crash-matrix 隔离与 Rust 边界） | `scripts/test-all.mjs` |
| 活文档 / 样式一致性检查 | `scripts/check-docs.mjs`、`scripts/check-styles.mjs` |

## 联网搜索（跨层）

| 场景 | 文件 |
|---|---|
| 三态策略纯函数（resolveWebSearchStrategy） | `kernel-adapters/src/llm-management/contracts/connection.ts` |
| 策略解析 | `llm-session/src/session/agent-resolver.ts` |
| 派生 + 剥离客户端工具 + citations 投影 | `llm-session/src/session/conversation-run-coordinator.ts` |
| citations 事件发射 + 流式聚合 | `kernel-adapters/src/effects/llm-chat-effect.ts` |
| citations 渲染 | `llm-ui-adapter/src/components/history/StreamController.ts`、`components/templates/NodeTemplates.ts` |
| 联网搜索开关 | `llm-ui-adapter/src/components/input/ChatInputView.ts`、`components/templates/ChatInputTemplates.ts` |
| CLI -p prompt 命令 | `apps/cli/src/commands.ts` |

> 详见 [web-search.md](./web-search.md)

## 应用策略与 UI 机制

| 场景 | 入口 |
| --- | --- |
| Provider 关联删除、工具授权 | `app-core/src/configuration/model-commands.ts`、`tool-grants.ts` |
| 工具箱归档与分组查询 | `app-core/src/configuration/toolbox-resources.ts`、`toolbox-drawers.ts` |
| 项目同组查询与组织命令 | `app-core/src/projects/project-sessions.ts` |
| 项目归档业务目标 | `app-core/src/projects/targets.ts`、`app-shell/src/projects/archive-targets.ts` |
| 业务边界与接口说明 | [应用策略边界](design/application-policy-boundaries.md) |
| 生产源码依赖边界检查（`pnpm architecture:check`） | `scripts/check-boundaries.mjs` |
| 工作区模块能力、路由恢复与统一释放 | `ui/app-shell/src/workspaces/module.ts` |
| 项目 UI 模块装配 | `ui/app-shell/src/projects/index.ts` |


- mindos-node 目录项目、目录身份与策略版本：`tools/mindos-node/src/projects/`；客户端：`libraries/mindos-node-driver/src/projects.ts`、`libraries/mindos-node-driver/src/project-process.ts`；设计：[项目模型](design/mindos-node-project-model.md)。

## CLI 与共享宿主

| 场景 | 入口 |
|---|---|
| 本地/远程应用模式选择 | `apps/cli/src/application-host.ts` |
| Session/远程 Conversation 验证 | `apps/cli/src/application-command.ts` |
| 每个客户端的独立会话绑定 | `backend/app-core/src/host/application-view.ts` |
| Node Runtime 与私密资源所有权 | `apps/node-host/src/runtime/application.ts` |
| HTTPS 服务和初始化屏障 | `apps/node-host/src/http/start-host.ts` |
| 平台中立 HTTP 客户端 | `shared/app-transport/src/http/view-client.ts` |
| Node mTLS 注入 | `apps/node-host/src/client/index.ts` |
| 模式日志与使用说明 | [CLI 与 HTTP](http-mode.md) |
