# Durable Harness 持久存储与文件组织

日期：2026-09-08。状态：第 2–4 节记录当前逻辑布局与边界，第 5 节固定 1.1 目标布局；新增记录、恢复、迁移和 GC 尚未全部实现。

## 1. 哪些机制必须固定

必须固定消息身份与去重、消费确认、等待登记与唤醒、cache 授权与消费、事务边界和崩溃恢复责任。否则不同 worker 即使读写相同文件，也不能可靠协作。进程内 Promise、事件订阅、socket 通知不是这些机制的权威事实。

文档按职责分开，避免在多份文件中维护相互冲突的协议：

| 文档 | 固定内容 |
|---|---|
| [主协议](durable-harness-protocol.md) | Session/Task 生命周期、lease、Effect、消息、等待、共享状态与恢复不变量 |
| [Cache 协议](durable-harness-cache.md) | scope、retention、usage、授权、选择、失效及持久 receipt |
| [资源协议](durable-harness-resources.md) | Linux 对齐、Session 内/跨 Session 资源表、授权与分配、预算、释放和所有者生命周期 |
| 本文 | 逻辑路径、记录归属、权威与索引区别、跨文件事务和存储演进约束 |
| [实施记录](../feat/durable-harness-implementation.md) | 已实现 API、验证证据、尚未实现的目标能力 |

协议应约束可观察语义；存储文档约束适配器与迁移器。业务 harness 通过 API 操作记录，不直接编辑 `.seq`。SQLite 表结构、分页、物理文件数量属于后端实现，不应成为 harness 公共接口。

## 2. 当前逻辑目录

路径由 StorageBinding resolver 决定，Session 不必放在固定的 `sessions/` 父目录。以下为两个逻辑根，不能理解为每个 Task 对应一个独立数据库。NestOS 当前 catalogRoot 为 `/var/lib/kernel`，sessionRoot 为 `/var/lib/sessions/<sessionId>/kernel`；外层业务 `session.seq/history.seq/attachments` 属于 SessionRepository，不能与本节 Kernel 内层 `session.seq` 混淆。

```text
<catalogRoot>/
  catalog.seq                  # Session 定位、注册意图、Task 路由
  resources.seq                # 简化核心的 kernel scope 共享资源（managed/*）

<sessionRoot>/
  session.seq                  # Session 本体、提交幂等记录
  shared.seq                   # Session 共享值及历史版本
  context.seq                  # Context commit 与 branch
  messages.seq                 # 持久 outbox/inbox 与消费状态
  resources.seq                # 资源、授权、预算、cache
  events.seq                   # Session journal 与序号
  graph.seq                    # 依赖、spawn 身份、反向等待索引
  index.seq                    # Task 列表与 ready 投影
  tasks/
    <taskId>/
      task.seq                 # Task 状态、执行与幂等事实
      artifacts/               # 已预留目录；通用大内容管理尚未实现
```

这些是 `IFileSystem` / SeqFile 的逻辑路径，不承诺是磁盘上可直接读取的逐行 JSON 文件。事务依赖同一支持事务的后端；不同存储绑定之间不自动获得分布式原子性。

### 2.1 Session 文件内容

表中 `<key>` 等业务字符串按实现使用 URI 编码；历史数字序号使用固定宽度补零。

| 文件 | 主要键 | 事实与重建性质 |
|---|---|---|
| `session.seq` | `record`、`submission/<requestId>` | Session 生命周期与 Task 提交去重事实，不能作为缓存删除 |
| `shared.seq` | `value/<key>`、`head/<key>`、`history/<key>/<version>` | 当前值、版本和历史/tombstone；等待证据依赖版本，不能任意丢历史 |
| `context.seq` | `commit/<id>`、`branch/<name>` | 不可变上下文提交及可变 branch 指针 |
| `messages.seq` | `outbox/<id>`、`inbox/<id>`、`delivery-sequence` | 投递责任、去重、到达次序与消费确认；不是通知缓存 |
| `resources.seq` | `resource/<id>`、`handle/<id>`、`budget/<id>/<dimension>`、`workspace/snapshot/<id>`、`workspace/diff/<id>` | 资源归属、授权链、账务及 workspace 元数据 |
| `resources.seq` | `cache/namespace/<id>`、`cache/entry/<id>/<key>` | cache 定义、generation、值、版本、TTL 与 consumedBy；不同字段的保留义务不同 |
| `events.seq` | `next-sequence`、`event/<sequence>`、`task-event-index-version`、`task-event-count/<encodedTaskId>`、`task-event/<encodedTaskId>/<ordinal>` | 事件及 Task 分页派生索引；引用值为 Session sequence，与事件同事务提交。缺失索引的旧日志首次查询原子补建，索引版本为 1；不能假定只靠事件可以重放全部状态 |
| `graph.seq` | `edge/<from>/<to>`、`spawn/<parent>/<spawnKey>` | 依赖关系与 spawn 去重身份；当前不能将整个文件视为可重建索引 |
| `graph.seq` | `wait/task/<target>/<waiter>` | Task 等待的反向索引，逻辑上可从等待记录派生；当前恢复不等于已实现完整 graph 重建 |
| `index.seq` | `task/<id>`、`ready/<id>`、`task-order-version`、`task-count`、`task-ordinal/<id>`、`task-order/<ordinal>` | Task 列表分页序号在首次索引时分配、状态更新不改变；序号索引版本 1，缺失时首次查询补建。可重建投影；是否可 claim 仍须校验 Task 控制、状态和 lease |

TaskBoard 当前保存在 `shared.seq` 的 `task-board/<id>` 共享键下，没有单独的 `taskboard.seq`。跨 Session 可变共享资源的完整 owner 服务仍是目标设计，不能把一个共同路径视为已经实现访问协议。

Catalog 的 `session/<id>` 保存绑定及注册意图，不能丢弃尚未完成的注册责任；`task/<id>` 是 Task 到 Session 的路由投影。不要把 Catalog 整体当成可随意清空的缓存。

简化核心新增 `resources.seq` 的 `managed/*` 命名空间，独立于旧 resource/handle/budget keys：`managed/schema=2`；resource 保存 pool/shared 本体，access 保存对目标 Session 的授权，handle 保存使用方 Task 引用，claim 保存唯一容量占用，request 保存幂等命令、排队次序和结果，sequence 分配请求顺序。kernel scope 本体/claim 在 catalogRoot 的 resources.seq；Session scope 在所属 Session；Task handles 在消费 Session。业务 key 段使用 URI 编码。权威与消费 root 必须属于同一个 IFileSystem 实例，当前读取 schema 1/2，写入时升级标记为 2；旧 rights 数组按 revision 0/空 epochs 解释，旧 handles 通过兼容字段读取，未知 schema 拒绝解释。schema 2 增加 grant revision/epochs、physical binding、claim cleanup 状态及 cleanup receipt；这与旧 VFS 目录/schema 迁移是不同层。撤权、销毁、清理与查询的当前 API 见 [资源实现基线](durable-harness-resources.md#当前实现基线2026-09-08)。早期 API 见 [本次实施记录](../feat/durable-harness-implementation.md#7-简化核心重构实际-api-与边界)，不能据此假定第 5 节的全部目标已实现。

### 2.2 Task 文件内容

| `task.seq` 键 | 内容 |
|---|---|
| `record` | input/state/output、初始化标记、业务 revision、step 与重试计数、status、currentAttempt、pendingEvents、effects、interactions、wait、control/祖先控制屏障、exit |
| `snapshot/<version>` | 已保存的完整 Task 快照 |
| `attempt/<attemptId>` | Attempt lease 与执行结果；活跃 lease 会更新，不是所有 attempt 记录都不可变 |
| `control/<requestId>` | 控制请求指纹和幂等结果 |
| `effect-resolution/<requestId>` | 人工裁决 Effect 的去重事实 |
| `cache-operation/<operationId>` | cache 操作指纹及持久结果；读命中包括选定值和来源 |

目前 Effect、wait、signal 输入都内嵌 TaskRecord，没有独立的 `effect.seq`、`wait.seq` 或 `signal.seq`。Task 私有业务数据放 state；必须精确恢复的外部结果通过 Effect 或持久输入进入 Task。不要用 cache 替代 checkpoint。

逻辑上私有不等于物理上必须位于 Task 目录。Task scope cache 仍在 Session 的 `resources.seq`，由 owner、handle 和生命周期约束隔离。Task 目录单独复制不能构成完整恢复包，因为依赖、资源授权、共享数据及消息还在 Session 文件中。

## 3. 通信、等待与 cache 的写入边界

以下描述必要事实所在位置；具体操作按需要更新 journal、快照和调度投影，并非每次都写所有文件。

### 3.1 进程间、Task 间通信

同 Session 的 Task 消息通过 `messages.seq` 的 outbox/inbox 与目标 `task.seq` 的 pendingEvents 持久交付。由 Decision 发出的消息，其发送登记与发送方状态提交处于同一 Session 事务；消费确认与接收方 Decision、回复登记也必须原子提交。

跨 Session 分三次本地提交：

1. 发送 Session 提交 outbox，保存待投递责任。
2. 接收 Session 按 messageId 去重，提交 inbox 与目标 Task 输入。
3. 发送 Session 收到确认后标记 outbox delivered。

在第 2、3 步之间崩溃会重投，由接收方去重；不承诺跨 Session 恰好一次传输或全局顺序。`delivered` 与 `consumedAt` 分别表示投递与业务消费，不能混用。独立机器间网络 transport、授权和背压等仍需按主协议补齐。

worker/process 不需要持久目录。workerId 用于识别，lease token/epoch 用于提交权限；PID、socket、进程内 Map 均不能代表 Task 是否拥有执行权。通知只负责降低轮询延迟，通知丢失后仍须能从持久事实恢复。

### 3.2 Task 等待与 Session 共享状态

等待条件存 `task.seq.record.wait`；Task 完成等待可建立 `graph.seq` 反向索引。共享版本等待读取 `shared.seq`，timer 保存绝对时间；当前共享和 timer 等待通过扫描检查，不依赖进程内定时器存活。

检查条件与登记 wait 必须在受保护事务内完成；目标满足后，将选定证据写入等待方 pendingEvents 并更新 ready 投影。不能只发通知后删除 wait，也不能在恢复时随意读取共享状态的最新值替换已选择的 revision。

transport inbox 保存“消息到达/消费”的事实，Task pendingEvents 保存“等待执行的输入”；两者职责不同，但更新必须遵守事务协议。未来独立 WaitSet 记录、更多 channel cursor 与大规模索引仍属演进目标。

### 3.3 Cache 管理

namespace、授权和 entry 存 `resources.seq`；Task 的幂等操作与选定输入 receipt 存其 `task.seq`。single-use 的领取标记与领取方 receipt 在同一事务提交，因此崩溃后同一 operationId 读取原结果，不重新领取。

scope、保留期、使用次数分别表达“谁可以用”“何时可以清理”“能否重复领取”。Task 可以通过获授权的操作创建、选择、失效和续期 cache；具体已支持选项以实施记录为准。

可淘汰的是派生值，不是所有名称带 cache 的记录。已经参与决策的 receipt 是恢复事实；generation、消费和幂等记录的删除也必须保持防止旧操作重放的约束。不得整体删除 `resources.seq`，其中还包含授权、预算等权威数据。当前尚无完整通用 GC/pin 服务。

## 4. 恢复、备份与演进约束

- 恢复依据 Task、Session、消息和资源等持久事实重建运行时，再处理过期 lease、待投递 outbox、等待和清理责任；不要从文件修改时间或 PID 推测业务状态。
- Session 是当前实用的逻辑恢复集合，但跨 Session 引用仍需绑定 resolver 和外部资源。导出需要跨文件一致快照及引用闭包；直接复制正在写入的物理文件不能保证一致，目前不宣称已有完整导入导出实现。
- 快照、journal、inbox 去重与操作 receipts 的压缩需要明确保留水位、消费者与重试窗口。只要旧请求仍可能重放，就不能把防重记录当普通 cache 回收。
- 当前全量 Task 快照内嵌 effects/pendingEvents 等数据，长期运行存在增长问题。后续可拆分 effect、输入和历史记录，但必须版本化迁移并保持原子边界；现在不预先创建没有实现语义的空文件。
- schemaVersion、Task revision、共享版本、lease epoch 和 cache generation 是不同概念。完整记录 schema 标识、迁移屏障、大内容引用发布与 GC 是目标要求，当前实现未全部覆盖。本文的布局说明不能替代这些验收。

存储布局变化需要同时更新本文、迁移方案和实施记录；行为变化先更新主协议或 Cache 协议。新后端必须验证跨逻辑文件事务、崩溃重投和 fencing，而不能仅验证 CRUD。

## 5. 目标布局 1.1 与记录归属

根据 [IPC 完备性审查](../feat/durable-harness-ipc-completeness-review.md)，固定以下目标记录归属，并由 [资源协议](durable-harness-resources.md) 定义 Session 内/跨 Session 资源分配表。**本节是待实现的 1.1 契约，不能按这些 keys 读取当前旧布局。** 数据迁移通过 manifest 切换，禁止同时维护可独立写入的旧内嵌事实和新记录。

**manifest 骨架已实现（2026-09-11）**：`createSession` 在 `session.seq` 的 `record` 中写入 `layout = { layoutVersion: 1, recordSchemas, requiredCapabilities, migration: { status: 'complete', to: 1 } }`；`openSession` 与所有经 `requireSessionTx` 的事务操作（含 `listShared`）在读取前用 `assertSessionLayout` 校验：更高 `layoutVersion`、`migration.status === 'pending'`、或要求本实现不具备的能力（如 `streams`）一律明确拒绝，早于该字段的旧记录按 legacy 兼容读取。回归：`protocol.test.ts`「declares a layout manifest and refuses Sessions it cannot interpret」。表中各记录族（`work/`、`group/`、`allocation/`、`authority/`、`stream/` 等）的拆分仍未落地。

**`events.seq` 保留期（2026-09-11）**：`Kernel.pruneTaskEvents(sessionId, taskId, { keepEvents })` 按 Task 保留最新若干条索引事件，删除更早的 `event/<sequence>` 与 `task-event/<taskId>/<n>`，记录 `task-event-first/<taskId>` 水位；`taskEventPage` 从水位起读并把 `firstAvailableIndex` 返回给消费者（过期游标 clamp + resync），会话级未索引事件不受影响。

| 逻辑归属 | 目标记录 | 权威事实 |
|---|---|---|
| `session.seq` | `manifest`、`group/<id>`、`work/<id>` | 布局/schema 能力；TaskGroup 成员策略与 join 结果；多阶段控制传播/cleanup/迁移/GC 的责任、游标、重试和完成 |
| `messages.seq` | `endpoint/<id>`、`send-stream/<id>`、`consumer/<id>`；扩充 inbox/outbox | owner、generation、消费者、容量、关闭；发送次序和 ack；消费水位、持久拒绝与重试 |
| `resources.seq` | `resource/<id>`、`handle/<id>`、`binding/<taskId>/<name>`、`use/<id>`（有状态使用时） | 本体与 owner、授权链、Task 私有引用表、显式共享或独立的使用实例 |
| `resources.seq` | `account/<id>`、`allocation-request/<id>`、`allocation/<id>`、`usage/<id>` | 额度与祖先汇总、申请等待、预留/占用、幂等结算；permit 是 allocation 模式，不另设第二份占用账本 |
| authority 的 `resources.seq` | `authority/<id>`（已落地为 `managed/authority/<id>`；其余未实现）、`export/<id>`、`subscription/<id>` | 服务 epoch、跨 Session 授权与配额关联、订阅及通知进度；实际 account/allocation 同样在此 authority |
| 消费 Session 的 `resources.seq` | `import/<id>`、`remote-request/<id>` | 外部授权引用、观测版本、持久申请/取消意图和 owner 回执；不包含独立全局余额 |
| `resources.seq` | `artifact/<id>`、`pin/<id>`、`retention/<id>`；扩展 `cache/namespace`、`cache/entry` | 内容定位、引用保留、GC 水位；cache owner 与 creator 分离，entry 实例身份不复用 |
| `task.seq` | `input/<id>`、`wait/<id>`、`effect/<id>`、`receipt/<id>` | 从大 record 拆分稳定输入、等待解析、Effect 历史和幂等结果；record 只引用当前所需对象 |
| `messages.seq`（业务流按需） | `stream/<id>`、`chunk/<stream>/<sequence>`、`stream-consumer/<id>` | 可恢复业务流的实例、关闭/错误、偏移和消费/保留规则；区别于 UI 观察事件 |
| `events.seq` | `retention`，必要时增加 `subscriber/<id>` | 日志保留区间、可靠订阅水位和 resync 契约；普通 UI 连接不必永久注册 |
| `index.seq` / `graph.seq` | 可重建 wait/timer/ready/work 投影 | 投影用于加速；group、wait 解析和 work 责任不得仅存于可删除索引 |
| Catalog | authority 发现投影 | authority 的固定 storage binding 可由 resolver 定位；唯一 ownerEpoch 存 authority 的 resources.seq，不由缓存路由决定 |

`work/<id>` 与 Session 控制记录共处 `session.seq`，字段为 kind/operationId、scope、status、cursor、attemptCount、nextAttemptAt、lease/fence、error/result 和引用。claim/重试/完成以 CAS 和幂等外部动作推进；outbox 投递责任仍归 outbox，work 不能维护第二份可独立修改的消息状态。简单且完全可推导的恢复扫描不要求每次生成 work 记录。

`group/<id>` 保存 owner、成员/成员 revision、structured/detached、join/failure/loser 策略、control epoch、finalizing/终结结果。`graph.seq` 的依赖边和 spawn 身份仍保留权威地位；反向等待与调度索引可重建，不能整体清空 graph。

Task 的小型 `record` 保存当前 step/state revision、控制、activeWaitSetId 和选定输入/Effect 引用。`input/<id>` 保存不可变内容/ref 与消费关联；`wait/<id>` 保存解析状态/证据/wakeInputId；`effect/<id>` 保存逻辑外部操作与物理 attempts；`receipt/<id>` 保存请求指纹及不可改变的结果。消费、状态推进、action 登记及 wait 切换在同一事务，历史快照记录一致性引用集合，禁止各文件各自快照后拼成一个不存在的时刻。

`retention/<id>` 保存对象族、允许重放窗口/确认水位、保留版本范围及 GC revision；`pin/<id>` 保存引用者、目标实例/version、原因和释放状态。durable pin 不因 worker 心跳消失而过期；期限到达必须先明确终结依赖者或报告不可恢复输入，不能悄悄删除恢复事实。GC 先事务标记候选与 generation，再受保护地排除新引用并删除内容，最后提交回收结果；新 pin 与 delete 竞争同一对象屏障。无法跨 blob store 事务时使用幂等 work 和 tombstone，禁止恢复期间暴露指向已删除内容的新引用。

ID 段使用不透明稳定 ID；业务 name/key 段使用 URI 编码；有序序号采用固定宽度编码。各表身份包含其 authority/session 作用域，重复 requestId 不同指纹必须冲突。新增 manifest 声明 layoutVersion、recordSchemas、requiredCapabilities 和 migration 状态；stream、共享 use、allocation 等未支持能力必须明确拒绝。

业务私有数据应有明确选择：小型可变进度放 Task state；大内容放持久 artifact；可重建数据放 cache；工作目录和文件变更通过 workspace resource 管理。`artifacts/` 是预留位置，不是对所有 backend 强制的物理存储路径。跨 Session artifact 的访问与保留由 owner/grant/pin 协议决定。

完整性验收应覆盖对象的创建、使用、暂停、所有者消失、恢复、关闭和删除全过程；新增 namespace 本身不等于完成协议。

### 能力资源创建幂等键

Session 的 resources.seq 保存 `create/<encoded ownerTaskId>/<encoded requestId>`，值为 fingerprint/resourceId/handleId。该回执与对应 resource/handle 键及创建事件同事务发布。重放检查规格指纹，返回当前记录以保留撤销状态；不会从回执恢复旧授权。未声明 requestId 不写该回执。

### 初始启动信号回执

任务记录文件中的 `start-signal` 键保存可选初始信号的编码指纹，与 Task 启动状态、pending signal、task.signal/task.started 事件同事务提交。后续相同信号 start 是 no-op，不同信号拒绝；只有普通无信号启动的任务没有此键。该键不替代后续 signal 的事件记录。

### 跨 Session 消息结算与 retention

消费回执不证明发送端已经停止重试。跨 Session 消息使用 `settlementAcknowledgedAt`：源端先写 delivered/rejected 结果，目标持久确认源端已结算，源端再记录目标已确认。未确认的终态 outbox 仍列入 pendingOutbox，但恢复只补确认，不重新 deliver；目标已清理回执时可完成源端确认。目标不存在且已过期的本地拒绝不要求目标确认。

清理仅处理终态 outbox、已消费或已拒绝 inbox；跨 Session 两类记录均需结算确认。同 Session 继续依靠本地事务与未完成 outbox 检查。水位取 created/delivered/rejected/consumed/settlementAcknowledgedAt 的最大时间；before 必须非负有限，limit 非负安全整数（0 不删除）。回归覆盖目标已消费但源端未结算、源已结算确认未完成、目标回执已回收后的 Kernel 重建，以及非法 GC 参数不改记录。

这些测试使用同一内存 VFS 中不同 Session 存储根和 Kernel 重建，不等于 SIGKILL/断电或多主机实测。宿主仍须保证 before 早于有效重放窗口；混合旧版本、超过该窗口仍在途的投递、跨存储 fencing 和来源可信边界仍属完整协议验收，不能因本批通过而关闭。
