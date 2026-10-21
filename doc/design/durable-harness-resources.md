# Durable Harness 资源表、分配与 Linux 对齐

版本：目标协议 1.1 · 日期：2026-09-08 · 状态：下述编号章节保留完整目标；当前同后端 managed pool/shared、撤权、物理清理及查询已实现，不能再概括为“分配 API 未实现”。

本文与 [主协议](durable-harness-protocol.md)、[Cache 协议](durable-harness-cache.md)、[存储设计](durable-harness-storage.md) 共同定义目标契约。资源所有权、授权、分配及回收以本文为准；当前 API 及完成边界见 [Kernel API](../kernel-api.md) 和 [证据映射](durable-harness-evidence.md)。

## 当前实现基线（2026-09-08）

当前实现以 [resource-api.ts](../../libraries/durable-kernel/src/domain/resource-api.ts)、[public/resources.ts](../../libraries/durable-kernel/src/public/resources.ts)、[managed-resources.ts](../../libraries/durable-kernel/src/infrastructure/seqfile/managed-resources.ts) 为准，历史 feat 记录不是最新 API 清单。

- ResourceRef 当前是 `{ id, scope }`，kind 为 pool/shared；scope 为 kernel 或 session:<id>。authority 与使用方须共享同一事务型 IFileSystem，未提供跨 backend broker。
- `create/share/open/acquire/release/close/read/write` 返回持久请求；`revoke(ref, { requestId, toSessionId, rights?, expectedRevision })` 支持按权限撤销，旧 handle 的 grantEpochs 防止重新 share 后复活。
- `destroy(ref, { requestId, expectedVersion })` 进入 closing，等待占用及物理销毁确认后 tombstone。resource version、grant revision/epochs、claim epoch 和清理 operationId 分别承担自己的并发/幂等职责。
- 可选 physical 绑定 `{ kind, version, externalId }`；宿主 registerResourceAdapter 提供 cleanup/destroy。claim 保持 held/cleanup-pending/released；unknown、超时或不匹配回执不释放容量，重启继续同一清理操作。仍需真实设备适配器和平台故障验收，逻辑 receipt 不能独自证明外部设备已停止。
- `query({ kind, scope?, sessionId?, taskId?, state?, limit?, cursor? })` 查询 resources/claims/requests/grants/cleanups，逐页重验授权，返回 items/nextCursor。这是 live keyset 查询，不是历史快照；存储扫描效率需另行核验。
- managed schema 当前写入 2，兼容读取 1/2；包含 resource/access/handle/claim/request/cleanup 等记录。第 3–4 节的 account/use/allocation/export/import authority 表不是这些记录的同名别称，完整协议仍待实施。

`resources.test.ts` 已有物理清理、未知回执、替换 worker、撤权后重授权、销毁、查询及旧 schema 测试；覆盖与剩余边界见 [目标与实现映射](durable-harness-evidence.md)。不要用这些测试证明全部 1.1 目标或真实跨进程设备隔离已完成。

## 1. 正确对齐 Linux，保留 Harness 的语义

Linux 的 process/thread 区别包含资源共享关系：`clone` 可分别控制地址空间、fd table 等共享；POSIX threads 共享地址空间和打开的 fd 等进程属性。不能把 Linux task 简化为“独立进程”，也不能仅因名字相同就把 Harness Task 当作 pthread。[clone(2)](https://man7.org/linux/man-pages/man2/clone.2.html)、[pthreads(7)](https://man7.org/linux/man-pages/man7/pthreads.7.html)

| Linux 概念 | Harness 对齐 | 必须保留的区别 |
|---|---|---|
| 进程的独立执行状态与资源引用 | Task 的 input/state、控制、退出和私有 binding 表 | Task 是可恢复逻辑工作；不能恢复任意指令、栈或 fd 数字 |
| 同进程 threads 的共享资源 | 多 Task 显式使用 Session shared/resource | 同 Session 不自动共享私有 state、消费游标或全部 handles |
| 内核调度实体与执行上下文 | worker 实际运行 reducer/Effect；Attempt 标记一次有权提交的执行 | Attempt 不是 OS thread；一个 OS 进程可承载多个 Task，Task 可迁移 worker |
| fd table entry → open file description → 文件/设备 | Task binding → use（如需游标/打开实例）→ resource；grant 决定准入 | 资源定义、使用实例、授权与容量占用分开；相同 resource 不自动共享游标 |
| session / process group | TaskGroup 的组控制可参考 job control | Harness Session 是持久命名空间、事务与生命周期域，不等同于 POSIX session |
| cgroup 资源层级 | authority→Session→Task/Effect 的配额和使用记账 | logical quota 不自动限制宿主 CPU/RAM；需要 adapter/sandbox 实施物理约束 |

Linux fd 是进程表索引，open file description 保存 offset/status；复制 fd 可共享同一 description。这里采用相同的“引用与对象分离”原则，不照搬 fd 生命周期。[open(2)](https://man7.org/linux/man-pages/man2/open.2.html)

Linux session/process group 用于 shell job control；cgroup controller 承担分层资源分配。两者不能混称为资源分配表。[credentials(7)](https://man7.org/linux/man-pages/man7/credentials.7.html)、[cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)

这些对应是设计类比，不声称 Session 提供 OS 级隔离。认证宿主必须绑定真实调用主体；调用方传入的 taskId/sessionId 不是权限证明。恶意 reducer 与可信 Kernel 共处同一 JS 进程时，逻辑 capability 不能替代进程/sandbox 隔离。

## 2. 对象与身份

**资源存在、获准使用、容量已分配、实际已消费是四件不同的事。** `grant` 不预留容量，`bind` 不重复计费，`release` 不退款已产生的成本，`close binding` 不自动销毁资源。

所有新增记录具有 `schemaVersion`、稳定 `id`、CAS `revision`、创建/更新时间及必要的因果身份。核心引用为 `{ authorityId, resourceId, incarnation }`；authorityId 指向唯一分配/变更权威，资源重新创建必须使用新 incarnation，旧引用不得匹配新对象。

| 对象 | 必要信息 | 职责 |
|---|---|---|
| Authority | authorityId、固定 storage binding、service endpoint、ownerEpoch、服务状态 | 唯一资源分配与仲裁域；worker 可以更换 |
| Resource | ResourceRef、kind/schema、ownerRef、creatorRef、lifecycle、state、dataVersion、adapterRef、容量维度 | 资源本体；owner 与最初创建者分离 |
| Grant | grantId、ResourceRef、issuer、grantee Session/Task、rights、parentGrantId、revision、期限/撤销 | 授权链；不扩大权限、scope、期限或可委派上限 |
| Binding | sessionId/taskId/name、bindingId、grantId/importId、useId?、closePolicy | Task 私有的逻辑引用表，name 可读但稳定 bindingId 防止名称复用混淆 |
| Use | useId、ResourceRef、持有者、打开模式、cursor/version 或外部 operationRef、close 状态 | 按需表示打开实例；显式区分共享 use 和新 use |
| Account | accountId、parentId、subject、dimension/unit、limit、reservation/usage 汇总、policy | 配额与预算；一个 dimension 的账务由同一 authority 裁决 |
| Allocation | allocationId、requestId、ResourceRef、grantee、accountIds、quantity、mode、lifetime、state、lease/fence、effectId? | 稀缺容量、独占许可或预算预留；permit 是 allocation 的一种模式 |
| Usage | usageId、allocationId、logicalOperationId、amount/unit、settlementRevision、证据 | 成本结算与审计；不可通过 Attempt 重放重复扣除 |
| ResourceRequest | requestId、指纹、申请/释放/续期类型、等待/结果、deadlineAt、receipt | 幂等命令及容量等待；不依赖临时 RPC 连接 |

`ownerRef` 是 `{kind: session, sessionId}`、`{kind: task, sessionId, taskId}` 或 `{kind: service, authorityId}` 的显式联合。task-owned 资源的清理责任归其 Session，owner Task 终态不使清理责任消失。Session/shared 资源的使用不得要求 creator Task 仍存在。

record revision、resource incarnation、dataVersion、authority ownerEpoch、allocation fence 和 cache generation 分别用于 CAS、对象身份、内容版本、服务所有权、占用 fencing 和缓存失效，不能混用一个 generation 承担全部职责。

## 3. Session 内资源分配表

Session 逻辑资源表由以下几组权威记录组成，统一放在 `resources.seq`，按 Task 展示的是这些记录的查询视图，不是第二份账本。

| 表 / key | 写入方 | 内容与约束 |
|---|---|---|
| `resource/<resourceId>` | 本地 authority | Session/task-owned 本体；外部资源只建 import，不能伪造本地本体 |
| `handle/<grantId>` | 授权 authority | 兼容当前 handle 命名；目标 schema 扩展 Session/Task grantee，显式撤销和闭包检查 |
| `binding/<taskId>/<name>` | Session Kernel | 该 Task 的 bindingId、handle/import/use；Task 不直接编辑其他 Task 表 |
| `use/<useId>` | 对应资源 authority | 可选打开实例；关闭/游标更新/消费需幂等与并发协议 |
| `account/<accountId>` | 分配 authority | Session 根、Task/Effect 子账户；不以 Resource.parentResourceId 隐式替代账务父关系 |
| `allocation-request/<requestId>` | 分配 authority | 指纹、排队次序、deadlineAt、granted/rejected/cancelled/timed-out 结果 |
| `allocation/<allocationId>` | 分配 authority | 容量预留/持有、预算预留、归属、release/cleanup 状态 |
| `usage/<usageId>` | 分配 authority | 幂等结算记录，和账户汇总在同一事务更新。**内核侧已实现（2026-09-11 第五十二轮）**：`Kernel.chargeBudget`/`SessionBudgetApi.chargeBudget` 接受 `{ usageId }`，`chargeBudget` 在同一事务内写 `usage/<usageId>` 回执（`BudgetUsage { usageId, resourceId, dimension, amount, accounts, settledAt }`）；同 id 重放返回记录的回执不再扣费，金额/资源/维度不同即冲突。Effect 路径由内核默认按逻辑 Effect 结算（`effect:<effectId>:<handleId>:<dimension>`），Adapter 不必自己传 id；未提供 `usageId` 的宿主直调保持「每次调用都扣」的旧语义。回归 `libraries/durable-kernel/src/kernel.test.ts`「settles a budget charge once per usage id and refuses a conflicting replay」「charges effect-driven usage once per logical Effect even when the attempt is retried」 |

默认每个 Task 有独立 binding 表，不提供隐式 `CLONE_FILES`。spawn 可声明 bindings：派生降权 grant + 新 binding；有状态 use 默认新建，只有显式 `share-use` 才共享游标/交互实例。分配给父 Task 的独占 allocation 不因派生 grant 自动复制给子 Task。

Session-owned 资源的授权根绑定 Session owner，creator 的管理 handle 是其中一个授权，不能成为所有长期使用者必经的 task-lifetime 根。需要跨 creator 生命周期的 grant 由 Session owner 命令签发并记录授权理由；不能通过派生短期 grant 静默延长期限。Task 终态关闭自身 binding，并按 grant 明确期限/撤销策略收敛；close binding 不等于级联 revoke。必须撤销的父 grant 若仍有长期使用者，应先经 owner 显式重新授权，否则按协议拒绝后续使用，不能只保留 ownerRef 却留下已失效授权链。

共享 use 必须采用单消费者或明确的竞争消费协议；对于 workspace 等共享可变资源，grant 的 write 权限也不替代 CAS/锁定策略。跨 Task use 的关闭只减少该持有者引用，最终 close 需根据引用和 owner 策略决定。

标准槽位采用类型化名称 `inbox`、`events`、`diagnostics`，workspace/model/cache 使用显式业务 binding 名。CLI adapter 可映射到 fd 0/1/2；Kernel 不强制把 inbox/EventJournal 当字节流，公共协议也不依赖数字 fd。

本地 allocate 的检查、账户预留、allocation/request receipt、Task Decision/等待输入和 journal 在同一 Session 事务内提交。容量不足返回 rejected 或持久 pending，不能让 reducer 持有数据库事务等待。资源 owner 创建必须具备 create/admin 能力；当前便利 API 不能推导出任意 Task 都有创建无限资源的权限。

Task 观察视图至少返回 resource/grant/binding/allocation 身份、权限、单位与数量、状态、期限、blockedReason、可用操作及 authority revision。Session 观察视图按 Task 汇总，但必须标注授权额度、预留额度、实际占用与累计消费，不能统一显示为 used。

## 4. 不同 Session 间的资源分配表

**共享资源只有一份分配 authority。** 它可以是长期 service Session，其 `resources.seq` 维护跨 Session 分配表；普通消费 Session 保存 import 和请求/回执。不要求新增一份所有 Session 都可写的全局 KV。

```text
<authoritySessionRoot>/
  resources.seq
    authority/<authorityId>             # ownerEpoch/服务实例屏障
    resource/<resourceId>               # 共享本体/容量
    export/<grantId>                    # 授予目标 Session 的契约
    handle/<grantId>                    # Task 级子授权（若派生）
    account/<accountId>                 # 根/各 Session/Task 配额
    allocation-request/<requestId>      # 申请、等待及幂等结果
    allocation/<allocationId>           # 唯一占用事实
    usage/<usageId>                     # 唯一结算事实
    subscription/<subscriptionId>       # 授权、版本及分配状态通知
  messages.seq                         # 命令消费与回复 outbox

<consumerSessionRoot>/
  resources.seq
    import/<importId>                   # export/authority 引用及观测版本
    binding/<taskId>/<name>             # Task 本地绑定
    remote-request/<requestId>          # 请求意图、取消意图、结果 receipt
  messages.seq                         # 请求 outbox、回复 inbox
  tasks/<taskId>/task.seq               # 固定输入、wait 与业务 checkpoint
```

Export 必须包含 issuer authority、ResourceRef、granteeSessionId、rights、允许子授权范围、accountId、期限、撤销版本及状态；owner 以认证 envelope 校验消费 Session 及 Task 主体。Import 包含 authorityRef、exportId、观测 epoch/revision、local status 与 receipt，不持有可自行修改的“全局剩余额度”。

Task 子授权通过 owner 命令登记，不能将本地伪造的 handle 当远端 grant。基础协议不允许断连期间自行签发全局容量许可。若未来支持离线委派，需要单独的 escrow 容量守恒与撤销协议；不能用缓存的 limit 实现。

默认共享池动态仲裁每次 allocation，并校验各 Session/Task 的上限；各 Session 上限之和可以超过总容量，因为上限不代表承诺。若业务要求保底容量，必须显式在 authority 预留 capacity slice，分区之和不得超过根容量；这是不同的 account policy，不能把 weight 当保证。

跨 Session 请求顺序：

1. 消费方提交 Decision + remote-request + outbox，等待稳定 requestId 的结果。
2. authority 消费请求，在一个本地事务内校验 grant、生命周期、额度和 request deadline；写 request/allocation/account/usage（适用时）及回复 outbox。
3. 消费方接收回复并去重，把 receipt 与业务输入原子提交。只有 owner-confirmed allocation 才能进入外部执行；投递 ACK 不等于分配成功。

响应丢失重发同 requestId，指纹不同拒绝；owner 已分配但回复未到不能再分配第二份。消费方取消/超时不回滚 owner 的既有 allocation，必须发送幂等取消/释放命令。先到取消须保存 tombstone，阻止后到旧申请重新分配；先到成功则按释放协议收敛。独立资源命令 channel 在业务 Task 终态后仍承接已登记操作的清理和回执。

所有跨 authority 的组合申请采用显式 Saga；允许部分预留但不启动业务，失败则释放，设置有限期限及固定申请顺序，暴露 partial/blocked。若业务要求全有或全无且不接受补偿，必须将其合并到一个 authority 事务域，不能承诺跨文件系统原子提交。

## 5. 容量、预算、速率不能混算

| 维度 | 例子 | 记账与释放 |
|---|---|---|
| gauge / permit | GPU 数、浏览器槽、并发 LLM、占用 bytes | held 包含预留、运行、释放中及未确认停止；确认安全后释放容量 |
| cumulative budget | token、货币、累计请求量 | reserve→settle；已消费不随 Task 取消回滚；未知成本保留预留/未结算 |
| rate | 每分钟请求、token 吞吐 | authority 保存时间窗口或 token-bucket 状态；不能重启清零绕过限制 |
| scheduling weight | Session 之间的分配优先权 | 只决定公平调度，不代表已授权、已预留或最低保证 |

同一 authority 对每个受约束账户保存子树聚合量：`heldSubtree <= capacity` 或 `spentSubtree + reservedSubtree <= hardLimit`。每个 allocation 在每个 dimension 只属于一个叶账户，提交时原子更新该账户及唯一祖先链；汇总报告不能把父子数字再相加。数据模型拒绝账户环路和重复计入同一祖先。一个申请同时约束多个维度时，在该 authority 事务中全部预留成功才 granted。

预算金额使用明确单位的非负整数（如 microcurrency），不能将浮点舍入误差当剩余额度。预留 30、最终消费 12 时，一次幂等 settlement 将 reserved 减 30、spent 加 12；释放的是差额 18。若实际可超出预留且 adapter 无法硬限制，只能声明软预算，真实超支必须入账并阻止新申请，不能丢弃超支事实维持表面不变量。

示例：共享浏览器池容量 4，A Session 上限 2、B 上限 3。A 持有 2、B 持有 1 时，根剩余 1；B 再申请 2 必须等待或拒绝。A 的两个 Task 各占 1，父账户显示 2，根计算一次；两份本地 import 不能各自再产生 4 个槽位。

## 6. Allocation、等待与抢占生命周期

申请状态：`pending → granted / rejected / cancelled / timed-out`，终态幂等且不可回退。Allocation 状态：`reserved → active → releasing → released`，也可进入 `reconciling/blocked`；进入 releasing/reconciling 不释放容量。

申请记录具有稳定 queueSequence、priority/公平策略、requested quantity、deadlineAt。基础策略为 authority 内确定性的队列规则，公平性不能只依赖遍历文件顺序；可配置受限的跳过大请求，但必须有老化/阻塞可见性，不能宣称无条件无饥饿。

容量检查与申请排队在同一事务，容量变化与选择申请、预留、结果 outbox 同事务。WaitSet 等待 request 结果，`resource-version` 只表示有变化，不等于取得容量。跨 Session 等待均转成本地 inbox 输入。

allocation lifetime 显式为 step/task/effect/session 或带期限的 owner-managed。Attempt 重试不重新 allocate；请求身份绑定逻辑工作，不绑定 workerId。跨多步长期占用绑定 Task/use；执行特定外部操作的许可绑定 Effect，并额外校验执行该 Effect 的 attempt fence。

Task pause/interrupt 保留 state、bindings 和授权；资源的 `onPause: retain | release-after-cleanup` 必须显式声明。retain 仍占配额并按 owner 策略续租/收费，不能因停止 reducer 就视为免费。release 后恢复须重新申请，不能复用旧 fence；cache/state 所需引用不因释放临时 GPU 等资源而删除。

lease 到期首先禁止旧持有者新操作。只有资源端能够 fence 旧执行且已确认物理容量可复用，或 cleanup/reconcile 已确认停止，才允许重新分配。单纯阻止旧写入未必释放 GPU/浏览器槽；无法确认时 blocked 并继续占账。取消未知 Effect 不得立即退款预算或释放仍在运行的资源。

撤销 grant 阻止新使用，已有 allocation 按 drain/cancel 策略关闭；撤销确认与物理停止确认分开。释放、续期、结算都核验 allocation identity、当前 fence 和幂等 requestId，旧 worker 不能释放新持有者的许可。

## 7. Authority 恢复、关闭与迁移

authority 是持久逻辑服务，不是创建资源的进程。首次创建固定 authorityId→storage binding；Catalog 仅保存发现投影。authority leader 的 ownerEpoch 在该权威存储中 CAS 递增，所有修改验证 epoch；缓存路由不能决定所有权。

**内核侧骨架已实现（2026-09-11 第五十一轮）**：`resources.seq.managed/authority/<id>` 保存 `{authorityId, ownerEpoch, ownerId, binding, serviceEndpoint, status, updatedAt}`；`ResourceApi.claimAuthority(id, {ownerId, expectedEpoch, binding, serviceEndpoint, scope})` 首次声明写入 epoch 1，接管必须提交观察到的 `expectedEpoch` 并 CAS 递增，否则报 `Authority epoch conflict: <id> is owned by <owner> at epoch <n>`；`ResourceApi.authority(id, scope?)` 只读；声明了 `binding` 的接管必须与首次记录一致，否则拒绝（不同物理 store 的显式切换屏障仍未实现）。写命令可携带 `authority: {authorityId, epoch}`：命令在该权威事务内校验 epoch，过期 leader 的**新**写入被拒绝；已受理请求的重放仍返回原结果（幂等事实优先于 fence）。回归 `libraries/durable-kernel/src/resources.test.ts`「fences a superseded authority leader by the ownerEpoch it presents」「keeps the authority binding fixed to the first claim and survives Kernel reconstruction」「rejects invalid authority claims and epoch presentations」「refuses a Decision resource write whose authority epoch was superseded」（Task Decision 内的资源命令同样被 fence，整笔 Decision 回滚）。

服务 worker 更换在同一 authority store 完成 fencing；资源端 adapter 必须识别相应执行令牌。迁移到不同物理 store 不在基础热迁移承诺内：需要停止新申请、固定一致性快照、建立单一切换屏障并证明旧 authority 无法再写，否则禁止两个 store 同时受理。迁移请求/进度放 `session.seq.work/<id>`，不能仅改 Catalog URI。

消费 Session close 拒绝新申请，继续接收已登记回复并发出释放/结算/退订命令；未收敛时 closing 显示 blockers。owner Session close 必须先迁移资源责任、冻结只读或完成撤销清理；消费方 suspended 不等于放弃 allocation，owner 暂不可用也不授权客户端自行接管。

资源 destroy 经 `active → closing → tombstoned → reclaimed`；停止新授权/申请后，等待 allocation 清理、订阅收敛与 pin/引用释放。删除 grant binding 与物理内容回收分开；保留重放所需 identity/tombstone 和 receipt。Task 归档前完成 task-owned 资源清理或显式移交；Session/shared 资源仅记录 creator provenance，不依赖已归档 Task 本体。

## 8. Cache、Artifact 与 Harness 使用方式

- step/task cache 的 lifecycle owner 是对应逻辑工作；session cache 的 owner 是 Session；跨 Session cache 的 owner 是 authority service。creator 仅用于审计，不能作为 Session cache 的可用性前提。
- cache grant 控制可见与管理权限，account 控制 namespace/容量预算，entry usage 控制 reusable/single-use；这三者不能用一个 Handle 替代。领取 single-use 与 Task receipt 同事务；跨 Session 由 owner 原子领取并登记回复，消费 Session 再固定 receipt，重投返回相同结果。
- 同一个发布实例使用不可复用 entryId，或在 namespace lifetime 内不回退的版本计数与 tombstone。淘汰 value 后重发同 publish operationId 只能返回原回执，不能复活已消费值；新发布产生新实例。
- 派生 bytes 可以提前淘汰；Task 已选输入和不可变 artifact 的 durable pin 是恢复义务。物理共享 blob 由唯一 storage account 记账，各 Session 使用引用/逻辑配额，不能因为本地引用删除就回收其他 Session 正在使用的 blob。
- workspace、交互式浏览器、TTY 等 use 需要说明能否重新附着；不能附着的宿主 PID/pipe 丢失后进入 reconcile/indeterminate 或显式新操作。Program 不直接保存 fd、socket、Promise。
- LLM token chunk 默认为观察事件，最终结果作为持久输入；Task 间增量计算必须使用主协议的持久业务 stream。标准 diagnostics 不获得业务消息的消费义务。

声明式目标操作为 resource-create/bind/grant、resource-request、resource-release/renew、budget-settle、resource-subscribe/unsubscribe；命令都带 requestId，异步结果进入 Task 输入。跨 Session 操作编译为 owner 消息，不能让 reducer 做网络 I/O。名称是目标操作分类，尚非当前 TypeScript API。

## 9. 实施与迁移验收

当前 `ResourceRecord/ResourceHandle/BudgetAccount` 仅提供本地定义、Task grant 链及祖先扣费。**authority 目前只有 ownerEpoch/绑定/读接口与写命令 fence（见 §7）**；本文的完整 allocation、account、export/import（跨 Session 授权、订阅、授权额度与预留账本）仍未实现。新增表必须由 versioned manifest 标记，不能按缺省值把旧 `used` 解释为 reserved/held。

迁移保留原资源和 handle ID、grant 链、使用记录；旧 resource 的 owner 默认按原 Session 归属解释，创建 Task 只作为初始 handle holder。cache 单独按 scope 推导 owner，迁移前禁止清理其依赖的 creator 记录。旧 budget 的 dimension 经明确映射后才可转为累计 spent；并发/存量/含义不明的维度需核对，不能自动按累计消费迁移。账户父树与资源包含树分别验证。

迁移在关闭新 claim 的屏障内完成，保留旧快照及 migration receipt；切换后只有一种 schema 是写入权威，禁止双写为两份独立分配账本。

| 验收 | 必须观察到的结果 |
|---|---|
| 同 Session 两 Task 争用 1 个槽位 | 只有一个 allocation 生效，另一个持久等待 |
| 两 Session 并发申请共享池最后容量 | authority 守恒，无本地 import 超配 |
| owner 分配后回复前 kill | 相同请求返回同 allocation，不重复预留 |
| 取消先于申请到达 owner | tombstone 阻止旧申请获得容量 |
| worker 更换及旧释放请求到达 | 旧 fence 不能释放新 allocation |
| permit 到期但外部操作仍运行 | 不重分配物理容量，blocked 可观察 |
| 预算结算后回执丢失 | 同 usageId 重试不重复扣费，未知成本不退款。内核侧已于 2026-09-11（第五十二轮）实现 `usage/<usageId>` 幂等结算回执与 Effect 默认结算 id，见 §6 表注；真实后端（供应商侧重复计费核对）仍未验收 |
| Session cache 创建 Task 被归档 | Session owner 与合法使用者仍可访问，原 Task state 不需保留 |
| 导出撤销、consumer 暂停后恢复 | 新操作拒绝；旧使用按既定策略收敛，不能凭缓存授权执行 |
| owner leader 迁移后旧 leader 写入 | authority epoch 和资源端 fence 拒绝旧执行 |
| stream/消息/receipt 保留期与 GC 竞争 | 未消费输入和 pin 不丢失，过期观察游标明确 resync |

完整支持须通过真实后端多进程竞争、kill/restart 和 adapter fencing 验收。本文修复设计，不将这些验收或新增 API 标记为已完成。

### 能力资源创建回执

低层 `ResourceSpec`/`TaskResourceSpec` 增加可选 requestId，按 owner Task 隔离。Kernel 以 kind/uri/rights/parentResourceId/parentHandleId/metadata 生成规格指纹，资源、句柄、resource.created 事件和创建回执在同一 resources.seq 事务写入。相同 Task/requestId 和规格重放读取当前资源/句柄，不再创建或追加事件；不同规格冲突。已有撤销状态保留，重放不重新授权。未提供 requestId 的调用沿用每次创建新资源的语义。此处是 LLM/tool 等能力资源入口，不替代 managed pool/shared API 的既有请求协议。

### Authority 接管审查（2026-09-14 工作树）

Session 调用方只能 claim 自己的 `session:<id>` 作用域，不能通过 scope 参数接管 kernel 或其他 Session 的 authority；Kernel 宿主调用方仍可管理显式作用域。接管参数在异步读取前复制，绑定标记须非空，epoch 达到 Number.MAX_SAFE_INTEGER 后拒绝递增且不改变持久记录。两项越权/溢出回归已复现并修复，内核 240 项与类型检查通过。

资源与 authority 的持久绑定已补齐，见下方 2026-09-14 事务隔离记录；执行端 token 校验及跨 store 切换仍未完成。


## 2026-09-14：托管资源 authority 事务隔离

资源创建时携带 authority 会把 `authorityId` 持久绑定到资源；share/revoke/destroy/open/acquire/release/close/write 必须提交同一 authority 的当前 ownerEpoch，省略、替换身份或旧 epoch 均拒绝。接管以 expectedEpoch CAS 递增，Session 不能接管其他作用域，安全整数溢出拒绝且事务回滚。已完成请求重放原回执；尚未分配的排队申请在接管后失败，已有 claim 保留至明确释放。读取沿用既有授权规则。

首次 claim 将该资源存储升级到 managed/schema=3，后续普通写入不降级；只支持 schema 1/2 的旧 managed-resource 实现拒绝访问。既有未绑定资源保持原行为，不猜测或自动迁移 authority。binding 仅是当前存储内不可变标记，不证明其他独立存储不能建立同名 authority。

本批只完成同一事务存储内的资源命令隔离。物理 adapter 的执行端 token、接管前已开始的外部操作、跨 store 迁移屏障与真实多主机故障矩阵仍待完成，P1-05 保持开放。

隔离提交快照验证：durable-kernel 239、llm-flow 213、llm-session 116、kernel-adapters 111、app-core 92 项通过，共 771 项；Kernel/CLI 类型检查与文档检查通过。资源回归含同存储两个 Kernel 并发 CAS、重建、身份省略/替换、排队接管、schema 升级与 Decision 回滚；不作为真实多进程或物理执行端验收。
