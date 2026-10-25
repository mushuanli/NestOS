# Context API

`@itookit/llm-context` 拥有上下文领域实现，零运行时依赖。其他模块通过包根接口与工厂调用；`durable-kernel` 不引入 Context 依赖。

纯内容摘要通过 `@itookit/llm-context/digest` 的 `sha256Bytes`、`sha256Hex` 和 `sha256HexSync` 调用，源码与发布产物均提供独立 ESM/CJS 及声明入口。契约层需要摘要时使用该入口，避免通过包根加载 Context 运行时；既有根导出与包内 `content/digest` 转发保留兼容。

## 接口与实现位置

| 接口 | 用途 | 实现 |
|---|---|---|
| `IContextAssembler` | 分支历史、Profile、材料与记忆装配 | [context-assembler.ts](../backend/llm-context/src/assembly/context-assembler.ts) |
| `IContextProfiles` | 不可变 Profile 版本与选择规则 | [profiles.ts](../backend/llm-context/src/application/profiles.ts) |
| `IContextEngine` | 完整工具组、目标与策略保留、输入预算 | [engine.ts](../backend/llm-context/src/window/engine.ts) |
| `IContextService` | prepare/request、内容 admission | [service.ts](../backend/llm-context/src/application/service.ts) |
| `IContextReader` | inspect/history/read | [reader.ts](../backend/llm-context/src/application/reader.ts) |
| `IContextContentStore` | 按 hash 发布、读取并校验不可变内容 | [store.ts](../backend/llm-context/src/content/store.ts) |
| `IContextGcStore` | 与内容发布/根提交共享的事务 GC 视图 | [task-content-store.ts](../backend/kernel-adapters/src/context/task-content-store.ts) |
| `createContextGc` / `scheduleContextGc` | 引用标记、保留期、预算、定时维护 | [collector.ts](../backend/llm-context/src/gc/collector.ts)、[scheduler.ts](../backend/llm-context/src/gc/scheduler.ts) |
| `ContextServiceResolver` | 按真实 Task/Session 获取服务 | [context-service.ts](../backend/app-core/src/runtime/context-service.ts) |

`ChatMessage`、`ToolDefinition`、`ContextPlan`、`ContextSnapshot`、`ContextCompactionPolicy` 等类型以 Context 为唯一来源。llm-tasks 入口保留相关类型转发，原 llm-common 与 common 的 LLM 转发均已删除；Session 的 Profile 文件存储仍由 adapter 负责。

当前输入仅在所属 Round 的实际消息已被选入且正文结构、附件身份均相同时去重。正文与附件分别比较，字面 JSON 文本不等同于结构化消息；附件参与预算估算，附件变更不能被相同正文吞掉。

## 持久执行

```text
Agent/Chat v2 → context.prepare@1 → 发布 history + request snapshot
             → 同一 Kernel Decision 提交 head/receipt CAS + Task cursor + llm.chat@2
             → llm.chat@2 校验 snapshot hash → 调用已有 LLM adapter
```

新 head 未提交时只能看到旧版本；旧请求重试读取原 snapshot，不重新装配。`operationId` 来自真实 Effect ID，同一 ID 不允许不同输入。Durable prepare 只接收 JSON 数据，File/Blob/ArrayBuffer 等活动附件须先由宿主转为可持久引用，不能静默存成空对象。相同已提交操作返回原引用，避免重复追加。最终助手答案通过 archive-only prepare 归档，不再触发模型请求。

`ContextTaskProgram` 包装 v1 状态机为 v2，保留审批键和工具调用身份。执行中只保留当前工具批次、cursor 与待提交信息，不再在每轮状态保存完整 messages。原始 Task input、历史快照和 Effect 元数据仍存在；不保证整个 TaskRecord 常量空间。

`createKernelRuntime` 默认注册 v1/v2；新建直接 Chat 和 Flow 的 Agent/Chat 在支持时选择 v2，已持久化 v1 Task 仍由 v1 恢复。Flow 在 scheduler checkpoint 固定 contextProgramVersion；旧 checkpoint 缺少此字段时继续使用 v1。自装 Kernel 可通过 `registerDurablePrograms(kernel, undefined, true)` 注册 v2，同时必须注册三个 Context Effect。宿主可用 `CreateKernelRuntimeOptions.contextService` 替换默认端口。

存储以 Session 绑定根目录为准：

```text
shared state:
  context/<encoded-task-id>/head
  context/<encoded-task-id>/receipt/<encoded-effect-id>
immutable content:
  <session-root>/tasks/<encoded-task-id>/task.seq
    context-content/blob/<sha256>  → original body
    context-content/meta/<sha256>  → id / createdAt / bytes
legacy content (read compatibility):
  <session-root>/tasks/<encoded-task-id>/context-content/<sha256>
```

每个 Task 独立内容命名空间；模型参数不能指定其他 Task/Session。候选 blob 先发布并回读校验，shared 写入遵守已有 Kernel 事务和 fencing。VFS 后端负责实际持久性；这里不额外承诺独立 fsync 协议。新内容使用现有 Task SeqFile 的独立命名空间，发布、GC 和 Kernel checkpoint 共用后端事务；Session 删除也会清除这些记录。旧文件保持只读兼容，不自动迁移或回收。

## 窗口策略与预算

```ts
const contextCompaction = {
  maxMessages: 100,
  keepRecent: 20,
  maxInputTokens: 64_000,
  maxToolOutputBytes: 16_384,
  strategy: 'summary-tail', // prune | summary-tail | checkpoint-reset
  summaryTokens: 1024,
};
```

默认使用 prune。保留 system/developer、最初用户目标、最新用户消息、最后消息及完整工具调用组；消息数上限因此是软限制。预算覆盖请求 JSON 与工具 schema，默认以 UTF-8 字节保守估算文本 token，`estimated=true`；不替代 provider tokenizer 或图片/音频计费。`IContextEngine` 可由宿主替换。必需内容超限则失败，不静默丢掉规则或目标。

summary-tail 通过注入端口生成有界笔记；摘要源和请求也检查预算。checkpoint-reset 要求笔记基于当前 revision、版本连续且 evidence 可读取；没有有效笔记就失败。Notes 作为派生观察插入 user 消息，不能改变执行权限。模型显式 checkpoint 即使未超限也会生效。Skill 规则每轮从持久 Skill 状态重建，其他初始规则固定在接受的请求中。

旧 ContextPlan 的 tokenBudget 仍是预装配估算；v2 请求预算在工具 schema 确定后再次检查。上游已经排除或裁剪的 Session 历史不属于当前 Task 的完整历史，仍从 Session 原记录读取。

## 工具输出与检索

v2 Agent 有工具授权时增加三个内建工具：

| 工具 | 行为 |
|---|---|
| `context_history` | 有界历史分页与文本搜索，返回当前 revision 和续页 cursor |
| `context_read` | 按输出预览中的 ref 分段读取；offset/limit 为字符串位置和字符数 |
| `context_checkpoint` | 提交工作笔记提案，在整个工具批次完成后应用 |

`tool.call@2` 在工具驱动原有截断前注入宿主 `admitOutput` 回调，先发布完整模型可读文本，再生成头尾预览与引用。未注入回调的旧工具调用保持旧限制。工具自身或远端服务已经截断的内容无法还原。工具外部效果未知时仍返回 indeterminate，不能因为需要补存输出而自动重做副作用。

History 保留原始增量和内容引用；窗口淘汰不删除原始历史。查询最多扫描 100 个 segment、每页最多 100 条，检索工具的最终输出再经字节 admission。内容缺失/hash 不符明确失败。尚无向量索引、跨 Task 共享或 provider native compaction。

## 自动 GC

默认开启：首次拥有 Context Session 后延迟 60 秒执行，之后每小时执行；同一维护器不重入。每轮最多访问 8 个 Session、处理 32 个 Task，Task 列表使用固定上界分页并轮转。恢复已授权 Session 时重新登记，完整应用每个 Task 前检查 Session 租约；未取得写权限的 Session 不参与。覆盖 `contextService` 时由宿主负责 GC，默认维护器不会猜测自定义存储。

每个 Task 的默认限制：孤立对象至少保留 24 小时，最多扫描 10,000 个对象和 10,000 个根、读取标记材料 64 MiB、删除 128 个对象；存储操作之间检查 1 秒协作时间预算。单次后端 I/O 的耗时不能强制中断。Task 必须终态、有 exit、无活动 attempt，所有 Effect 均结束并确认清理；审批等待、暂停、indeterminate 等一律保留。

根包含当前 Task、全部保留的 Task 行/快照、当前 Context shared 值及其历史版本。沿 request/history/notes/evidence 和工具预览中的 ContentRef 递归标记，并校验字节与 hash。标记不完整、引用缺失、内容损坏或预算耗尽时不删除。删除与元数据更新同事务，失败回滚；旧文件引用可参与标记，旧文件本身不参与 sweep。内容发布在同一事务检查 Task 尚未终结，避免迟到写者越过终态屏障。

```ts
const runtime = await createKernelRuntime({
  // ...host ports
  contextGc: {
    policy: { retentionMs: 86_400_000, maxDeletes: 128 },
    intervalMs: 3_600_000,
    onResult: report => recordMaintenance(report),
  },
});
await runtime.contextGc?.collect({ dryRun: true });
await runtime.contextGc?.collect();
// runtime.contextGc.lastResults: status, candidates, deleted, reclaimedBytes, error
```

`contextGc: false` 禁用维护器。并发手动调用和定时调用合并到当前轮次，采用该轮已经确定的参数；dry-run 不删除内容。`dispose()` 停止调度并等待在途事务。此 GC 回收终态孤儿，不是总磁盘容量上限：被历史引用的内容仍保留，后端数据库物理压缩由存储层负责。设计与参考见 [自动 GC 设计](design/context-gc.md)。

## 验证

- [service.test.ts](../backend/llm-context/src/application/service.test.ts)：CAS 竞争、回执幂等、连续三次窗口切换、Notes 版本、Unicode 大输出、工具组、schema 预算。
- [context-program.test.ts](../backend/llm-tasks/src/durable/context-program.test.ts)：联合 Decision、持久状态恢复、工具批次与伪造 checkpoint 拒绝。
- [effects.test.ts](../backend/kernel-adapters/src/context/effects.test.ts)：缺失/损坏快照、跨 Task 拒绝、取消屏障、未知外部效果。
- [context-runtime.test.ts](../backend/app-core/tests/context-runtime.test.ts)：真实 Kernel 审批点关闭/重开、工具不重跑、checkpoint、完整原文检索、v1/v2 并存。
- [collector.test.ts](../backend/llm-context/src/gc/collector.test.ts)：可达性、保留期、dry-run、预算、损坏引用、批量限制、调度与关闭。
- [task-content-store.test.ts](../backend/kernel-adapters/src/context/task-content-store.test.ts)：发布保护、历史根、事务回滚、Effect 清理确认、并发 sweep 和终态发布屏障。
- [context-gc.test.ts](../backend/app-core/tests/context-gc.test.ts)：重启自动清理、写权限检查和已提交历史检索。

CLI 的 22 个既有 SIGKILL 恢复用例也已通过；这不等同于覆盖 Context 发布协议的全部进程 kill-point 或各后端断电矩阵。CLI 非崩溃测试有两个既有路由/supervisor 场景失败，在临时关闭 v2 的 v1 对照中同样复现。

`ContextEngineOptions` 可注入默认窗口与完整请求计量；`IContextEngine.measure` 将预算检查贯穿窗口、Notes 和摘要。`ContextServicePorts.engineOptions` 自动构造默认引擎，显式 engine 优先。计量器返回非负安全整数；默认是 UTF-8 字节估算。app-core 的 `contextEngineOptions` 同步用于真实摘要请求。
