# @itookit/durable-kernel — API 参考

> 持久化执行内核：`DurableTaskProgram`（init/reduce 状态机）+ `EffectAdapter`（副作用）+ Task/Resource/Budget/Interaction 的调度与恢复。所有 API 从 `@itookit/durable-kernel` 根导出。

独立包使用者请先读随包提供的[接口参考](../libraries/durable-kernel/docs/api.md)和[事件契约](../libraries/durable-kernel/docs/events.md)。本文保留根入口及宿主集成扩展；[接口审查](./design/durable-kernel-interface-review.md)区分当前行为与建议修订。

## 目录

- [入口：Kernel](#入口kernel)
- [句柄：SessionHandle / TaskHandle](#句柄)
- [程序模型：DurableTaskProgram / Decision / KernelAction / WaitSpec](#程序模型)
- [Effect 模型：EffectAdapter / EffectExecutionContext](#effect-模型)
- [资源 / 权限 / 预算](#资源权限预算)
- [会话数据：SharedState / Context / 跨会话消息](#会话数据)
- [事件与信号](#事件与信号)
- [工具函数](#工具函数)
- [错误模型](#错误模型)
- [存储：SeqFileKernelStore](#存储)
- [源码结构：文件与路径](#源码结构文件与路径)

---

## 入口：Kernel

执行内核主类，通过 `new Kernel(options)` 创建，`await kernel.initialize()` 后可用。

```ts
class Kernel implements KernelRegistration {
    constructor(options: KernelOptions);
    initialize(): Promise<void>;
    dispose(): void;
    shutdown(options?: ShutdownOptions): Promise<ShutdownReport>;
    drain(options?: ShutdownOptions): Promise<WorkerDrainReport>;
    readonly archives: SessionArchiveApi;
    recoveryIssues(sessionId: string, taskId?: string): Promise<RecoveryIssue[]>;
    /** 等待所有 in-flight drain/execute 完成（dispose 后调用），默认超时 5000ms，超时抛 IDLE_TIMEOUT */
    waitIdle(timeoutMs?: number): Promise<void>;
    get isDisposed(): boolean;

    // 注册（装配期调用）
    registerProgram(program: DurableTaskProgram): void;
    registerEffect(adapter: EffectAdapter): void;
    registerStorageResolver(resolver: SessionStorageResolver): void;
    registerWorkspace(adapter: WorkspaceAdapter): void;
    /** 注册托管资源适配器，并唤醒 kernel/各 session 的资源扫描 */
    registerResourceAdapter(adapter: ManagedResourceAdapter): void;
    use(plugin: KernelPlugin): Promise<void>;

    // 注册表与资源面（只读属性）
    readonly programs: ProgramRegistry;
    readonly effects: EffectRegistry;
    readonly storageResolvers: StorageResolverRegistry;
    readonly workspaces: WorkspaceRegistry;
    get resources(): ResourceApi;                            // kernel 作用域
    // ResourceApi.claimAuthority(authorityId, {ownerId, expectedEpoch, binding, serviceEndpoint, scope}) 接管/声明 authority
    // ResourceApi.authority(authorityId, scope?) 只读；写命令可选带 authority: {authorityId, epoch} 由权威事务校验
    resourceApi(sessionId: string, taskId?: string): ResourceApi;   // 指定作用域

    // 会话
    createSession(spec: { id?: string; storage: StorageBindingRef }): Promise<SessionHandle>;
    openSession(id: SessionId, expectedStorage?: StorageBindingRef): Promise<SessionHandle>;
    reopenSession(id: SessionId): Promise<SessionHandle>;
    listSessions(): AsyncIterable<SessionRecord>;
    sessionStat(sessionId: string): Promise<SessionStat>;
    setSessionStatus(sessionId: string, status: SessionRecord['status']): Promise<void>;
    closeSession(sessionId: string, cancelRunning: boolean): Promise<void>;
    /** 删除会话的 Kernel 存储 + catalog 记录；有运行中 Task/待清理资源时拒绝 */
    removeSession(id: SessionId, options?: { force?: boolean }): Promise<boolean>;

    // 任务（全局 / 按会话）
    openTask<O>(id: TaskId): Promise<TaskHandle<O>>;
    inspectTask(id: TaskId): Promise<TaskEventSnapshot>; // Cold read: task + asOfSequence
    inspectSession(id: SessionId): Promise<SessionReader>;
    attachTask<O>(sessionId: SessionId, taskId: TaskId): Promise<TaskHandle<O>>;
    listSessionTasks(sessionId: SessionId): Promise<TaskRecord[]>;
    listSessionPendingInteractionTasks(sessionId: SessionId): Promise<TaskRecord[]>;
    listSessionTaskPage(sessionId: SessionId, query?: TaskListQuery): Promise<TaskListPage>;
    submit<I, O>(sessionId: string, spec: TaskSpec<I>): Promise<TaskHandle<O>>;
    retryTask<O>(sessionId: string, taskId: string, options: { requestId: string }): Promise<TaskHandle<O>>;
    task(sessionId: string, taskId: string): Promise<TaskRecord>;
    taskHistory(sessionId: string, taskId: string, afterVersion?: number): Promise<TaskRecord[]>;
    taskHistoryPage(sessionId: string, taskId: string, query?: TaskHistoryQuery): Promise<TaskHistoryPage>;
    taskAttempts(sessionId: string, taskId: string): Promise<TaskAttempt[]>;
    signal(sessionId: string, taskId: string, signal: TaskSignal, options?: SignalOptions): Promise<SignalReceipt>;
    controlTask(sessionId: string, taskId: string, mode: TaskControl['mode'],
        options: TaskControlOptions & { signal?: TaskSignal }): Promise<TaskControl>;
    startTask(sessionId: string, taskId: string, options?: TaskStartOptions): Promise<void>;
    respondInteraction<T>(sessionId: string, taskId: string, response: InteractionResponse<T>): Promise<void>;
    cancel(sessionId: string, taskId: string, reason?: string, options?: TaskCancellationOptions): Promise<void>;
    readTaskCancellationReceipt(sessionId: string, taskId: string, requestId: string): Promise<TaskCancellationReceipt | undefined>;
    resolveEffect(sessionId: string, taskId: string, request: EffectResolution): Promise<void>;
    sendTaskMessage(sessionId: string, taskId: string, request: TaskMessageRequest): Promise<CrossSessionMessage>;

    // 事件
    eventList(sessionId: string, after: number): Promise<EventEnvelope[]>; // Legacy unbounded API
    readEvents(sessionId: string, query?: EventQuery, taskId?: string): Promise<EventPage>;
    taskSnapshot(sessionId: string, taskId: string): Promise<TaskEventSnapshot>;
    sessionSnapshot(sessionId: string): Promise<SessionEventSnapshot>;
    taskEventPage(sessionId: string, taskId: string, query?: TaskEventQuery): Promise<TaskEventPage>;
    onChanged(listener: (e: { sessionId: string; taskId?: string; reason: KernelChangeReason }) => void): () => void;

    // 共享状态
    getShared<T>(sessionId, key): Promise<SharedStateEntry<T> | undefined>;
    setShared<T>(sessionId, key, value, options?): Promise<SharedStateEntry<T>>;
    deleteShared(sessionId, key, options?): Promise<boolean>;
    listShared(sessionId, prefix?): Promise<SharedStateEntry[]>;
    sharedHistory<T>(sessionId, key): Promise<SharedStateRevision<T>[]>;

    // 跨会话消息
    sendCrossSession<T>(sourceSessionId, targetSessionId, topic, payload, options?: SessionSendOptions): Promise<CrossSessionMessage<T>>;
    outbox(sessionId: string): Promise<CrossSessionMessage[]>;
    inbox(sessionId: string, after?: number): Promise<CrossSessionMessage[]>;
    relayPendingMessages(): Promise<number>;
    /** 保留期/GC：只删除已终结的出箱记录与已被消费（或被拒绝）的收件回执。 */
    pruneSessionMessages(sessionId: string, before: number, limit?: number): Promise<{ outbox: number; inbox: number }>;

    /** Task 版本历史保留期/GC：只裁剪 `snapshot/<version>`，主记录与 attempts/effects/receipts 不动。 */
    compactTaskHistory(sessionId: string, taskId: string, options?: { keepVersions?: number; beforeVersion?: number }): Promise<{ removed: number; keptFrom: number }>;

    /** Task 事件日志保留期/GC：保留最新 `keepEvents` 条索引事件，写 `task-event-first` 水位。 */
    pruneTaskEvents(sessionId: string, taskId: string, options?: { keepEvents?: number }): Promise<{ removed: number; firstAvailableIndex: number }>;

    // Session 布局：会话记录携带 layout manifest（版本/记录 schema/必需能力/迁移状态）；
    // 更高版本、pending 迁移或未知必需能力的 Session 在 open 与事务操作前被拒绝。

    // Context
    commitContext<T>(sessionId, delta, options?): Promise<ContextCommit<T>>;
    getContextCommit<T>(sessionId, id): Promise<ContextCommit<T> | undefined>;
    getContextBranch(sessionId, name?): Promise<ContextBranch>;
    contextHistory(sessionId, head?): Promise<ContextCommit[]>;

    // 资源 / 权限
    createResource(sessionId, spec: ResourceSpec): Promise<ResourceGrant>;
    grantResource(sessionId, parentHandleId, holderTaskId, rights): Promise<ResourceHandle>;
    revokeResource(sessionId, handleId): Promise<number>;
    authorizeResource(sessionId, handleId, right, holderTaskId?): Promise<ResourceRecord>;

    // 预算
    setBudget(sessionId, handleId, dimension, hardLimit, expectedVersion?): Promise<BudgetAccount>;
    chargeBudget(sessionId, handleId, dimension, amount, options?: { usageId?: string }): Promise<BudgetAccount[]>;   // usageId 幂等结算（回执落 usage/<usageId>）

    // 工作区
    snapshotWorkspace(sessionId, handleId, adapterRef: ProgramRef): Promise<WorkspaceSnapshot>;
    diffWorkspace(sessionId, handleId, baseId, targetId): Promise<WorkspaceDiff>;
    mergeWorkspace(sessionId, handleId, baseId, leftId, rightId): Promise<WorkspaceMergeResult>;

    // Cache（namespace/entry 落在 resources.seq，operation 收据落在 task.seq）
    createCache(sessionId, taskId, spec: CacheSpec): Promise<{ namespace: CacheNamespace; handle: ResourceHandle }>;
    readCache(sessionId, taskId, request: CacheRead): Promise<CacheReceipt>;
    publishCache(sessionId, taskId, request: CachePublish): Promise<CacheEntry>;
    invalidateCache(sessionId, taskId, handleId, expectedGeneration): Promise<CacheNamespace>;
    renewCache(sessionId, taskId, handleId, expectedGeneration, ttlMs): Promise<CacheNamespace>;
    listCaches(sessionId, taskId): Promise<Array<{ namespace: CacheNamespace; handleId: string }>>;

    // 恢复
    recover(options?: RecoveryOptions): Promise<RecoveryReport>;
    recoverSession(sessionId: SessionId, options?: RecoveryOptions): Promise<RecoveryReport>;
}
```

**`KernelOptions`**：`catalog`（目录 fs，`rootPath` 默认 `/.config/kernel`）、`maxConcurrent` / `maxConcurrentEffects`（Reducer / Effect 工作并发上限，均默认 4；显式只读观察可暂时让出 Effect 工作额度）、`leaseMs`（租约时长，默认 30s）、`effectCleanupTimeoutMs`（Effect 清理等待上限，默认 30s，整数范围 1–2147483647ms）、`pollMs`（兼容轮询间隔，默认 0）、`rescanMs`（安全补扫默认 1000ms，批量读取水位而非空闲全扫 Task；关闭时必须提供 wakeSource）、`workerId`（可选）、`onDiagnostic`（非敏感操作/阶段/分类/耗时观察回调）。并发上限属于单个 Kernel 实例。

**`KernelChangeReason = 'structure' | 'content'`**：`onChanged` 通知的成因。`structure` 表示 Task/Session 被创建、删除或状态变化（列表视图需重读）；`content` 表示 Task 内容推进（流式增量、日志、共享状态、context 提交）而列表成员未变，每秒可能触发多次，消费者不应据此重渲染。

**`bindCapabilities(task, bindings, onHandle?)`**：为 Task 创建类型化资源句柄（llm/tool/...），逐项回调 `onHandle`（用于 setBudget），发 `capabilities` signal 后 `start()`。这是上层能力绑定的统一入口。


### 受管跨 Session Task 调用

Kernel 内置 `kernel.call@1/@2` Program 与 `task.call@1` Effect，宿主通过 `bindTaskCall(TaskRef, TaskCallPlan)` 为确切计划授予执行能力并启动 deferred 调用者，根入口与 `/core` 均可使用。计划包含已准备的目标 Session、TaskSpec、能力绑定、正整数 maxDepth 和可选 timeoutMs；目标 Task ID、请求身份和 ownedBy 由 Kernel 生成。结构化成功结果为 `TaskCallResult {task: TaskRef, exit: ExitRecord}`；子任务失败或取消传播为调用者失败，保留子任务真实终态。

原 Effect.request 保持调用意图，source shared 保存目标实例与归属，目标以稳定身份先 deferred 再启动。取消可以先创建并取消同一目标，迟到创建只能得到原 Task；恢复核对原目标，不创建新业务调用。完成与清理确认同时检查本地后代和原 Resource claim，Task exit 不会自动释放物理容量。跨 Session 的嵌套调用按实际根 Task 继承最紧深度上限，只读等待使用原工作额度机制。

`KernelOptions.authorizeTaskCall(plan, ownerRef, phase)` 可对 execute/cleanup 注入宿主授权与单写者检查；Kernel 不解析 Agent/Flow 定义、业务 Session 历史或上下文。当前暂停是调用边界语义，跨调用 token/费用预留和结算、业务工作区资源映射仍需接入。源绑定、目标请求和停止记录须保留至旧操作不能再次启动；目标 Session 的 instanceId 防止旧调用进入同 ID 的替代存储实例。完整示例、错误与诊断见[独立库接口](../libraries/durable-kernel/docs/api.md#受管-task-函数调用)，机制与应用边界见[合入计划第 84 节](design/functional-merge-plan.md#84-kernel-受管-task-调用贯通)。

`snapshotTaskCallPlan` 提供接纳前的调用信封/持久 JSON 校验和独立快照，不创建任务或授予能力。指纹规范化与执行数据分开：目标提交保留原输入表示，不递归排序消息对象，以免破坏原生上下文摘要。SDK 恢复读取原冻结计划；重新装配输入属于新调用或显式冲突处理。

完整应用通过 app-core 的 `createSessionTaskCallAuthority` 注入双侧应用写权检查；`createKernelRuntime` 的同名选项原样透传到 Kernel。execute 检查已持有租约及删除/移动状态，cleanup 续验原租约但不按新调用可用性拒绝清理；失权不自动接管，保留原清理责任。`renewSessionWriteLease` 位于 app-core/kernel/session-lease，供 Task 调用与 Harness 清理复用；这是应用宿主策略，独立 Kernel 不依赖该租约格式。该检查不提供跨 Session 原子事务或远端执行围栏，接线与验收边界见[合入计划第 85 节](design/functional-merge-plan.md#85-宿主接通受管调用的双侧写权检查)。

---

## 句柄

### SessionHandle（组合 9 个窄接口）

```ts
interface SessionHandle extends
    SessionTaskApi, SessionSharedStateApi, SessionTaskBoardApi,
    SessionMessageApi, SessionContextApi, SessionResourceApi,
    SessionBudgetApi, SessionWorkspaceApi, SessionLifecycleApi {
    readonly id: SessionId;
    readonly resources: ResourceApi;                     // 会话作用域托管资源面
    recover(options?: RecoveryOptions): Promise<RecoveryReport>;
    spawn<I, O>(spec: TaskSpec<I>): Promise<TaskHandle<O>>;   // submit() 的别名
    stat(): Promise<SessionStat>;
    watch(options?: WatchOptions): AsyncIterable<EventEnvelope>;   // events() 的别名
}
```

**`SessionTaskApi`** — 任务生命周期

| 方法 | 说明 |
|---|---|
| `submit<I,O>(spec: TaskSpec<I>): Promise<TaskHandle<O>>` | 提交任务 |
| `attachTask<O>(taskId): Promise<TaskHandle<O>>` | 重启/重连后挂载已有 Task |
| `listTasks(): Promise<TaskRecord[]>` | 读取完整 Task 树（含终态） |
| `signal(taskId, signal, options?): Promise<SignalReceipt>` | 发信号 |
| `respond<T>(taskId, response): Promise<void>` | 回应交互（HITL） |
| `events(options?): AsyncIterable<EventEnvelope>` | 按序消费会话事件 |

**`SessionSharedStateApi`** — 会话内共享状态（key-value + 版本 CAS）

| 方法 | 说明 |
|---|---|
| `getShared<T>(key)` | 读共享状态 |
| `setShared<T>(key, value, options?)` | 写共享状态（可带 expectedVersion） |
| `deleteShared(key, options?)` | 删除 |
| `listShared(prefix?)` | 列出 |
| `sharedHistory<T>(key)` | 版本历史 |

**`SessionTaskBoardApi`** — 持久化协调板（多 Agent 抢占 + CAS）

| 方法 | 说明 |
|---|---|
| `listTaskBoard(): Promise<TaskBoardItem[]>` | 读取全部看板项（按 createdAt 排序） |
| `createTaskBoardItem(input): Promise<TaskBoardItem>` | 创建看板项（`title`/`description`/`dependencies`/可选 `id`） |
| `claimTaskBoardItem(id, assigneeTaskId, options?)` | 抢占（`leaseMs` 默认 300000，过期可重抢，依赖未完成则拒绝） |
| `renewTaskBoardLease(id, assigneeTaskId, leaseToken, leaseMs?)` | 续租 |
| `completeTaskBoardItem(id, leaseToken, result?, failed?)` | 完成/失败 |

`TaskBoardItem`：`{ id; title; description?; status: 'open'|'claimed'|'completed'|'failed'; dependencies?: string[]; assigneeTaskId?; leaseUntil?; leaseToken?; result?; createdAt; updatedAt }`。

**`SessionMessageApi`** — 跨会话消息（outbox/inbox）

| 方法 | 说明 |
|---|---|
| `send(request)` | 强制稳定幂等键；可指定目标 Task，省略时投递 Session 邮箱 |
| `sendToSession<T>(targetSessionId, topic, payload, options?)` | 兼容发送；可带 `idempotencyKey`、`targetTaskId`、`correlationId`、`expiresAt` |
| `inbox(options?)` | after 为接收方 deliverySequence，不是发送时间 |
| `inboxPage(query?)` | 接收序号分页，可固定 throughSequence |
| `acknowledgeMessage(id, options?)` | 幂等确认宿主拥有的 Session 消息；Task 输入仅随 Decision 消费 |
| `outbox(): Promise<CrossSessionMessage[]>` | 读取本会话发件箱 |

**`SessionContextApi`** — Context 分支/提交

| 方法 | 说明 |
|---|---|
| `commitContext<T>(delta, options?)` | 提交一次 context 变更（CAS） |
| `getContextCommit<T>(id)` | 读某次提交 |
| `getContextBranch(name?)` | 读分支头 |
| `contextHistory(head?)` | 遍历提交历史 |

**`SessionResourceApi`** — 资源/权限

| 方法 | 说明 |
|---|---|
| `createResource(spec)` | 创建资源 + 句柄 |
| `grantResource(parentHandleId, holderTaskId, rights)` | 派生子句柄 |
| `revokeResource(handleId)` | 撤销 |
| `authorizeResource(handleId, right, holderTaskId?)` | 校验权限 |

**`SessionBudgetApi`** — 预算

| 方法 | 说明 |
|---|---|
| `setBudget(handleId, dimension, hardLimit, expectedVersion?)` | 设置硬上限 |
| `chargeBudget(handleId, dimension, amount, options?)` | 扣减（超限抛错）；`options.usageId` 时按幂等结算回执去重 |

**`SessionWorkspaceApi`** — 工作区快照/合并

| 方法 | 说明 |
|---|---|
| `snapshotWorkspace(handleId, adapter)` | 快照 |
| `diffWorkspace(handleId, baseId, targetId)` | diff |
| `mergeWorkspace(handleId, baseId, leftId, rightId)` | 三方合并 |

**`SessionLifecycleApi`** — `suspend()` / `resume()` / `close(options?)`

### TaskHandle<O>

```ts
interface TaskHandle<O = unknown> {
    readonly id: TaskId;
    readonly resources: ResourceApi;                       // Task 作用域托管资源面
    readonly cache: CacheApi;                              // 缓存面（create/list/read/publish/invalidate/renew）
    send(request: TaskMessageRequest): Promise<CrossSessionMessage>;
    stat(): Promise<TaskStat>;
    stats(): Promise<TaskStats>;
    watch(options?: WatchOptions): AsyncIterable<EventEnvelope>;   // events() 的别名
    status(): Promise<TaskSnapshot>;
    wait(options?: TaskWaitOptions): Promise<ExitRecord<O>>;
    waitStopped(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TaskStat>;
    readEvents(query?: EventQuery): Promise<EventPage>;
    snapshot(): Promise<TaskEventSnapshot>;   // 阻塞等待终态
    poll(): Promise<ExitRecord<O> | undefined>;                        // 非阻塞
    signal(signal: TaskSignal, options?: SignalOptions): Promise<SignalReceipt>;
    start(options?: TaskStartOptions): Promise<void>;
    pause(options: TaskControlOptions): Promise<TaskControl>;
    interrupt(options: TaskControlOptions): Promise<TaskControl>;
    resume(options: TaskControlOptions & { signal?: TaskSignal }): Promise<TaskControl>;
    withdrawPause(options: TaskPauseWithdrawalOptions): Promise<TaskControl>;
    respond<T>(response: InteractionResponse<T>): Promise<void>;
    createResource(spec: TaskResourceSpec): Promise<ResourceGrant>;
    cancel(reason?: string, options?: TaskCancellationOptions): Promise<void>;
    events(options?: WatchOptions): AsyncIterable<EventEnvelope>;
    history(options?: { afterVersion?: number }): Promise<TaskRecord[]>;
    attempts(): Promise<TaskAttempt[]>;
    /** 幂等创建延迟启动的新 root Task；资源需重新授权 */
    retry(options: { requestId: string }): Promise<TaskHandle<O>>;
    resolveEffect(request: EffectResolution): Promise<void>;
    sendMessage(request: TaskMessageRequest): Promise<CrossSessionMessage>;
    createCache(spec: CacheSpec): Promise<{ namespace: CacheNamespace; handle: ResourceHandle }>;
    listCaches(): Promise<Array<{ namespace: CacheNamespace; handleId: string }>>;
    readCache(request: CacheRead): Promise<CacheReceipt>;
    publishCache(request: CachePublish): Promise<CacheEntry>;
    invalidateCache(handleId: string, expectedGeneration: number): Promise<CacheNamespace>;
    renewCache(handleId: string, expectedGeneration: number, ttlMs: number): Promise<CacheNamespace>;
}
```

---

## 程序模型

### DurableTaskProgram<S, I, O>

持久化状态机 —— 这是 Program 的核心契约。State 必须 JSON 可序列化，跨 `reduce` 持久化。

```ts
interface DurableTaskProgram<S = unknown, I = unknown, O = unknown> {
    readonly manifest: TaskProgramManifest;                              // { kind, version }
    init(input: I): Decision<S, O> | Promise<Decision<S, O>>;            // 首次
    reduce(state: Readonly<S>, event: TaskInputEvent): Decision<S, O> | Promise<Decision<S, O>>;  // 逐事件
}
```

### Decision<S, O>

每次 `init`/`reduce` 的返回：新状态 + 声明副作用 + 下一步。

```ts
interface Decision<S, O> {
    state: S;
    actions?: KernelAction[];
    next:
        | { type: 'continue' }
        | { type: 'wait'; on: WaitSpec }
        | { type: 'complete'; output: O }
        | { type: 'fail'; error: SerializableError; retryable?: boolean };
}
```

### KernelAction

程序声明的副作用（由内核执行）：

```ts
type KernelAction =
    | { type: 'resource'; command: ResourceCommand }
    | CacheManagementAction                     // cache-create / cache-invalidate / cache-renew
    | { type: 'send-message'; message: TaskMessageRequest }
    | { type: 'cache-read'; request: CacheRead }
    | { type: 'cache-publish'; request: CachePublish }
    | { type: 'effect'; effect: EffectRequest }
    | { type: 'spawn'; spawnKey: string; spec: TaskSpec }
    | { type: 'request-interaction'; interaction: InteractionRequest<JsonValue> }
    | { type: 'set-shared'; key: string; value: JsonValue; expectedVersion?: number | null }
    | { type: 'delete-shared'; key: string; expectedVersion?: number | null }
    | { type: 'emit'; eventType: string; payload?: unknown };
```

`CacheManagementAction`（`domain/cache.ts`）：`{ type: 'cache-create'; operationId; spec }` / `{ type: 'cache-invalidate'; operationId; handleId; expectedGeneration }` / `{ type: 'cache-renew'; operationId; handleId; expectedGeneration; ttlMs }`。

### WaitSpec

等待条件（原子 + 组合）：

```ts
type WaitAtom =
    | { type: 'resource'; scope: string; requestId: string }
    | { type: 'message'; topic?: string; correlationId?: string }
    | { type: 'cache'; operationId: string }
    | { type: 'cache-management'; operationId: string }
    | { type: 'signal'; id?: string }
    | { type: 'effect'; id?: string }
    | { type: 'task'; id: TaskId }
    | { type: 'child'; spawnKey: string }
    | { type: 'interaction'; id: string }
    | { type: 'shared-version'; key: string; afterVersion: number }
    | { type: 'timer'; id: string; at: number };

type WaitSpec = WaitAtom
    | { type: 'any'; waits: WaitSpec[] }
    | { type: 'all'; waits: WaitSpec[] }
    | { type: 'quorum'; waits: WaitSpec[]; required: number };
```

### TaskInputEvent

程序收到的输入事件：

```ts
type TaskInputEvent =
    | { type: 'resource-result'; receipt: ResourceRequestSnapshot }
    | { type: 'started' }
    | { type: 'step' }
    | { type: 'message'; message: CrossSessionMessage }
    | { type: 'cache-result'; receipt: CacheReceipt }
    | { type: 'cache-managed'; receipt: CacheManagementReceipt }
    | { type: 'shared-changed'; revision: SharedStateRevision }
    | { type: 'timer-fired'; id: string; at: number }
    | { type: 'effect-completed'; effectId: EffectId; result: unknown }
    | { type: 'effect-failed'; effectId: EffectId; error: SerializableError }
    | { type: 'task-exited'; taskId: TaskId; exit: ExitRecord }
    | { type: 'interaction-resolved'; interactionId: string; value: JsonValue }
    | { type: 'signal'; sequence: number; signal: TaskSignal };
```

### TaskSpec<I>

提交任务的规格：

```ts
interface TaskSpec<I = unknown> {
    retryOfTaskId?: TaskId;               // 人工重试来源（必须已终态）
    requestId?: string;                   // 会话内持久化提交键，复用时规格必须一致
    program: ProgramRef;                  // { kind, version }
    input: I;
    parent?: TaskId;
    spawnKey?: string;
    dependsOn?: TaskDependency[];
    retry?: RetryPolicy;
    priority?: number;
    labels?: Record<string, string>;
    deferStart?: boolean;                 // 持久化但不调度，直到 TaskHandle.start()
}
```

---

## Effect 模型

### EffectAdapter<Req, Res>

副作用执行器（能力面）：

```ts
interface EffectAdapter<Req = unknown, Res = unknown> {
    readonly kind: string;
    readonly version: string;
    /** 'idempotent-retry' → Effect 失败可自动重试；默认按 'manual' 处理 */
    readonly recoveryPolicy?: 'idempotent-retry' | 'manual';
    execute(request: Req, context: EffectExecutionContext): Promise<Res>;
    reconcile?(request: Req, context: EffectExecutionContext): Promise<EffectReconcileResult<Res>>;  // worker 丢失后
    cancel?(request: Req, context: EffectExecutionContext): Promise<void>;
}
```

`EffectReconcileResult<Res>`：`{ status: 'completed'; result: Res } | { status: 'retry' } | { status: 'indeterminate'; error: SerializableError }`。

### EffectRequest<Req>

```ts
interface EffectRequest<Req = unknown> {
    id?: EffectId;
    kind: string;
    version: string;
    request: Req;
    idempotencyKey: string;               // 幂等键（崩溃后不重复执行）
    timeoutMs?: number | null;           // 缺省 30 秒；null 显式无总执行期限
    retry?: RetryPolicy;
    grants?: Array<{ handleId: HandleId; right: ResourceRight }>;
}
```

timeoutMs 缺省保持原 30_000ms；正有限数指定总期限，显式 null 不设总执行期限。无期限仍保留取消、租约、预算、工作额度及物理清理责任；wait({timeoutMs}) 只超时观察，不能替代调用期限。数字定时器按平台上限分段。实际提交 null Effect 的同一事务声明 recordSchemas.effect=2 与 effect-unbounded-deadline 能力，旧 Kernel 拒绝读取该契约，归档也须保留声明；升级前退出旧 writer。

kernel.call@1 保持旧冻结语义（缺省 30 秒或明确正数），@2 要求明确 timeoutMs 为正数或 null。SDK 仅在显式 null 时选择 @2，不改变旧请求的 Program 与去重身份。恢复将原 EffectExecutionContext.deadlineAt 传给目标 Task.start({deadlineAt})，在 created → ready 的目标事务中拒绝过期启动（TASK_START_DEADLINE_EXCEEDED）；已经接纳的原启动可继续核对。清理沿用独立超时与原目标停止确认，不能因总执行期限到期丢掉责任。

### EffectExecutionContext

```ts
interface EffectExecutionContext {
    sessionId: SessionId;
    taskId: TaskId;
    effectId: EffectId;
    idempotencyKey?: string;
    abortSignal: AbortSignal;
    deadlineAt?: number;                 // 执行/核对使用原冻结绝对期限；清理不受执行期限限制
    grants: AuthorizedEffectGrant[];
    sessionState?: EffectSessionState;
    emit?: (event: { type: string; payload?: unknown }) => Promise<void>;     // 流式事件
    chargeBudget?: (handleId, dimension, amount, options?) => Promise<BudgetAccount[]>; // 预算扣减（超限抛错；缺省按逻辑 Effect 幂等结算）
}
```

---

## 资源 / 权限 / 预算

```ts
type ResourceRight = 'read' | 'write' | 'execute' | 'grant' | 'admin';

interface ResourceRecord {           // 资源本身
    id; sessionId; kind; uri; generation;
    parentResourceId?; metadata?; createdAt;
}

interface ResourceHandle {           // 资源的某个句柄（带权限）
    id; resourceId; holderTaskId; rights: ResourceRight[];
    generation; parentHandleId?; revokedAt?;
}

interface ResourceSpec {             // 创建资源
    kind; uri; ownerTaskId; rights?: ResourceRight[];
    parentResourceId?; parentHandleId?; metadata?;
}

interface BudgetAccount {            // 预算账户
    resourceId; dimension; hardLimit; used; version; updatedAt;
}
```

---

## 会话数据

```ts
interface SharedStateEntry<T> { key; value: T; version; updatedAt; updatedByTaskId?: TaskId; }
interface SharedStateWriteOptions { taskId?; expectedVersion?: number | null; }
interface SharedStateRevision<T> { key; version; value?: T; deleted: boolean; updatedAt; updatedByTaskId?: TaskId; }

interface CrossSessionMessage<T> {
    id; sourceSessionId; sourceTaskId?; targetSessionId; targetTaskId?;
    correlationId?; requestFingerprint?; deliverySequence?; consumedAt?;
    topic; payload: T; status: 'pending' | 'delivered' | 'rejected';
    rejectedAt?; rejection?: { code: 'target-closed' | 'target-terminal' | 'target-ancestor-cancelled' | 'expired'; message };
    expiresAt?; deliveryAttempts?; nextAttemptAt?; lastDeliveryError?;
    createdAt; deliveredAt?;
}

interface ContextCommit<T> { id; sessionId; parentIds: string[]; delta: T; authorTaskId?; createdAt; }
interface ContextBranch { name; version; head?; updatedAt; }
interface ContextCommitOptions { branch?: string; expectedHead?: string | null; parents?: string[]; }
```

---

## 事件与信号

```ts
type TaskSignal = { type: string; payload?: unknown };

interface EventEnvelope {
    schemaVersion?: number;      // 当前为 1
    effectId?: EffectId;         // 由 Effect 内部 emit 的事件带来源标识
    attemptId?: string;
    sequence: number;       // 会话内单调递增
    sessionId: SessionId;
    taskId?: TaskId;
    type: string;           // e.g. 'task.created' | 'effect.resolved' | 'budget.consumed' | 'agent.event'
    payload?: unknown;
    occurredAt: number;
}

interface ExitRecord<O = unknown> { taskId; status: 'succeeded'|'failed'|'cancelled'; output?: O; error?: SerializableError; completedAt; }
```

**常用事件名**（`store.ts`/`store-helpers.ts`/`cache-store.ts`/`mailbox-store.ts`/`managed-resources.ts` 落盘）：

- 会话：`session.created`、`session.reopened`、`session.open/suspending/suspended/closing/closed/archived`（`setSessionStatus` 按状态派生）。
- Task：`task.created`、`task.spawned`、`task.started`、`task.signal`、`task.ready/waiting/succeeded/failed/cancelled`（Decision / 结束路径按状态派生；初始 blocked 与领取 running 从 created / leased 及快照观察）、`task.retry.scheduled`、`task.program.unavailable`、`task.attempt.lost`、`task.control.run/pause/interrupt`、`task.control.acknowledged`、`task.wait.progress`、`task.wait.satisfied`。
- Effect / 交互：`effect.leased`、`effect.succeeded/failed/indeterminate`、`effect.retry.scheduled`、`effect.resolved`、`effect.attempt.lost`、`effect.interrupt.requested`、`effect.cleanup.confirmed`、`task.interaction.requested`、`task.interaction.resolved`。
- 资源 / 预算：`resource.created`、`resource.granted`、`resource.revoked`、`resource.requested`、`resource.resolved`、`budget.configured`、`budget.consumed`。
- 共享状态 / Context / 工作区：`session.shared.set`、`session.shared.deleted`、`session.context.committed`、`workspace.snapshot.created`、`workspace.diff.created`。
- 消息：`session.message.queued`、`session.message.received`、`session.message.rejected`、`message.consumed`。
- Cache：`cache.created`、`cache.published`、`cache.read`、`cache.renewed`。
- 业务流式透传：`agent.event`。

---

## 工具函数

```ts
// 授权断言：校验 context.grants 含指定 handle 的 resource kind + right（默认 execute）
assertEffectGrant(context: EffectExecutionContext, handleId: string, resourceKind: string, right?: ResourceRight): void;

// 统一审批判定：true / {approved:true} / 'yes'|'approved'|'allow'|'true'|'y'|'ok'
interactionApproved(value: JsonValue): boolean;

// 幂等 ID
createId(prefix: string): string;

// 能力绑定（见入口）
bindCapabilities(task: TaskHandle, bindings: CapabilityBinding[], onHandle?): Promise<void>;
```

---

## 错误模型

```ts
enum KernelErrorCode {
    SESSION_NOT_FOUND, TASK_NOT_FOUND, BUDGET_EXCEEDED, BUDGET_INVALID,
    STALE_EFFECT_CLAIM, HANDLE_LACKS_RIGHT, HANDLE_REVOKED,
    EFFECT_TIMEOUT, EFFECT_CANCELLED, INVALID_SPEC, CONFLICT,
}

class KernelError extends Error {
    readonly code: KernelErrorCode;
}

// 用法
try { await session.chargeBudget(handleId, 'tokens', n); }
catch (e) {
    if (e instanceof KernelError && e.code === KernelErrorCode.BUDGET_EXCEEDED) { ... }
}
```

---

## 存储

`SeqFileKernelStore` —— 基于 SeqFile（顺序日志 + snapshot）的持久化实现。所有 Session/Task 状态、事件、effect、resource/budget、cache、托管资源与跨会话消息落盘，重启后 `Kernel.recover()` 恢复（lease 过期任务重新入队）。对外通过 `SessionStorageResolver` 解析到具体 `IFileSystem` 后端（VFS/localFS/IndexedDB/内存）。

---

## 源码结构：文件与路径

`@itookit/durable-kernel` 的公共 API 全部从 `libraries/durable-kernel/src/index.ts` 根导出（`exports['.']` 指向 `src/index.ts`）。包内按 **六层** 组织，依赖单向向下：

```
libraries/durable-kernel/src/
├── index.ts                      根导出（唯一公共入口）
├── core.ts                       精简入口：createHarness() + Harness/Session/Task 窄接口
├── domain/                       纯类型 + 错误模型（无逻辑）
│   ├── types.ts                  SessionId/TaskId/JsonValue、SessionRecord/TaskRecord、
│   │                             TaskSpec/TaskSnapshot/TaskAttempt、ProgramRef/StorageBindingRef、
│   │                             Decision/WaitSpec/KernelAction/TaskInputEvent/RetryPolicy、
│   │                             ResourceRecord/ResourceHandle/ResourceSpec/BudgetAccount、
│   │                             SharedStateEntry/CrossSessionMessage/ContextCommit/ContextBranch、
│   │                             SessionStorageResolver/WorkspaceAdapter 等全部核心类型
│   ├── errors.ts                 KernelErrorCode 枚举 + KernelError 类 + kernelError() 工厂
│   ├── interaction.ts            InteractionKind/ApprovalDecision、InteractionRequest/Record/Response
│   ├── cache.ts                  CacheApi/CacheSpec/CacheRead/CachePublish/CacheEntry/
│   │                             CacheNamespace/CacheManagementAction/CacheManagementReceipt
│   ├── resource-api.ts           ResourceApi/ManagedResource/ManagedHandle/ResourceClaim/
│   │                             ResourceCommand/ManagedResourceAdapter/ResourceCleanup 等托管资源契约
│   │                             以及 ManagedAuthority/ResourceAuthority（authority ownerEpoch 与写命令 fence）
│   └── status.ts                 taskStat()/taskStats()/sessionStat()/closedSessionStat() + TaskStat/TaskStats/SessionStat
├── ports/                        内核向外的契约（注册面）
│   ├── registry.ts               ProgramRegistry / EffectRegistry / StorageResolverRegistry / WorkspaceRegistry
│   └── plugin.ts                 KernelRegistration（内核能力面）+ KernelPlugin（装配插件）
├── application/                  内核编排（Kernel 主类 + 决策引擎）
│   ├── kernel.ts                Kernel 主类 + KernelOptions/KernelChangeReason（入口）
│   ├── capabilities.ts           bindCapabilities() + CapabilityBinding（能力绑定统一入口）
│   ├── decision.ts               状态机核心：transition()/shouldRetry()/retryTask()/validateDecision()
│   │                             以及 normalizeInputEvent()/failureDecision()/terminal()/mergeReport()
│   ├── actions.ts                decisionSideEffects()/prepareSpawns()（副作用与 spawn 展开）
│   ├── effect-utils.ts           normalizeEffect()/addEffect()/addInteraction()/abortError()/
│   │                             effectFailure()/serializeError()/assertEffectGrant()/interactionApproved()
│   ├── durability.ts             assertDurableValue()/inspectDurableValue()（决策 payload 可持久化校验）
│   └── workspace-utils.ts        workspaceContext()/workspaceSnapshot()/assertWorkspace()（快照/合并助手）
├── public/                       对外句柄实现（组合窄接口）
│   ├── session-handle.ts         DefaultSessionHandle（实现 SessionHandle 9 个窄接口）
│   ├── task-handle.ts            DefaultTaskHandle<O>（实现 TaskHandle<O>）
│   ├── event-stream.ts           eventStream()/waitForChange()（事件流工具）
│   ├── program.ts                defineTask() + TaskStepEvent（单步纯函数声明式程序）
│   └── resources.ts              resourceApi() + resourceResult()（资源面工厂）
├── runtime/                      调度运行时（内核内部，不导出）
│   ├── durable-poller.ts         DurablePoller — ready 候选轮询（claimReady→execute→applyDecision）
│   ├── lease-heartbeat.ts        LeaseHeartbeat — 任务/Effect 租约心跳续期
│   └── effect-cleanup.ts         EffectCleanupRunner — Effect 清理等待与超时
└── infrastructure/seqfile/       SeqFile 持久化实现
    ├── store.ts                  SeqFileKernelStore（对外存储实现）+ TaskClaim/EffectClaim/
    │                             EffectCompletion/PreparedSpawn/TaskCommitSideEffects
    ├── store-helpers.ts          事务助手：assertClaim/claimTask/finishAttemptTx/writeTaskTx、
    │                             effect 恢复、budget/resource/context/shared 读写 TX、key 构造
    ├── seqfile-core.ts           路径/键名函数 + ensureSessionLayout/ensureTaskLayout/ensureSeqFile
    ├── cache-store.ts            Cache TX：createCacheTx/manageCacheTx/publishCacheTx/readCacheTx/
    │                             invalidateCacheTx/renewCacheTx/listCachesTx
    ├── mailbox-store.ts          Task 消息 TX：enqueueMessageTx/deliverMessageTx/consumeMessageTx
    └── managed-resources.ts      ManagedResourceStore + executeResourceTx/sweepResourceTx（托管资源扫描）
```

### SeqFile 持久化路径设定

每个 Session 绑定一个存储根目录（`StorageBindingRef` → `ResolvedStorageBinding.rootPath`，对应一个 `IFileSystem` 目录），布局由 `ensureSessionLayout()` 建立：

```
<rootPath>/
├── catalog.seq        会话目录（全局）：session/<id> → SessionRecord（含生命周期状态）
├── session.seq        会话主记录（SESSION_KEY → 最新 SessionRecord）
├── shared.seq         会话共享状态：value/<key>、head/<key>、history/<key>/
├── context.seq        上下文提交：commit/<id>、branch/<name>（默认 main）
├── messages.seq       跨会话消息：outbox/<id>、inbox/<id>
├── events.seq         会话事件流（EventEnvelope，单调 sequence）：event/<16位序号>、next-sequence、
│                      task-event-count/<taskId>、task-event/<taskId>/<16位序号>、task-event-index-version
├── graph.seq          Task 依赖图（dependsOn/waiter 关系）
├── resources.seq      资源/句柄/预算/缓存：resource/<id>、handle/<id>、budget/<resourceId>/<dimension>、
│                      managed/request/<…>、managed/access/<…>、managed/claim/<id>、managed/cleanup/<id>、
│                      managed/authority/<id>（authority ownerEpoch/ownerId/binding）、
│                      usage/<usageId>（幂等预算结算回执 BudgetUsage）、
│                      cache/namespace/<id>、cache/entry/<namespaceId>/<key>、cache/version/<namespaceId>/<key>
├── index.seq          Task 索引（indexTask）
└── tasks/<taskId>/
    ├── artifacts/     Task 产物目录（ensureTaskLayout 建立，供能力/工具落盘）
    └── task.seq       Task 主日志：attempt/<id>、snapshot/<version>、wait/task/<target>/<waiter>、
                       spawn/<parent>/<key>、workspace/snapshot/<id>、workspace/diff/<id>、
                       cache-operation/<operationId>
```

**观察投影的取消三态**：`taskStat(task)` 的 `control.requested` 在取消请求被接受后即为 `'cancel'`，而 `control.acknowledged` 只有在**没有任何在途/待清理操作**（`activeOperations === 0`，含 `cleanupPending` 的 Effect）时才为 true——即“请求已接受/逻辑状态已变化”与“外部确已停止”可区分；`taskStat`/`taskStats`/`sessionStat` 现由包入口公开导出，`@itookit/app-core` 的 `taskSummary` 透传 `control`/`activeOperations` 供宿主渲染。回归 `libraries/durable-kernel/src/kernel.test.ts`「distinguishes an accepted cancel request from a confirmed external stop」。

**预算结算幂等**：`chargeBudget` 可选 `usageId`——扣费与 `usage/<usageId>` 回执在同一事务写入，同 id 重放返回记录的回执（不再扣费），同 id 不同金额/资源/维度抛冲突；Effect 路径由内核默认按逻辑 Effect 结算（`effect:<taskId>:<effectId>:<handleId>:<dimension>`），未提供 `usageId` 的宿主直调保持每次调用都扣。回归 `libraries/durable-kernel/src/kernel.test.ts`。

**authority 归属**：`managed/authority/<id>` 记录 `{authorityId, ownerEpoch, ownerId, binding, serviceEndpoint, status, updatedAt}`；首次 `claimAuthority` 写 epoch 1，接管必须提交 `expectedEpoch` 并 CAS 递增（失配报 `Authority epoch conflict: …`）；命令携带 `authority: {authorityId, epoch}` 时在同一权威事务内校验，过期 leader 的新写入被拒，已受理请求的重放仍返回原结果。回归见 `libraries/durable-kernel/src/resources.test.ts`。

**约定补充**：托管资源（`managed/*`）按作用域落在对应存储根的 `resources.seq`——kernel 作用域落在 `catalog` 根，`session:<id>` 作用域落在该 Session 根；Cache 的 operation 收据（`cache-operation/<operationId>`）落在发起 Task 的 `task.seq`，与 namespace/entry 分离。

**键命名规则**（`seqfile-core.ts` 导出的 `*Path()` / `*Key()` 函数）：

适配器通过包根入口的 `taskStoragePath(sessionRoot, taskId)` 获取 Task 主日志路径，复用内核的单段身份校验与布局规则。Task ID 不作 URL 编码；媒体资产、Context 内容与各自回执使用该路径下的独立命名空间，不导入内核内部文件。

| 函数 | 路径 / 键 | 用途 |
|---|---|---|
| `catalogPath(root)` | `catalog.seq` | 全局会话目录 |
| `sessionPath(root)` | `session.seq` | 会话主记录 |
| `sharedPath(root)` | `shared.seq` | 共享状态 |
| `contextPath(root)` | `context.seq` | 上下文提交 |
| `messagesPath(root)` | `messages.seq` | 跨会话消息 |
| `eventsPath(root)` | `events.seq` | 会话事件流 |
| `resourcesPath(root)` | `resources.seq` | 资源/句柄/预算 |
| `indexPath(root)` | `index.seq` | Task 索引 |
| `graphPath(root)` | `graph.seq` | Task 依赖图 |
| `taskPath(root, id)` | `tasks/<id>/task.seq` | 单个 Task 主日志 |
| `attemptKey(id)` | `attempt/<id>` | Task 尝试记录 |
| `snapshotKey(version)` | `snapshot/<16 位补零版本>` | Task 状态快照 |
| `taskWaitKey(targetId, waiterId)` | `wait/task/<target>/<waiter>` | 任务等待注册 |
| `spawnMappingKey(parentId, key)` | `spawn/<parent>/<key>` | spawn 映射 |
| `outboxKey(id)` / `inboxKey(id)` | `outbox/<id>` / `inbox/<id>` | 消息投递 |
| `sharedKey(key)` / `sharedHeadKey(key)` | `value/<key>` / `head/<key>` | 共享值 + 头版本 |
| `sharedHistoryPrefix(key)` | `history/<key>/` | 共享值版本历史 |
| `contextCommitKey(id)` / `contextBranchKey(name)` | `commit/<id>` / `branch/<name>` | 上下文提交/分支 |
| `resourceKey(id)` / `handleKey(id)` | `resource/<id>` / `handle/<id>` | 资源/句柄 |
| `budgetKey(resourceId, dimension)` | `budget/<resourceId>/<dimension>` | 预算账户 |
| `taskEventCountKey(taskId)` / `taskEventKey(taskId, index)` | `task-event-count/<taskId>` / `task-event/<taskId>/<16 位补零序号>` | Task 事件索引（events.seq） |
| `workspaceSnapshotKey(id)` / `workspaceDiffKey(id)` | `workspace/snapshot/<id>` / `workspace/diff/<id>` | 工作区快照/差异 |

**约定**：存储根必须是支持事务性 SeqFile 的 `IFileSystem`（`requireTransactionalSeq` 校验，缺失时报错）；`createSession()` 将会话登记进全局 `catalog.seq`，`openSession()` 从 `session.seq` 读取主记录后按需恢复 `tasks/` 下的 Task。

`openSession` 可选 `expectedStorage` 校验调用方预期的存储绑定；每次打开仍读取 catalog/主记录并验证身份与布局。同一 Kernel 中已登记且 fs/root 未变的绑定复用监听器，不重复写固定布局元数据或重新启动资源扫描。只有未登记的 Session 才由上层进入创建路径；未完成登记仍按持久 intent 恢复。

**会话删除**：`removeSession(id)` 只负责 Kernel 拥有的部分，顺序固定为：停止轮询与资源扫描 → 取消 fenced reducer → 通知插件 `onSessionClosed` → 解除存储根 `vfsFixedLayout` 固定布局保护 → 删除存储根子树 → **清除该 Session 全部 SeqFile 记录**（`session/shared/context/messages/events/graph/resources/index.seq` 以及每个 `tasks/<id>/task.seq`；记录独立于文件存在，删文件不会清理它们）→ 最后在同一事务删除 `catalog.seq` 的 `session/<id>` 与所有指向它的 `task/<taskId>`。存在非终态 Task 或 `cleanupPending` 的 Effect 时抛 `CONFLICT`（`force: true` 才强制），因此**关闭失败不会连带销毁数据**；会话不存在时返回 `false`（幂等）。

catalog 记录最后删除，使中断的删除**可安全重试**（绑定在收尾前始终可解析）；此外 `ensureSessionLayout` 在发现 `session.seq` 缺失时会先清空同名遗留记录，因此即使删除在"删文件"与"清记录"之间被中断，用同一 ID 重建也不会复活旧的 closed 状态或 shared 数据。Kernel 之外的会话记录（如 llm-session 的 history/session seq）由宿主在 `removeSession` 成功后自行删除，顺序不可颠倒。

**重启后恢复未完成的删除**：`removeSession` 通过 `catalog` 直接解析绑定（`inspectSessionBinding`），不走要求主记录文件仍存在的 `openSession()`，因此存储根已删除时仍可继续清理。`closeSession` 与 `sessionStat` 同样对"存储已不存在"的会话幂等：前者视为无需关闭（也不再尝试 `closed → closing` 状态迁移），后者报告 `closed`。因此应用层 `SessionLifecycleService` 在进程重启后仍能走完 close → remove → 记录删除的完整链路。

## 人工重试

`TaskHandle.retry({ requestId })` 或 `Kernel.retryTask(sessionId, taskId, { requestId })` 创建带 retryOfTaskId 的新 root Task。来源必须已终态，非空请求身份在同一来源内幂等；旧终态和历史保持不变。新任务复制原 program/input/dependencies/retry/priority/labels，默认 deferStart=true，未复制 checkpoint、Effect、interaction 或资源授权；宿主须重新授权并调用 start。失败依赖按原提交策略传播。TaskSpec 也支持 retryOfTaskId，普通提交及结构化 spawn 的存储事务均校验来源终态；Kernel 重建后，相同来源和请求身份仍返回原重试任务。此接口不自动替换 Flow 图节点或继续原图。

`TaskHandle.createResource` / `SessionHandle.createResource` 的 spec 可传非空 requestId，以拥有者 Task 为作用域幂等创建能力资源。同键不同规格报错；重放返回当前资源/句柄（包括撤销标记），不会重新授权。没有 requestId 时仍每次创建。该能力为恢复授权装配提供基础，尚不代表整个 bindCapabilities/start 流程事务化。

`TaskHandle.start(options?: { signal?: TaskSignal })` 支持原子初始信号：同事务登记信号及启动，重复相同信号不重投，不同信号冲突。bindCapabilities 使用 `capability:<signalKey>` 资源 requestId，准备资源与回调后调用 start({ signal })。资源准备回调可能重试执行，需自行保持幂等；资源创建与启动仍是分阶段操作。

`TaskHandle.respond` 对已 resolved 的同 interactionId/同编码回应值幂等返回，包括 Task 已成功、失败或取消的情况；异值冲突，不变更终态 Task/version/事件。终态上尚未解决的交互仍拒绝新回应，不能用 respond 重新启动 Task。

Effect 完成提交在存储事务中校验 lease 及祖先取消状态。祖先已取消、后代清理尚未传播时，旧 Effect 结果不能写入、唤醒任务或安排自动重试；已经保存的最终 Effect 结果仍按原记录幂等返回。

人工 `resolveEffect` 的新裁决同样受祖先取消屏障约束，包括确认成功、确认失败及重试；取消前已保存的相同请求仍可幂等重放，不同内容报冲突。

祖先取消尚未传播到目标时，创建新后代、首次 start、signal、新控制请求及尚未解决的交互回应也会拒绝。已有提交、启动、控制和交互回执保持原有幂等重放；取消不允许通过这些入口恢复业务执行。

Task 消息发送拒绝取消祖先下的新入队请求，原消息身份可重放已保存的入队回执。接收方祖先已取消时，消息保存为 rejected，原因码为 `target-ancestor-cancelled`；同 Session 和跨 Session 投递一致。既有投递或拒绝回执仍幂等，不重复唤醒目标。

存储层 sweep/recover 在恢复后代 lease 前检查完整祖先链；已有祖先取消时，事务内将后代取消并登记 Effect 清理。该传播不依赖父任务先被扫描，重复恢复不追加取消事件；物理清理由后续清理流程执行。

Session 布局声明：新记录携带 `layout`（布局版本、各记录族 schema 版本、必需能力与迁移状态）。`openSession` 与 `requireSessionTx` 校验这些字段；不支持的版本/记录族、缺失 schema、未知必需能力及未完成或非法迁移均拒绝。仅完全缺少 `layout` 字段的旧记录保留兼容读取。低层存储方法并非全部经该入口；这不构成在线迁移或跨主机 fencing 协议。

Task 历史裁剪：`Kernel.compactTaskHistory(sessionId, taskId, { keepVersions?, beforeVersion? })` 只删除 Task 文件中的旧 `snapshot/<version>`，与 `task.history.compacted` 事件同事务提交。`keepVersions` 默认为 20，须为正安全整数；`beforeVersion` 可选，须为非负安全整数。只裁剪同时早于两个保留边界的版本，版本 0 也参与计数；当前 Task、attempts、Effect/交互及回执保留。返回 `{ removed, keptFrom }`，其中 `keptFrom` 是本次计算的保留边界，不保证更早已裁剪的数据存在。已删除版本的分页读取返回空。此 API 不管理外部读者的历史固定版本租约，也不代替完整 retention/GC 故障验收。

Task 事件裁剪：`Kernel.pruneTaskEvents(sessionId, taskId, { keepEvents? })` 默认保留最近 200 条已索引事件；数量须为正安全整数。删除旧事件及 Task 索引、写入保留水位和裁剪审计事件在同一事务内完成。裁剪会校验索引指向的事件属于当前 Session/Task，损坏索引或非法水位均拒绝。审计事件本身也进入索引，因此本次保留窗口之外会新增一条事件；重复裁剪可能移除一条旧事件。Session 级事件、其他 Task、当前 Task 记录和历史快照不受影响。

`taskEventPage` 返回可选 `firstAvailableIndex`；旧游标被推进到保留窗口，固定的 `throughIndex` 早于窗口时返回空页，调用方应据水位重新同步。这一兼容水位仅用于 Task 索引分页。新 readEvents / watch 统一使用 Session sequence，过期游标抛 CURSOR_EXPIRED；Task / Session snapshot 的 asOfSequence 与状态同事务读取，可据此重同步。未实现跨进程订阅者的保留租约。

提交事件触发调度：catalog 文件变化唤醒 Kernel 资源清理和已打开 Session 的轮询；Kernel 的 resources 文件变化仅唤醒资源清理。同一文件系统内其他文件的提交（例如 Session 租约心跳）不通过 catalog 监听器触发扫描。Session 监听器仍处理所属存储根下的提交，但仅 resources 文件变化直接唤醒该 Session 的资源清理。定时截止和正常调度保持原有行为；这项触发范围优化本身不证明桌面发送延迟或 IPC 总量达标。

Task 全量列表扫描复用目录扫描时已经读取的 `record`，每个有效 Task 只读取一次记录，按目录 Task ID 排序。缺少 Task 文件的残留目录跳过，数据仅在单次调用内复用，不跨调用缓存；扫描不是跨 Task 的原子快照。此优化不改变持久索引分页接口。

启动前检查与批量恢复：`inspectSession(id)` 返回 `id`、`listTasks()` / `getShared(key)` 及不激活 Session 的 `attachTask(id)`；后者的 `status()` 与固定版本 `taskHistoryPage` 同样只读。解析持久绑定不注册 Session 监听器或启动执行；任务句柄上的控制方法仍是显式写操作。`recoverSessions(ids, options)` 去重所选 ID，先恢复所有所选 Session 的持久状态及资源，再注册这些 Session 并启动轮询；资源恢复使用只读绑定解析，避免中途激活。该方法也恢复 Kernel 级公共资源，但不遍历其他 Session 或全局投递消息。原 `recover(options)` 仍恢复全部 Session，随后执行消息投递。

`takeover: true` 要求 Kernel 执行空闲，调用方仍须先取得 Session 写租约并停止旧执行者。批量恢复不负责获取租约，也不是跨 Session 原子事务；中途错误可能已恢复部分持久记录，应修正原因后重试。此接口提交不代表所有宿主启动接线或真实桌面重启场景均已合入。

### 关闭与取消观察

`taskStat`、`taskStats`、`sessionStat` 是公开的只读状态投影，宿主用它们区分取消请求与清理确认。`closeSession` 对 closed/archived Session 的重复关闭在事务内保持终态，普通状态转换仍拒绝倒退。kernel-adapters 的六类 Effect 按 Session + Task + Effect 跟踪全部本地在途执行，取消确认等待它们结束；这不证明远程提供方停止计费或跨宿主 fencing 已完成。

### 消息结算确认与清理（工作树审查）

跨 Session 的消费与源端记录投递结果不是同一事务。消息 `settlementAcknowledgedAt` 在目标记录“源端已有终态结果”、随后在源端记录“目标已知”后写入；未确认的终态 outbox 仍列入待处理项，但恢复只补确认，不调用目标 deliver。确认缺失的跨 Session inbox/outbox 不因消费或年龄而清理；同 Session 保持本地事务语义。目标已清理回执时，终态源可完成确认而不重新投递。目标不存在且投递已过期的本地拒绝无需等待目标确认。

retention 的 before 必须为非负有限数，limit 必须为非负安全整数（0 为不删除）。清理水位以最近一次投递/拒绝/消费/结算确认时间为准；宿主仍负责保持水位早于允许的重放窗口。该协议尚待完整隔离批次与进程故障验证；旧版本宿主及超过重放窗口仍在途的投递不得据此宣称受强 fencing 保护。

### 保留与清理 API 批次

`Kernel.pruneSessionMessages(sessionId, before, limit?)` 返回 `{outbox, inbox}`；跨 Session 回收以双方持久结算确认为前提。已终态源恢复只补确认，不重新投递。缓存按 Task/Session 生命周期在同一事务清理，旧 owner 索引事务内重建并校验真实所有者。详见 [Cache 设计](design/durable-harness-cache.md) 与 [Storage 设计](design/durable-harness-storage.md)；自动回归在 `libraries/durable-kernel/src/retention.test.ts`。


## 2026-09-14：托管资源 authority 事务隔离

资源创建时携带 authority 会把 `authorityId` 持久绑定到资源；share/revoke/destroy/open/acquire/release/close/write 必须提交同一 authority 的当前 ownerEpoch，省略、替换身份或旧 epoch 均拒绝。接管以 expectedEpoch CAS 递增，Session 不能接管其他作用域，安全整数溢出拒绝且事务回滚。已完成请求重放原回执；尚未分配的排队申请在接管后失败，已有 claim 保留至明确释放。读取沿用既有授权规则。

首次 claim 将该资源存储升级到 managed/schema=3，后续普通写入不降级；只支持 schema 1/2 的旧 managed-resource 实现拒绝访问。既有未绑定资源保持原行为，不猜测或自动迁移 authority。binding 仅是当前存储内不可变标记，不证明其他独立存储不能建立同名 authority。

本批只完成同一事务存储内的资源命令隔离。物理 adapter 的执行端 token、接管前已开始的外部操作、跨 store 迁移屏障与真实多主机故障矩阵仍待完成，P1-05 保持开放。

隔离提交快照验证：durable-kernel 239、llm-flow 213、llm-session 116、kernel-adapters 111、app-core 92 项通过，共 771 项；Kernel/CLI 类型检查与文档检查通过。资源回归含同存储两个 Kernel 并发 CAS、重建、身份省略/替换、排队接管、schema 升级与 Decision 回滚；不作为真实多进程或物理执行端验收。


## 2026-09-14：调度扫描复用与空闲读取边界

Kernel 在恢复 sweep 后复用一次任务扫描供任务遍历、Effect 候选与唤醒计算使用；sweep/lease/CAS 保持自身最新读取。读取前建立快照占位，通知、重排、停止使其失效，读取结束仅在占位仍有效时发布，下一次唤醒消费一次后清除；其他 Session 的通知不清除当前 Session 快照，dispose 清理所有快照。

两项受控交错回归复现读取期间/读取后通知造成旧空列表忽略新 timer，修复后通过。七项快照测试覆盖上述边界；DOM 工作台在 MemoryBackend 和真实 LocalFS/SQLite 上静置一秒，VFS 与 sidecar 逻辑调用增量均为零。工作台测试的 Kernel facade 是桩，不代表完整运行时或桌面 IPC。

隔离验证：Kernel 246、Flow 213、app-shell 184 项通过，共 643 项，另有 30 项既有跳过；Kernel/CLI/Web 类型检查与文档检查通过。P0-02 桌面发送 ≤2 秒 / ≤100 次 IPC、真实窗口与跨进程通知矩阵继续保持开放。


### 同存储的共享租约条件

`LeaseGuardOptions.lease = { key, ownerId, epoch }` 可用于 `SessionHandle.submit(spec, options)` 和 `SessionHandle.signal(taskId, signal, options)`；`SharedStateWriteOptions` 同样支持 `lease`，用于 setShared/deleteShared。租约保存在本 Session 共享状态，须含匹配 ownerId/epoch、未置 deleted、expiresAt 严格大于事务内宿主时间。

检查和业务写入在同一事务内，失权返回 `KernelErrorCode.STALE_SHARED_LEASE`。lease 不进入 TaskSpec 提交指纹，因此接管者可以复用稳定 requestId。省略条件保持原 API 行为；不是所有宿主命令自动获得 fencing。有效范围与迁移路径见[过渡设计](design/p1-transition.md)。

### 父子任务完成关联

`TaskInputEvent` 的 task-exited 事件支持可选 spawnKey。Kernel 从持久子 Task 记录读取该值，仅向实际父 Task 提供，用于恢复后关联声明式 child wait；普通依赖完成事件不附带其他父级的 spawnKey。Flow 的结构化派发控制器使用这一关联读取子任务返回。

**显式重新运行**：`openSession()` 不改变 closed 状态。用户明确重跑时可调用 `reopenSession()`：等待本机关闭清理并清理旧能力作用域，事务内只允许 closed → open（open 幂等），拒绝 closing/archived 以及未完成 Task/Effect 清理；记录 `session.reopened`。旧 Task 终态和已回收 cache 不恢复。普通 `setSessionStatus` 仍拒绝 closed → open。宿主负责持有 Session 写租约；llm-session 在 Flow 重跑创建替代分支前调用此入口。

Task 事件流按 Task 事件索引分页追尾，`events({ after })` 的 after 仍使用 Session sequence；订阅单 Task 不扫描其他 Task 的 Session 日志。默认在 settled 后排空结束，包含物理清理确认；until: exit 可显式只等逻辑终态。watch 支持 AbortSignal，过期游标抛 CURSOR_EXPIRED；详见独立包[事件契约](../libraries/durable-kernel/docs/events.md)。


`EffectAdapter.shouldRetry?(error, context)` 分类当前 worker 的执行失败；若未实现，沿用 recoveryPolicy 判断。
它不改变崩溃后的 reconcile / manual 语义。持久重试仍要求 EffectRequest.retry 的 maxAttempts / backoffMs，
受总 deadline 和取消约束；`effect.retry.scheduled` 包含 attempt / maxAttempts / error。

## 列表读取成本（2026-09-27）

`listSessionTaskPage` 在同一事务内分两阶段批量读取：先取本页 `task-order` 指针，再用 `getEntriesMany` 取当前 Task；固定 `throughIndex`，缺失指针/记录或身份不匹配仍拒绝。旧索引首次查询仍需补建，超过后端批量上限时由后端分批。全量 Task 扫描只枚举目录的轻量 name/type 条目。`listShared` 的布局校验与 shared 遍历处于同一个事务，不再单独打开守卫事务。


## 独立库与停止恢复契约（2026-10-21）

源码位于 `libraries/durable-kernel`，唯一运行依赖为 vfs-core，TypeScript 配置可独立使用。根、`/core`、`/contracts` 继续保留；独立使用和打包步骤见 [库 README](../libraries/durable-kernel/README.md)。

`/core` 提供 Session 提交/分页/消息/消费确认和 Task 快照/恢复问题检查/Effect 裁决；`recoveryIssues` 返回具体 Session、Task、Effect 及缺失程序、缺失适配器、未知结果、待清理或在途操作的分类。`RecoveryReport.issues` 为恢复读取时的持久阻塞快照，后续异步派发后的状态应重新查询。

`shutdown({timeoutMs})` 对当前实例已登记的 open Session 持久请求暂停，等待在途操作排空，再 dispose 本地 worker。返回 `{status: 'stopped' | 'blocked', localIdle, issues, pendingSessions}`；重复调用复用同一过程。恢复后暂停仍保留，须显式 resume。关闭存储前应确认 localIdle；`dispose` 本身不证明物理停止，`waitIdle` 超时抛 IDLE_TIMEOUT。

Effect 超时保留 cleanupPending，取消确认成功后才清除此标记；Session 暂停和 Task 控制确认均受该责任约束。缺失或失败的取消适配器保持阻塞，不把失败结果解释成外部已停止。真实进程回归覆盖 failed Effect 的清理意图落盘后 SIGKILL，重建后继续确认，确认后再次重建不重复取消。

Session.send 使用源 Session 内稳定幂等键，同键异内容冲突；Task.send 终态后允许重放已有消息，拒绝新发送。消息按接收方 deliverySequence 读取，迟到和同毫秒消息不会被发送时间游标跳过。宿主消费的 Session 邮箱须显式 acknowledgeMessage，Task 消息仍随 Decision 原子确认。跨 Session 不承诺原子提交、全局顺序或外部副作用恰好一次。

## v2 事件与可取消观察

新信封 schemaVersion 2，Session manifest 的 events schema 在首次新写时同事务提升；新宿主兼容读取 v1 / v2，旧 writer 须退出后再升级。Effect 生命周期携带 effectId 和已有 attemptId；正常 Decision 与直接取消的 Task 终态都携带 ExitRecord。KernelEventMap / KernelEvent 提供内建判别联合，parseEventEnvelope / parseKernelEvent 验证信封及已收录 v2 payload。旧 v1 与未收录事件保留为原始事实，自定义 emit 不得冒用内核保留名字。

interrupt 保存 pending + cleanupPending 以及 lost attempt，再 abort / cancel；旧结果和进度不能提交。树内清理确认后 task.control.acknowledged 才为真；resume 先 reconcile，不能盲目重放未知副作用。context 的 attemptId / attemptNumber 可供外部系统 fence 迟到执行者，cancel 必须确认指定 attempt 不能再次启动。

`withdrawPause({requestId, expectedEpoch})` 仅撤销指定版本的未确认 pause，不放宽 resume。它拒绝 interrupt、终态、已确认暂停及树内 cleanupPending，保留 Session、祖先和子节点自身 hold，不取消、核对或重派发原 Effect。长活 Effect 的 `sessionState.setIfRunning(key,value,expectedVersion?)` 与控制在同一事务校验 claim 及暂停屏障；受阻时返回 undefined 且不写，普通 set 仍可保存观察和结算。撤销记录使用 `task.control.withdraw-pause` 事件及独立请求身份。

Task wait 默认等逻辑 exit，until: settled 等清理；waitStopped 等控制停止确认。Task watch 默认 settled，Session watch 在 closed / archived 后结束；dispose 结束流并拒绝未完成的等待，恢复后重新附加句柄。readEvents 使用有界 sequence 页；snapshot 与 asOfSequence 提供原子重同步边界。核心签名和错误分类以随包提供的[接口参考](../libraries/durable-kernel/docs/api.md)为准。

Effect 的可选 `context.waitForObservation(read)` 在只读等待期间让出本实例工作额度，成功和失败都先重新取得额度再返回，避免单额度下父 Effect 等子 Effect 的死锁。原 Effect 仍保持 leased、心跳、deadline 和取消/清理责任；waitIdle/drain 不将它当作空闲。回调接收 AbortSignal，只能观察已有操作并应释放订阅；返回不授予新执行权限，后续副作用仍须 setIfRunning 与当前授权。恢复继续原 journal 的 reconcile，不保存 Promise 或重建原业务调用。具体限制见独立库接口。


## 独立库新增运行契约

本地 worker 退出使用 drain，业务暂停使用 shutdown；signal 支持稳定 requestId 与 SignalReceipt；Session.schedule 提供持久定时任务；archives 提供 JSONL 导出、校验和暂停导入。完整签名与验收边界分别见独立库[接口](../libraries/durable-kernel/docs/api.md)、[存储与通知](../libraries/durable-kernel/docs/storage.md)、[定时](../libraries/durable-kernel/docs/scheduling.md)、[归档](../libraries/durable-kernel/docs/archives.md)。

## Session 活动摘要

`Kernel.sessionActivity(sessionId)` / `Harness.sessionActivity(sessionId)` 同事务冷读生命周期、各 Task 阶段数量、pending approval/input/cleanup、最近终态和 asOfSequence。用途是轻量会话总览；控制是否确认仍使用 Session/Task stat，导出恢复使用 archives。活动投影与 Task 原子提交，正常查询不读 Task 正文或对话历史；旧存储缺少投影时批读缺少摘要的记录，包含需要核对清理责任的终态任务。详细契约见[独立库 API](../libraries/durable-kernel/docs/api.md#session-执行摘要)，验证见[Harness 场景](../libraries/durable-kernel/docs/harness-scenarios.md)。

## 外部执行结果未知

Effect适配器可通过可选 `failureOutcome(error)` 将实时调用无法确认的结果标为 `indeterminate`，Kernel保留Task等待并阻止自动Effect重试。该机制也用于远程Harness丢响应；默认适配器行为不变。现有 `resolveEffect()` 可提交核对结果或显式授权同一Effect继续尝试，稳定请求与外部回执仍由适配器保证。详见[独立库契约](../libraries/durable-kernel/docs/api.md#实时-effect-失败分类)与[远程执行连接](design/remote-harness-connections.md)。


### 取消接纳与物理清理的独立证据

`TaskCancellationOptions` 在已有 lease 外允许 `requestId` 和 `expectedEpoch`；提供控制版本时必须提供稳定请求 ID。取消回执与终态在同一 Session 事务提交，`Kernel.readTaskCancellationReceipt` 冷读取 `{requestId, taskId, expectedEpoch?, controlEpoch, status}`，不激活 worker，不重发取消，不返回原因和正文。同一请求不同原因或版本冲突；重复请求不重复终态事件。若完成或失败先发生，回执保留真实终态。父取消的 ID/版本不传递给子任务。

回执仅证明取消请求已处理，不证明资源释放或整树停止；清理挂起/失败后回执仍可查询，继续使用 `taskStat/taskStats` 的 stopped/settled 观察收尾。无 requestId 的旧接口继续可用，但不产生可核对的取消接纳证据。详细契约及回归见独立 Kernel 的 `docs/api.md` 与 `src/interface-contracts.test.ts`。
