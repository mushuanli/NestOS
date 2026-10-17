# llm-ui — 事件处理与渲染管线

## Event → DOM 完整链路

```
SessionEventHandler.handleSessionEvent(event)
  → HistoryView.processEvent(event)       ← EventBatchProcessor（50ms 批处理）
    → processEventImmediate()              ← message:appended / finished / error 即时处理
    → processEventBatch()                  ← message:updated / message:status 合并后批量处理
    → EventDispatcher.dispatch(actionContext) ← 点击委托（data-action → handler）
```

## 事件分类

| 类型 | 事件 | 处理方式 |
|------|------|---------|
| 即时事件 | `message:appended`, `finished`, `error`, `messages:cleared`, `messages:deleted`, `message:edited`, `regenerate_started`, `regenerate_completed`, `sibling:switched`, `branch:switched` | 跳过批处理，立即同步执行 |
| 合并事件 | `message:updated`（chunk）| 每个 messageId 合并为 `{thought, output}` |
| 合并事件 | `message:status` | 每个 messageId 取最新 status |
| 元数据事件 | `message:updated`（仅 metaInfo）| TtyController 消费 |

## 副作用声明表

`SessionEventHandler` 使用声明式映射 `EVENT_SIDE_EFFECTS`：

| 事件 | 副作用 |
|---|---|
| `finished` | clearErrors, updateStatus, notifyChange, refreshNav |
| `message:appended` | clearErrors, updateStatus, notifyChange, scrollToBottom |
| `message:updated` | 流式增量渲染（StreamController），不触发全量刷新 |
| `message:status` | 更新节点状态图标 |
| `branch:switched` | refreshBranch, refreshNav, flashIndicator |
| `regenerate_started` | clearErrors, flashIndicator |
| `regenerate_completed` | refreshBranch, refreshNav |

## 核心 Controller 职责

| Controller | 职责 | 关键方法 |
|---|---|---|
| `SessionRenderer` | DOM 创建/销毁，MDxController 生命周期 | `appendSession()`, `appendNode()`, `removeMessages()`, `renderWelcome()` |
| `StreamController` | 流式内容增量更新，编辑器最终化 | `enter()`, `exit()`, `updateContent()`, RAF 帧调度（80ms 交替 phase） |
| `CollapseController` | 折叠状态管理 | `toggleSession()`, `computeInitialState()`（user + 非最后 assistant → 折叠） |
| `EventDispatcher` | 单次 click 委托，`data-action` → handler | 支持 17 种操作（collapse/copy/delete/regenerate/edit/...） |
| `NodeRenderer` | 节点 DOM 创建（工具调用、响应、思考） | `renderExecutionRoot()`, `renderToolNode()` |

## SessionGroup 渲染规则

```
appendSession(group, isCollapsed):
  role === 'user' →
    <div class="llm-ui-session--user" data-session-id>
      → previewText + 只读 MDxController

  role === 'assistant' →
    <div class="llm-ui-session--assistant" data-session-id>
      → 头像 (metaInfo.agentIcon) + executionRoot 容器
      → appendNode() 递归渲染 ExecutionNode 树
```

## ExecutionNode 树渲染

```
ExecutionNode {
  executorType: 'agent'   → 主响应气泡（thought + output）
  executorType: 'tool'    → 工具调用卡片（data.toolCall）
  children[]              → 递归渲染子节点
  status: 'running'       → 流式模式（isStreaming=true）
  data.metaInfo           → 透传任意元数据（agentId, HITL, TTY, ...）
}
```

## 消息删除流程

```
外部 call → SessionManager.deleteMessage()
  → emit('messages:deleted', { deletedIds })
  → HistoryView.processEventImmediate()
    → removeMessages(deletedIds, animated=true)
      → SessionRenderer.removeMessages()
        → 销毁 MDxController, 移除 DOM, 清理 nodeMap/renderedSessionIds
        → 容器为空 → renderWelcome()
```

## 流式渲染细节

```
message:appended (isExecutionRoot=true) →
  MDxController 创建（isStreaming=true）
  StreamController.enter() → raf 循环启动

message:updated (delta) →
  StreamController.updateContent(messageId, delta, 'output'|'thought')
    → MDxController.appendDelta(chunk) / thought 容器更新
    → 标记 dirty → 下一帧 flush

finished →
  StreamController.exit()
    → 刷新 pending delta, finalize 编辑器
    → 500ms recentlyExited 保护期
```
