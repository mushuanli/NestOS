# durable-kernel 接口、事件流与修订验证

审查与修订日期：2026-10-21。对象：`libraries/durable-kernel` 的 0.1.0 源码与发布制品。目标：独立库支持 Session 内多任务、Session 间持久 IPC、停止后恢复，并提供可消费的接口与事件契约。

Session / Task / Program / Effect 分层、事务 Decision、租约 fencing 和 outbox / inbox 保持为执行基础。此次实现补齐了审查发现的五项主要正确性缺口，并收敛新入口、定义 v2 事件校验及可取消观察。接口与边界见随包提供的[API](../../libraries/durable-kernel/docs/api.md)和[事件契约](../../libraries/durable-kernel/docs/events.md)。

## 对照依据

采用各项目官方文档 / 主仓库当日内容。它们处于不同层次；对照的是生命周期和可消费协议，不要求本库实现所有 Agent、聊天或产品能力。

| 项目 | 核实的接口 / 事件行为 | 对本库的启示 |
| --- | --- | --- |
| Codex | App Server 分 thread / turn / item；turn/start 接受请求，turn/completed 携带 completed / interrupted / failed；thread/read 与 thread/resume 分开，history 分页 | 区分只读与激活；有身份的操作及最终状态；请求回执不能替代完成事件。[官方协议](https://developers.openai.com/codex/app-server/) |
| Claude Code / Agent SDK | 完整消息、可选原始 stream_event 和最终 result 分层；session resume 恢复对话，文件 checkpoint 单独处理 | 区分进度与最终权威结果，并明确恢复范围；不能从“恢复会话”推导任意副作用恢复。[流式协议](https://code.claude.com/docs/en/agent-sdk/streaming-output)、[Session](https://code.claude.com/docs/en/agent-sdk/sessions) |
| DeepSeek Harness（dsh） | typed SessionEventMap 的追加日志；Session page / follow 与持久游标、首帧、重连修补结合；Agent 的 live stream 与已提交的历史区分 | 明确日志 schema、快照水位与补读；订阅需有取消信号；普通历史读取不应激活 Agent。[Session 协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)、[Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md) |
| Pi | RPC 区分 command response 与 Session event；agent_end 后仍可能自动继续，agent_settled 才说明后续自动工作结束；abort 等待 idle | 一次请求、一个执行片段、整体静止必须分开；不能把某个终态事件或迭代器结束当成所有工作完成。[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[事件](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)、[abort](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md#abort) |
| OpenCode | Server 发布 OpenAPI 3.1 供 SDK 生成；Session / message / abort 与 SSE event 分开 | 用公开 schema 限制文档漂移；控制调用与观察流分别建模。[官方 Server API](https://opencode.ai/docs/server/) |

上述材料并未共同承诺任意业务副作用 exactly-once，也不能证明它们都支持断点恢复到任意 JavaScript 指令。本库应保留自己的 checkpoint / reconcile / fencing 语义。dsh 的追加日志可派生模型历史，本库的 EventEnvelope 当前是观察日志，执行状态另有权威记录，不应混称同一类事件溯源。

## 问题与最终实现

| 审查项 | 当前行为 | 实现与证据 |
| --- | --- | --- |
| P1 interrupt 与 pause 相同 | pause 排空；interrupt 持久 fence 树内旧 attempt、登记 cleanupPending 并请求物理取消；确认前不允许恢复 | [effect-interrupt](../../libraries/durable-kernel/src/infrastructure/seqfile/effect-interrupt.ts)、[Kernel](../../libraries/durable-kernel/src/application/kernel.ts)；整树、缺失适配器、授权延迟与重建回归 |
| P1 Effect 缺身份 | 领取、结果、重试、核对、清理均携带 effectId；有历史 attempt 时携带 attemptId，context 提供 attemptNumber | [store](../../libraries/durable-kernel/src/infrastructure/seqfile/store.ts)；同一 Task 的并发 Effect 关联回归 |
| P1 inspectTask 激活执行 | inspectTask 与 inspectSession 都冷读；新 core.SessionReader 只暴露观察方法 | [Kernel](../../libraries/durable-kernel/src/application/kernel.ts)、[core](../../libraries/durable-kernel/src/core.ts)；检查无 Session worker 登记 |
| P1 Task watch 早于清理结束 | 默认 settled 后排空；until: exit 显式保留逻辑边界；wait 默认 exit，新增 waitStopped | [event-stream](../../libraries/durable-kernel/src/public/event-stream.ts)、[task-handle](../../libraries/durable-kernel/src/public/task-handle.ts)；阻塞取消确认时仍追尾 |
| P1 裁剪补读无断档协议 | readEvents / watch 抛 CURSOR_EXPIRED；快照和 asOfSequence 同事务读取，用于重同步 | [event-store](../../libraries/durable-kernel/src/infrastructure/seqfile/event-store.ts)；旧水位回退、固定上界、并发追加回归 |
| P2 无订阅取消、全历史扫描 | signal 取消观察，dispose 结束流；Session 按范围批读，Task 按索引二分定位、每页最多 500 | [wait](../../libraries/durable-kernel/src/public/wait.ts)、[event-store](../../libraries/durable-kernel/src/infrastructure/seqfile/event-store.ts)；挂起 next / IO 取消回归 |
| P2 payload 不一致、无 schema | 正常 / 直接 Task 终态统一 ExitRecord；Session / Task queued 统一消息记录；v2 判别联合和解析器；保留命名域禁止冒用 | [事件类型](../../libraries/durable-kernel/src/domain/events.ts)、[解析器](../../libraries/durable-kernel/src/public/events.ts)；v1 / v2 / 非法事件回归 |
| P2 core 别名、递归泄漏、错误码 | core 选 canonical 名称，别名留根入口；retry 返回窄 Task；常用关联类型同入口；控制 / 等待 / 游标错误可机器分类 | [core](../../libraries/durable-kernel/src/core.ts)、[errors](../../libraries/durable-kernel/src/domain/errors.ts)；严格类型检查及仓库外 .mts / .cts 消费 |

## 状态和事件顺序

interrupt 事务保存控制请求、清理责任和 lost attempt，旧结果 / 进度 / 带 claim 的共享写入此后不能提交。worker 依据持久事实调用取消；取消确认、cleanupPending 清除及 effect.cleanup.confirmed 同事务。所有后代清理完成后，控制确认才为真。resume 保留原 Task 和逻辑 Effect，先 reconcile，明确安全的幂等策略才允许重试，未知结果保留 indeterminate。

逻辑终态、物理停止和观察结束分开：wait 默认只等待 ExitRecord，wait({until: settled}) 等清理，watch 默认等 settled 并排空。取消订阅不取消执行；Session 关闭和 Harness 释放结束流，恢复后重新附加句柄。

每页在一个事务中固定 sequence 上界、检查保留边界并读取记录。过期 cursor 不静默推进；丢弃旧投影后读取 snapshot，以 asOfSequence 为新起点。Task 使用原 Session sequence，不能与 Task index、消息 deliverySequence 或快照 version 混用。

## 兼容与支持边界

- 根句柄保留 spawn、status、events、sendToSession、inbox 等名称；core 收敛为 submit、stat、snapshot、watch、readEvents、send、inboxPage。旧 core.ResourceHandle 改用 ManagedHandle，retry 不再泄漏完整旧句柄。
- 新事件 schemaVersion 2。新宿主读取 v1 / v2；只读不会升级，首次新写在同一事务提升 manifest。旧 writer 须先退出，不支持旧新版本混合写入；旧 v1 不足的关联信息保持未知。
- KernelEventMap 收录核心生命周期。应用扩展和尚未收录领域事件由其拥有者校验；旧扩展 API 仍可能抛普通 Error，新控制 / 等待 / 分页协议使用明确 KernelErrorCode。
- 恢复从持久 checkpoint 继续，不恢复任意 JS 栈。同步死循环需要宿主 Worker / 进程隔离。
- 外部 cancel 必须确认指定 attempt 已停止且不能迟到启动；context 的 attemptId / 单调 attemptNumber 用于外部 fencing。内核的持久提交屏障不能替代远端服务的执行屏障，也不承诺任意副作用 exactly-once。
- Session IPC 使用共享事务存储及通知 / 轮询；跨主机 transport 和业务答复协议由宿主提供。宿主邮箱的外部处理与消费确认仍需业务幂等。
- settled 指 Task 的 Effect 最终性；物理托管资源回收还受 ResourceApi / Session close 的独立生命周期约束。Snapshot 重建当前状态，不创造已裁剪的审计历史。

## 当前验收（2026-10-21）

独立库 401 项测试（349 单元/契约、52 真实进程）、构建及仓库外 ESM/CJS/NodeNext 消费通过；应用后端 700、相关前端 20 和隔离 httpd 浏览器 7 项通过。当前实现和范围见[Harness 场景验证](../../libraries/durable-kernel/docs/harness-scenarios.md)，实施提交为 [f31e4a2](https://github.com/mushuanli/durable-kernel/commit/f31e4a2b69736a26fe88fe908f09a8b213fcc241)。独立仓库已建立；npm 发布状态须以 registry 查询结果为准，Git 提交和 tarball 验证不等于已发布。

## 验证入口

[interface-contracts.test.ts](../../libraries/durable-kernel/src/interface-contracts.test.ts) 将原问题场景改成正向回归，覆盖并发身份、整树停止、中断持久化、迟到授权、物理确认、冷读取、裁剪 / 补读、schema、取消及日志脱敏。[事件流回归](../../libraries/durable-kernel/src/public/event-stream.test.ts) 覆盖分页尾部与挂起 IO 的取消。

[真实进程矩阵](../../libraries/durable-kernel/tests/ipc.test.ts) 在 root / module 两种挂载上覆盖 SIGKILL：中止意图保存后退出，替代进程取消失败时保持未确认，再次替换并确认，最后从同一 Task 的 checkpoint 通过 reconcile 恢复，execute 未重复调用。

应用挂接也传入观察专用 AbortSignal；[RunAttachmentController](../../ui/llm-ui-adapter/src/shell/RunAttachmentController.ts) 在 detach 时中断挂起的 next，不取消后台 Task。对应 16 项挂接测试通过，包含新增的观察释放回归。

```bash
pnpm --filter @itookit/durable-kernel typecheck
pnpm --filter @itookit/durable-kernel test
pnpm --filter @itookit/durable-kernel test:package
pnpm typecheck
pnpm docs:check
pnpm architecture:check
```

制品检查同时验证随包 API / 事件文档、ESM / CJS 三入口、NodeNext 声明、core retry 的递归窄类型及 Task / 活动汇总 / 消息 / 定时 / 归档 / shutdown 的实际运行。外部存储的物理停止和迟到启动 fencing 仍以适配器协议为边界。较早批次的测试数量和 tarball 校验和已移除，当前结果以上节及实际制品为准。

## 后续审查实施：通知、幂等、定时和归档

同日增补已完成以下实现：

- 默认 rescanMs 为 1000ms，按 IFileSystem 批量读 journal / 托管资源修订标记；水位不变不枚举 Task。rescanMs 关闭时须接入可靠 wakeSource，普通本地事件不能代替跨进程补扫。
- signal 支持稳定 requestId 与持久 SignalReceipt，同键异内容冲突；终态拒绝新输入，已保存回执仍可重放。
- drain 退休本实例并排空已接纳执行，不暂停共享 Session；blocked 保留心跳和存储责任。shutdown 保留业务暂停语义。
- Session.schedule 使用 kernel.schedule@1、持久 timer-fired 的 firedAt 和原子 spawn，实现单次、固定间隔、skip / catch-up 及 maxRuns。调度本身是可控制、可恢复的 Task。
- archives 提供有界 JSONL 导出、SHA-256 校验及原子导入。restore 要求源端退役与依赖验证，导入暂停；fork 只重建根任务输入和根依赖，由 Program 再创建后代，避免复制旧子任务。
- core 提供 onChanged；文件 node:* 回调和宿主 watcher 的边界、事务后端要求及进程崩溃 / 掉电差异均有独立文档。

文档见[存储与通知](../../libraries/durable-kernel/docs/storage.md)、[定时运行](../../libraries/durable-kernel/docs/scheduling.md)、[文本归档](../../libraries/durable-kernel/docs/archives.md)。

200 个空闲 scope 的回归验证每轮同存储只做一次批量标记事务、未变水位不调度任务扫描。新增活动索引与 Task 同事务提交，在线恢复在修复事务内复核 Task version；正常索引不读 Task 正文，旧格式批读缺少投影的记录以核对遗留清理责任。全部最新证据统一见上文当前验收，避免保留多个相互冲突的“最终”结果。


## 文档清理复核（2026-10-21）

当前全仓文档检查通过：163 份活文档、4 份历史文档链接，0 错误、0 告警。已清理过时远端说明、旧制品校验和及相互冲突的测试基线；历史验收与当前源码状态分开。原 nestos-node 路径失效问题已不再出现，VFS 文档中的废弃符号表述已改为当前接口，并补齐 Web/Tauri 宿主开发说明。npm 发布仍须以 registry 中实际可见版本为准，二次认证链接不写入长期文档。
