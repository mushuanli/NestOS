# Context 自动 GC

状态：已实现。策略与调度属于 `@itookit/llm-context`；事务适配属于 `kernel-adapters`；Session 权限和生命周期由 `app-core` 装配。Kernel 不依赖 Context，也不解析 Context 对象。

## 参考与取舍

核对日期：2026-09-21。以下链接指向官方源码，分支内容可能继续变化。

| 参考 | 已核对的行为 | 本项目采用 |
|---|---|---|
| [OpenCode truncate.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/truncate.ts) | 超大输出外置；工具临时文件保留 7 天；延迟 1 分钟启动，每小时清理，随作用域停止 | 有界输出、延迟后台维护、清理失败隔离和生命周期管理 |
| [Gemini CLI sessionCleanup.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/utils/sessionCleanup.ts) | 启动清理；可配置年龄/数量策略；排除当前会话；清理结果计数，异常不阻断启动 | 当前执行保护、可配置保留期、结果可观测、错误不影响主任务 |
| 本仓 Context/Codex 基准 | 活动窗口、规范状态、Notes、原始历史分离；先发布内容，再提交 checkpoint | 窗口淘汰不代表原始证据失效；持久引用决定存储对象是否存活 |

上述临时文件/会话清理策略不能直接用于 durable checkpoint。这里年龄只筛选**已经不可达**的对象，不覆盖引用保护；损坏记录也不作为可删除证据。

## 两种回收

活动窗口由已有 `IContextEngine` 自动按预算裁剪/压缩；Canonical policy、目标和完整工具组仍受保护。历史原文和 Notes 引用不会随窗口裁剪删除。

存储 GC 使用 mark-and-sweep。当前实现只回收**已终结 Task 中、超过保留期的不可达新内容**。已保留的旧 Task snapshot、Effect 回执、Context receipt 和 shared history 都是根，因此正常提交的历史仍可审计。历史保留政策尚未被本次 GC 改写，不能把它描述为对总磁盘空间的硬限制。

## 端口和布局

`IContextGcStore.exclusive(work)` 提供与发布和根提交串行化、删除失败可回滚的事务视图。视图只暴露 `roots/entries/read/remove`。Context 层负责解析 ContentRef、遍历引用、校验预算和选择孤儿；适配器负责判断拥有者是否已静止以及提供真实根。

新内容存于现有 `<session-root>/tasks/<task-id>/task.seq`：

```text
context-content/blob/<sha256> → UTF-8 original body
context-content/meta/<sha256> → { id, createdAt, bytes }
```

正文与元数据一起提交。该命名空间不进入 TaskRecord 的 state/snapshot，也不被当作根；Kernel 的完整 Task SeqFile 删除流程会一并清除它。这样无需解除固定目录保护，也没有“删掉文件后数据库记录仍然残留”的新路径。

旧 `context-content/<sha256>` 文件仍能读、仍能作为引用图节点，但不自动迁移或删除。数据库页是否缩小由后端负责，`reclaimedBytes` 表示本轮逻辑删除的正文 UTF-8 字节数。

## 发布屏障与事务证明

1. **运行中隐式 pin 全部内容**：只要 Task 未终结，GC 返回 busy。即使 prepare 已发布、Kernel 还没有写入 Effect result/head，正文仍受保护。审批等待、暂停和慢模型调用不会因为年龄而失去内容。
2. **确认静止**：Task 必须有终态与 exit、没有 currentAttempt；所有 Effect 都必须处于 succeeded/failed/cancelled，且没有 currentAttempt/cleanupPending。indeterminate 不视为静止。
3. **同事务验证**：GC 在 SeqFile 事务中重新读取 Task 状态、枚举根、完成标记、删除正文和元数据。内容发布也在同一后端事务中验证 Task 非终态；Kernel 自身提交同样经过该事务序列。
4. **完整标记后 sweep**：根包含全部非 Context 正文的 Task 行及快照，以及该 Task 的 Context shared 当前值与历史版本。递归保留 snapshot/history 链、Notes evidence 和工具预览内嵌引用。读取引用时校验 hash/字节数；缺失、损坏、格式错误、预算不足均终止整轮。
5. **终态不复活**：当前 Kernel 手动 retry 创建新 Task，旧 Task 的内容空间不重新用于新执行。GC 之后的迟到发布在终态检查处失败，不产生可提交的新候选。

因此当前实现无需用会过期的短租约代表未完成发布。Session 写租约仍由宿主管理，完整应用在每个 Task 的维护入口检查本地租约状态；数据安全的并发屏障来自上述存储事务，而不是该时间检查。

Context 当前不提供跨 Task 内容共享或独立的模型可操作 pin API。宿主在当前 Task 的 Context shared 命名空间保存的引用及历史版本会成为根，但不得绕过 Content 服务向终态 Task 注入已经失效的新引用。未来若需要在线回收活跃 Task 的孤儿，必须额外引入发布租约、pin 交接与事务复核协议。

## 默认调度和预算

| 参数 | 默认值 |
|---|---:|
| 首次延迟 / 后续间隔 | 60 秒 / 1 小时 |
| 单轮 Session / Task 数 | 8 / 32 |
| 孤儿最小保留期 | 24 小时 |
| 单 Task 对象 / 根扫描上限 | 10,000 / 10,000 |
| 标记读取字节预算 | 64 MiB |
| 单 Task 删除上限 | 128 |
| 单 Task 协作时间预算 | 1 秒 |

Task 使用带固定上界的分页 cursor；Session 轮转，避免每次只扫列表头部。时间预算在存储操作之间检查，不声称能中断一次阻塞的后端 I/O。超过扫描预算时整轮保留；可通过配置提高预算，不能以部分扫描结果继续删除。

只登记宿主已授权恢复或已执行 Context Effect 的 Session。完整应用在成功取得租约后的恢复钩子登记；headless 自动恢复时登记恢复范围；新执行在解析 Context 服务时登记。覆写 `contextService` 时关闭默认维护器，避免操作自定义存储。

定时与手动调用共享在途 Promise，沿用先启动调用的参数。`dryRun` 做完整判定但不删除；状态为 collected/dry-run/busy/budget/failed。宿主可读取 `lastResults` 或订阅 `onResult/onError`。关闭 Session 先撤销登记、等待当前轮次，再释放适配器；关闭运行时取消定时器并等待事务，不留下后台写入。

## 故障证据

- [collector.test.ts](../../backend/llm-context/src/gc/collector.test.ts)：间接引用、内嵌输出引用、保留期、dry-run、扫描/字节/时间预算、损坏根、批量删除、非重入与关闭等待。
- [task-content-store.test.ts](../../backend/kernel-adapters/src/context/task-content-store.test.ts)：未提交候选保护、快照/shared 历史根、Effect cleanup、事务删除故障回滚、双收集器串行、迟到发布拒绝。
- [context-runtime.test.ts](../../backend/app-core/tests/context-runtime.test.ts)：真实 Kernel 提交后删除孤儿，最终答案和历史仍可检索。
- [context-gc.test.ts](../../backend/app-core/tests/context-gc.test.ts)：运行时关闭后重建，无需新模型调用即触发自动 GC；失去写权限时跳过；恢复权限后回收。

目前验证覆盖 MemoryBackend 的真实事务和运行时重建；没有将其等同于所有后端的断电、SQLite VACUUM 或全部进程 SIGKILL 故障矩阵。
