# @itookit/durable-kernel

持久执行内核：把 Session / Task / Effect 的状态机、SeqFile 持久化、资源与预算、缓存、托管资源扫描收敛到一个可重启恢复的实现。它是 LLM 依赖链的最底层（`llm-session → llm-flow → llm-tasks → durable-kernel → vfs-core`），只依赖 `@itookit/vfs-core`。详见 [Kernel API](../../doc/kernel-api.md)、[Durable Harness 证据映射](../../doc/design/durable-harness-evidence.md)。

## 定位与铁律

- **唯一公共入口是 `src/index.ts`**（`exports['.']` 与 `exports['./core']`）。包内目录不可被外部深引用（`kernel-adapters` / `llm-flow` 只从根导出取符号）。
- **不依赖上层**：`src/` 内不出现 `@itookit/common`、`driver-llm`、`tools`、`kernel-adapters`、`llm-*`；平台差异经 `SessionStorageResolver` / `WorkspaceAdapter` / `EffectAdapter` 端口注入。
- **一切决策必须可持久**：`Decision` 的 payload 由 `assertDurableValue` 校验；跨重启只依赖持久记录，不依赖进程内 Promise 或内存 Map。
- **观察与事实分离**：`domain/status.ts` 的 `taskStat`/`taskStats`/`sessionStat` 是只读投影（如「取消已接受」与「外部已停止」可区分），不得写状态。

## 结构

```
src/
├── index.ts                     根导出（唯一公共入口）
├── core.ts                      精简入口 createHarness()：Harness/Session/Task 窄接口
├── domain/                      纯类型 + 错误模型（无逻辑）
│   ├── types.ts                 SessionRecord/TaskRecord/TaskSpec/TaskSnapshot/
│   │                            Decision/WaitSpec/KernelAction/TaskInputEvent 等核心类型
│   ├── errors.ts                KernelErrorCode + KernelError + kernelError()
│   ├── interaction.ts           人工交互（approval）请求/记录/响应
│   ├── cache.ts                 CacheApi/CacheSpec/CacheRead/CachePublish/CacheEntry
│   ├── resource-api.ts          ResourceApi/ManagedResource/ResourceClaim/
│   │                            ManagedResourceAdapter/ManagedAuthority
│   └── status.ts                taskStat()/taskStats()/sessionStat()（含取消三态）
├── ports/                       内核向外契约：ProgramRegistry / EffectRegistry /
│                                StorageResolverRegistry / WorkspaceRegistry / KernelPlugin
├── application/                 Kernel 主类与决策引擎
│   ├── kernel.ts                Kernel + KernelOptions（入口）
│   ├── decision.ts              transition()/validateDecision()/retryTask()（状态机核心）
│   ├── actions.ts               decisionSideEffects()/prepareSpawns()
│   ├── durability.ts            assertDurableValue()（决策 payload 可持久化校验）
│   └── capabilities.ts          能力绑定统一入口
├── public/                      对外句柄：DefaultSessionHandle / DefaultTaskHandle /
│                                eventStream() / defineTask() / resourceResult()
├── runtime/                     调度运行时（包内）：
│                                durable-poller（ready 轮询）/ lease-heartbeat / effect-cleanup
└── infrastructure/seqfile/      SeqFile 持久化：store.ts（SeqFileKernelStore）/
                                 store-helpers.ts / seqfile-core.ts（路径与键）/
                                 cache-store.ts / mailbox-store.ts / managed-resources.ts
```

## 入口

```ts
// 完整内核（宿主：app-core / CLI）
const kernel = new Kernel({ catalog: { fs, rootPath: '/kernel' }, maxConcurrent, pollMs });
await kernel.initialize();
const session = await kernel.openSession('s1');
const task = await session.spawn(spec);

// 最小组装（测试与嵌入式）
const harness = createHarness(options);
```

`Kernel` 承载：`createSession`/`openSession`/`reopenSession`/`recover`/`recoverSession`/`waitIdle`/`dispose`、`registerProgram`/`registerEffect`/`registerWorkspace`/`registerResourceAdapter`/`registerStorageResolver`，以及资源/缓存/事件面。`session.spawn()` 返回 `TaskHandle<O>`（`wait`/`stat`/`cancel`/`pause`/`resume`/`respond`/`signal`）。

## 关键语义（改这里前先读证据）

- **取消三态**：`control.requested='cancel'` 表示请求已接受，`control.acknowledged` 只有在 `activeOperations === 0`（含 `cleanupPending` 的 Effect）时才为 true；「请求发出」不等于「外部已停止」。回归 `src/kernel.test.ts`「distinguishes an accepted cancel request from a confirmed external stop」。
- **预算结算幂等**：`chargeBudget(..., { usageId })` 与 `resources.seq.usage/<usageId>` 回执同事务写入；同 id 重放返回记录回执、不再扣费，金额/资源/维度不同即冲突。Effect 路径默认按逻辑 Effect 结算。
- **authority fence**：`managed/authority/<id>` 保存 `ownerEpoch`；`claimAuthority` 接管须 CAS 递增，写命令携带 `authority: {authorityId, epoch}` 时在权威事务内校验，过期 leader 的新写入被拒（已受理请求的重放仍返回原结果）。
- **retention/GC**：`compactTaskHistory`（`snapshot/<version>`）、`pruneTaskEvents`（`events.seq`，带 resync 水位）、`pruneSessionMessages`（只删已终结出箱与已消费回执）；裁剪不得删除活跃引用、Effect 幂等事实与未交付 receipt。
- **恢复读取成本**：`repairCatalog` 只按 `task/<id>` 键读取该 Session 自己的 Task 映射；每个 Session 全量扫描 catalog 的 `task/` 行会让恢复成本变成 `sessions × (sessions + tasks)`，在浏览器 IndexedDB 上主导启动耗时。`recoverSessions(ids, { onSessionRecovered })` 提供只读观察钩子（每 Session 的 state/resources 耗时），恢复决策不得依赖它。回归 `src/kernel.test.ts`「recovers a Session by keyed catalog reads instead of scanning foreign task rows」——该守卫在旧的 catalog 全扫实现上会失败。
- **等待图恢复**：`recoverWaitGraphTx` 在重建关系后各扫描一次 `edge/` 与 `wait/task/` 键，仅对有关系的终态 Task 执行原有递归推进/唤醒；无终态 Task 时跳过这两次读取。不能恢复成每个终态 Task 各做两次空范围查询。回归见 `src/protocol.test.ts`「does not probe empty dependency and wait prefixes for every terminal Task」。
- **Session layout manifest**：`session.seq` 的 `record.layout`（`layoutVersion`/`recordSchemas`/`requiredCapabilities`/`migration`）在 `openSession` 与 `requireSessionTx` fail closed；旧记录按 legacy 读取。

## 运行

```bash
pnpm --filter @itookit/durable-kernel test        # vitest run
pnpm --filter @itookit/durable-kernel typecheck
```

测试与实现同目录（`src/*.test.ts`、`src/runtime/effect-cleanup.test.ts`）：`kernel.test.ts`（状态机/Effect/预算/观察）、`protocol.test.ts`（协议不变量、layout、retention、cache、消息）、`resources.test.ts`（托管资源、authority）。

## 相关文档

| 文档 | 内容 |
|---|---|
| [Kernel API](../../doc/kernel-api.md) | 句柄、程序模型、Effect、资源、SeqFile 布局与键名 |
| [Durable Harness 证据映射](../../doc/design/durable-harness-evidence.md) | 五篇设计 → 实现 → 持久记录 → 故障证据 |
| [Durable 协议](../../doc/design/durable-harness-protocol.md) | §2 不变量与 §15 kill 矩阵 |
| [运行时架构](../../doc/runtime-architecture.md) | Kernel 在 app-core / CLI 中的装配位置 |

发布出口：根入口和 `/core` 使用 dist 的 ESM/CJS 及对应类型声明，工作区继续使用 src；发布只包含 dist，唯一运行依赖为 vfs-core。
