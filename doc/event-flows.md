# 核心事件流

> 事件层分两套：**Kernel 持久化事件**（落盘，经 `eventList`/`TaskHandle.events()` 轮询消费）与 **业务流式事件**（`agent.event` payload，流式渲染）。

## 1. Kernel 持久化事件（EventEnvelope）

所有 Task/Effect 生命周期事件写进会话事件日志（seqfile），消费方按 `sequence > after` 轮询（`session.events(after)` / `TaskHandle.events(after)`），或订阅 `onChanged` 通知。

| 事件 | 触发 |
|---|---|
| `session.created` | 会话创建 |
| `task.created` / `task.started` / `task.leased` | 任务提交/启动/领取 |
| `task.signal` / `task.spawned` | capabilities 等信号 / patch-graph 子任务 |
| `task.failed` / `task.attempt.lost` | 任务失败 / worker 丢失重试 |
| `effect.leased` / `effect.resolved` / `effect.attempt.lost` | effect 领取/完成或失败/重试 |
| `budget.configured` / `budget.consumed` | 预算设置/扣减 |
| `session.shared.set` / `session.shared.deleted` | 会话内共享状态（task 间） |
| `session.context.committed` | context commit（分支） |
| `session.message.queued` / `session.message.received` / `session.message.rejected` | 跨会话同步（outbox/inbox 消息队列） |
| `workspace.snapshot.created` / `workspace.diff.created` | 工作区快照/diff |
| `task.interaction.requested` / `task.interaction.resolved` | HITL 交互请求/解决 |
| `agent.event` | 业务层流式事件透传（见下） |

```
Kernel store.appendEvent → 事件日志 → kernel.eventList(sessionId, after) / TaskHandle.events(after) 轮询
                                        → cli RunStore.appendEvent（events.jsonl）
                                        → llm-ui 流式渲染
```

## 2. 业务流式事件（agent.event payload）

LLM 流式与程序进度经 `agent.event` 透传（`KernelAction.emit` 或 effect `context.emit`）。

| 事件 | 来源 | 用途 |
|---|---|---|
| `stream:content` / `stream:thinking` | `LlmChatEffectAdapter`（SSE chunk） | 流式正文/思考渲染 |
| `round:start` / `round:end` | `DurableAgentProgram` | 轮次边界 |
| `tool:running` / `tool:success` / `tool:error` | `DurableAgentProgram` | 工具生命周期（开始、结果、失败） |
| `tool:progress` | `ToolCallEffectAdapter`（工具进度回调） | 有界活动/匹配快照，携带真实 callId，最终结果到达后停止展示 |
| `finished` | `DurableAgentProgram`（含 usage） | 任务完成、token 统计 |
| `citations` | `LlmChatEffectAdapter`（终态 chunk） | 联网搜索引用（一次性，投影为 `message:citations`） |

```
LlmChatEffectAdapter.execute（流式逐块）
  → context.emit({ type:'agent.event', payload: { type:'stream:content', delta } })
    → store.appendEvent(sessionId, taskId)
      → TaskHandle.events() → UI / CLI
```

## 3. Interaction（HITL）链路

```
DurableAgentProgram.request-interaction（approval/human）
  → task.interaction.requested（事件 + interaction 入列）
  → 外部（UI/CLI）respondInteraction(interactionId, value)
  → task.interaction.resolved → 程序收到 interaction-resolved
  → interactionApproved(value) 判定 → 放行工具或拒绝重试
```

## 4. Session 事件（llm-session → UI）

`SessionEventBus` 把 durable 运行投影为会话事件供 `llm-ui` 消费：

| 事件 | UI 操作 |
|---|---|
| `message:appended` | 创建会话分组、渲染消息 |
| `message:updated` | 流式追加文字、更新 thought |
| `message:status` | 完成/失败/工具结果 |
| `node:appended` → `tool:running` | 先挂载工具卡片（名称、真实参数），再立即更新运行状态 |
| `tool:success` / `tool:error` | 更新工具卡片的结果/错误，保留多行文本与转义 |
| `finished` | token 统计、停止 loading |
| `message:citations` | 渲染联网搜索引用块 |
| `branch:switched` / 再生事件 | 分支切换/再生 |

```
ConversationRunCoordinator → RoundLog 投影 → SessionEventBus.emitSession()
  → llm-ui SessionEventHandler → HistoryView / StreamController
```

> 联网搜索的 citations 事件链与三态决策详见 [web-search.md](./web-search.md)。

Harness 工具事件无需等待 effect 完成：`tool:running` 随发起 effect 的 decision 持久化，`ConversationRunCoordinator` 先发 `node:appended` 再透传生命周期事件，`HistoryView` 对二者立即处理。工具结果区按预格式文本展示；刷新后的失败卡片读取持久化 `data.error`。Grep 目前通过授权 VFS 遍历并执行 JavaScript 正则，没有实际 shell 命令可展示；Bash 的真实命令在调用参数中。Grep 通过 `ToolInvokeRequest.onProgress` → effect `context.emit` → `agent.event/tool:progress` → `HistoryView` 显示 cwd、搜索路径、扫描数、跳过数和匹配预览。快照按约 250ms 限频，首个匹配及时发送；消息最多 2048 字符，预览最多 8192 字符，不作为 LLM 的最终工具结果。终态覆盖预览，迟到进度不改写终态。通用 `getActivityDescription` 已由 ToolDeviceDriver 接入，并通过工具进度端口发出活动描述。回归：`backend/app-core/tests/harness-default-tools.test.ts` 阻塞搜索完成并确认开始事件已到达；`ui/app-shell/tests/tool-history-live.test.ts` 验证执行中卡片及成功/失败结果。

## 5. 跨会话同步（outbox/inbox）

```
session A: sendCrossSession(source, target, topic, payload)
  → store.createOutboxMessage → 事件 session.message.queued
  → relayMessage → 投递到 target 的 inbox → 事件 session.message.received（拒绝时 session.message.rejected）
  → target: session.inbox(after) 读取
```

用于会话间的消息传递（与 session 内 `setShared/getShared` 互补：前者跨会话、后者会话内 task 间）。

## 6. VFS 事件

```
FSEventBus（vfs-core/src/impl/event/event-bus.ts）：
  node:created / node:updated / node:deleted / node:renamed / node:moved / node:copied
    （payload 统一为数组：{nodes:[…]}；node:deleted 为 {requestedPaths, allDeletedPaths}）
  mount:added / mount:removed（payload {mountPath, mountId, label?}）
  → vfs-ui（EngineAdapter 订阅 driver 事件 → VFSUIShell 刷新树）
  → app-settings SettingsService 防抖重载 → app-shell SkillsEngine（skill 变更同步）
```

## 7. 消费方一览

`LLMDeviceDriver` 在 `/etc` 文件视图上监听创建、更新、删除、移动和重命名，仅当受影响路径为 `/llm`、其子路径或整个配置根时，防抖 300ms 重载连接、MCP 和 Skill。移动和重命名检查源、目标两侧；`/ui` 状态持久化等无关写入不触发重载。异步重载失败通过 `[LLM config] refresh failed` 报告，不成为未处理的 Promise 异常。

| 消费方 | 事件源 | 用途 |
|---|---|---|
| `cli`（RunStore） | `session.events(after)` | events.jsonl 落盘 + 运行渲染 |
| `llm-ui` | `TaskHandle.events()` / SessionEventBus | 流式聊天渲染、DagWorkbench |
| `app-shell` | VFS FSEventBus / kernel onChanged | 树刷新、skill 同步 |
| kernel 内部 | 事件日志 | drain 推进、recover 恢复 |

## 执行取消的错误事件标记

SessionRunCoordinator 在取消终态的 `error` 事件中保留 `code: ABORTED`。HistoryView 与 SessionEventHandler 据此呈现取消状态、取消提示及重新执行入口；缺失该码、TIMEOUT 或仅包含 aborted 文本的普通错误仍按失败显示。状态指示器的取消状态停止 loading，历史 aborted 节点仍保留持久原因。该标记描述执行取消，不替代 Kernel 控制面的外部停止确认。


## 图重试恢复确认

控制端经 requestFlowGraphRetry 把 intent 追加到 Session shared；GraphRetryController 在恢复调度前消费。图状态与 appliedGraphRetries 回执写入同一 scheduler checkpoint 后才确认队列。恢复遇到已有回执时只确认，不重复下游失效、代数推进或 token 退款；checkpoint 写入失败保留 pending 意图。完整序列图见 [运行时架构审查](runtime-architecture.md#集中实施调度会话ui-与解码边界)。

UI 挂接恢复通过 EditorTaskControlPlane 获取状态和事件，每次异步返回后核验 Session、attachment revision 与关闭状态。编辑器销毁先阻止新挂接，再尝试保存、detach、解绑和视图释放；任一失败不会跳过后续清理，最终以 AggregateError 交给宿主。
