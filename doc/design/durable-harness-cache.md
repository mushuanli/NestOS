# Durable Harness Cache 控制协议

版本：1.1 · 日期：2026-09-05 · 状态：目标设计，核心部分已实现；owner、跨 Session 分配及保留契约修订待实施。

实施进度：step/task/session cache、显式选择、TTL、授权、失效/续期和持久 receipt 已落地；跨 Session owner、provider cache 和大内容存储仍待实现。当前 API 与证据见 [Kernel API](../kernel-api.md) 和 [证据映射](durable-harness-evidence.md)，早期取舍见 [实施记录](../feat/durable-harness-implementation.md#4-task-管理与选择-cache)。下述协议描述完整目标，不是当前 API 的逐字定义。

本文补充 [Session / Task 协议](durable-harness-protocol.md)，回答 cache 是否一次性、是否限于本 Task、Task 能否管理及选择 cache，以及这些选择如何影响中断恢复。当前已实现核心能力，不能视为完整实现本文协议。namespace、entry 与 Task receipt 的存放位置及删除约束见 [持久存储与文件组织](durable-harness-storage.md)。

## 当前实现基线（2026-09-08）

当前接口以 [domain/cache.ts](../../backend/durable-kernel/src/domain/cache.ts) 为准，事务实现见 [cache-store.ts](../../backend/durable-kernel/src/infrastructure/seqfile/cache-store.ts)。以下编号章节仍描述完整目标。

- `CacheSpec` 支持 `step/task/session`、`reusable/single-use`、可选 `ttlMs` 和 namespace 容量；默认 task/reusable、256 entries、4 MiB。没有独立 retention 字段、聚合 Task/Session 容量预留或 pin。
- `CacheRead` 使用 `operationId`、有序 `sources: { handleId, key, fingerprint, expectedVersion? }[]`、顶层 `maxAgeMs` 和四种 mode。新操作先校验并授权全部显式来源，再选择首个命中；`refresh/bypass` 也校验来源，返回 bypass。`cache-only` 未命中返回 miss，由调用方决定后续行为；没有 `allowStale` 或隐式写入目标。
- read 将小 JSON 值复制到 Task receipt，与 single-use 领取同事务提交。相同 operationId/请求重放原结果，不重新读取 cache 或再次检查 handle；仍要求调用 Task/Session 的生命周期允许操作。请求内容不一致报冲突。无效来源、模式和版本不会写 receipt 或消耗 single-use 值。
- publish 使用 `expectedGeneration` 和可选 `expectedVersion`；null 要求本代没有现存 entry，省略则不做版本 CAS。每 key 的独立发布序号跨容量淘汰保留，避免旧版本身份复用。容量回收按发布时间保留较新项，不是 LRU；receipt 与版本序号不计入 entry 容量。
- invalidate 增加 generation；renew 增加 generation 并仅延长当前代仍存活、未消费的 entry，不能复活过期或已消费值。TTL 必须为正有限值且绝对期限不超过安全整数上界；generation 耗尽时拒绝变更。
- Task 的 `cache-create/cache-invalidate/cache-renew` action 有 operationId 持久回执；宿主 `CacheApi.create/invalidate/renew` 本身没有 operationId 参数。list 返回当前获授权列表，尚无分页。

**Task 终态清理（2026-09-11 已实现）**：`cleanupTaskCachesTx` 在 Task 进入终态的同一事务里删除该 Task 拥有的 `step`/`task` scope namespace、其全部 entry 与每 key 发布序号、`resource`/`handle` 记录，并追加 `cache.cleaned` 事件；`session` scope 的 namespace（及其 owner 索引）保留，创建者 Task 归档后其他 Task 仍可凭 grant 读取。artifact 族资源、`effect/<id>` 幂等事实与 `cache-operation/<id>` 回执不在清理范围内。为免每次终态全量扫描 `resources.seq`，`createCacheTx` 同时写入可重建的 owner 索引 `cache/owner/<taskId>/<namespaceId>`，清理只遍历该前缀。回归：`protocol.test.ts`「cleans Task-scope cache at Task terminal while keeping session scope and other facts」。

**Session 关闭时的物理回收（2026-09-11 第二轮，同日）**：`cleanupSessionCachesTx` 在 Session 转为 `closed` 的同一事务里删除该 Session 的全部 cache namespace（含 `session` scope）、entry、发布序号、owner 索引与 handle/resource，并追加 `cache.cleaned`（`scope: session`）。`closed` 转换前已校验没有未结束 Task，且 cache 操作对 closed Session 一律拒绝，因此回收时不可能存在活跃引用；artifact 族资源与幂等事实同样不动。回归：`protocol.test.ts`「reclaims every cache namespace when the Session closes, including session scope」。

跨 Session owner、provider cache、artifact 大值、容量账本与跨 Session 的 retention/GC 竞争仍待实施。当前 namespace 的 `ownerTaskId` 记录创建者，Session scope 授权不要求该 Task 本体仍存在。基础回归见 [protocol.test.ts](../../backend/durable-kernel/src/protocol.test.ts)；独立进程竞争与提交前/后 SIGKILL 回执原子性见 [LocalFS IPC 测试](../../apps/cli/tests/20-kernel-ipc.test.ts)，覆盖根后端和非根挂载、失效后的原回执重放；本轮实测 durable-kernel 全套 189 项通过（其中 protocol.test.ts 112 项）、20-kernel-ipc 所属 vfsdriver-local 54 项通过，不能替代上述扩展的验收。测试计数随代码演进，以实际测试输出为准。

## 1. 设计裁决

**Cache 是可丢弃的派生数据资源；作用域、保留期限和使用次数独立配置。Task 可以管理获授权的 cache，并显式选择读写目标。恢复事实不依赖 cache 一定存在。**

| 数据类别 | 例子 | 是否可以按 cache 淘汰 |
|---|---|---|
| 权威状态 | Task state、checkpoint、mailbox、SharedState、ContextCommit | 否，按各自持久协议管理 |
| 外部操作事实 | Effect 结果、幂等记录、未结算预算 | 否；删除后可能重复副作用 |
| 可重建 cache | 文件解析、检索结果、编译中间产物、已允许复用的计算结果 | 是，miss 后按策略重建或报告缺失 |
| Provider cache | adapter 管理的远端上下文/prompt 缓存引用 | 由 adapter 声明能力；Kernel 不假定可枚举、删除或延长 |
| 一次性工作输入 | 消费后不再交付的任务数据、命令 | 若丢失不可接受，使用 mailbox/持久工作队列，不使用 cache |

“必须保留才能继续”的数据应存 Task state 或 artifact。Cache 可以持久化以提高重启命中率，但仍不获得权威状态的语义。

## 2. 三个独立维度

### 2.1 Scope：谁可以使用

| scope | 所有者和默认可见性 | 典型用途 |
|---|---|---|
| step | 当前 Task 的逻辑 step；同一步重试可复用，其他 step 不自动可见 | 一次解析/检索阶段的中间结果 |
| task | 当前 Task；默认不对 parent/children 开放 | Agent 多轮计算中的派生数据 |
| session | Session；Task 必须获得显式 cache handle | 同 Session 多 Task 共享解析/索引结果 |
| shared-resource | 稳定 owner endpoint 管理；跨 Session 显式授权 | 跨 Session 的共享派生数据 |

worker/process-local 是存储层级而非权限 scope：可以作为上述 cache 的 L1，但不能通过 scope 绕过授权。child 不继承 parent cache 的可见性；spawn 的资源绑定显式列出 cache handles、rights 和子命名空间。

ownerRef 与 creatorRef 必须分离：Session scope 的 owner 是 Session，不能要求创建 Task 在归档后仍存在；shared-resource 的 owner 是稳定 authority service。Session 内 account/allocation 与跨 Session export/import 按 [资源协议](durable-harness-resources.md) 分配容量和授权，grant 本身不预留容量。简化重构已移除 Session cache 授权检查对创建 Task 本体的依赖；namespace 仍保留 ownerTaskId 作为原始记录，grant 链、完整 owner schema 迁移与 GC 仍需各自处理。

### 2.2 Retention：希望保留多久

- `until-step-complete`：逻辑 step 成功后可清理；Attempt lost 不等于 step complete。
- `until-task-terminal`：pause/interrupt 不清理，Task 终态后可清理。
- `until-session-closed`：Session suspended 不清理，closed 后可清理。
- `ttl`：首次发布时确定绝对 expiresAt，重启不重置。默认没有 sliding TTL。
- `owner-managed`：无自动时间到期，owner 主动失效或释放；仍可能因容量/后端故障丢失。

命名空间与 retention 并非任意组合：step scope 不能超过 step 生命周期，task scope 不能超过 Task 生命周期，Session scope 不能超过 Session 生命周期；TTL 可进一步缩短。需要跨生命周期保留时显式复制到较宽 scope 的授权 cache，或 promote 成 artifact。

保留期限是最长可命中边界，不是保证存在的最短期限。容量不足允许提前淘汰；有限 pin 只是受配额约束的保留请求，不能代替 durable checkpoint。

### 2.3 Usage：能用几次

- `reusable`：有效期内可反复读取，默认模式。
- `single-use`：每个 entry version 最多向一个持久读操作成功交付一次；不是“进程内 get 后 delete”。

entry version 必须具有不可复用的发布实例身份：使用稳定 entryId 或不回退版本计数与 tombstone。容量淘汰/GC 后同 key 新发布不得与旧实例混淆；同 publish operationId 重放只返回旧回执，不能复活已领取值。跨 Session single-use 在 owner 事务中完成领取和回复 outbox，消费 Session 固定同一结果，不承诺跨两个 store 的直接原子读取。

因此，“一次性”至少有三个不同含义：只在一个 step 可见、只活到 Task 结束、只能成功交付一次。调用方必须选择对应维度，不能统一叫 ephemeral。

默认配置：`scope=task`、`retention=until-task-terminal`、`usage=reusable`，可附加 TTL；默认容量受 Task/Session 预算约束。无 cache 授权时不自动搜索其他 Session 或全局缓存。

## 3. Task 能管理什么

Task 通过声明式 cache action/broker 管理数据，不直接读写共享进程 Map。控制面也可以使用相同带权限的接口进行运维操作。

| 能力 | 权限 | 语义 |
|---|---|---|
| create namespace | create grant + scope quota | 在允许的 scope 创建自己的 namespace |
| list/stat | read-metadata | 分页查名称、标签、版本、大小、有效期；不泄露未授权内容 |
| read/select | read | 显式选择 namespace/key/version，得到 hit/miss/stale/rejected 等结果 |
| publish | write | 发布完整 immutable entry version；不允许把不完整 chunks 标成完整结果 |
| invalidate/delete | invalidate | 逻辑撤销未来命中；后台物理回收异步完成 |
| renew retention/pin | manage-retention | 受 scope 上限、quota 和 expectedVersion 约束 |
| promote | read + artifact-write | 将选中值转为不可变 artifact，脱离 cache 淘汰生命周期 |
| share/grant | grant | 向指定 Task/Session 显式授予子集权限 |

Task 只持有自己 namespace 的默认管理权；Session/shared cache 的权限由 owner 授予。读取 Session cache 不自动获得删除全部内容的权利。clear namespace 使用 generation bump；已在途旧 generation 的填充不能重新发布到新 generation。

## 4. 如何挑选 cache

使用有序且显式的读选择器，不做隐式全局 fallback：

```ts
interface CacheSelection {
  sources: Array<{
    handleId: string;
    namespace: string;
    key: string;
    expectedVersion?: string;
  }>;
  mode: 'prefer-cache' | 'refresh' | 'bypass' | 'cache-only';
  freshness: { maxAgeMs?: number; allowStale?: boolean };
  writeTarget?: { handleId: string; namespace: string; key: string };
}
```

- prefer-cache：按 sources 顺序选第一个授权、依赖匹配且满足 freshness 的结果；全部 miss 后才执行已声明的计算/读取。
- refresh：忽略现有命中，计算后向 writeTarget 发布；并发发布仍校验 generation/version。
- bypass：不读也不写 cache，用于本次明确重新执行；不绕过 Effect 的幂等和 reconcile。
- cache-only：不执行 fallback，miss 作为显式业务输入返回；需要等待或失败由 Program Decision 决定。

writeTarget 独立于读取来源；从共享 cache 命中不意味着获得共享写入权。没有 writeTarget 时不填充。默认只接受 fresh；allowStale 仍不能接受权限失效、schema 不兼容、源版本不匹配的数据。

配置采用“约束交集 + 显式覆盖”：平台/Session 设定权限、scope/TTL/容量上限；Task 声明默认选择器；单个 action 可以改 sources/mode/freshness，但不能扩大授权。Task 可以通过 list/stat 挑选 namespace/key；不能自动把整个 cache namespace 注入 LLM 上下文。

示例：Agent 优先读本 Task `parsed-files`，再读获授权的 Session `parsed-files`；key 绑定文件内容 hash 和 parser 版本，miss 后执行解析，并只写回自己的 Task namespace。若需要共享成果，再显式 publish 到获授权的 Session namespace。

## 5. Key、依赖与失效

Cache key 的有效身份包括 namespace generation、schema、producer/program/adapter version、规范化输入 hash 和 dependency fingerprint。scope/tenant/授权边界参与分区，不能只按 prompt 文本或路径字符串共享。

例如文件解析 key 必须绑定内容 revision/hash，而不是只有 `/workspace/a.ts`；检索 key 绑定 query、index revision 和过滤条件；允许复用的模型结果要绑定相关模型/配置/上下文版本，并由业务明确允许这种复用。外部“最新数据”的语义必须声明 TTL 或校验策略。

公开 metadata 不存凭证本身；授权变化由 grant/generation 验证。缓存命中不能替代当前授权检查。

Entry 状态至少为 published/invalidated/expired，值版本不可变；namespace generation 支持整体逻辑失效。invalidate 与 read/take receipt 在 authority store 中串行化：先成功交付的结果已成为历史输入，后续失效只影响未来读取，不能回写过去的 Task 决策。

普通 cache 更新不用于 Task 间可靠通信。若业务要求“等待某份数据产生”，使用 SharedState/version wait 或 mailbox 传 artifact ref；cache-ready 通知仅是优化提示。

## 6. Durable 读取与中断恢复

reducer 不能自行读取易变 cache。它提交 cache-read action，broker 返回带 provenance 的持久输入：hit/miss、namespace generation、entryVersion、producer/dependencies、observedAt、freshness 和选中值/ref。

Cache hit 在成为业务输入前，必须把值复制或引用到受恢复 retention 保护的不可变 artifact。值和引用准备完毕后，事务提交 read receipt + 结果输入/唤醒。此前 cache 被淘汰则返回 miss/重试读；此后淘汰不影响已提交输入。miss 也作为此次逻辑读的结果保存，重放时不因 cache 后来命中而改变分支。

重复同一 `(taskId, stepId, actionKey)` 读取复用 receipt。resume/recover 不重新选择 sources，除非 Program 提交新的 read action。暂停默认保留 cache，但即使底层全部清空，已提交 state、输入、Effect 结果仍可恢复。

普通 reusable read 跨 cache/backend 与 Session store 不要求分布式事务：先获得 immutable value/promote，再持久提交 Task 输入；未提交的中间 artifact 可 GC。receipt 尚未形成前不承诺此次读取已被业务观察。

### 6.1 Single-use 协议

single-use 是可选后端能力。authority store 原子创建 `(entryVersion, readOperationId, receipt)` 的唯一交付记录，同时标记该 entry version consumed，并持有可恢复的值/ref：

1. 同一 readOperationId 重试返回原 receipt，不能再次返回 miss。
2. 其他 operation 返回 consumed/miss，不获得相同 entry version。
3. receipt 通过持久 relay 投递到 Task inbox；投递成功才表示输入已持久到达，业务消费仍按 mailbox 协议。
4. 若 take 后进程崩溃，receipt/outbox 继续投递。若目标终态，保留 rejected 交付审计且不自动重新放回，避免一份数据被重复使用。

不支持原子 receipt 与恢复投递的 cache backend 必须拒绝 single-use，不能降级为 get/delete。若任务依赖该数据必达，即使读取前 cache 被淘汰也不可丢失，应该使用持久队列而非 single-use cache。

## 7. 填充、并发和副作用边界

默认只缓存完整成功结果。错误缓存、negative cache 和流式 partial 必须独立类型及 TTL；partial 不能冒充已完成的 LLM/tool 结果。

miss 填充可选 single-flight：authority 为 namespace/generation/key 发放 fill lease/token；发布校验 token、generation 和源依赖。旧 worker、失效前开始的计算不能覆盖新结果。single-flight 只减少重复计算，不能提供外部副作用 exactly-once。

纯计算或业务允许复用的只读结果可缓存。执行 shell 写入、发消息、扣费等操作不能仅因同参数 cache hit 跳过；每个逻辑 Effect 的幂等/结果记录仍是权威事实。Effect 重试先读取自己的已提交事实，不通过缓存猜测“应该执行过”。

若 cache 命中允许替代一个读取型 Effect，仍需记录该逻辑操作的完成事实及 cache provenance；这确保观测与恢复链路一致。

cache publish/delete/renew 采用幂等 actionKey，遵守控制 epoch、授权和配额。逻辑失效与后台物理删除分开记录；Task 终结不需等待普通派生 cache 的物理回收，但未交付 single-use receipt 与活跃 durable artifact 引用不能被顺带删除。

## 8. Provider cache 与本地 cache 分离

provider prompt/context cache 通过 Effect adapter 的 capability 描述控制，不能把某个 provider 的 ephemeral 名称解释成本文 single-use。adapter 应明确支持哪些选择：禁用、本次允许缓存、复用指定远端 ref、设置期限、查询、删除；不支持的操作返回 unsupported，不能假报成功。

Task 可以声明要参与缓存的上下文块或已授权 cacheRef、使用模式和期限上限。选择由 harness 的 ContextAssembler 编译到 adapter 请求；Kernel 保存策略/provenance、用量和结果，不理解具体 prompt 布局。

远端 ref 失效或后端 eviction 时，adapter 按声明的 fallback 重新发送所需内容；若不可重建则明确 blocked。唯一需要的上下文内容不能只存在 provider cache。provider 报告 cache 命中与计费作为观测事实，与 Kernel cache hit 分别统计。

## 9. 容量、观察与安全边界

每个 namespace 有 entry/bytes/TTL/pin 配额，计入 Task/Session/shared owner 预算。默认 LRU 等淘汰是后端策略，不承诺跨后端相同命中顺序；业务不能依赖它维持正确性。

可观察字段：scope/owner、namespace/generation、entry version、大小、创建/到期时间、hit/miss/stale/bypass、选中的 source、填充者和依赖版本、被拒原因。事件按 metadata 记录，不默认把全部缓存内容复制进 journal。

grant 撤销立即阻止未来 cache 读取/发布；历史已提交的 Task 输入不会被物理撤回。需要删除历史敏感数据时走独立的 retention/删除流程，并明确其对恢复的影响，不把 invalidate 当作历史擦除。

## 10. 验收矩阵

| 场景 | 必须成立的结果 |
|---|---|
| Task 未授权读取其他 Task/Session cache | 拒绝；不泄露内容或未授权 metadata |
| child spawn 未声明 cache grant | 不自动获得父 Task cache |
| pause/restart/resume 后 cache 全丢 | 已提交的决策输入及 checkpoint 不变；新读取按 miss 处理 |
| cache-read receipt 后失效/过期/淘汰 | 重放读取同一 durable 输入，不重新命中别的值 |
| key 依赖的文件/index/schema 版本变化 | 旧 entry 不得作为新依赖结果命中 |
| invalidate generation 后旧 fill 返回 | 旧发布被 fencing 拒绝 |
| two workers single-use 同时 take | 最多一个逻辑操作获得该 entry version |
| single-use take 后、目标 inbox 前 kill | 原 receipt 可重放投递，不再次取走、不丢恢复责任 |
| 不支持 single-use 的 backend | 显式 unsupported，不降级成非原子读删 |
| prefer-cache/cache-only/refresh/bypass | 严格遵循读写/fallback 约定，不能隐式全局搜索 |
| TTL 到期后重启/重试 | 不延长绝对期限；已固定的历史输入仍可恢复 |
| Task cache 到终态清理 | 不删除 artifact、Effect 幂等事实、未交付 receipt |
| 同参数写操作重复调用 | 由逻辑 Effect 身份处理，不由 cache 擅自省略副作用 |
| provider 不支持删除/TTL/ref 控制 | 返回能力差异；不声称已执行不支持的控制 |

最小落地顺序：Task scope reusable + 显式选择 + durable read receipt → Session scope/grants/失效/fill fencing → shared owner cache → single-use 可选能力 → provider adapter 能力映射。Cache 不阻塞基础 Task 状态机落地，但不得引入不可恢复的隐式读路径。

### 缓存物理清理与旧索引兼容

Task 终态在同一事务清理其 step/task namespace、条目、发布序号与相关 resource/handle；Session namespace 保留至 Session closed。Effect 幂等事实、cache-operation 回执及 artifact 不删除。step 的可见性仍在逻辑 step 改变时失效，剩余物理记录在 Task 终态回收。

`cache/owner/<taskId>/<namespaceId>` 只是派生索引。`cache/owner-index-version` 缺失时，创建或 Task 清理先从 namespace 记录事务内重建索引并写版本 1；未知版本拒绝。删除前核对索引键、namespace id 和 ownerTaskId，错误索引不允许删除另一 Task 的缓存；终态提交也回滚。Session closed 时移除索引版本标记。回归位于 `backend/durable-kernel/src/retention.test.ts`。旧宿主继续写入但不维护索引的混合部署，以及跨 Session/provider/大值与 GC 竞争仍需独立验收。
