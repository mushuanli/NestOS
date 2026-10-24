# Harness 通用原语借鉴清单（RAPTOR 来源）

本文把 RAPTOR 中**可移植到通用编排层**的机制，与本仓库的现有实现位置、缺口和验收方式逐条对齐。RAPTOR 是方法来源，不是运行依赖；本文不宣称任何缺口已经实现，未闭环的行保持“缺口”标记。

与其他两篇的分工：

- [RAPTOR 用例与远程编排](raptor-harness-integration.md)：哪些 RAPTOR 用例迁入了 `.flow`、哪些明确没迁、远程执行与沙箱边界。
- [Durable 契约证据映射](durable-harness-evidence.md)：Durable 设计目标 → 实现 → 持久记录 → 故障证据。
- 本文：**从 RAPTOR 借什么、我们现状在哪、缺口是什么、用什么证据闭环**。

上游基线固定为 [`2ac96303d5e382c196aa34b2984a3c6a218132a9`](https://github.com/gadievron/raptor/tree/2ac96303d5e382c196aa34b2984a3c6a218132a9)。文中上游路径均指该 commit 的 checkout，链接指向 GitHub 固定版本。

更新约定：新增原语补一行总表并补小节；把“缺口”改成“证据”之前，必须先有可复现测试或实机记录；业务词表（verdict、severity、CWE、producer taxonomy）一律留在业务 Flow 资源，不进核心。

## 0. 不借清单（我们已更强）

| 维度 | 本仓库 | RAPTOR | 结论 |
| --- | --- | --- | --- |
| 持久性、幂等、租约、fencing、恢复 | `libraries/durable-kernel`，协议 §2 十条不变量 + kill 矩阵，见 [证据映射](durable-harness-evidence.md) | JSONL 账本 + worker 存活检查 | 不借；照搬会把 durable 语义拉回进程内 |
| 端口/模式契约 | `backend/llm-flow/src/flow/port-contract.ts` 的 `id@version` + 子类型证明 | 无对应物 | 不借 |
| 调度并发模型 | Kernel Task/Effect + 持久检查点 | `ThreadPoolExecutor` 进程内同步池 | 只借策略（B-08、B-09），不借机制 |
| 预算账本 | `libraries/durable-kernel/src/application/kernel.ts` 的 `chargeBudget(usageId)` 幂等、跨重启可恢复 | `cost_tracker` 内存计数 + 运行目录 JSON | 不借账本，只借语义（B-09、B-10） |

## 1. 原语总表

| ID | 原语 | 我们的现状 | 缺口 | 批次 |
| --- | --- | --- | --- | --- |
| B-01 | 有界产物协议：解析前卡大小、全量落盘 + 摘要引用、超预算独立错误 | `backend/tools/src/tools/Bash/BashTool.ts` 截断 + `truncated` 标记 | 无“落盘 + 引用”通用能力；超预算与坏 JSON 不可区分 | 一 |
| B-02 | 三态能力探测与版本闸门 | `backend/kernel-adapters/src/effects/tool-call-effect.ts` 只比声明版本 | 外部二进制不可见/版本不足无人验证 | 一 |
| B-03 | 内容寻址证据块 + 环境不可验证第三态 | `backend/kernel-adapters/src/effects/llm-chat-effect.ts` 有 indeterminate | 无 `unverifiable` 分类；证据块无跨管道去重 | 一 |
| B-04 | 源 span 五态 staleness | 只有定义/契约漂移（`backend/llm-flow/src/flow/run-catalog.ts`） | 恢复时不校验被处理内容是否变化 | 一 |
| B-05 | 覆盖账本 + 残差查询 | 无 | 无法回答“看过什么、剩什么” | 二 |
| B-06 | `skipped-with-reason` 阶段终态 | 原因已记录、持久化、进入 Run 结果 `skipped[]` 并有 `node.skipped` 事件 | 缺流程内引用与预算判据 | 一（部分完成） |
| B-07 | judge 绑定 primary 不可变快照 | `apps/cli/examples/raptor/raptor-review.flow` 当前成立 | 无校验规则保证未来不被回写污染 | 二 |
| B-08 | (item × model) 成对幂等身份 + 每模型断路器 | `chargeBudget` 幂等，粒度是资源句柄 | 无 pair 身份；无 per-model 断路器 | 三 |
| B-09 | 预算预检取最贵模型上界 + 分档 cutoff | 只有每请求输出上限 | 无累计预算与分档跳过判据 | 三 |
| B-10 | abort 后 straggler 收尾，已花费不得记为“未发生” | 取消有“请求/确认”两态 | 取消与异常路径不补记已发生花费 | 二 |
| B-11 | 隔离地板契约：floor 声明 + dispatch 前断言 + 请求/交付成对记录 | `tools/mindos-node/src/plugin/process/sandbox.rs` fail-closed 启动 | 无“请求边界 vs 交付边界”记录 | 二 |
| B-12 | 有版本、可迁移、损坏即隔离的派生上下文缓存 | VFS/Context 有持久化 | 缺派生产物的版本-迁移-隔离约定 | 三 |
| B-13 | 度量防伪：label digest + 工具链版本戳 + 反事实评分 | `doc/design/fixtures/raptor-parity-evidence.json` 有 definition sha | 无标签集摘要与工具链戳，结论过期不可察觉 | 收尾 |
| B-14 | 只读子代理与证据完整性绑定 | 模型节点按需声明 `Read`/`Grep` 能力 | 缺“账本写入者必须是宿主”的不变量与测试 | 二（B-05 前置） |

## 2. 逐条说明

### B-01 有界产物协议

- 机制：外部工具的 JSON/日志先按大小拒绝再解析；产物全量落盘并由引用传递，模型只看到有界摘要；“超预算”是独立错误类型，继承普通解析错误以便旧路径降级、新路径可区分。
- 上游：`core/json/bounded.py`（`loads_bounded`、`load_json_bounded`、`JsonBudgetExceededError` 继承 `ValueError`，open 后 fstat 关闭换位窗口，非 `S_ISREG` 拒绝）。
- 现状：`backend/tools/src/tools/Bash/BashTool.ts` 的 `MAX_OUTPUT_CHARS = 50_000` 直接 `slice` 并置 `truncated`，判断责任推给每个上层；`.flow` 侧只能靠 `truncated=false` 门禁整体拒绝。
- 缺口：没有“全量落盘 + 引用”的通用输出形态；端口 schema 无法把 `over-budget`、`malformed`、`empty` 分成三种。
- 落地层：`backend/tools` 适配器输出形态 + `backend/llm-flow` 端口判别；不改内核。
- 验收：缺口。需要覆盖“超预算不给截断后的部分结果”与“坏 JSON 与超预算分类不同”。

### B-02 三态能力探测与版本闸门

- 机制：能力探测有明确三态——缺失、存在但不回答（`returncode=None`）、可用带版本；探测用净化环境、exec 解析后的绝对路径（堵 `which` 到裸名的 TOCTOU），负结果也缓存。
- 上游：`core/run/toolprobe.py`（`ToolInfo`、`probe`、`_CAPTURE_RETAIN_CHARS`）。
- 现状：`backend/kernel-adapters/src/effects/tool-call-effect.ts` 只比较 manifest 声明的 `meta.version`，与宿主上真实可执行文件无关。
- 缺口：外部工具是否可见、版本是否满足下限（例如需要版本门控的命令行开关）无人核实；远程项目沙箱内可见性尤其如此。
- 落地层：tool manifest 增加 `probe` 声明 + Effect 前置探测，三态写入日志与 Effect 结果。
- 验收：缺口。可用 RAPTOR 场景做首个真实用例（扫描器版本低于下限时明确拒绝，而不是拿到未知参数错误）。

### B-03 内容寻址证据块 + 环境不可验证第三态

- 机制：证据按内容哈希寻址，同一字节只写一次、跨管道自动去重；执行结果区分“证伪”“证实”“环境无法验证”，第三态既不算成功也不算失败。
- 上游：`core/witness/`（`Witness` 只存 sha256 引用 + `WitnessStore` 哈希寻址）与 `core/witness/sandbox_outcome.py` 的 `UNVERIFIABLE_ENVIRONMENT`。
- 现状：`backend/kernel-adapters/src/effects/llm-chat-effect.ts` 的 `reconcile` 已有 indeterminate；`tools/mindos-node/src/plugin/harness/receipts.rs` 已有 epoch 回执。
- 缺口：没有“沙箱/环境未满足”这一分类，于是“没复现”容易被读成“不存在”；证据块没有内容寻址，重复产物无法自动合并。
- 落地层：kernel-adapters Effect 结果分类 + VFS 内容寻址目录。
- 验收：缺口。需要覆盖“环境拒绝执行时结论为不可判定，且不写入任何否定证据”。

### B-04 源 span 五态 staleness

- 机制：对“我处理过的那段源”记录 span 哈希与归一化哈希，重入时给出五态：`current`、`modified`、`cosmetic`、`deleted`、`unknown`；`unknown` 绝不折叠成 `modified`；一次读取文件即可得出任意多个 span 的结论。
- 上游：`core/staleness/`（`Span`、`SpanResult`、`hash_spans`、`check_batch`；注释剥离后的归一化哈希；明确声明“staleness 检测器，不是完整性校验”）。
- 现状：Flow 内的 drift 检查只覆盖**契约**漂移（`backend/llm-flow/src/flow/run-catalog.ts`）；恢复只校验定义摘要、端口模式与工作区租约，不校验被处理的内容。
- 缺口：源文件变了却复用旧检查点结论，是“看起来成功”的假结论来源。
- 落地层：Kernel shared state 存 `(resourceHandle, span)` 的 span 哈希与归一化哈希，恢复时批量判五态；`unknown` 单列并触发重新确认，不进重算路径。
- 验收：缺口。需要覆盖“注释改动判 cosmetic”“截短后 span 越界判 deleted 而非 unknown”“读不到判 unknown 而非 modified”。

### B-05 覆盖账本与残差查询

- 机制：追加式账本记录每个已处理单元及处理时的上下文；批次边界统一 fsync 而非逐条；**只有账本完整加载才允许判定“已完成”**，两种读模式——只读消费可降级为部分视图，授权花费的必须硬失败；短写要回滚部分字节；压缩视图按业务主键 most-recent-wins。
- 上游：`core/coverage/journal.py`（`append_entry`、`flush_journal`、`JournalIncomplete`、`require_complete_entries`、`load_entries_checked`）。
- 现状：Flow 有 Task 终态与事件流，可回答“跑没跑”，不能回答“这一轮到底看过哪些单元、还剩哪些没看”。
- 缺口：无账本，因此“覆盖残差”这类判断无从建立；同时缺少“谁能写账本”的约束（见 B-14）。
- 落地层：宿主写入的记录目录（可复用 receipt 的 scope 形态）+ app-core 查询；业务词表留在业务 Flow。
- 验收：缺口。需要覆盖“部分加载不得判完成”“短写回滚不留半条记录”“残差查询与已处理集合互斥”。

### B-06 `skipped-with-reason` 阶段终态

- 机制：阶段可以“整段跳过并记录原因”，且必须与“跑了但全部失败”区分开——二者运维响应相反。
- 上游：`packages/llm_analysis/orchestrator.py` 的 `should_skip_phase` 与 `_classify_absent_consensus`；分档 cutoff 为 consensus 0.70、judge 0.75、exploit 0.85、patch 0.85、aggregate 0.95。
- 现状：已落地第一版。`backend/llm-flow/src/flow/skip-state.ts` 定义通用原因词表（`branch-not-selected`、`upstream-skipped`、`call-source-skipped`、`delegation-cancelled`）与记录结构；跳过写入点仍是 `backend/llm-flow/src/flow/scheduler-readiness.ts` 的单一 `skipNode`，首次判定优先，激活与图重试失效时清除。原因随 `backend/llm-flow/src/flow/scheduler-state.ts` 进入检查点（可选字段，旧检查点照常恢复），由 `backend/llm-flow/src/flow/run-aggregation.ts` 投影到 Run 结果的 `skipped[]`，并以 `node.skipped` 事件经 `backend/llm-flow/src/flow/scheduler.ts` 的 `reportSkips` 发给宿主；恢复时只补报本段新增的跳过。
- 缺口：①`${nodes.X.skipped}` 这类**流程内引用**仍被 `backend/llm-flow/src/flow/structured/references.ts` 的“必须是 `nodes.id.outputs.port`”规则拒绝，路由无法据此分支；②预算判据（B-09）尚未接入，`budget` 原因值还不存在。
- 落地层：`backend/llm-flow` 插件与结果投影；不改检查点 v1 的必填结构、不改租约边界。
- 验收：`backend/llm-flow/__tests__/flow-skip-reasons.test.ts` 5 项通过——未选分支记录 `branch-not-selected` 且根任务成功、下游记录 `upstream-skipped`、`node.skipped` 事件恰好一次且带原因与边、恢复后原因仍在、旧检查点无该字段可解码而非法原因值被拒。

### B-07 judge 绑定 primary 不可变快照

- 机制：裁决者读取的是“初判在裁决时刻的快照”，即使后续阶段回写了初判字段，裁决对象也不被替换。
- 上游：`packages/llm_analysis/orchestrator.py` 的 `_snapshot_verdicts`，理由原话是避免 judge 询问一个 primary 可能并不持有的判决。
- 现状：`apps/cli/examples/raptor/raptor-review.flow` 的 judge 输入是 `initial` 节点输出，当前成立；但这是定义写法的巧合，不是被校验的不变量。
- 缺口：一旦有人在 consensus 之后回写 primary 字段，judge 的裁决对象会被静默替换。
- 落地层：Flow 校验规则——凡引用“可被 loop/route 回写节点”的输入，必须显式声明快照语义。
- 验收：缺口。需要覆盖“回写后 judge 输入不变”。

### B-08 (item × model) 成对幂等身份 + 每模型断路器

- 机制：批量面板按“输入项 × 模型”成对建立幂等身份；每个模型独立熔断，且阈值双向权衡——从未成功过要快速放弃，曾成功过要容忍瞬时风暴；全部工作预先入队，模型判死后短路尚未开始的部分。
- 上游：`packages/llm_analysis/dispatch.py`（`_breaker_should_open`、`_BREAKER_PROVEN_THRESHOLD`、预提交 futures 后短路）。
- 现状：`libraries/durable-kernel/src/application/kernel.ts` 的 `chargeBudget` 以 usageId 保证幂等，粒度是资源句柄；Flow 里同一 finding 对同一模型的第二次尝试没有独立身份。
- 缺口：429 风暴或凭据中途失效会把所有分支的预算一起烧掉。
- 落地层：Flow 调度层（`backend/llm-flow/src/flow/scheduler-readiness.ts` 与 retry 路径），不进内核。
- 验收：缺口。需要覆盖“同一 pair 重复提交不重复计费”“模型判死后未开始的 pair 不再发起”。

### B-09 预算预检上界与分档 cutoff

- 机制：派发前的预算预检用最贵模型算保守上界；各阶段有各自的 cutoff 分档，跳过是整段跳过。
- 上游：`packages/llm_analysis/dispatch.py` 的预算预检分支与 `packages/llm_analysis/tasks.py` 的分档常量。
- 现状：`backend/llm-flow/src/contracts/flow-definition.ts` 的 `budget` 注释写明“每请求输出上限，不是累计预算”；累计预算与分档判据都不存在，“还够跑”的乐观估计会让长跑流中途断供。
- 缺口：见上；与 B-06 强耦合。
- 落地层：与 B-06 同批。
- 验收：缺口。

### B-10 abort 后 straggler 收尾

- 机制：中止后仍要清扫已提交的工作，把“确实执行完并已计费”的结果登记为事实，而不是回填成“被中止、未发生”。
- 上游：`packages/llm_analysis/dispatch.py` 的 straggler sweep 与错误信封分支（空字符串错误信封曾因真值判断走了成功路径并重置熔断）。
- 现状：Durable 侧区分“取消请求已接受”与“外部已停止”（见[证据映射](durable-harness-evidence.md)不变量 10）；但 `backend/kernel-adapters/src/effects/llm-chat-effect.ts` 的 `chargeUsage` 只在正常返回路径调用，取消或异常中断后不再补记已发生的花费。
- 缺口：缺少“中止后收尾登记”的通用惯例，导致成本与事实可能同时丢失。
- 落地层：Kernel 取消收尾路径 + `chargeBudget` 记账；Effect 侧在中断分支携带已知用量。
- 验收：缺口。可在现有 crash 矩阵里扩展“中断后已发生的调用仍有花费记录”。

### B-11 隔离地板契约

- 机制：调用方声明一次隔离下限（floor），入口检查意图，**每次派发前**再断言实际交付能力不低于 floor；任何降级通道都必须穿过派发点，否则 fail closed；跨平台不比较、同一档内变化的轴（策略 ABI、seccomp、egress）是拒绝条件而不是新档位。
- 上游：`core/sandbox/tiers.py`（`ContainmentTier` 全序 + `assert_floor`）与 `core/sandbox/context.py`。
- 现状：`tools/mindos-node/src/plugin/process/sandbox.rs` 在 bubblewrap 不可用时 fail closed；`tools/mindos-node/src/plugin/projects/api.rs` 上报执行后端与 `execution` 可用性。
- 缺口：请求的边界与交付的边界没有成对记录，事后无法证明“这次到底在什么隔离级别下跑的”。
- 落地层：执行请求带 `containmentFloor`，Effect 结果记 `deliveredTier` 与降级原因，日志与界面可见。
- 验收：缺口。需要覆盖“floor 未达成时拒绝而非降级执行”“降级原因可查”。

### B-12 有版本、可迁移、损坏即隔离的派生上下文缓存

- 机制：从仓库推导出的上下文（符号表、调用图、依赖图）是带 schema 版本的持久产物，可迁移；只有“文件损坏”这一类错误进入隔离，其余错误不得当作损坏。
- 上游：`core/understand_graph/store.py`（`SCHEMA_VERSION`、迁移、损坏隔离）。
- 现状：VFS 与 Context 提供通用持久化，但没有对“派生上下文产物”的版本、迁移、损坏分类约定。
- 缺口：派生上下文要么每次重算，要么被盲目复用。
- 落地层：app-core 级缓存规范。
- 验收：缺口。

### B-13 度量防伪

- 机制：度量结论必须自带“输入固定”证据——输入 clone 的哈希、标签集摘要、工具链版本块；被修改过的标签集拒绝比较；反事实评分只增量计算、不改写原报告。
- 上游：`core/recall/`（`manifest.py` 的 `compute_label_digest`、`score.py` 的 `collect_toolchain`、`warm.py` 的 `apply_would_suppress`）。
- 现状：`doc/design/fixtures/raptor-parity-evidence.json` 记录了定义摘要、上游 commit 与运行 id，但没有标签集摘要与扫描器版本戳。
- 缺口：换工具链版本或改用例集之后，旧结论仍然“看起来有效”。
- 落地层：证据文件 schema 增加 `labelDigest`、`toolchain` 字段，落在生成流程里。
- 验收：缺口。改动用例集或升级扫描器后旧结论必须被显式判为不可比。

### B-14 只读子代理与证据完整性绑定

- 机制：只做分析的子代理工具白名单是只读的，理由不是“限制权限”而是**让它无法伪造证据/覆盖记录**；放宽白名单必须先移动或封堵对应写入入口。
- 上游：`packages/llm_analysis/cc_dispatch.py` 的 `tools="Read,Grep,Glob"` 及其注释（无 Write/Edit/Bash 则无法生成覆盖记录）。
- 现状：Flow 的模型节点按需声明 `Read`/`Grep` 能力，工具授权由宿主执行。
- 缺口：缺“账本与证据只能由授权宿主写入”的显式不变量与对应测试；这是 B-05 的前置条件——账本若可被被审查的模型写入，它就能宣称“我已审查”。
- 落地层：记录目录的写入权限（宿主独占）+ Flow 校验。
- 验收：缺口。需要覆盖“声明写能力的模型节点无法写入记录目录”。

## 3. 实施顺序

| 步骤 | 内容 | 前置 |
| --- | --- | --- |
| 1 | B-06 skip 态与判据分离 | 无（B-09 的前置） |
| 2 | B-01 有界产物协议、B-02 探测三态、B-04 span 五态 | 无 |
| 3 | B-14 写入权限不变量，然后 B-05 账本与残差 | B-14 先于 B-05 |
| 4 | B-03 环境不可验证第三态、B-10 中止收尾登记、B-11 地板契约 | B-01、B-03 支撑 B-10/B-11 的结果分类 |
| 5 | B-07 快照校验、B-08 pair 身份与熔断、B-09 预算上界与分档 | B-06 先于 B-09 |
| 6 | B-12 派生上下文缓存规范、B-13 度量防伪 | 无 |

批次内可并行；跨批次的前置只有表中三处。

## 4. 未建立（与 RAPTOR 证据文件口径一致）

以下不是本文缺口，而是上游用例迁移层面的既定事实，避免混读：完整 RAPTOR CLI 功能与语法等价、SCA 完整扫描与修复、自动 fuzz 与生成 exploit 及 Witness 验证、仅靠原生 Bash 达到的沙箱/网络命名空间/凭据边界等价。逐条出处见 [RAPTOR 用例与远程编排](raptor-harness-integration.md)与 `doc/design/fixtures/raptor-parity-evidence.json`。

## 5. 维护

- 每条原语只有一种闭环方式：可复现测试或实机记录，二选一，写明文件与用例名。
- 新增原语时同时补总表行与小节；删除原语必须说明替代入口。
- 改动本文后运行 `pnpm docs:check`。
