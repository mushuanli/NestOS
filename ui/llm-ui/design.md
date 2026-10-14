# LLM Workspace Editor (`llm-ui`) — 设计文档

> 本文档是架构设计的权威参考。所有功能开发、接口修改、代码审查必须遵循此文档中的规则。
>
> 与代码不一致时以 `src/` 为准;接口清单见 `src/domain/ports/`,公共 API 见 `src/index.ts`。

---

## 0. 功能概览

LLM 对话工作区编辑器 — 支持多分支对话、流式输出、会话持久化的富交互 UI 组件。

- **多分支对话** — 从任意消息创建分支,自由切换对话路径
- **流式输出** — 实时渲染 LLM 响应,支持 Markdown / 代码块 / 数学公式 / Mermaid
- **会话管理** — 编辑、重新生成、删除消息,批量操作
- **状态持久化** — 折叠状态、输入内容、Agent 选择自动保存恢复
- **浮动导航** — 快速跳转、批量选择、分支筛选
- **附件系统** — 拖拽/粘贴上传,内联引用
- **DAG 工作台** — 节点运行图 + 插件流编排
- **TTY 面板** — 运行输出展示
- **Skills 工作区** — Skill 列表 + 表单编辑器

**会话绑定**:一个会话 = 一个 `LLMWorkspaceEditor` 实例。vfs-ui 选中 chat 节点时,由 app-shell 注入的 `EditorFactory` 创建编辑器,会话身份来自 `EditorOptions.target.sessionId`(`{ kind: 'session' }`)。llm-ui 不负责会话选择,是纯显示/交互层。

---

## 1. 架构原则

### 1.1 核心约束

| 编号 | 原则 | 约束 |
|------|------|------|
| **P1** | 单向依赖 | 外层 → 内层,禁止反向或跨层捷径 |
| **P2** | 接口隔离 | 层间通过 `domain/ports` 通信,不引用实现类 |
| **P3** | 数据驱动 | UI 是数据的投影,不持有业务状态 |
| **P4** | 声明式扩展 | 新增事件/操作通过声明表或注册,不修改 switch/if |
| **P5** | 资源必回收 | Timer → `TimerManager`,Event → `EventCleanup`,无例外 |

### 1.2 设计决策记录

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 组件通信 | Props 回调 / EventBus / 状态管理 | **EventBus(实例级)** | 多对多通信,避免 prop drilling,实例级避免全局污染 |
| 操作封装 | 方法内联 / Command 模式 | **Command 模式** | 统一错误处理,可测试,符合 OCP |
| 引擎事件处理 | switch/case / 声明表 | **声明表** | 新增事件只改数据,不改逻辑 |
| View 交互 | 直接引用 / 接口 | **接口(ports)** | 允许替换实现,Command 可独立测试 |
| 状态持久化 | 即时保存 / 防抖 | **防抖(2s/1s)** | 避免高频写入,生成中跳过 |
| 会话控制 | 直接调 SessionManager / CommandBus | **ICommandBus(`session.*`)** | 会话事实源收敛到 `llm-session`,UI 不直接操作引擎 |
| 会话管理器 | 每实例 / 全局单例 | **宿主注入 SessionViewPort** | 每个运行时持有自己的会话管理器和提示词历史 |

---

## 2. 分层架构

### 2.1 层级定义

```
Layer 0  components/common/ 基础设施    零业务知识(物理位置)
Layer 1  domain/           契约层      纯类型 + 接口
Layer 2  services/         服务层      数据操作
Layer 3  commands/         命令层      操作编排
Layer 4  components/       组件层      UI 实现
Layer 5  shell/            壳层        组装 + 路由
```

### 2.2 依赖矩阵

被依赖方 →

| 依赖方 ↓ | components/common | domain | services | commands | components | shell |
|----------|:-:|:-:|:-:|:-:|:-:|:-:|
| **components/common** | — | ❌ | ❌ | ❌ | ❌ | ❌ |
| **domain** | ❌ | — | ❌ | ❌ | ❌ | ❌ |
| **services** | ✅ | ✅ types | — | ❌ | ❌ | ❌ |
| **commands** | ✅ | ✅ ports+types | ✅ | — | ❌ | ❌ |
| **components** | ✅ | ✅ ports+types | ❌ | ❌ | — | ❌ |
| **shell** | ✅ | ✅ | ✅ | ✅ | ✅ 构造时 | — |

关键约束:
- **commands → components**: ❌ 禁止。Command 通过 `domain/ports` 接口操作 UI
- **components → services**: ❌ 禁止。组件不直接获取数据,由 Shell 推送
- **shell → components**: ✅ 仅在构造时引用具体类,运行时通过接口

### 2.3 目录结构(以代码现状为准)

```
llm-ui/
├── index.ts                          # 公共 API(工厂函数 + 编辑器导出)
│
├── domain/                           # Layer 1 — 契约层
│   ├── types.ts                      #   SessionGroup, CollapseStateMap, NodeAction...
│   ├── events.ts                     #   EditorBusEvents, IEditorEventBus
│   └── ports/                        #   10 个接口(见 §3)
│       ├── IHistoryPresenter.ts
│       ├── IChatInputPresenter.ts
│       ├── IStatusPresenter.ts
│       ├── IBranchPresenter.ts
│       ├── INavigationPresenter.ts
│       ├── IBranchStore.ts
│       ├── IStreamableEditor.ts
│       ├── ICollapseManager.ts
│       ├── IStreamingController.ts
│       ├── IPrivilegedCommandService.ts
│       └── index.ts
│
├── services/                         # Layer 2
│   ├── SessionService.ts             #   会话生命周期(sessionId 绑定、加载、重命名、设置)
│   ├── StateService.ts               #   UI 状态持久化
│   ├── AssetService.ts               #   附件管理
│   ├── BranchStore.ts                #   分支数据源(唯一真相)
│   ├── BranchService.ts              #   分支操作(vcs.branch.*)
│   ├── NavDataBuilder.ts             #   导航面板数据构建
│   ├── FileSearchService.ts          #   @mention 文件搜索
│   └── index.ts
│
├── commands/                         # Layer 3
│   ├── Command.ts                    #   基类(错误处理/命名)
│   ├── CommandContext.ts             #   依赖接口(面向 ports + services)
│   ├── CommandRegistry.ts            #   EventBus → Command 绑定
│   ├── SendMessageCommand.ts         #   发送消息
│   ├── BranchCommands.ts             #   Create/Switch/SwitchById/Rename/Delete/ByOffset
│   ├── NodeCommands.ts               #   Regenerate/DeleteMessage/EditAndRetry/SiblingSwitch
│   ├── BatchCommands.ts              #   BatchDelete/BatchCopy
│   ├── WorkspaceCommands.ts          #   CopyAll/Print
│   └── index.ts
│
├── components/                       # Layer 4 — UI 实现
│   ├── common/                       # ⭐ Layer 0 基础设施(物理位置,依赖方向零业务)
│   │   ├── TimerManager.ts           #   定时器生命周期
│   │   ├── EventCleanup.ts           #   事件监听器生命周期
│   │   ├── DOMCache.ts               #   DOM 查询缓存(WeakRef)
│   │   ├── ScrollController.ts       #   统一滚动控制
│   │   ├── ContentResizeTracker.ts   #   高度变化监听(ResizeObserver)
│   │   ├── EventBatchProcessor.ts    #   事件合并批处理
│   │   └── index.ts
│   ├── history/                      #   对话历史 UI
│   │   ├── HistoryView.ts            #   Facade (implements IHistoryPresenter)
│   │   ├── SessionRenderer.ts        #   DOM 渲染 + MDxController 管理
│   │   ├── StreamController.ts       #   ⭐ 流式输出控制(两阶段状态机,见 §10.2)
│   │   ├── CollapseController.ts     #   折叠状态控制
│   │   ├── EditController.ts         #   编辑模式控制
│   │   ├── EventDispatcher.ts        #   点击事件委托
│   │   ├── NodeRenderer.ts           #   节点 DOM 工厂
│   ├── input/                        #   聊天输入
│   │   ├── ChatInputView.ts          #   implements IChatInputPresenter
│   │   ├── AttachmentManager.ts      #   附件管理
│   │   ├── OcrReviewPanel.ts         #   OCR 结果确认
│   │   ├── SkillInvocationParser.ts  #   Skill 调用解析
│   │   └── plugins/                  #   History/SlashCommand/Mention/TokenMeter
│   │       ├── InputPlugin.ts        #   插件接口
│   │       ├── HistoryPlugin.ts
│   │       ├── SlashCommandPlugin.ts
│   │       ├── MentionPlugin.ts
│   │       ├── TokenMeterPlugin.ts
│   │       └── PopupPanel.ts
│   ├── indicators/                   #   状态指示器
│   │   ├── StatusIndicatorView.ts    #   implements IStatusPresenter
│   │   ├── BranchIndicatorView.ts    #   implements IBranchPresenter
│   │   └── index.ts
│   ├── dag/                          #   DAG 工作台(从 Manifest/UI Contribution 构建)
│   │   ├── DagCanvas.ts              #   画布
│   │   ├── DagDraftController.ts     #   草稿控制
│   │   ├── SchemaForm.ts             #   表单
│   │   ├── FlowSettingsDialog.ts     #   Flow 设置对话框
│   │   └── TaskTranscriptDialog.ts   #   Task 记录对话框
│   ├── DagWorkbench.ts               #   implements DAG 入口(不 import DAG Runtime)
│   ├── FlowsEditor.ts                #   Flow 列表编辑器 + createFlowsEditorFactory
│   ├── FlowParameterForm.ts          #   Flow 参数表单
│   ├── FloatingNavPanel.ts           #   implements INavigationPresenter
│   ├── mdx/                          #   Markdown 编辑器封装
│   │   └── MDxController.ts          #   implements IStreamableEditor
│   ├── tty/                          #   TTY 面板(只展示运行输出)
│   │   ├── TtyController.ts
│   │   └── TtyPanel.ts
│   └── templates/                    #   HTML 模板(纯函数)
│       ├── LayoutTemplates.ts        #   工作区骨架(history/run-graph/inspector/input)
│       ├── NodeTemplates.ts
│       ├── ChatInputTemplates.ts
│       ├── ErrorTemplates.ts
│       ├── DialogTemplates.ts
│       ├── BranchIndicatorTemplates.ts
│       ├── FloatingNavPanelTemplates.ts
│       ├── IconTemplates.ts
│
├── shell/                            # Layer 5 — Composition Root
│   ├── LLMWorkspaceEditor.ts         #   implements IEditor(主组装入口)
│   ├── EditorEventBus.ts             #   implements IEditorEventBus
│   ├── SessionEventHandler.ts        #   引擎事件 → 副作用声明表
│   ├── StateManager.ts               #   防抖持久化 + UI 状态恢复
│   ├── EventBinder.ts                #   DOM 事件 + 快捷键绑定
│   ├── WorkspacePaneController.ts    #   history/run-graph/inspector 面板切换
│   ├── NavigationHelper.ts           #   导航面板(浮动导航)
│   ├── RunAttachmentController.ts    #   经 TaskControlPlane 附着并控制运行
│   ├── AgentProvider.ts              #   Agent/Connection 选项构建(buildExecutorOptions)
│   ├── SlashCommandRouter.ts         #   slash 命令路由
│   ├── directory-command.ts          #   /add-dir、/set-home 参数解析
│   └── InterruptedRunPrompt.ts       #   中断运行恢复提示
│
├── context-menu/                     #   AI 右键菜单扩展
│   └── AIContextMenu.ts
│
├── utils/                            #   工具函数(可被任意层引用)
│   ├── textUtils.ts / timeUtils.ts / debounce.ts / domEvents.ts / domInsertion.ts
│   ├── iconResolver.ts / imageDownscale.ts
│   └── errorHandler.ts / styleInjector.ts
│
└── styles/                           #   CSS(BEM 命名)
    ├── variables.css / base.css / index.css
    ├── llm-workspace.css / workspace-titlebar.css / chat-nodes.css
    ├── llm-input.css / input-plugins.css / dialogs.css
    ├── dag.css / floating-nav.css / tty-panel.css / ai-context-menu.css
```

LLM 设置类编辑器（AgentConfig / Connection / Provider / MCP / Cost / SystemPrompt / Skill 表单）不在本包，已迁至 `@itookit/llm-settings-ui`，由 `src/index.ts` 再导出。

### 2.4 基础设施层说明

`components/common/` 是基础设施层(Layer 0)的物理位置。它虽位于 `components/` 下,但依赖方向**等同 Layer 0**,禁止 import 任何业务层:

```
components/common/  →  禁止 import domain/ services/ commands/ 其他 components/ shell/
```

现有类:TimerManager、EventCleanup、DOMCache、ScrollController、ContentResizeTracker、EventBatchProcessor。

流式渲染管线为 `components/history/StreamController.ts`(两阶段状态机,见 §10.2)。

---

## 3. 接口契约

### 3.1 Port 接口规范

所有 port 接口遵循以下规则:

```
规则 1: 接口文件只包含 interface 和 type,不包含 class 或函数实现
规则 2: 接口方法的参数和返回值只使用 domain/types 中的类型或原始类型
规则 3: 接口方法不暴露 DOM 内部结构(HTMLElement 仅限必要的查询返回值)
规则 4: 每个接口必须包含 destroy() 方法
规则 5: 新增方法标记为可选(?:)以保持向后兼容
```

### 3.2 IHistoryPresenter

```typescript
interface IHistoryPresenter extends ICollapseManager, IStreamingController {
    // 渲染
    renderFull(sessions: SessionGroup[], options?: { position?: 'top' | 'bottom' }): void;
    renderWelcome(): void;
    renderError(error: Error): void;
    clearErrors(): void;

    // 消息操作
    removeMessages(ids: string[], animated: boolean): string[];

    // 滚动
    scrollToBottom(force: boolean): void;

    // 查询
    getSessionElement(sessionId: string): HTMLElement | null;
    getElement(id: string): HTMLElement | null;
    getUnfoldedNavigationTarget(direction: 'prev' | 'next'): string | null | '__end__' | '__start__';

    // 引擎事件
    processEvent(event: SessionEvent): void;

    // 生命周期
    destroy(): void;
}
```

> 拆分为 `ICollapseManager`(折叠)与 `IStreamingController`(流式)两个窄角色接口,消费者按需依赖最窄接口。

### 3.3 IChatInputPresenter

```typescript
interface IChatInputConfig {
    text: string;
    agentId: string;
    settings?: ChatInputSettings;
}

interface IChatInputPresenter {
    setLoading(loading: boolean): void;
    setConfig(config: Partial<IChatInputConfig>): void;
    getConfig(): IChatInputConfig;
    restoreInput(text: string, agentId?: string): void;
    focus(): void;
    refreshAgents(
        agents: ExecutorOption[],
        validateAgentId: (id: string, agents: ExecutorOption[]) => string
    ): boolean;
    refreshConnections(): Promise<void>;
    selectFlow(flowId: string, revision: number): void;
    updateTokenStats?(stats: TokenStats): void;
    destroy(): void;
}
```

### 3.4 IStatusPresenter

```typescript
interface IStatusPresenter {
    update(status: string): void;
    updateFromSnapshot(snapshot: any): void;
    updateBackground(payload: { running: number; queued: number }): void;
    cacheElements(): void;
    destroy(): void;
}
```

### 3.5 IBranchPresenter

```typescript
interface IBranchPresenter {
    refresh(): Promise<void>;
    flash(): void;
    destroy(): void;
}
```

### 3.6 INavigationPresenter

```typescript
interface NavPanelData {
    items: any[];
    branches: BranchItem[];
    currentSessionId?: string;
}

interface INavigationPresenter {
    readonly isVisible: boolean;
    toggle(): void;
    update(data: NavPanelData): void;
    destroy(): void;
}
```

### 3.7 IBranchStore

```typescript
interface IBranchStore {
    readonly current: BranchItem[];
    refresh(): Promise<void>;
    onChange(cb: () => void): () => void;
    destroy(): void;
}
```

### 3.8 IEditorEventBus

```typescript
interface IEditorEventBus {
    on<K extends EditorEventKey>(event: K, callback: (payload: EditorBusEvents[K]) => void): () => void;
    emit<K extends EditorEventKey>(event: K, payload: EditorBusEvents[K]): void;
    once<K extends EditorEventKey>(event: K, callback: (payload: EditorBusEvents[K]) => void): () => void;
    destroy(): void;
}
```

### 3.9 接口实现对照

| Port 接口 | 实现类 |
|---|---|
| `IHistoryPresenter` | `HistoryView`(5 个子控制器 Facade) |
| `IChatInputPresenter` | `ChatInput` |
| `IStatusPresenter` | `StatusIndicatorView` |
| `IBranchPresenter` | `BranchIndicatorView` |
| `INavigationPresenter` | `FloatingNavPanel` |
| `IBranchStore` | `BranchStore`(services 层) |
| `IStreamableEditor` | `MDxController` |
| `IEditorEventBus` | `EditorEventBus`(shell 层) |
| `IEditor`(外部 `@itookit/ui-common`) | `LLMWorkspaceEditor` + `@itookit/llm-settings-ui` 的编辑器 |

---

## 4. 接口修改规则

### 4.1 非破坏性变更(允许直接合入)

```typescript
// ✅ 新增可选方法
interface IHistoryPresenter {
    existingMethod(): void;
    newOptionalMethod?(): void;    // 不破坏现有实现
}

// ✅ 新增可选参数
interface IHistoryPresenter {
    renderFull(sessions: SessionGroup[], options?: RenderOptions): void;
}

// ✅ 新增事件类型
interface EditorBusEvents {
    // 原有事件不变...
    'new:event': { data: string };   // 新增
}
```

### 4.2 破坏性变更(需要 RFC 流程)

```typescript
// ❌ 修改已有方法签名 / 删除方法 / 缩窄返回类型 / 可选参数改为必需 / 重命名方法

// 破坏性变更的执行步骤:
// 1. 标记旧方法 @deprecated,添加新方法
// 2. 迁移所有调用方
// 3. 下一个主版本移除旧方法
```

### 4.3 接口变更检查清单

```
□ 变更属于哪种类型?(非破坏/破坏)
□ 所有实现类是否已适配?   — 搜索 `implements IXxxPresenter`
□ 所有消费方是否已适配?   — 搜索 `IXxxPresenter` 的 import,含 CommandContext
□ 新增的类型是否定义在 domain/types.ts 中?
□ 是否需要同步更新 README.md / 本文档?
```

---

## 5. 事件系统

llm-ui 有两套事件:

| 事件流 | 定义位置 | 用途 |
|---|---|---|
| **内部 EventBus**(实例级) | `domain/events.ts` `EditorBusEvents` | 组件 ↔ Command ↔ Shell 的 UI 内部通信 |
| **引擎 SessionEvent**(canonical) | `llm-session` `core/types.ts` | 会话/分支/消息事实源,经 `SessionEventHandler` 消费 |

### 5.1 内部 EventBus 事件目录

| 事件 | 发送方 | 接收方 | 用途 |
|------|--------|--------|------|
| `branch:create` | EventDispatcher, FloatingNavPanel, Shell | CreateBranchCommand | 创建分支 |
| `branch:switch` | BranchIndicatorView, FloatingNavPanel | SwitchBranchCommand | 切换分支 |
| `branch:switchById` | FloatingNavPanel | SwitchBranchByIdCommand | 按 headNodeId 切换 |
| `branch:rename` | FloatingNavPanel | RenameBranchCommand | 重命名分支 |
| `branch:delete` | FloatingNavPanel | DeleteBranchCommand | 删除分支 |
| `nav:scrollTo` | FloatingNavPanel, Shell | CommandRegistry(inline) | 滚动到指定消息 |
| `nav:toggleFold` | FloatingNavPanel | CommandRegistry(inline) | 切换单条折叠 |
| `nav:foldAll` | FloatingNavPanel | CommandRegistry(inline) | 全部折叠 |
| `nav:unfoldAll` | FloatingNavPanel | CommandRegistry(inline) | 全部展开 |
| `batch:delete` | FloatingNavPanel | BatchDeleteCommand | 批量删除 |
| `batch:copy` | FloatingNavPanel | BatchCopyCommand | 批量复制 |
| `content:copy` | CommandRegistry | CommandRegistry(inline) | 复制单条内容 |
| `state:collapseChanged` | CollapseController, Shell | Shell(StateManager) | 折叠状态持久化 |
| `state:inputChanged` | ChatInput, Shell | Shell(StateManager) | 输入状态持久化 |

### 5.2 canonical SessionEvent(引擎事实源)

由 `llm-session` 定义,经 `sessionManager.onEvent()` 到达 `SessionEventHandler.handleSessionEvent()`:

```
消息投影:      message:appended / message:updated / message:status / message:citations
结构性变更:    messages:cleared / messages:deleted / message:edited
分支切换:      sibling:switched / branch:switched
重新生成:      regenerate_started / regenerate_completed
生命周期:      finished / error
日志:          log:appended / log:ref_moved / log:ref_renamed
```

### 5.3 副作用声明表

```typescript
const EVENT_SIDE_EFFECTS: Partial<Record<string, SideEffect[]>> = {
    finished:              ['clearErrors', 'notifyChange', 'refreshNav'],
    error:                 [],
    'message:appended':    ['clearErrors', 'notifyChange', 'scrollToBottom'],
    'messages:cleared':    ['refreshNav', 'refreshBranch'],
    'messages:deleted':    ['refreshNav', 'notifyChange'],
    'message:edited':      ['refreshNav'],
    'sibling:switched':    ['refreshBranch'],
    'branch:switched':     ['refreshBranch', 'refreshNav', 'flashIndicator'],
    'log:appended':        ['refreshBranch', 'flashIndicator'],
    'log:ref_moved':       ['resetCollapse', 'refreshBranch', 'flashIndicator'],
    'log:ref_renamed':     ['refreshBranch'],
    regenerate_started:    ['clearErrors', 'flashIndicator'],
    regenerate_completed:  ['refreshBranch', 'refreshNav'],
};
```

| 副作用 | 执行内容 | 使用场景 |
|--------|---------|---------|
| `renderFull` | 重新渲染完整会话列表 | 分支切换/创建 |
| `refreshBranch` | 刷新 BranchStore | 分支结构变更 |
| `refreshNav` | 推送数据到导航面板 | 消息/分支变更 |
| `flashIndicator` | 分支指示器闪烁动画 | 分支切换/创建 |
| `scrollToBottom` | 滚动到底部 | 分支切换后定位 |
| `clearErrors` | 清除错误 banner | 新操作开始 |
| `updateStatus` | 更新状态指示器 | 会话状态变化(token 统计走 `updateStatusFromEvent`) |
| `notifyChange` | 触发外部 change 事件 | 内容变更 |
| `resetCollapse` | 重置折叠状态 | 日志引用移动 |

**新增引擎事件的步骤**

```
Step 1: 在 EVENT_SIDE_EFFECTS 表中添加一行
Step 2: 需要 HistoryView DOM 处理 → processEventImmediate 中添加 case
Step 3: 需要新副作用类型 → 在 executors 中注册执行函数
Step 4: 不可合并事件 → EventBatchProcessor immediateTypes
Step 5: 更新本文档 §5.3
```

### 5.4 RegistryEvent(全局会话事件)

经 `sessionManager.onGlobalEvent()` 到达 `handleGlobalEvent()`,按 `getCurrentSessionId()` 过滤当前会话:

```
session_registered / session_unregistered / session_status_changed / session_unread_updated
background_task_completed / execution_task_projected / session_tty_active
session_hitl_active
```

TTY/HITL 事件仅在后**台**会话(非当前)时 Toast 通知,可带 `onNavigateToSession` 跳转。

---

## 6. Command 规范

### 6.1 Command 结构

```typescript
export class MyCommand extends Command<TParams, TResult> {
    // 必须:命令名称(用于日志和错误上报)
    protected readonly name = 'My Command';

    // 可选:错误严重级别(默认 'toast')
    protected severity: ErrorSeverity = 'toast';

    // 必须:执行逻辑
    protected async execute(params: TParams): Promise<TResult> {
        // 通过 this.ctx 访问依赖
    }
}
```

### 6.2 CommandContext(依赖只通过接口)

```typescript
interface CommandContext {
    getSessions: () => SessionGroup[];     // 会话投影快照
    commands: ICommandBus;                 // 'session.*' / 'vcs.*' 会话控制命令总线
    session: ISession;                     // Channel 原语 — signal() 入向 + events() 出向
    sessionService / stateService / assetService / branchService: services;
    historyView: IHistoryPresenter;        // 不可 downcast
    chatInput: IChatInputPresenter;        // 不可 downcast
    bus: IEditorEventBus;
    errorHandler: ErrorHandler;
    getSessionId: () => string;
}
```

```
规则 1: 只通过 this.ctx 访问依赖,不自行 import 实现类
规则 2: 会话数据操作通过 ctx.commands.execute('session.*' / 'vcs.*'),不直接调 SessionManager
规则 3: ctx.historyView / ctx.chatInput 是接口,不可 downcast
规则 4: 需要新依赖时,先扩展 port 接口,再修改 CommandContext
规则 5: 不在 Command 中持有可变状态(除非是执行过程中的临时状态)
```

### 6.3 错误处理级别

| 级别 | 行为 | 使用场景 |
|------|------|---------|
| `silent` | 仅 console.warn | 状态保存、非关键查询 |
| `warn` | console.warn + 内部通知 | 设置保存、历史加载 |
| `toast` | Toast 提示用户 | 发送失败、删除失败 |

### 6.4 Command 注册方式

```
方式 1: EventBus 驱动(多触发源)→ CommandRegistry.bindCommand('event:name', new MyCommand(ctx))
方式 2: 直接调用(单一入口)→ Shell 持有实例,this.myCommand.run(params)
方式 3: 内联(< 10 行)→ CommandRegistry.bindInline('event:name', async (payload) => { ... })
```

**选择依据**:多触发源 → 方式 1;单一调用处 → 方式 2;逻辑短且无需独立测试 → 方式 3。

---

## 7. 组件开发规范

### 7.1 组件结构

```typescript
export class MyComponent implements IMyPresenter {
    // 使用 components/common/ 管理资源
    private timers = new TimerManager();
    private events = new EventCleanup();

    constructor(container: HTMLElement, options: MyOptions) {}
    // 实现接口的所有方法 + 内部 DOM 操作不暴露

    destroy(): void {
        this.timers.destroy();
        this.events.cleanup();
    }
}
```

### 7.2 组件通信规则

```
组件 ↔ Shell:      通过 port 接口(Shell 调用接口方法)
组件 → 外部:       通过 options 中的回调函数
组件 ↔ 组件:       通过 IEditorEventBus(禁止直接引用)
组件 → 子控制器:    通过构造函数注入 + 直接方法调用
```

### 7.3 HistoryView 子控制器协作规则

```
HistoryView (Facade)
├── SessionRenderer    持有 DOM 引用 + MDxController 映射
├── StreamController   流式输出(两阶段状态机,见 §10.2)
├── CollapseController 折叠状态控制
├── EditController     编辑模式控制
└── EventDispatcher    点击事件委托(路由到对应控制器)

规则:
- 子控制器之间不直接引用(通过 HistoryView 协调)
- SessionRenderer 是数据持有者,其他控制器通过它查询
- EventDispatcher 是入口,将事件路由到对应控制器
- 新增子控制器需要同时更新 EventDispatcher 的 actionMap
```

### 7.4 模板规范

```typescript
// templates/ 中的文件必须是纯函数,无副作用
export class MyTemplates {
    static renderItem(data: ItemData): string {
        return `<div class="my-item">${escapeHTML(data.text)}</div>`;
    }
}

// 安全规则:
// - 用户输入必须经过 escapeHTML()
// - CSS 类名使用 BEM 命名:block__element--modifier
// - data-action 属性用于事件委托
```

---

## 8. Services 开发规范

### 8.1 Service 结构

```typescript
export class MyService {
    constructor(
        private sessionRepository: ISessionRepository,   // 或注入 ICommandBus
        private commands: ICommandBus,
    ) {}

    async loadData(id: string): Promise<Data | null> {}
    async saveData(id: string, data: Data): Promise<void> {}
    // 3. 不持有 UI 引用
    // 4. 不 import components/ 或 shell/
    // 5. 错误向上抛出(由 Command 或 Shell 的 ErrorHandler 处理)
}
```

### 8.2 SessionService 会话绑定契约

```
sessionId → SessionService.ensureReady(sessionId, branch?)
  → engine.getManifest(sessionId)
  → commands.execute(SessionCommand.Bind, { sessionId })
  → commands.execute('vcs.branch.switch', { branchName: branch ?? 'main' })
  → 返回 sessionId,供 ChatInput 渲染前读写 settings

约束:
- sessionId 由 VFS manifest / EditorOptions.target.sessionId 决定,llm-ui 不自行编号
- ensureReady 必须在 ChatInput 渲染前完成
- loadSession(sessionId, defaultTitle) 复用 SessionCommand.Bind 并返回 SessionSnapshot
```

### 8.3 BranchStore 使用契约

```
BranchStore 是分支数据的唯一真实来源(Single Source of Truth)。

规则:
- 读取分支数据只通过 BranchStore.current / currentBranch
- 刷新只通过 BranchStore.refresh()(内部合并并发)
- 不直接调用 SessionManager.listBranches()
- UI 更新通过 BranchStore.onChange() 订阅
- 脏检查避免无变化时的无意义通知
```

---

## 9. 数据流

### 9.1 发送消息流程

```
用户输入 → ChatInput.triggerSend()
  → options.onSend(text, files, agentId, overrides)
    → Shell 路由到 SendMessageCommand.run()
      → AssetService.uploadFiles()            [如有附件]
      → ctx.commands.execute('session.send', ...)
        → llm-session / Engine 处理
          → message:appended 事件
            → SessionEventHandler.handleSessionEvent()
              → HistoryView.processEvent()     [渲染用户气泡]
              → 副作用表: clearErrors + updateStatus + scrollToBottom
          → message:updated / message:status 事件
            → StreamController.updateContent() / updateStatus()
              → MDxController.appendDelta()
              → RAF 两阶段 flush(§10.2)
          → finished 事件
            → 副作用表: refreshNav + notifyChange
            → updateStatusFromEvent() → ChatInput.updateTokenStats(tu)
```

### 9.2 分支切换流程

```
用户点击分支 → BranchIndicatorView
  → bus.emit('branch:switch', { branchName })
    → CommandRegistry → SwitchBranchCommand.run()
      → ctx.commands.execute('vcs.branch.*')
        → branch:switched 事件
          → SessionEventHandler.handleBranchEvent()
            → HistoryView.renderFull(sessions, { position })   [重渲染]
          → 副作用表: refreshBranch + refreshNav + flashIndicator
            → BranchStore.refresh() → onChange() → BranchIndicatorView.render()
```

### 9.3 状态持久化流程

```
用户操作(折叠/输入/选择 Agent)
  → Component 触发 bus.emit('state:collapseChanged') 或 bus.emit('state:inputChanged')
    → Shell 监听
      → StateManager.scheduleUIStateSave()   [防抖 2s]
      → StateManager.scheduleInputStateSave() [防抖 1s]
        → guard: sessionManager.isGenerating() ? 跳过 : 继续
          → StateService.saveUIState(sessionId, payload)

恢复流程(loadSession 时):
  Shell.loadSession()
    → StateManager.loadUIState()
    → restoreInputState(chatInput, options)
      → 优先级: initialInputState > sessionStorage > savedState > 父目录 AI 默认
```

### 9.4 导航面板数据流

```
数据流向:单向推送,面板不主动拉取

触发推送的时机:
  1. toggleNavigator() 首次打开 → pushNavDataImmediate()
  2. refreshNav 副作用 → pushNavData() [防抖 50ms]
  3. 分支切换/删除 → refreshNav 副作用

数据构建:
  Shell.buildNavData() / NavigationHelper
    → NavDataBuilder.build(sessions, collapseStates, branches, currentSessionId)
    → floatingNav.update(data)          [推送到面板]

面板内操作:
  FloatingNavPanel
    → 本地操作(选择/高亮):立即更新 DOM
    → 远程操作(删除/切换):bus.emit() → 等待事件回流 → update() 刷新
```

### 9.5 会话加载流程(loadSession)

```
loadSession(preloadedSettings)
  → sessionService.loadSession(sessionId, currentTitle)
    → commands.execute(SessionCommand.Bind, { sessionId }) → SessionSnapshot
  → snapshot.sessions.length > 0 ? historyView.renderFull : renderWelcome
  → promptInterruptedRun(snapshot)           [snapshot.interruptedAssistantId]
  → restoreInputState(chatInput, ...)
  → sessionManager.onEvent(SessionEvent)      [会话事件订阅]
  → statusIndicator.updateFromSnapshot(snapshot)
```

---

## 10. 性能约束

### 10.1 关键性能指标

| 指标 | 目标值 | 测量方法 |
|------|--------|---------|
| 流式首字渲染 | < 100ms | message:appended → 首个 DOM 更新 |
| 流式帧率 | ≥ 30fps | RAF 循环中的 flush 频率 |
| 分支切换 | < 500ms | branch:switched → renderFull 完成 |
| 消息删除(UI) | < 16ms | 乐观更新的 DOM 操作时间 |
| 状态持久化 | 不阻塞 UI | 防抖 + async,无同步写入 |

### 10.2 性能敏感区域与约束

**流式渲染管线(StreamController)**

```
StreamController 配置:
  FLUSH_INTERVAL = 80ms         — 内容 flush 最小间隔
  两阶段状态机: idle → waitScroll
    idle:        渲染(DOM write),标记下一帧滚动
    waitScroll:  滚动(DOM read + write),回到 idle

约束:
  - 不在 flush 回调中触发同步 layout(避免 forced reflow)
  - 渲染与滚动严格分帧(Phase 分离)
  - 流式期间 ContentResizeTracker 不工作(由管线接管)
  - 生成结束后折叠 thinking 面板、finalize 编辑器
```

**EventBatchProcessor 配置**

```
自适应间隔:30ms - 150ms
  > 20 事件/批 → 间隔 × 1.2(降频)
  < 5  事件/批 → 间隔 × 0.8(提频)

约束:
  - immediateTypes 中的事件绕过缓冲,但先 flush 队列保证顺序
  - chunk 合并按 messageId 分组,同一消息的多个 chunk 合并为一次渲染
  - status 合并取最后值(后覆盖前)
```

**ScrollController 配置**

```
SCROLL_THRESHOLD = 150px              — 距底部多少像素视为"在底部"
PROGRAMMATIC_SCROLL_WINDOW = 300ms    — 程序滚动标记窗口(此期间 scroll 事件不更新用户状态)
scrollLockUntil = +100ms              — 程序滚动后的用户状态判定锁

约束:
  - 流式期间用户上滚 → shouldAutoScroll=false,停止自动滚动,直到用户滚回底部
  - forceScrollToBottom() 重置 shouldAutoScroll/isUserScrolledUp
  - 程序触发的滚动不得改变 _isUserScrolledUp 状态
```

**BranchStore 并发控制**

```
约束:
  - 并发 refresh() 调用复用同一 Promise
  - 数据脏检查:isEqual 比较后才通知监听器
  - branch:switched 连续触发只产生一次请求
```

**StateManager 防抖配置**

```
UI 状态保存:2000ms 防抖
输入状态保存:1000ms 防抖
Guard: sessionManager.isGenerating() 时跳过保存

约束:
  - destroy 时同步保存一次(不等防抖)
  - isBeingDeleted 时跳过保存
  - 资源不存在(not found)错误静默处理(`StateService`)
```

### 10.3 DOM 操作约束

```
规则 1: 批量 DOM 操作使用 DocumentFragment 或 innerHTML
规则 2: 事件监听使用事件委托(EventDispatcher 的 actionMap)
规则 3: DOM 查询结果通过 DOMCache 缓存(WeakRef 自动过期)
规则 4: 动画使用 CSS class 切换,不使用 JS 动画
规则 5: 删除动画结束后再移除 DOM(animationend 监听 + 350ms 兜底)
规则 6: 模板使用 innerHTML 一次性设置,不逐个 createElement
```

### 10.4 内存管理约束

```
规则 1: MDxController 在 removeMessages 时必须调用 destroy()
规则 2: EventCleanup 在组件 destroy 时必须调用 cleanup()
规则 3: TimerManager 在组件 destroy 时必须调用 destroy()
规则 4: BranchStore.listeners 在 destroy 时必须 clear()
规则 5: document 级事件监听器必须在 destroy 中移除
规则 6: ResizeObserver 必须 disconnect()
规则 7: FloatingNavPanel 隐藏时清空 selectedIds 和解绑键盘事件
规则 8: RunAttachmentController 在 destroy 时 detach() 运行句柄
```

---

## 11. 新增功能指南

### 11.1 决策树

```
需要新功能?
│
├─ 是纯 UI 交互(不涉及数据)?
│   └─ 在 Component 内部处理,不需要穿透到 Shell
│
├─ 需要操作数据(Session/Branch/State)?
│   ├─ 操作有多个触发源? → 创建 Command + EventBus 绑定
│   └─ 只有一个触发源?   → 创建 Command + Shell 直接调用
│
├─ 需要新的引擎事件响应?
│   └─ 在 EVENT_SIDE_EFFECTS 表添加一行
│      └─ 需要新的副作用类型? → 在 executors 中注册
│
├─ 需要新的组件间通信?
│   └─ 在 domain/events.ts 添加事件类型
│      └─ 发送方 emit + 接收方注册处理
│
├─ 需要新的持久化状态?
│   └─ 扩展 domain/types.ts 的 UIState
│      └─ StateManager 中添加读写逻辑
│
└─ 需要新的外部依赖?
    └─ 确认依赖方向是否合法(参考 §2.2)
       └─ 考虑使用动态 import() 减少初始加载
```

### 11.2 检查清单

```
架构合规
  □ 新文件放在正确的层级目录
  □ import 路径不违反依赖矩阵(§2.2)
  □ 不直接引用其他层的实现类(通过接口或回调)

接口契约
  □ 如修改了 port 接口 → 非破坏性变更(§4.1)
  □ 如新增了事件类型 → 已添加到 domain/events.ts
  □ 如新增了持久化字段 → 已添加到 domain/types.ts

资源管理
  □ 新的 setTimeout/setInterval → 使用 TimerManager
  □ 新的 addEventListener → 使用 EventCleanup
  □ 新的 DOM 引用 → 在 destroy 中清理
  □ 新的异步操作 → 通过 ErrorHandler.wrap()

性能
  □ 不在 RAF 回调中触发同步 layout
  □ 高频操作有节流/防抖
  □ 大列表渲染使用批量 DOM 操作

文档
  □ 更新本文档相关章节
  □ 更新 README.md(如影响公共 API)
```

### 11.3 示例:添加"导出为 PDF"功能

```
分析:
  - 需要读取会话数据 → 涉及数据操作
  - 只有一个触发源(工具栏按钮)→ Shell 直接调用
  - 需要外部依赖(PDF 库)→ 动态 import

执行步骤:
1. commands/ExportPDFCommand.ts(通过 ctx.commands 读取会话)
2. shell/LLMWorkspaceEditor.ts — handleExportPDF() 旁添加
3. shell/EventBinder.ts — bindNavigationEvents 中添加按钮映射
4. components/templates/LayoutTemplates.ts — 添加按钮
影响范围:4 个文件,不修改任何接口
```

### 11.4 示例:添加新的引擎事件 `message_pinned`

```
1. shell/SessionEventHandler.ts — 声明表添加一行
   'message_pinned': ['refreshNav', 'notifyChange'],
2. 需要 UI 反馈 → components/history/HistoryView.ts
   case 'message_pinned': {
       const el = this.renderer.getSessionElement(event.payload.messageId);
       el?.classList.add('llm-ui-session--pinned');
       break;
   }
3. components/common/EventBatchProcessor.ts — 需要立即处理则加 immediateTypes
影响范围:1-3 个文件,不修改任何接口
```

---

## 12. 常见修改场景

| 场景 | 做法 |
|------|------|
| **修改数据格式** | `domain/types.ts` → `services/` 适配 → 完成(组件/命令通过接口隔离,无需修改) |
| **替换 UI 框架** | 实现 `domain/ports/` 接口 → `shell/` 构造时注入新实现 → 完成 |
| **添加新快捷键** | `shell/EventBinder.ts` → `bindGlobalShortcuts()` 添加映射 |
| **新增会话命令** | `llm-session` 注册 `session.*` → UI 侧通过 `ctx.commands.execute()` 调用 |
| **新增聊天输入插件** | 实现 `InputPlugin` 接口 → `ChatInput.registerPlugin()` |
| **新增技能表单编辑器** | `@itookit/llm-settings-ui` 继承 IEditor → bootstrap 注册 editorFactory |

---

## 13. 重构指南

### 13.1 安全重构操作

```
✅ 提取方法(Extract Method)— 不改变公共 API
✅ 提取类(Extract Class)— 如果原类仍然是 Facade
✅ 移动文件到正确层级 — 只改 import 路径
✅ 内联模板 → 提取到 Templates 文件
✅ 手动事件管理 → EventCleanup
✅ 裸 setTimeout → TimerManager
✅ 裸 try-catch → ErrorHandler.wrap()
```

### 13.2 危险重构操作

```
⚠️ 修改事件处理顺序(EventBatchProcessor 的 flush 时机)
⚠️ 修改 ScrollController 的阈值或判断逻辑
⚠️ 修改 StreamController 的帧率或 Phase 顺序
⚠️ 修改 destroy 顺序(可能导致空引用)
⚠️ 修改 CommandContext 的接口类型(影响所有 Command)
```

### 13.3 代码异味检测

```
异味 1: Shell 中出现 DOM 操作(querySelector, classList)
  → 应委托给 Component 的接口方法

异味 2: Command 中 import 了 components/ 下的文件
  → 应通过 CommandContext 的接口访问

异味 3: Component 中 import 了 services/ 下的文件
  → 数据应由 Shell 推送,Component 不主动拉取

异味 4: components/common/ 中 import 了 domain/ 或更上层
  → 基础设施必须零业务知识

异味 5: 一个引擎事件在 EVENT_SIDE_EFFECTS 表中找不到
  → 要么添加到表中,要么在 processEventImmediate 中处理

异味 6: 组件 destroy() 中缺少 timers.destroy() 或 events.cleanup()
  → 必须清理所有托管资源

异味 7: 在 handleBatchedEvents 或 processEventImmediate 之外处理引擎事件
  → 所有引擎事件应走统一管线
```

---

## 14. 命名与编码约定

### 14.1 命名规范

```
文件名: PascalCase(类文件)或 camelCase(工具文件)
类名:   PascalCase
接口名: I 前缀 + PascalCase
类型名: PascalCase(无前缀)

事件名: kebab-case,冒号分隔命名空间
  'branch:create', 'state:collapseChanged', 'nav:scrollTo'

CSS 类名: BEM 命名
  .llm-ui-session / .llm-ui-session__header / .llm-ui-session--assistant

data 属性: kebab-case
  data-action="collapse" / data-session-id="xxx" / data-branch-name="main"
```

### 14.2 import 排序约定

```typescript
// 1. 外部包(按字母序)
import { Toast } from '@itookit/common';
import { SessionManager } from '@itookit/llm-session';

// 2. domain 层(类型优先)
import type { CollapseStateMap, BranchItem } from '../domain/types';
import type { IEditorEventBus } from '../domain/events';

// 3. 同层或下层模块
import { TimerManager, EventCleanup } from '../components/common';

// 4. 相对路径同目录
import { SessionRenderer } from './SessionRenderer';
```

### 14.3 错误处理约定

```typescript
// ✅ 正确:通过 ErrorHandler
await this.errorHandler.wrap(
    () => this.sessionService.loadSession(sessionId, title),
    'Load session', 'warn'
);

// ✅ 正确:Command 基类自动处理(run() 捕获异常)
export class MyCommand extends Command<Params> {
    protected severity: ErrorSeverity = 'toast';
    protected async execute(params: Params) { /* 业务逻辑 */ }
}

// ❌ 错误:裸 try-catch 吞掉错误,用户无感知
// ❌ 错误:在 Component 中处理业务错误(应通过回调/事件上报)
```

---

## 15. 公共 API

### 15.1 工厂函数

```typescript
import { createLLMFactory, createAgentEditorFactory, createSkillsEditorFactory } from '@itookit/llm-ui';

// 会话工作区编辑器(vfs-ui 选中 session 目标时创建)
const llmFactory = createLLMFactory(agentService, {
    sessionRepository,                   // 必填:ISessionRepository
    ocr?: OcrControls,                   // 可选:宿主提供识别、配置与状态订阅
    commandBus?: commandBus,             // initializeConversationSystem 返回
    kernel?: kernel,                     // 可选:附加执行运行(TaskHandle)
    privilegedCommands?: privilegedCommands,
    sessionSkills?: sessionSkills,
});
const editor = await llmFactory(container, {
    title: 'New Chat',
    target: { kind: 'session', sessionId },   // 会话身份必须由 target 提供
});

// Agent 配置编辑器(entity: agent)
const agentFactory = createAgentEditorFactory(agentService);

// Skills 工作区(列表 + 表单)
const skillsFactory = createSkillsEditorFactory(agentService);
```

### 15.2 独立编辑器导出

```typescript
// 本包实现
export { DagWorkbench, FlowsEditor, createFlowsEditorFactory } from '@itookit/llm-ui';
export { createAIContextMenuConfig } from '@itookit/llm-ui';   // AI 右键菜单
export { VFSAgentService } from '@itookit/llm-ui';
export type { LLMEditorOptions, DagWorkbenchOptions, FlowsEditorDeps } from '@itookit/llm-ui';
export type { IPrivilegedCommandService } from '@itookit/llm-ui';

// 自 @itookit/llm-settings-ui 再导出
export {
    ConnectionSettingsEditor, ProviderSettingsEditor, MCPSettingsEditor,
    SkillSettingsEditor, CostEditor, SystemPromptSettingsEditor,
    AgentConfigEditor,
} from '@itookit/llm-ui';
```

### 15.3 IEditor 契约实现

`LLMWorkspaceEditor` implements `IEditor`(来自 `@itookit/ui-common`)。关键方法:

```
init / destroy / waitUntilReady / getText / setText / setTextAsync
isDirty / setDirty / focus / setTitle / setReadOnly / getMode
on(event, cb) / updateNodeId / markAsDeleted
collapseBlocks / expandBlocks / toggleBlocks
getSearchableText / getSummary / pruneAssets
injectIntoRunningKernel(message)          — 运行中注入用户消息
```

---

## 16. 生命周期管理

### 16.1 初始化顺序(严格,以代码为准)

```
Phase 1: 静态结构
  1. initLayout()            渲染工作区骨架(history/run-graph/inspector/input)

Phase 2: 基础设施
  2. initInfrastructure()    DOMCache / EditorEventBus / ErrorHandler / commandBus(no-op 兜底)

Phase 3: 数据层
  3. initServices()          Session / State / Asset / StateManager / BranchStore / BranchService / NavDataBuilder / FileSearch / Ocr
  4. ensureReady(sessionId)  ⭐ 绑定会话(必须在 ChatInput 渲染前)

Phase 4: UI 层
  5. initComponents()        WorkspacePaneController / DagWorkbench / HistoryView / NavigationHelper / BranchIndicator / StatusIndicator / ChatInput / plugins

Phase 5: 操作层
  6. initCommands()          CommandRegistry + 命令实例 + state 事件监听
  7. initEventHandler()      SessionEventHandler + RunAttachmentController

Phase 6: 激活
  8. bindEvents()            EventBinder + 全局/AgentService 事件订阅
  9. loadSession()           数据加载 + UI 恢复 + 会话事件订阅
  10. statusIndicator.cacheElements() + branchIndicator.refresh()

约束:
- Phase N 只能依赖 Phase 1..N-1 已初始化组件
- initCommands 在 initComponents 之后(CommandContext 需要 View 引用)
- bindEvents 在 initCommands 之后(快捷键触发 Command)
- loadSession 在 bindEvents 之后(需要引擎事件订阅)
```

### 16.2 销毁顺序(严格逆序)

```
Phase 1: 持久化(先于组件销毁)
  1. StateManager.cleanup()         取消防抖定时器
  2. StateManager.saveUIState()     最后一次保存(允许时)

Phase 2: 事件解绑
  3. sessionEventUnsub / globalEventUnsub / agentServiceUnsub
  4. runAttachment.detach()
  5. eventBinder.cleanup()          DOM 事件 + 快捷键
  6. commandRegistry.destroy()      EventBus 绑定

Phase 3: 浮动组件
  7. navigation.destroy()

Phase 4: 基础设施定时器
  8. timers.destroy()

Phase 5: 插件
  9. historyPlugin.deactivate() / slashPlugin.deactivate()

Phase 6: UI 组件(逆序于 initComponents)
  10. branchIndicator / statusIndicator / historyView / dagWorkbench / chatInput 的 destroy()

Phase 7: 服务
  11. branchStore / domCache / bus 的 destroy()

Phase 8: 引擎解绑
  12. commands.execute('session.unbind')

Phase 9: DOM 清理
  13. container.innerHTML = '' / editorEvents.clear() / nodeCommands.clear()

约束:
- 不在 destroy 中抛出异常(用 .catch(() => {}) 吞掉保存失败)
- 不在 destroy 中触发事件(EventBus 可能已被清理)
- 每个组件的 destroy 必须幂等
- isBeingDeleted 状态下跳过持久化保存
```

### 16.3 组件销毁检查清单

```
□ TimerManager.destroy()          — 所有定时器
□ EventCleanup.cleanup()          — 所有事件监听器
□ ResizeObserver.disconnect()     — 如果使用了
□ 子组件的 destroy()              — 递归清理
□ Map/Set.clear()                 — 释放引用
□ DOM 引用置 null                 — 帮助 GC
□ document 级事件监听移除          — 防止泄漏
□ 订阅取消(onChange 返回的 unsub)— 防止回调到已销毁对象
```

---

## 17. 测试要求

### 17.1 各层测试覆盖要求

| 层级 | 覆盖要求 | 测试类型 | 关注点 |
|------|---------|---------|--------|
| components/common | ≥ 90% | 单元测试 | 边界条件、并发、资源释放 |
| domain | 100%(纯类型) | 编译检查 | 类型正确性 |
| services | ≥ 80% | 单元 + Mock | 错误处理、边界、并发 |
| commands | ≥ 85% | 单元 + Mock 接口 | 正常流程、错误回滚、边界 |
| components | ≥ 60% | DOM 集成测试 | 渲染正确性、事件路由、销毁 |
| shell | ≥ 40% | 集成测试 | 初始化/销毁顺序、数据流 |

### 17.2 禁止的测试模式

```
❌ 测试实现细节          — expect(component['privateMethod']).toHaveBeenCalled()
❌ 依赖具体 DOM 结构      — container.querySelector('.llm-ui-node__body > div:nth-child(2)')
❌ 测试中使用真实 Timer   — await new Promise(r => setTimeout(r, 2000)); 用 jest.useFakeTimers()
❌ 跨层 Mock             — Command 测试中 Mock MDxController(跨 commands → components → mdx)
```

运行:

```bash
pnpm --filter @itookit/llm-ui typecheck
pnpm --filter @itookit/llm-ui exec vitest run
```

---

## 18. 变更日志要求

每次变更需记录以下信息:

```markdown
## [日期] 变更标题

### 类型
- [ ] 新功能 / Bug 修复 / 重构 / 性能优化 / 接口变更

### 影响层级
- [ ] components/common / domain / services / commands / components / shell

### 接口变更
- 无 / 非破坏性 / 破坏性(需说明迁移方式)

### 检查清单
- [ ] 依赖方向合规
- [ ] 资源回收完整
- [ ] 文档已更新
- [ ] 测试已通过
```

---

## 附录 A: 术语表

| 术语 | 定义 |
|------|------|
| **Shell** | Composition Root,负责组装依赖和路由事件 |
| **Port** | domain/ports 中的接口,定义组件的能力契约 |
| **Command** | 封装单个操作的类,自带错误处理 |
| **Presenter** | Port 接口的 UI 实现(HistoryView implements IHistoryPresenter) |
| **Facade** | 对外暴露简化 API 的类(HistoryView 是 5 个子控制器的 Facade) |
| **Side Effect** | 引擎事件触发的响应动作(renderFull, refreshBranch 等) |
| **canonical 事件** | `llm-session` 定义的会话事实源事件(`message:appended` 等) |
| **Optimistic Update** | 先更新 UI 再等服务端确认,失败时回滚 |
| **Guard** | 防抖函数的前置条件检查(如 isGenerating) |

## 附录 B: 快速参考

```
添加新 Command        → commands/ 新建类 + CommandRegistry 或 Shell 注册
添加新引擎事件响应    → EVENT_SIDE_EFFECTS 表添加一行
添加新 EventBus 事件  → domain/events.ts + 发送方 emit + 接收方 on
添加新组件能力        → domain/ports/ 扩展接口(可选方法)+ 实现
添加新持久化字段      → domain/types.ts UIState + StateManager 读写
添加新工具栏按钮      → templates/ + EventBinder + Shell 路由
添加新快捷键          → EventBinder.bindGlobalShortcuts()
添加新会话命令        → llm-session 注册 session.* + UI 侧 ctx.commands.execute()
添加新输入插件        → InputPlugin 接口 + ChatInput.registerPlugin()
```
