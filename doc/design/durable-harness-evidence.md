# Durable Harness 目标 → 实现 → 持久记录 → 故障证据映射

本文件是 [P1-05](../todo.md) 的活文档：把 Durable 五篇设计（[Core](durable-harness-core.md)、
[Protocol](durable-harness-protocol.md)、[Storage](durable-harness-storage.md)、
[Resources](durable-harness-resources.md)、[Cache](durable-harness-cache.md)）中**仍然有效**的目标逐条
映射到当前 API、持久记录与可复现的故障证据。它不复制设计正文；每条只回答四个问题：

1. 目标/不变量（设计出处）；
2. 实现入口（包与文件）；
3. 持久记录（SeqFile 键或 Session shared key）；
4. 证据（测试文件 + 用例名；无法用测试表达的，写明验收方式与缺口）。

更新约定：新增能力时补一行；把某行的“缺口”改成证据前，必须先有可复现的测试或实机记录。
本文不宣称设计目标全部达成；没有证据的行保持“缺口”标记。

**当前范围（2026-09-14 用户决定）**：本表保留完整目标的对照，但当前 P1 只验收[本地运行范围](p1-transition.md)。迁移、跨主机、通用资源服务/记录族重构、可插拔缓存、通用业务流不再作为本地 P1 阻塞项；标注未实现不等于当前必须实施。

## 0. 证据总览

| 证据 | 范围 | 命令 |
|---|---|---|
| `libraries/durable-kernel/src/kernel.test.ts` | Kernel 状态机、租约、wait、spawn、shared CAS、消息、资源授权 | `pnpm --filter @itookit/durable-kernel test` |
| `libraries/durable-kernel/src/protocol.test.ts` | 协议不变量与 §15 矩阵中的内核侧行（分页、重试、fencing、cache 回执、outbox） | 同上 |
| `libraries/durable-kernel/src/resources.test.ts` | 资源分配/授权/预算/物理清理/迁移 | 同上 |
| `libraries/durable-kernel/tests/ipc.test.ts` | 真实 LocalFS + SQLite 上的 SIGKILL/多进程：接管、竞争、单次消费、清理恢复 | `pnpm --filter @itookit/vfsdriver-local test` |
| `backend/llm-flow/__tests__/durable-flow-executor.test.ts` | Flow 调度：根任务、检查点恢复、任务去重、工作区租约、detached 计时器、调度所有权 fencing | `pnpm --filter @itookit/llm-flow test` |
| `backend/llm-flow/__tests__/scheduler-lease.test.ts` | Run 级调度租约：记录、拒绝活拥有者、到期接管、心跳、释放 | 同上 |
| `backend/llm-flow/__tests__/{git-worktree-manager,transcript-budget,port-contract}.test.ts` | 隔离工作区恢复、transcript 字节预算、端口结构兼容 | 同上 |
| `apps/cli/tests/crash-matrix.test.ts` | 真实 CLI 进程 + 真实 HTTP 模型服务的 SIGKILL 崩溃矩阵 | `pnpm --filter @itookit/cli test` |
| `apps/cli/tests/{run.integration.test.ts,nested-harness.test.ts,hitl.test.ts,session-lease.test.ts,run-scheduler-lock.test.ts,run-scheduler-lease-delete.test.ts,worktree-run.test.ts}` | 端到端 Run、嵌套 harness、人工交互、Session 租约、本机调度锁、跨主机调度租约删除保护、隔离工作区宿主装配 | 同上 |
| `backend/llm-session/__tests__/*` | 会话/回合投影与失败回合可继续性 | `pnpm --filter @itookit/llm-session test` |

## 1. Protocol §2 不变量

| # | 不变量（§2） | 实现入口 | 持久记录 | 证据 / 缺口 |
|---|---|---|---|---|
| 1 | 一个 Task 最多一个有权提交的 reducer Attempt；租约失效后不能提交 | `durable-kernel/src/application/kernel.ts`、`infrastructure/seqfile/store.ts` | `task.seq` `attempt/<id>`、`snapshot/<version>` | `protocol.test.ts`「takes over an unexpired attempt and rejects its stale commit」「fences old decisions and abandonment across a pause/resume」；[独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「grants a ready task to only one competing process」 |
| 2 | 消息/Effect 完成不使当前 reducer claim 失效 | `store.ts` pendingEvents / `wakeFromPendingEvents` | `task.seq` `pendingEvents`、`graph.seq` | `protocol.test.ts`「preserves arrivals while the owning reducer commits and renews」 |
| 3 | state 更新、输入确认、action、wait 注册、journal 事件同事务 | `store.ts` `transaction()` 包裹的 Decision 提交 | `task.seq` + `events.seq` + `shared.seq` 同事务 | `kernel.test.ts`「commits task state and session shared state atomically」 |
| 4 | 终态不可恢复为非终态；人工重做是新 Task，自动重试保持原 TaskId | `kernel.ts` `retryTask`、`llm-flow/src/flow/retry-task.ts` | `task.seq` 新 Task + `retryOfTaskId` | `protocol.test.ts`「manually retries a terminal Task as an idempotent fresh deferred root」「keeps %s Tasks terminal across lifecycle controls and receipt replay」 |
| 5 | 同幂等键不能覆盖已提交结果，同键不同内容冲突 | `store.ts` `submission/<requestId>`、`control/<requestId>`、`effect-resolution/<requestId>` 指纹 | Session `session.seq`、`task.seq` | `protocol.test.ts`「reuses the resource creation receipt after Kernel reconstruction」「retains manual retry request identity after Kernel reconstruction」；Flow 侧 `durable-flow-executor.test.ts`「reuses a submitted node Task when the scheduler checkpoint missed the instance」 |
| 6 | 检查等待、登记 wait、唤醒事实与 ready 投影原子 | `store.ts` wait 注册与 `wakeFromPendingEvents` | `graph.seq` `wait/<target>/<waiter>` | `kernel.test.ts`「durably wakes a task waiter without losing completion」；[独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「does not lose a wakeup when registration races completion」 |
| 7 | 控制意图与传播工作持久保存，崩溃不遗忘暂停/取消/关闭/投递 | `kernel.ts` control、`store.ts` cleanupPending、outbox | `task.seq` `control`、`cleanupPending`、`messages.seq` `outbox/inbox` | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「retains Effect cleanup across missing, unsupported and failed adapters after SIGKILL」「recovers a cancelled tree after SIGKILL between parent commit and descendant cleanup」 |
| 8 | Session 内共享操作可事务原子；跨 Session 不承诺原子/全局顺序 | `shared.seq` + `messages.seq` | `shared.seq` `value/head/history` | `kernel.test.ts`「persists versioned session shared state with CAS」「delivers cross-session messages through a durable outbox」 |
| 9 | 无 notifier、worker 换进程、首次恢复早于旧租约到期，仍最终推进 | `kernel.ts` sweeper/timer service、`store.ts` recover | `task.seq` `attempt/`、`graph.seq` | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「resumes an unexpired task through Kernel after SIGKILL without periodic polling」「waits for the dead worker lease deadline and resumes without forced takeover」；`protocol.test.ts`「uses a deadline timer without polling and leaves idle sessions idle」 |
| 10 | 观察者能区分“请求已接受/逻辑状态已变化/外部是否停止” | `domain/status.ts`、事件流 `task.*`/`effect.*` | `events.seq` | `protocol.test.ts`「pages a Task event index without scanning unrelated events and pins the upper bound」；`app-core/src/session/session-browser.ts` 投影。**三态投影与 UI 可见性已于 2026-09-11（第五十五轮）补证**：`kernel.test.ts`「distinguishes an accepted cancel request from a confirmed external stop」——取消在途 Effect 未确认时 `task.stat()` 为 `{ phase: 'done', control: { requested: 'cancel', acknowledged: false }, activeOperations: 1 }`，确认后 `{ acknowledged: true, activeOperations: 0 }`；`taskStat`/`taskStats`/`sessionStat` 由 `@itookit/durable-kernel` 公开导出，`taskSummary` 增加 `control`/`activeOperations`（app-core `session-browser.test.ts`「exposes whether an accepted cancel is still waiting for the external stop」），`SessionWorkbench` 任务视图渲染 `[data-stop-state]`（`none`/`pending`/`stopped`，copy 为 `session.tasks.stopPending|stopStopped`），jsdom 回归 `app-shell/tests/session-browser-ui.test.ts`。缺口：真实窗口下的可见性验收仍未做（本轮为 jsdom） |

## 2. Protocol §15 kill / 故障矩阵

| 故障点 | 要求 | 证据 / 缺口 |
|---|---|---|
| reducer 运行中收 signal/Effect completion | 合法提交成功，新输入不覆盖 | `protocol.test.ts`「preserves arrivals while the owning reducer commits and renews」 |
| init→continue→多步纯计算 | 有限 step 推进 | `protocol.test.ts`「executes internal steps and retries the first failure after many successes」 |
| 成功执行多步后首次瞬态失败 | 用本步重试预算，同一 Task 从已提交点继续 | 同上；`kernel.test.ts`「retries a retryable decision after durable backoff」 |
| interrupt 请求提交后立即 kill | 恢复器继续停止/核对，receipt 最终 ack 或 blocked | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「retains Effect cleanup … after SIGKILL」 |
| paused 时消息/共享更新到达，再 resume | 输入与匹配版本保留，屏障解除后消费一次 | `protocol.test.ts`「fences old decisions and abandonment across a pause/resume」 |
| resume + 输入提交后响应丢失，重试请求 | 不重复输入/恢复动作 | `protocol.test.ts`「reuses prepared capabilities after setup failure without prematurely starting」 |
| 外部 Effect 成功、结果提交前 kill | reconcile 或幂等重放；不支持时 indeterminate | 内核侧 `kernel.test.ts`「recovers and reconciles an effect abandoned by a disposed worker」；端到端 `apps/cli/tests/crash-matrix.test.ts`（真实 SIGKILL + 真实 HTTP 模型：`indeterminate` → `blockedEffects` → `--retry-indeterminate` 重放）。缺口：真实外部设备（bash/tty/托管资源）的“已执行但未提交”核对 |
| 旧 worker 在新 claim 后返回/abandon/emit | 旧 token 写入全部拒绝 | `protocol.test.ts`「takes over an unexpired attempt and rejects its stale commit」 |
| A→B→C 多级依赖失败及旁路 waiter | 按策略收敛，不漏终态事件 | `protocol.test.ts`「propagates terminal dependency failures through the graph and waiters」 |
| 父取消后、child cleanup 前 kill | 持久屏障阻止新工作，可查询残留 | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「recovers a cancelled tree after SIGKILL between parent commit and descendant cleanup」 |
| inbox 提交后、outbox ack 前 kill | 重投同 receipt，消费一次 | `protocol.test.ts`「persists terminal delivery rejection and exposes it in outbox」 |
| 请求消费与回复登记之间 kill | 事务全成或全不成 | `protocol.test.ts`「replays a resolved interaction after %s without mutating the terminal Task」 |
| shared 更新与 wait 注册交错 | 已满足立即绑定，否则原子唤醒 | `kernel.test.ts`「persists versioned session shared state with CAS」 |
| shared 13 唤醒后更新为 14、删除、重启 | waiter 消费绑定的 revision | `protocol.test.ts`「captures the first shared revision through pause, deletion and recovery」 |
| 跨 Session owner 更新、通知前 kill | outbox 重投，最终满足 | `kernel.test.ts`「delivers cross-session messages through a durable outbox」 |
| 前 worker lease 未过期时新 worker 启动 | 到期后 sweeper 接管，无需二次人工 recover | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「waits for the dead worker lease deadline and resumes without forced takeover」 |
| Session close drain/cancel 中重启 | closing 继续收敛 | `protocol.test.ts`「persists retry progress for a missing session and a rejection when it closes」 |
| TaskBoard A 过期被 B 领取后 A complete | 拒绝旧 token | `protocol.test.ts`「takes over an unexpired attempt and rejects its stale commit」 |
| terminal 在事件读取与状态读取间提交 | 订阅读到 terminalSequence 再结束 | `protocol.test.ts`「keeps task exits observable when no waiter existed at completion」 |
| notifier 全丢、消费者慢、短暂存储故障 | 在策略允许时最终推进，背压可查询 | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「advances another process's waiter and dependant without event delivery or sweep」；缺口：跨主机网络分区与真实 S3/NFS 类后端 |
| 任意崩溃点的 Flow 调度 | 根身份与已提交调度从 Run 第一刻持久，resume 续跑不重跑 | `apps/cli/tests/crash-matrix.test.ts`（包括真实提交/检查点间隙及委派 SIGKILL）、`durable-flow-executor.test.ts`「reuses a submitted node Task when the scheduler checkpoint missed the instance」 |
| 多恢复者 | 不能在旧拥有者仍有效时接管 | `scheduler-lease.test.ts`（4 通过）、`durable-flow-executor.test.ts`「refuses a second scheduler while the owner lease is live and fences the old owner」；缺口：跨主机时钟与共享存储后端 |
| 隔离工作区崩溃恢复 | 恢复租约、补跑 finalization | `git-worktree-manager.test.ts`（5 通过）、`durable-flow-executor.test.ts`「restores an isolated workspace lease instead of preparing a second one」「completes a workspace finalization left pending by a crashed host」、**CLI 宿主端到端** `apps/cli/tests/worktree-run.test.ts`「re-attaches the recorded worktree when a crashed host resumes」（SIGKILL 后 `resume` 复用同一 worktree，`git worktree list` 恰为 2 项）；CLI/Tauri 装配已实现；完整窗口启动与桌面重启、真实 OCI 仍见 P1-03 |

## 3. Storage

| 目标（Storage §1/§2/§4） | 持久记录 | 证据 / 缺口 |
|---|---|---|
| Session/Task 逻辑目录与键固定 | `catalog.seq`、`session.seq`、`shared.seq`、`context.seq`、`messages.seq`、`events.seq`、`graph.seq`、`resources.seq`、`index.seq`、`task.seq` | `doc/kernel-api.md` 路径表；`protocol.test.ts`「protects the kernel layout from rename, ancestor moves and deletion」 |
| 权威事实与索引分离，索引可重建 | `index.seq` + `graph.seq` 由 `task.seq` 重建 | `kernel.test.ts`「rebuilds task indexes and catalog routes from task directories」；`protocol.test.ts`「repairs lost wait and dependency indexes from durable records」 |
| 跨文件事务与回滚 | 事务型 backend | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「rolls back a killed multi-file transaction and resumes durable waiting after restart」 |
| 游标分页与上界 | `task.seq` 版本/事件索引 | `protocol.test.ts`「pages immutable Task versions with bounded key reads and a stable upper bound」「pages stable Task membership while reading current state and backfills old indexes」 |
| Session 删除与身份复用 | `catalog.seq` + Session 根 | `protocol.test.ts`「removes Session storage and catalog entries only when nothing is live」「does not resurrect records when a removed Session identity is reused」「resumes an interrupted removal after a Kernel restart」 |
| retention/compaction 不删活跃引用 | 已落地一条记录族（2026-09-11）：`Kernel.compactTaskHistory(sessionId, taskId, { keepVersions, beforeVersion })` 只裁剪 `task.seq` 的 `snapshot/<version>`，**主记录（权威事实）、attempts、effects、interactions、receipts 一律不动**；保留最新 `keepVersions`（默认 20）与 `beforeVersion` 之后的所有版本，写入 `task.history.compacted` 事件，被裁剪版本的 pin 读返回空而不是损坏状态 | 同轮补上 `events.seq`：`Kernel.pruneTaskEvents(sessionId, taskId, { keepEvents })` 保留最新 `keepEvents` 条索引事件，删除更早的 `event/<sequence>` 与其索引项，写 `task-event-first/<taskId>` 水位；`taskEventPage` 对过期游标做 clamp 并返回 `firstAvailableIndex`，UI 显示「更早的事件已按保留期裁剪」，即设计要求的 resync 契约（会话级不索引的事件不参与裁剪）。缺口：`messages.seq` 之外的其它族与跨 Session GC 竞争；回归 `protocol.test.ts`「compacts Task version history without touching the authoritative record or facts」与「prunes old Task events and reports the retention watermark for resync」 |
| 目标布局 1.1 全量字段 | manifest 骨架已落地：`session.seq` 的 `record.layout` 声明 `layoutVersion`/`recordSchemas`/`requiredCapabilities`/`migration`，`openSession` 与 `requireSessionTx`（含 `listShared`）用 `assertSessionLayout` fail closed（更高版本、pending migration、未知必需能力），无该字段的旧记录按 legacy 读取 | 缺口：§5 各记录族（`work/`/`group/`/`allocation/`/`authority/`/`stream/` 等）仍未拆分；回归 `protocol.test.ts`「declares a layout manifest and refuses Sessions it cannot interpret」 |

## 4. Resources

| 验收（Resources §9） | 证据 / 缺口 |
|---|---|
| 同 Session 两 Task 争用 1 个槽位 | `resources.test.ts`「arbitrates the last shared slot, persists FIFO wait, and wakes on release」 |
| 两 Session 并发申请共享池最后容量 | `resources.test.ts`（跨 Session 共享与撤销用例） |
| owner 分配后回复前 kill | `resources.test.ts`「reconnects to durable requests without allocating twice and rejects conflicting reuse」 |
| 取消先于申请到达 owner | `resources.test.ts`「persists cancellation tombstones before an acquire arrives」 |
| worker 更换及旧释放请求到达 | `resources.test.ts`「expires queued requests and fences fabricated releases」 |
| permit 到期但外部操作仍运行 | `resources.test.ts`「retains physical capacity until an idempotent cleanup confirms reuse」 |
| 预算结算后回执丢失 | `resources.test.ts`「provides versioned shared values and immutable read receipts」；**幂等结算已于 2026-09-11（第五十二轮）实现**：`chargeBudget(..., { usageId })` 与扣费在同一事务写 `resources.seq.usage/<usageId>` 回执，同 id 重放返回记录回执（不再扣费）、金额/资源/维度不同即冲突；Effect 路径默认按逻辑 Effect 结算（`effect:<effectId>:<handleId>:<dimension>`），回归 `kernel.test.ts`「settles a budget charge once per usage id and refuses a conflicting replay」「charges effect-driven usage once per logical Effect even when the attempt is retried」（后者用真实 effect retry：attempt 1 扣费后抛错、attempt 2 再次扣费，最终 `used` 只 +4，且 Kernel 重建后回执仍生效）。缺口：真实后端/供应商侧的重复计费核对仍未取证 |
| Session cache 创建 Task 被归档 | `resources.test.ts`「keeps held capacity through pause and blocks Session close until explicit cleanup」 |
| 导出撤销、consumer 暂停后恢复 | `resources.test.ts`「revokes queued work and cleans active claims without resurrecting old handles on re-share」 |
| owner leader 迁移后旧 leader 写入 | 内核侧骨架（2026-09-11 第五十一轮）：`resources.seq.managed/authority/<id>` 记录 `ownerEpoch`/`ownerId`/固定 `binding`，`ResourceApi.claimAuthority` 首次声明写 epoch 1、接管须 CAS 递增（提交观察到的 `expectedEpoch`，失配即拒绝并给出当前 owner/epoch），`ResourceApi.authority` 只读；写命令携带 `authority: {authorityId, epoch}` 时在该权威事务内校验——过期 leader 的新写入被拒，已受理请求的重放仍返回原结果。回归 `resources.test.ts`「fences a superseded authority leader by the ownerEpoch it presents」「keeps the authority binding fixed to the first claim and survives Kernel reconstruction」「rejects invalid authority claims and epoch presentations」「refuses a Decision resource write whose authority epoch was superseded」（Decision 内资源命令同样被 fence）。缺口（不宣称验收通过）：writer 端 `adapter` 执行令牌 fence 未实现，真实多进程/多 store 竞争与迁移切换屏障仍未验收；account/allocation/export/import 与 `authority/<id>` 之外的记录族未实现 |
| stream/消息/receipt 保留期与 GC 竞争 | `Kernel.pruneSessionMessages(sessionId, before, limit?)` / `pruneMessagesTx`：只删除**已终结**的出箱记录（delivered/rejected）与**已消费或已拒绝**的收件回执；未投递出箱、未消费回执、以及发送方尚未记录投递的回执一律保留（后者同时保护同库内 pending 出箱对应的回执）。水位 `before` 由宿主维护，必须早于部署的重放窗口。回归 `protocol.test.ts`「prunes settled messages only, keeping undelivered and unconsumed records」；跨 Session 场景（源/目标分属不同 store、各自独立跑保留期）由「keeps cross-session delivery responsibility while both stores run retention」验证：未投递出箱在源库保留、已投递未消费回执在目标库保留、消费落盘后才可回收，水位早于投递时不会误删 |
| 能力资源创建回执幂等 | `protocol.test.ts`「deduplicates resource creation per owner and keeps revocation on replay」；`resources.test.ts`「reuses the resource creation receipt after Kernel reconstruction」 |

## 5. Cache

| 验收（Cache §10） | 证据 / 缺口 |
|---|---|
| 未授权读取其他 Task/Session cache | `protocol.test.ts`「selects authorized cache sources and preserves receipts after invalidation」 |
| child spawn 未声明 cache grant | `kernel.test.ts`「spawns one idempotent child and waits for it atomically」+ 授权用例 |
| pause/restart/resume 后 cache 丢失 | `protocol.test.ts`「selects authorized cache sources and preserves receipts after invalidation」 |
| cache-read receipt 后失效/过期/淘汰 | 同上 |
| key 依赖版本变化不得命中旧 entry | `protocol.test.ts`「misses when the dependency fingerprint or expected version no longer matches」：fingerprint 变化 → miss；消费者 pin 的 `expectedVersion` 与当前 entry version 不符 → miss，匹配才 hit |
| invalidate generation 后旧 fill 返回被 fencing | `protocol.test.ts`「selects authorized cache sources and preserves receipts after invalidation」：`invalidate` 后新 operationId 读 miss；用旧 generation 的 `publishCache` 抛 `Cache generation conflict` |
| two workers single-use 同时 take | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「delivers a single-use cache to only one competing process」 |
| single-use take 后、目标 inbox 前 kill | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)「preserves single-use receipt atomicity across SIGKILL %s」 |
| 不支持 single-use 的 backend | 缺口：内置 SeqFile store 始终支持，暂无可插拔 cache provider 以表达能力差异 |
| prefer-cache/cache-only/refresh/bypass | `protocol.test.ts`「serves a live entry in %s mode」「never serves an entry in %s mode and leaves a single-use entry unconsumed」：prefer-cache/cache-only 命中；refresh/bypass 恒 `bypass` 且不消费 single-use |
| TTL 到期后重启/重试不延长绝对期限 | `protocol.test.ts`「hydrates timers durably even when polling starts before their deadline」 |
| Session cache 关闭时物理回收 | `protocol.test.ts`「reclaims every cache namespace when the Session closes, including session scope」：`closed` 同事务删除全部 cache namespace（含 `session` scope）与 handle/resource，artifact、其 handle 与 `cache-operation` 回执保留；`closed` 前已校验无未结束 Task |
| Task cache 到终态清理不删 artifact/幂等事实/receipt | `protocol.test.ts`「cleans Task-scope cache at Task terminal while keeping session scope and other facts」：终态同事务删除 `step`/`task` scope namespace、entry、发布序号与 handle/resource；`session` scope 保留且创建者归档后另一 Task 仍可凭 grant 命中；`artifact` 资源、`effect/<id>` 幂等事实与 `cache-operation/<id>` 回执保留 |
| 同参数写操作重复调用由 Effect 身份处理 | `kernel.test.ts`「preserves successful effects and refuses unsafe replay」 |
| provider 不支持删除/TTL/ref 控制时返回能力差异 | 缺口：cache 目前只有内置 SeqFile 实现，没有 provider 能力协商面 |

## 6. Core

| 目标（Core §7/§9） | 证据 / 缺口 |
|---|---|
| Program 保持可恢复的单步接口 | `llm-tasks/src/durable/*` + `protocol.test.ts`「executes internal steps and retries the first failure after many successes」 |
| SeqFile 与普通文件分工 | `doc/kernel-api.md` 路径表；本文 §3 |
| 运行循环与维护边界（sweeper/timer/relay/reconciler） | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)（无周期轮询的到期恢复、跨进程接管）；缺口：跨主机 notifier/主动唤醒仍属宿主部署条件 |
| 观察/控制 API 草案 | `doc/kernel-api.md`；缺口：GUI 侧“三者可区分”验收 |

## 7. 真实外部 Effect 清理验收现状

| 层次 | 已有证据 | 仍缺 |
|---|---|---|
| 存储/协议层 | [独立库进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts)：SIGKILL 后 adapter 缺失/不支持/抛错三种清理失败保留标记、重启后成功清理、再次重启不重复调用，Task 始终 cancelled | 真实设备（摄像头、串口、外部服务）的停止确认 |
| 真实模型请求 | `apps/cli/tests/crash-matrix.test.ts`：真实 CLI 进程被 SIGKILL 时在途模型请求无法核对 → `indeterminate` → 显式裁决（`--retry-indeterminate`）后重放同一逻辑 Effect | 供应商侧幂等键/查询接口（若供应商支持，可把 indeterminate 收敛为 reconcile） |
| 本地进程（bash/tty） | `backend/kernel-adapters/src/effects/*.ts` 的**全部**适配器（llm.chat/tool.call/bash/tty/skill.load/skill.unload）实现 `EffectAdapter.cancel`（`effects/in-flight.ts` 记录在途执行，`cancel` 等待其结束才确认停止）；`apps/cli/src/shell.ts` 的 `runProcess` 取消时先 SIGTERM 进程组、未退出则 SIGKILL，并**等 `close` 才 resolve**；CLI 实机证据 `apps/cli/tests/process-cancel.test.ts`（进程组忽略 SIGTERM，断言 cancel 返回时 pid 确已消失）与 `run-control.test.ts`（超时/SIGINT 后模型服务观察到客户端断开）；适配器契约见 `effect-adapters.test.ts` | Tauri 隔离模式实机证据（2026-09-11 补齐）：`apps/cli/tests/tauri-process-tree.test.ts` 编译**真实** Rust 模块（`apps/tauri-app/src-tauri/src/session_bash.rs` + `bash_process.rs`），在 bwrap（`--die-with-parent --unshare-pid`）内运行一个忽略 SIGTERM、持续写文件的进程树并触发取消：取消路径确认（`cancelled=true`、`elapsed_ms` 远小于 30s 超时）、退出码 1、**取消返回后 1s 内文件不再增长**（无残留进程）。该保证由「进程组 SIGTERM → 100ms → 组 SIGKILL」与 `--die-with-parent`/PID namespace 拆除共同提供，测试断言的是宿主可观察行为而非某一行实现。 Rust 侧原生测试（`cargo test`，经 `pnpm --filter tauri-app test:rust` 运行，**15 通过**）另覆盖 `session_bash::tests::never_falls_back_to_a_host_shell`（唯一可执行程序是 `bwrap`，脚本只作为内层 `bash` 的单个 `-c` 参数）、`session_bash::tests::clears_host_credentials_and_exposes_only_the_fixed_session_environment`（宿主凭证不进入会话 shell，环境恰为 `PATH`/`HOME`/`LANG`）、`bash_process::tests::a_missing_isolator_fails_the_command_instead_of_running_unescaped`（隔离器缺失时以 `bash exec failed` 失败，不静默回退宿主）、 `bash_process::tests::cancellation_stops_a_running_process_group` 与 `timeout_stops_children_that_ignore_term_and_closes_their_pipes`、`session_bash::tests::confines_bash_to_readonly_and_writable_grants`、`directory_boundary::tests::*`（绝对/父路径与符号链接逃逸）。仍缺：`reconcile` 仍返回 `indeterminate`（`PROCESS_INDETERMINATE`），外部进程结果无法核对 |
| 隔离工作区 | `git-worktree-manager.test.ts` + `durable-flow-executor.test.ts`：恢复租约、补跑 pending finalization、对已移除工作区幂等；`apps/cli/tests/worktree-run.test.ts`（4 通过）：CLI 宿主装配 `runtime.workspace.mode: worktree` 后节点在 worktree 内执行、脏工作区不被静默删除、崩溃恢复复用同一工作区 | CLI/Tauri 工作区装配及文件/进程/cwd 一致已有证据（见 `doc/todo.md` P1-03）；仍缺用户窗口启动与桌面重启、真实 OCI 及跨主机验收 |

## 8. 本地未完成与扩展的归属

当前本地 P1 按 [todo](../todo.md) 验收：本机崩溃恢复、全部控制入口的同机所有权、实际进程停止确认、工作区/委派可用性、图重算真实窗口、现有消息/receipt/cache/资源清理竞争以及节点级输出契约。

原表中的以下缺口保留为未来扩展，不再阻塞本地 P1：跨主机时钟与 S3/NFS 后端、跨 store authority 迁移、通用 account/allocation/export/import、Storage §5 全记录族布局、可插拔 cache provider、通用 stream 协议和供应商计费幂等。

图级重算与 CLI/Tauri 工作区装配已实现，剩余是本地用户操作/重启/结果收敛验收，不能再次列为尚未开发。原生工作区为当前基线，OCI 独立验收。详见[范围设计](p1-transition.md)。


## 2026-10-21 独立内核验收入口

`libraries/durable-kernel/src/independent-contracts.test.ts` 覆盖多 Session 并发上限、Session 消息幂等与消费确认、接收游标、Task 定向消息、停止确认和 core 入口恢复裁决。`libraries/durable-kernel/tests/ipc.test.ts` 现在由库自身运行，包含超时失败后清理意图的 SIGKILL 恢复；无需 CLI。仓库外制品消费使用 `pnpm --filter @itookit/durable-kernel test:package`，验证 ESM/CJS、三个入口、NodeNext 声明、任务/消息/停机。跨主机传输和物理设备结果核对仍由宿主与适配器提供。


## 2026-10-21 活动汇总与 Harness 组合补证

[活动契约](../../libraries/durable-kernel/src/activity-contracts.test.ts)覆盖多 Task 待办计数、冷读取、旧格式清理责任、仅内容事件不提升活动水位，以及恢复与 Task 完成/新增交错。[Harness 场景](../../libraries/durable-kernel/docs/harness-scenarios.md)覆盖同 Session 协作、跨 Session 请求回复、Session/Task 独立控制、审批后的模型/工具循环重建、文件回调和关闭；真实进程矩阵另验证两进程团队通信及 SIGKILL 后两个菜单恢复。最新库基线为 401 项（349 单元/契约、52 真实进程），不是历史章节中的较早批次数量。

工作台的持久待办总览、刷新恢复和双端 SSE 已通过隔离新源码 httpd 的 7 项浏览器验收，详见[当前实施记录](flow-cli-capabilities-verification.md)。历史表内任务停止三态的专门真实窗口验收、跨主机网络分区、物理外设及掉电边界仍按各自证据判断，不因本轮侧栏验收自动关闭。
