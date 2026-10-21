# Durable Harness 简化核心提案

日期：2026-09-05。状态：针对 1.1 的收敛设计，窄入口、单 step 适配、状态视图及同后端 pool/shared 资源已实现；本文保留原 API 草案，当前新增 revoke/destroy/query、grant epochs 与 physical cleanup 见 [资源实现基线](durable-harness-resources.md#当前实现基线2026-09-08)；早期 API 和限制见 [实施记录第 7 节](../feat/durable-harness-implementation.md#7-简化核心重构实际-api-与边界)。不覆盖旧数据格式或自动废止既有正确性约束。

## 1. 审查结论

1.1 的主要问题不是恢复事实太多，而是把用户对象、内部记录、存储布局和可选分布式能力放在同一抽象层。要求每个 harness 作者先理解 Authority/Grant/Use/Allocation/WaitSet/PropagationWork，学习和维护成本过高。

建议日常只使用 **Session、Task、Resource** 三类对象。Task 以小型可序列化 state 和声明式动作描述业务；外部操作由 `call` 声明，等待由 `wait` 声明；执行租约、操作尝试、回执和事件日志由 Kernel 管理。资源仍保留权限、占用和消费的区别，但无需暴露成一组必须手工拼装的对象。

完整规格留作内部约束和扩展参考。首版不实现通用跨主机资源调度平台、热迁移、多消费者流框架或所有 Linux IPC；保留满足实际 harness 的事务状态、持久消息、固定 owner 资源、cache 与外部操作恢复。

## 2. 从 Linux 学什么

Linux 调度线程，内核代码也通过系统调用、异常/中断以及内核工作线程等路径执行；它不是一个循环遍历磁盘文件的独立“内核进程”。Workqueue 将 work item 与执行它的 worker pool 分开，调度器管理可运行的执行实体。[Kernel entry/exit](https://docs.kernel.org/core-api/entry.html)、[sched(7)](https://man7.org/linux/man-pages/man7/sched.7.html)、[Workqueue](https://www.kernel.org/doc/html/latest/core-api/workqueue.html)

进程 fd 表保存引用，open file description 保存打开状态，底层文件/设备保存本体；`/proc/<pid>/stat` 暴露状态与统计，读取它不等于调度进程。[open(2)](https://man7.org/linux/man-pages/man2/open.2.html)、[proc_pid_stat(5)](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)

本项目采用对应的职责分离：

| 职责 | Harness 形式 |
|---|---|
| 运行工作 | worker 领取 ready Task，执行一步 reducer |
| 资源访问 | Task 私有 handle 引用资源表；类型化操作由 adapter 处理 |
| 等待 | 持久条件与固定输入；满足后重新 ready |
| 状态观察 | `stat()`/`watch()`；统计不决定是否有权提交 |
| 中断恢复 | 从已提交 state、操作结果和输入继续；不恢复 OS 栈/指令位置 |

Linux 对象主要由内存中的内核维护；此处将恢复所必需的状态转成事务记录。不能因为接口类似 fd，就假定普通路径、FIFO 或内存 pipe 天然 durable。

## 3. 核心与可隐藏的细节

| 概念 | 收敛方式 | 不可丢失的语义 |
|---|---|---|
| Session | 公共对象：工作空间、Task 集合、共享资源、关闭策略 | 持久身份与生命周期 |
| Task | 公共对象：业务 state、输入、控制和结果 | 已提交状态、等待、不可逆终态 |
| Resource | 公共对象：共享数据、mailbox、cache、文件/设备/容量池 | owner、权限、版本及按类型定义的生命周期 |
| Attempt | 内部 lease/执行历史，诊断接口可查 | 旧 worker 无权提交；正常下一步与失败重试分开计数 |
| Effect | Program 的 `call` 动作；内部保存 operation/attempt/结果 | 外部执行未知时不能盲目重放 |
| WaitSet | `wait` 条件及内部 waitId/evidence | 登记不丢唤醒、解析一次、重放相同结果 |
| EventJournal | `watch()` 的内部有序日志 | 状态与事件共同提交、游标补读 |
| Account/Grant/Allocation | Resource API 管理的表字段/内部记录 | 权限不等于额度；释放不等于退款 |

Resource 统一的是 create/open/share/stat/close 与授权入口。`mailbox.send`、`shared.get/set`、`cache.read/publish`、`pool.acquire/release` 保持类型化语义，不把所有操作压成万能 read/write。

三类公共对象不意味着只剩三条数据库记录；也不意味着 Effect 结果可以放进 cache。减少的是用户需要手工管理的身份和协议。

## 4. 简明状态、控制与统计

当前实现见 [domain/status.ts](../../libraries/durable-kernel/src/domain/status.ts)：`taskStat()` 返回 `id/revision/phase/control/blockedBy/exit/activeOperations`，其中 `phase` 是按状态与阻塞原因推导出的字面量值，不是具名 `TaskPhase` 类型；`taskStats()` 返回 `observedRevision/completedSteps/attempts/pendingInputs/operations/createdAt/updatedAt`。下面五个执行阶段与 `progress` 是兼容投影的目标形态（提案），当前尚无具名 `TaskPhase` 类型和 `progress` 字段：

```ts
// 目标形态（提案）
type TaskPhase = 'created' | 'ready' | 'running' | 'waiting' | 'done';
type TaskStat = {
  phase: TaskPhase;
  control: { requested: 'run' | 'pause' | 'interrupt' | 'cancel'; acknowledged: boolean };
  blockedBy?: { kind: string; ref?: string }; // dependency/message/timer/resource/cleanup…
  exit?: { status: 'succeeded' | 'failed' | 'cancelled'; output?: unknown };
  progress?: { stage: string; completed?: number; total?: number }; // harness 自定义
};
```

created/ready/running 保留对应阶段；blocked/waiting/paused/finalizing 映射 waiting 并说明原因，原 wait 与控制屏障都保留；三个终态映射 done + exit。pause 尚未停止 reducer 时仍显示 running 与未确认控制。外部操作是否仍运行由 activeOperations 显示，不能因 Task waiting 就判定外部停止。

Session 视图使用 open/paused/closing/closed，附 control acknowledged 和 blockers；suspending 显示 paused 请求未确认，archived 显示 closed 与归档属性。这是 UI/API 视图，内部状态转移不被静默重写。

统计使用 `stats()`：完成步数、失败尝试、pending 输入、Effect 记录数和 `createdAt/updatedAt` 时间戳为可重建/可延迟投影，附 observedRevision；当前没有运行时长投影。在途外部操作由 `stat().activeOperations` 给出，`stats().operations` 是 Effect 记录总数。预算已消费量、预留量、占用许可是权威账务，不能用近似统计做准入判断。业务 state、运行状态、控制意图、统计分别展示，不使用一个含糊的 status 承担全部含义。

## 5. 简明资源表：本 Session 与 Session 间

首版支持 **共享同一个具备真实事务隔离的后端** 的多个进程和 Session；资源 owner 固定为 Session 或持久 kernel shared root。kernel root 是显式配置的共享命名空间，不等于某个 worker 的内存或进程寿命。

| 逻辑表 | 本 Session 共享 | Session 间共享 |
|---|---|---|
| 资源本体 | `<sessionRoot>/resources.seq` | `<kernelRoot>/resources.seq` |
| Task 使用表 | 使用方 Session 的 `resources.seq` | 仍在使用方 Session，指向 kernel root 的本体 |
| 容量占用/消费 | 本体所在 authority 的记录 | kernel root 的唯一记录；使用方不维护第二份余额 |

表的最小内容（当前键布局，见 [managed-resources.ts](../../libraries/durable-kernel/src/infrastructure/seqfile/managed-resources.ts)）：

```text
managed/schema                         表格式版本（当前 '2'）
managed/sequence                       单调递增序号，用于 pending 请求排序
managed/resource/<encodeURIComponent(id)>   ref, kind, name, owner/scope, state, version, capacity, value, physical
managed/handle/<id>                    ref, sessionId, taskId, rights, name, closed, grantEpochs
managed/claim/<id>                     ref, handleId, quantity, token, state, epoch, cleanupId  # 池类型
managed/request/<encodeURIComponent([subject, id])>  actor/fingerprint/command, pending/result, sequence, error
managed/access/<encodeURIComponent([id,sessionId])>  grant rights/epochs/revision/state
managed/cleanup/<id>                   物理回收操作 epoch/status/attempts/receipt
```

容量占用由未释放 `claim.quantity` 记账；代码尚无 `usage/<id>` 一类的计费/消费账本，消费结算仍是目标设计。这些是 facade 的最小逻辑视图和候选实现分组，不要求将现有 handle/claim/request/cleanup 键改名。池才需要 claim；只读 artifact 不需要先分配一个 GPU 式许可；无预算资源不必创建空账户树。有多个额度维度时在 owner 事务内共同校验。

Session A 授权 B 后，A/B 的多个 Task 可以显式 open 同一资源；Task 不自动继承其他 Task 的全部 handles。申请与占用、释放与等待唤醒可以跨这些逻辑 SeqFiles 在同一后端事务提交。跨 Session 不等于跨数据库，不必为这个部署强制搭建网络 owner 服务。

不同后端的资源共享使用显式 broker 扩展：同一公共 API，内部变为持久 outbox→owner 事务→回复；副本/不可变引用也可通过消息共享。未安装该扩展时明确返回不支持，禁止把两个本地资源表当作一致的共享池。owner 热迁移、离线额度委派和跨 authority 原子申请不属于首版。

## 6. 面向使用者的 API 草案

以下为新 facade 提案，不是当前可直接调用的 API。宿主可以 await；Program reducer 只能声明对应动作，不能捕获这些 handle 的运行时 Promise。

| API | 语义 |
|---|---|
| `kernel.createSession({requestId, …})` / `session.spawn({requestId, program, input})` | 幂等创建工作 |
| `task.pause/interrupt/resume/cancel({requestId})` | 持久控制，返回请求/确认状态 |
| `task.stat()` / `task.stats()` / `task.watch({after})` | 当前事实视图、统计、增量观察 |
| `scope.resources.create({requestId, kind, …})` | scope 是 Session 或 kernel shared root；创建 owner 本体 |
| `resources.share(ref, {requestId, to, rights})` | owner 登记对指定 Session/Task 的授权，不预留容量 |
| `session.resources.open(ref, {requestId, taskId, rights, name})` | 校验授权，登记使用方 handle，返回持久请求 |
| `session.resources.acquire(handle, {requestId, quantity, deadlineAt})` | 容量足够则分配，否则登记等待，返回持久请求 |
| `session.resources.release(claim, {requestId})` | 幂等释放；必要时先清理，不能提前确认容量空闲 |
| `session.resources.close(handle, {requestId})` | 关闭本地引用；不删除其他使用者的资源 |
| `resources.stat(ref)` / `resources.list({holder})` | 查询权限、占用、版本和等待；鉴权后返回 |

`create/share/open/acquire/release/close` 的统一返回值为 durable Request：包含 id/status，提供 `poll()`、`wait()`、`cancel()`。`wait()` 只是当前客户端等回执；调用方断线后，内核继续处理请求。相同 requestId 重连查询或重试，不创建第二次分配；`wait()` 的本地超时不自动取消远端申请。

当前 [task-handle.ts](../../libraries/durable-kernel/src/public/task-handle.ts) 已实现 `stat()/stats()/watch()`、`pause/interrupt/resume(TaskControlOptions)`（含 requestId/expectedEpoch/reason）和 `retry({requestId})`；`cancel(reason?)` 不接 requestId，是即时取消而非持久请求。资源侧已实现 `ResourceApi` 的 create/share/revoke/destroy/open/acquire/release/close/read/write/stat/list/query，命名以 [resource-api.ts](../../libraries/durable-kernel/src/domain/resource-api.ts) 为准；本节其余 `{requestId}` 控制面与 `scope.resources.*` 分组仍是提案。

```ts
// 宿主辅助：result(command) 等待命令登记，再等待其持久结果。
// 需要显示排队进度时直接保留 Request，使用 poll()/wait()/cancel()。
const pool = await result(kernel.resources.create({
  requestId: 'pool-create', kind: 'pool', name: 'browsers', capacity: 2,
}));
await result(kernel.resources.share(pool.ref, {
  requestId: 'allow-S1', to: { sessionId: s1.id }, rights: ['use'],
}));
const handle = await result(s1.resources.open(pool.ref, {
  requestId: 'open-T1', taskId: t1.id, rights: ['use'], name: 'browser',
}));
const claim = await result(s1.resources.acquire(handle, {
  requestId: 'browser-for-operation-1', quantity: 1, deadlineAt,
}));
// 外部操作登记时绑定 claim，adapter 验证许可与执行 lease。
await result(s1.resources.release(claim, { requestId: 'release-operation-1' }));
```

同 Session 的资源用 `s1.resources.create`，跨 Session 的资源用 `kernel.resources.create`；之后的 open/acquire/release 相同。share 只能由已授权 owner/admin 发起。Task-scoped 临时资源通过 create 的 owner/lifetime 选项表达；不会因放在一个公共路径就变为公开可读。

`result()` 只是宿主便利函数，不恢复调用方的 JS 栈；持久请求仍可按 requestId 查询。业务不需手写 outbox/import/allocation，也不必为了简单使用展开两阶段等待。

## 7. Program 保持一个可恢复的 step 接口

```ts
// 概念性伪代码；call/wait 表达 Decision，均不直接执行 I/O。
function step(state, event) {
  if (state.phase === 'start') {
    return {
      state: { phase: 'testing' },
      actions: [call('test', 'shell.run', { command: 'pnpm test' })],
      wait: { operation: 'test' },
    };
  }
  if (event.type === 'operation-result' && event.key === 'test') {
    return { state: { phase: 'finished' }, done: event.result };
  }
}
```

首次 step 提交 state + operation + wait，worker 随后执行命令，结果作为持久输入唤醒 Task。重试同一步复用 `(taskId, logicalStepId, actionKey)` 的操作身份；等待引用被绑定到该具体 operationId，后续 step 可以再使用 test 名字而不混淆。失败/unknown 也作为类型化结果处理，不被包装成成功。

保留显式 step 是首版的主要简化：任意 `async function` 中的 await/闭包无法自动成为 checkpoint。若以后增加脚本式 facade，需要单独实现可验证的事件重放或编译转换，不能仅换写法就声称 durable。

## 8. SeqFile 与普通文件各做什么

当前 [SeqFile 接口](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/capabilities/seq-file.ts) 的 `ISeqFileOperations` 提供 getEntry/getEntries/setEntry/setEntries/deleteEntry/hasEntry/walkEntries 和可选的 `transaction`；CAS/increment/append 只在事务内的 `ISeqFileTransaction` 上，事务可跨同一后端的多个 SeqFile。它本质上是带有序键的记录空间，不是普通 JSONL 日志。Kernel 要求真实 transactionalSeqFiles；整体文件覆盖式 fallback 不满足多进程恢复要求。

| 存储 | 放什么 | 不放什么 |
|---|---|---|
| SeqFile | Task checkpoint、lease、操作结果/ref、消息和消费、资源/权限/占用、cache metadata、日志序号 | 大量重复内嵌的文件内容与 token 历史 |
| 普通不可变文件/blob | 大报告、artifact、cache value、大消息 payload、已封存 chunks | 可被并发覆盖的权威 Task status、锁、领取 ACK |
| 普通工作文件 | repo/workspace 的源码与工具输出 | 未经 snapshot/version 固定的恢复输入 |
| 内存/socket/pipe | 通知、加速缓存、正在运行的 I/O | 唯一消息副本、唯一等待记录或可恢复操作身份 |

普通内容发布顺序：先写完整不可变 blob，校验 hash/长度并达到 backend 声明的持久级别，再用 SeqFile 事务提交引用、状态和消息；事务失败只留下未引用内容，由保留策略清理。SeqFile 回滚不会回滚普通文件。对象存储可用唯一 key + 完成写确认，不能强制所有后端支持 rename；文件系统上的 atomic rename 也不等于掉电持久，需对应 sync 契约。

这是 [FSDriver 事务接口](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/services/fs-driver.ts) 已明确的边界：文件操作原子性取决于 backend；记录原子性由 `meta.seq.transaction` 提供。Memory 只能验证算法，SQLite 的事务隔离/提交持久配置、IndexedDB 的持久策略和真实进程故障仍需验收。

最小 durable mailbox = SeqFile 消息/ref + 幂等 identity + 消费记录 + Task checkpoint 原子提交。payload 可放普通文件。现有 [pipe()](https://github.com/mushuanli/vfs-core/blob/main/src/utils/pipe.ts) 只有运行时复制循环，没有这些记录；不能直接作为 durable IPC 使用。

资源表只给普通文件增加身份/权限/生命周期，不能把任意可变文件自动变成事务型共享内存。共享小状态用 SeqFile CAS；共享大状态发布新 blob 并 CAS head。相同 blob 的 metadata/引用参与同一回收屏障；不能在提交引用前被 GC 误删。

## 9. 运行循环与维护边界

首版逻辑循环为：扫描可推进事实→短事务 claim→执行纯 step→短事务提交 Decision；独立执行外部 operations，再事务提交结果与唤醒。周期维护处理过期 lease、timer、pending 资源请求/消息和清理；通知只降低延迟。不是为每个对象创建常驻进程/线程。

实现按四个职责划分：store 负责事务，runner 负责执行与 lease，resource driver 负责类型语义，facade 负责简明 API/视图。内部可复用请求回执、等待解析和恢复扫描，不再为每种资源构建一套不同的重试/通知框架。

迁移先加 facade/stat 投影，保留已有数据布局；随后补实际需要的资源表和同后端共享能力，减少 Task 全量快照膨胀。只有出现真实业务需求才开启跨 store broker、业务 stream、复杂 TaskGroup 策略和分布式 owner 迁移。

验收仍保留六类故障：旧 lease 提交、提交前后 kill、消息重复投递、等待与更新交错、两 Session 争抢最后容量、外部结果未知。简化 API 和文件组织不能删除这些保证。
