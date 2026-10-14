# 本地 P1 范围与实现设计

日期：2026-09-14。范围由用户明确收窄为**完备的本地运行**。迁移、跨主机执行与下述通用扩展不再属于当前 P1，也不是必须先做的后续阶段；保留最终设计作为将来参考，不以其全部落地作为本地验收门槛。

本地完备指当前版本在单机本地事务存储上可启动、传值、委派、控制、恢复和核对持久结果。CLI/Tauri 使用共用核心；同机多个进程和多个 Session 仍在正确性范围内。

## 1. 支持边界

本阶段的保证限定为：单主机时间源、支持跨逻辑记录事务的存储、同一 Session 存储内的调度命令。LocalFS/SQLite 的本机证据不能外推到 NFS、对象存储或多主机。此处是支持与验收范围声明，不是新增了一个部署检测或功能开关。

- 外部 Effect 无可靠结果查询时继续返回 indeterminate；只在显式授权后重放，不承诺供应商恰好计费一次。
- 新 Run 保存插件清单/schema 快照，恢复拒绝契约漂移。旧检查点没有快照时仍依赖宿主；插件代码版本必须不可变，旧 Run 所需实现必须保留。
- 工作区保存创建意图、租约和 finalization 记录；清理失败保留证据与用户文件。Web 没有原生执行能力时拒绝隔离模式。
- 缺少后端能力或清理确认时明确失败或保留 pending；不能以默认成功完成阶段验收。

## 2. 本地持久调度

### A1. 租约的有效区间（本批实现）

有效条件为 ownerId/epoch 匹配、未删除、未释放、expiresAt 严格大于当前时间。到期边界即失效，不需要等待另一宿主出现。已经观察到失权的句柄不再恢复为有效。

心跳不能延长已经到期的租约。续租同时使用共享记录 expectedVersion 和事务内 lease 条件：释放、接管或到期发生在读和写之间时，迟到续租不能复活旧拥有者。skewMs 只延迟其他宿主的接管，不延长旧宿主自己的执行资格。

### A2. 调度写入的原子条件（本批实现）

Kernel 增加可选 `LeaseGuardOptions.lease = { key, ownerId, epoch }`，读取 Session 内共享租约记录，在**同一存储事务**中检查身份与期限，再提交操作。期限由执行该事务的宿主 `Date.now()` 判断，不是 authority store 统一时间。

支持的命令：

- `session.submit(spec, options)`：先检查租约，再进行 requestId 去重或创建 Task。lease 不属于 spec 指纹，因此新拥有者可以复用旧逻辑提交。
- `session.setShared` / `deleteShared`：先检查租约，再检查目标记录版本并写内容/历史/事件。
- `session.signal(taskId, signal, options)`：先检查租约，再写 Task 输入与事件。
- Task cancel/pause/interrupt/resume/start/signal/retry/respond、资源创建和预算：同一事务检查 lease 后写入；图控制命令另检查 Session 写权限并串行化同一 Run 的请求，暂停只作用于该 Run。

失权返回 `STALE_SHARED_LEASE`，不提交 Task、业务输入或共享版本。Task 目录预创建仍遵循既有存储实现；拒绝提交不保证物理上没有空目录。

Flow 取得租约后使用带条件的 Session 视图，覆盖节点提交、成员/检查点/metadata、图重试意图写入及根完成/失败信号。事务校验不依赖前一个调度步的 assertOwned 仍然有效。失权异常直接结束旧调度器，不把 Run 判失败、不由该异常触发任务取消或工作区失败清理。

工作区正常 finalization 完成或失败并写回状态前，调度器保留租约；`waitIdle()` 因而包含这段收尾。清理错误仍由 workspaceCompletion 暴露，不改写已成功的 Run。终态 Run 重开补做 finalization 时同样持租约并校验状态写入。

### A3. 执行边界与本地验收

A2 是本机命令提交条件，不是全面执行端 fencing：

- 已创建的 Task、已发出的 Effect 和已经进入宿主回调的 Git/进程操作，不会因新的 epoch 自动物理停止。
- 取消、重试、资源授权等命令已逐条核对；真实进程 SIGSTOP/过期接管/SIGCONT 验证八种迟到写入拒绝，旧 release 不撤销新租约。物理执行停止仍依赖既有取消屏障与 adapter 确认。
- 条件由新调度器主动附加；省略条件的旧调用方保持原行为，因此不支持混合版本写者共享同一 Run，当前没有统一拒绝旧写者的布局升级屏障。
- 跨宿主时钟跳变、网络分区和跨 store 迁移不在当前保证内。
- 工作区清理超过 5 秒报告持久 pending，CLI 等待退出时输出说明；保留文件与所有权，确认停止后才释放。按策略保留或清理失败时报告具体目录/分支，支持人工处理后重试收尾。

本地验收已覆盖命令审计、实际持久边界崩溃、真实窗口重算，以及原生工作区授权/创建/重启/失败保留/人工处理。运行记录列表、快照和 transcript 不隐式激活任务；继续运行与图重试经正式控制入口恢复。OCI 属可选运行后端，单独验收，不阻塞原生本地 P1；P0 性能指标保持独立。

## 3. 本地数据契约与故障处理

### B1. 节点级输出契约

已实现节点级 `portSchemas` contract，引用 `{ id, version }` 的不可变 schema；没有节点级声明时沿用插件输出契约。节点契约不得静默削弱插件保证。Agent responseFormat 的 JSON schema 编译到节点契约，且确定其对应的是解析后的结构化值，而不是原始响应文本。

schema 身份需显式、可被消费者引用；同 id/version 的不同内容拒绝注册，不直接使用 Agent 的展示名称充当全局 schema 身份。编译后的契约和定义进入 Run 快照，恢复不从新宿主配置重新推导。发布、直接提交和动态图使用同一解析路径。

### B2. 本地输出失败策略

Flow 端口采用严格 fail：保存原始输出和具体错误，不派发不满足输入契约的下游；提供已有的人工修正/重新执行入口。Agent 内部已有的模型响应 repair/continue 保留，不把它误称为 Flow 端口修复。

本地 P1 不新建通用修复任务系统或 invalid 分支 DSL。需要自动修复时先由显式 Flow 节点表达，未来有明确需求再扩展通用策略；不得为修复格式而悄悄重跑带副作用的原节点。

### B3. 现有存储的本地生命周期

保持当前布局，不为对齐目标表名做记录族拆分或迁移。现有 Task/Effect、事件、消息/receipt、cache、资源与预算必须覆盖取消、重启、删除和保留期清理。

同机多 Session 的未确认回执、活跃引用和恢复事实不得误删；清理未确认不得释放实际容量；幂等事实不能因重试重复结算。对现有 API 补故障矩阵，不引入新的存储抽象。

## 4. 移出当前 P1 的扩展

| 扩展 | 当前替代/边界 |
| --- | --- |
| 跨主机调度、S3/NFS authority、网络分区与跨 store 迁移 | 单机、本地事务存储；同机竞争仍验证 |
| 数据布局迁移、混合版本在线运行 | 当前版本重启恢复；保留未知布局/契约漂移拒绝，升级迁移不实现 |
| Storage §5 全记录族重构、通用 account/allocation/export/import 资源服务 | 保持现有资源/预算/请求/回执语义与布局，验证真实使用路径 |
| 可恢复业务字节流、多消费者流协议 | 保留现有模型输出、事件与 transcript；不建设通用 stream 系统 |
| 可插拔 cache provider 能力协商、供应商恰好计费一次 | 内置存储与本地预算去重；不确定 Effect 默认阻断，显式裁决 |
| 通用自动修复 Task、invalid 分支 DSL、任意 schema 转换 | 节点级契约、严格失败、现有人工重试与 Agent 响应修复 |
| 插件构建摘要/旧版本产物仓库 | 当前实现版本不可变；清单/schema 漂移明确拒绝，不自动迁移 |
| 自动冲突解决与完整冲突编辑器 | 现有 auto-if-clean 仅快进；保留分支/工作区、报告冲突、允许人工处理 |
| OCI 与其他平台的完整矩阵 | 当前 Linux 原生/bwrap 基线；选用 OCI 或宣称其能力时单独真实验收 |

“本地”不意味着单进程或无外部副作用：CLI 与桌面竞争、旧进程迟到取消、Bash 子进程未退出、清理悬挂、本机多 Session 的 GC 竞争都必须处理。上述扩展后移不能免除这些义务。

## 5. 证据入口

- `backend/llm-flow/__tests__/scheduler-lease.test.ts`：到期边界、释放、迟到心跳、skew 与接管。
- `backend/durable-kernel/src/kernel.test.ts`：旧条件的 Task/shared/signal 写入被拒、新 owner 复用逻辑 requestId。
- `backend/llm-flow/__tests__/durable-flow-executor.test.ts`：旧宿主卡在回调、接管者完成后旧宿主恢复，不重复提交、不执行失败清理；工作区收尾。
- `apps/cli/tests/crash-matrix.test.ts`：真实 SIGKILL 的提交/完成检查点间隙、委派在途、显式 Effect 重放。
- `ui/app-shell/tests/scheduler-paused-owner.test.ts`：真实旧进程暂停、过期接管、恢复后的迟到控制隔离。
- `apps/cli/tests/20-kernel-ipc.test.ts`：消息消费后 SIGKILL、并发 GC、物理清理与缓存回执原子性。
- [完整目标与缺口](../todo.md)、[Durable 证据映射](durable-harness-evidence.md)、[本机验收记录](../minimal-system-acceptance.md)。

本地 YAML 委派入口已落地：`tasks[].delegation` 指定子 Agent、指令、数量/并发上限与失败策略。子任务工具取父子交集，当前不暴露嵌套委派。真实 CLI crash-matrix 的委派用例通过这一公开入口运行，夹具只负责注入进程崩溃。
