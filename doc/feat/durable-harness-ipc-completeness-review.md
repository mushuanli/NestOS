# Linux IPC 对照与 Harness 存储完备性审查

> ⚠️ 历史归档：本文记录当时的方案与审查结论，**不随代码更新**，不作为当前实现依据。当前文档见 `../`。

日期：2026-09-05。范围：当前 durable-kernel 源码、[目标协议](../design/durable-harness-protocol.md)、[Cache 协议](../design/durable-harness-cache.md) 与 [逻辑布局](../design/durable-harness-storage.md)。本文是设计审查与演进建议，不表示新增能力已经实现。

后续处理：1.1 修订已在主协议补齐 endpoint/业务流/WaitSet 目标记录，在存储设计固定记录归属，并新增 [资源表与 Linux 对齐协议](../design/durable-harness-resources.md)。以下保留审查时的代码缺口；设计修订不等于实现缺口已经关闭。

2026-09-06 实现更新：等待索引恢复、SeqFile 提交通知、消息拒绝/重试、固定路径保护和 LocalFS rename 崩溃恢复已补强；当前覆盖边界见 [目标与实现映射](../design/durable-harness-evidence.md)。下文为原审查记录，不能据此判断这些修复仍然缺失。

## 1. 结论与判据

**当前目录骨架可以沿用，当前记录组织尚不足以承诺完整、长期、跨进程的 harness 运行。** 缺口主要是持久对象及其生命周期契约，不是缺少某几个文件名。目标主协议已经覆盖许多语义，但还没有为所有目标对象确定可验收的 schema、存储归属和恢复算法。

以每个对象是否回答以下问题判断完备性：身份如何保持？谁拥有/使用？状态如何转移？与哪些记录原子提交？崩溃后谁继续？何时可以删除？无法回答其中一项，就不能仅凭类型或文件存在判定完备。

Linux IPC 是对照清单，harness 不需要复刻全部系统调用。Linux process 的退出不等于逻辑 Task 退出，Linux session/process group 也不等于这里的 Session/TaskGroup；一个 Task 可以跨多个 worker Attempt 存活。

## 2. Linux 能力到 Harness 的映射

| Linux 机制 | 实际语义 | Harness 对应要求 | 当前差距 |
|---|---|---|---|
| pipe/FIFO | 有限容量的字节流，无消息边界，有 EOF/EPIPE | 有边界的持久消息；若支持业务流，则需要 chunk、offset、关闭及背压 | 基础消息已有；可恢复业务流与 endpoint 关闭协议未完整定义。[pipe(7)](https://man7.org/linux/man-pages/man7/pipe.7.html) |
| Unix domain socket | 本机双向通信，可传递 fd/凭据 | 稳定 endpoint、认证来源、关联回复、重连去重；资源引用通过 grant 传递 | 当前主要按 targetTaskId 寻址，独立 service mailbox 和跨主机认证 transport 未实现。[unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) |
| POSIX/System V 消息队列 | 消息边界与排队；POSIX MQ 可存活至系统关闭 | 提交后跨进程/重启保存、投递与消费分离、容量及防重水位 | 已有 outbox/inbox；严格发送流顺序、持久拒绝/重试进度和背压未完成。POSIX MQ 的 kernel persistence 不能等同于磁盘恢复协议。[mq_overview(7)](https://man7.org/linux/man-pages/man7/mq_overview.7.html) |
| shared memory | 共享字节，访问同步另行负责 | 有版本的 SharedState、CAS、固定读取证据、跨 Session owner | Session 内基础已有；跨 Session owner、订阅和引用保留未落地。[shm_overview(7)](https://man7.org/linux/man-pages/man7/shm_overview.7.html) |
| semaphore / futex | 计数协调；futex 提供原子的比较并阻塞 | 短操作用事务/CAS；等待登记原子化；长资源占用用可恢复 permit | Task 执行 lease 不是通用资源 permit；完整 permit 协议需按业务需求补充。[sem_overview(7)](https://man7.org/linux/man-pages/man7/sem_overview.7.html)、[futex(2)](https://man7.org/linux/man-pages/man2/futex.2.html) |
| poll/epoll | 监视可执行 I/O 的 readiness，维护 interest/ready 集合 | 稳定 WaitSet、匹配证据、期限仲裁与可重建反向索引 | 已有嵌入式 WaitSpec 和部分证据；完整 WaitSet 结果身份/历史尚缺。[epoll(7)](https://man7.org/linux/man-pages/man7/epoll.7.html) |
| signal | 异步通知/控制；标准信号同类多次 pending 不排队 | 不丢失的控制意图、幂等请求、停止确认；业务消息独立 | 控制核心已有；不能把 OS signal 当持久控制回执。[signal(7)](https://man7.org/linux/man-pages/man7/signal.7.html) |
| waitpid / pidfd | 子进程状态收集、进程对象引用及退出观察 | 稳定 TaskId、可重复观察的 ExitRecord、监管及 join | Exit/Task wait 已有；自动 join、detached、完整 TaskGroup 尚缺；worker 消失只结束 Attempt。[wait(2)](https://man7.org/linux/man-pages/man2/wait.2.html)、[pidfd_open(2)](https://man7.org/linux/man-pages/man2/pidfd_open.2.html) |

FIFO 有路径并不意味着管道内容落盘；共享内存同步也不等于业务事务。上述 Linux 语义来自所引手册，持久对象和布局建议是针对本仓库的设计推导。

Cache 不属于上述 IPC 原语集合。共享 cache 可以通过相同的授权、事务和 owner 协议提供服务，但不能替代可靠消息队列、共享权威数据或 checkpoint。

## 3. 具体缺口及代码证据

### 3.1 Mailbox 还缺少独立对象及关闭协议

当前 [消息类型](../../libraries/durable-kernel/src/domain/types.ts) 仅有 pending/delivered，目标主要是 Session/Task；[mailbox 实现](../../libraries/durable-kernel/src/infrastructure/seqfile/mailbox-store.ts) 保存 inbox/outbox、消费时间，并直接追加 Task pendingEvents。没有独立 endpoint 的 owner、generation、消费者绑定、容量、close/drain 和发送流记录。

影响：目标终态后 [relay](../../libraries/durable-kernel/src/application/kernel.ts) 捕获投递错误并留待后续重试，却没有持久永久拒绝事实；短期失败、目标已删除和权限拒绝无法形成完整的可查询收敛协议。主协议已要求这些行为，布局尚未为其确定记录。

应定义 endpoint 生命周期、每 channel 的消费模型、发送流序号/确认水位、重试 nextAttemptAt、rejected receipt 与迟到回复处理。默认单消费者；多个竞争消费者必须另外定义 claim/ack，不可只把多个 Task 绑定到同一游标。广播需独立 delivery 或每订阅者游标，单个 consumedAt 无法表达。

### 3.2 WaitSpec 不是完整的 WaitSet 结果账本

当前 `TaskRecord.wait` 保存条件，输入队列保存 message/shared/timer 等证据；[等待辅助实现](../../libraries/durable-kernel/src/infrastructure/seqfile/store-helpers.ts) 判断条件与唤醒。已有基础能力不能等同于稳定 waitSetId、统一 resolved/timeout/cancelled 结果和每次解析唯一 wake identity。

需要定义每次逻辑等待的身份、所属 step、叶子证据、决胜结果、消费关联，以及历史保留。反向索引与扫描是实现选择；等待解析事实是恢复需要。共享版本、资源版本、Task exit 不能仅依赖瞬时通知。

### 3.3 跨 Session 资源缺少长期 owner 与订阅账本

`ResourceRecord` 和 handle 已有资源/generation/授权基础；目标主协议描述了 owner service，但当前未实现稳定 owner endpoint、迁移屏障、订阅起点/确认水位、退订和删除通知。

将数据放在一个公共目录不能解决这些问题。建议明确：Catalog 的 Session 路由是投影；如果增加唯一资源 owner 路由，它必须指向明确的 authority，迁移 CAS/fencing 在那里完成，不能继续把该路由按普通可重建索引处理。

### 3.4 长期生命周期缺少可独立恢复的工作进度

当前已有控制屏障、outbox、cleanupPending 和扫描恢复，因此并非“没有恢复工作记录”。缺少的是目标协议中的大规模控制传播、owner 迁移、清理、GC 和导出等操作的统一可查询进度、分页游标、重试与幂等完成记录。

这些操作不能只写 closing 后依靠某个 worker 的内存 for-loop。可完全从权威事实重新推导且幂等的简单扫描不必额外登记 job；多阶段、有外部副作用或需保存处理水位的操作应有持久 work 记录。

### 3.5 Cache 与恢复数据的保留策略尚未闭合

[Cache 实现](../../libraries/durable-kernel/src/infrastructure/seqfile/cache-store.ts) 已将读取结果复制到 Task receipt，避免失效后恢复输入丢失。但 namespace 配额没有限制这些 receipts、Task 全量快照及 Session 历史的累计增长。

必须区分 value 可淘汰、已选输入必须保留、namespace/generation 与防重 tombstone 受重放窗口约束。需要 artifact 引用、pin、消费水位、GC 计划和 Session 归档规则。single-use 指某个发布实例最多一次新领取；若允许重新发布同 key，则必须有不会与旧发布混淆的实例身份/版本规则。该约束在淘汰、重新发布和压缩之间也要成立。

当前 Session scope namespace 仍记录创建 Task，授权检查会加载该 Task。未来清理终态 Task 时，还需保留必要 owner 元数据或迁移到显式 Session owner；否则“cache 属于 Session 生命周期”与“删除创建 Task”会冲突。

### 3.6 Streaming 与长资源占用需要明确范围

如果 stream 仅用于 UI，journal chunk 可作为观察数据，最终 Effect 结果才是业务输入；需明确 chunk 可截断/重同步。如果另一个 Task 会边读 chunk 边计算，则必须定义持久 stream identity、attempt、chunk sequence、消费游标、close/error、保留及背压，不能把 UI 事件订阅当业务管道。

如果 Task 要独占浏览器、GPU、workspace 或外部账号等跨多个步骤的资源，应提供 owner 管理的 permit/租约记录，包含 requestId、holder、generation/token、到期、释放及等待。数据库短事务/CAS 足以处理共享小状态，不必为所有读写再引入持久 mutex。

permit 到期不证明旧的外部操作已经停止。资源端支持 fencing 才能安全换持有者，否则必须先 reconcile/cleanup 或进入 blocked。Task/Effect 的本地并发上限不能替代跨 worker 共享资源配额。

## 4. 文件组织建议

保留现有逻辑文件，优先补对象 schema 与 key namespace；后续固定的目标归属见 [存储设计第 5 节](../design/durable-harness-storage.md#5-目标布局-11-与记录归属)。独立文件不是语义成立的前提，也不应仅为模仿 Linux 增加 `pipe.seq`、`socket.seq`、`semaphore.seq`。

Task 内建议逐步区分小型当前记录与按 ID 存储的 input、wait、effect、receipt、历史引用。Session 内区分 endpoint/投递、共享版本、资源授权/保留、监管和后台操作。Catalog 外不强制增加 global 数据目录；跨 Session 数据可以由长期 service Session 所有，物理 blob store 由 binding 决定。

这种拆分必须通过迁移保证单一权威：旧内嵌数据与新 keyed 记录不能都接受独立写入。当前全量 snapshot 也需要新的快照/引用协议，不能仅拆文件后仍重复复制全部历史。

## 5. 优先级与验收

| 优先级 | 工作 | 最小故障用例 |
|---|---|---|
| P0：基础可恢复协作 | endpoint 接收/关闭/拒绝、持久发送重试、WaitSet 身份和解析、监管完成规则 | 目标关闭仍有 outbox；超时与结果并发；worker 在解析后消费前被杀；父完成时子仍运行 |
| P0：跨 Session 共享要求 | 明确 resource owner authority、订阅/版本事件与迁移 fencing | owner 更新后发通知前崩溃；旧 owner 在迁移后写入；subscriber 重启 |
| P1：长期运行 | 分页/容量、artifact/pin、去重和观察水位、可恢复 GC/归档 | 慢消费者；旧消息重放；cache 淘汰但 Task 恢复；清理创建 Task 后 Session cache 仍可用 |
| 按业务是否需要纳入 | 业务 stream、多消费者队列、跨步骤资源 permit | 生产者崩溃后的 EOF/error；竞争消费；permit 过期但旧外部操作仍运行 |

最终需在实际存储后端运行两个独立 OS 进程及 kill/restart 故障测试，覆盖无通知、旧 lease、重复投递和多文件提交中断；同进程 Memory 事务测试不能替代这项证据。当前工作仅完成审查与文档补充。
