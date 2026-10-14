# 最小系统验收记录（2026-09-10）

对应工作树：`d883a497`（`docs(todo): 修正 P1-01 的未完成项引用`）+ 本文档所在提交 + 同日复审补丁（§5）。§1/§2 的数字为**复审后重测**结果。
环境：Node v26.8.1、pnpm 10.20.0、rustc 1.98.1、Linux + X11 `:11.0`（Enlightenment）。
本文是 P0-05 的交付物：记录本轮在**当前工作树**上重跑的构建、测试与桌面端到端结果，
并列出仍未通过或未覆盖的项。阶段性通过不自动等于全部通过；上一轮记录不自动适用于当前版本。

## 1. 构建与静态检查

| 项 | 命令 | 结果 |
|---|---|---|
| 全仓类型检查 | `pnpm typecheck` | 通过（无 `error TS`） |
| 活文档检查 | `pnpm docs:check` | 通过（70 份活文档，10 条告警：5 条历史表述 + 5 条 `[missing-doc]`） |
| 样式一致性 | `pnpm styles:check` | 通过（63 stylesheets / 813 markup / 3768 类） |
| 包构建 | `pnpm build:libs` | 通过 |
| CLI 构建 | `pnpm --filter @itookit/cli build` | 通过（`apps/cli/dist/cli.js`） |
| 前端构建 | `pnpm --filter tauri-app build` | 通过（`apps/tauri-app/dist/`） |
| Tauri 生产二进制 | `cargo build --offline --features tauri/custom-protocol` | 通过（2 条 dead_code 告警） |

## 2. 历史测试矩阵（2026-09-11；后续增量见各节）

本表及合计是历史快照，不表示当前整仓已重新验收。2026-09-13 第一百一十四轮完整复跑 app-shell/app-core 的结果见 §53，其余套件须按各自最近记录确认。

| 套件 | 命令 | 结果 |
|---|---|---|
| `@itookit/durable-kernel` | `pnpm --filter @itookit/durable-kernel test` | 201 通过 |
| `@itookit/kernel-adapters` | 同上 | 95 通过 |
| `@itookit/llm-flow` | 同上 | 177 通过 |
| `@itookit/llm-session` | 同上 | 97 通过（第六十六轮 96→97，新增 consumer-join 回归） |
| `@itookit/llm-tasks` | 同上 | 37 通过 |
| `@itookit/app-core` | 同上 | 65 通过 |
| `@itookit/app-shell` | 同上 | 133 通过 / 30 跳过（第六十七轮 +1：LocalFS 双通道空闲回归） |
| `@itookit/vfs-core` | 同上 | 173 通过 |
| `@itookit/vfs-ui` | 同上 | 88 通过 |
| `@itookit/vfsdriver-local` | 同上 | 64 通过（第六十七轮 +3：sidecar 计量；此后为 journal / 只读路径 / 前缀免元数据 / 并发写 / 嵌套视图 / 前缀批量回归） |
| `@itookit/vfsdriver-indexeddb` | 同上 | 15 通过 |
| `@itookit/driver-llm` | 同上 | 49 通过 |
| `@itookit/device-tty` | 同上 | 4 通过 |
| `@itookit/tools` | 同上 | 2 通过 |
| `@itookit/llm-ui` | 同上（本轮新增脚本） | 19 通过 |
| `@itookit/mdxeditor` | 同上（本轮新增 vitest/jsdom 与脚本） | 9 通过 |
| `@itookit/llm-settings-ui` | 同上 | 1 通过 |
| `apps/cli` | `pnpm --filter @itookit/cli exec vitest run --exclude 'tests/crash-matrix.test.ts'` | 88 通过 / 24 文件 |
| `apps/cli`（崩溃矩阵） | `pnpm --filter @itookit/cli exec vitest run tests/crash-matrix.test.ts` | 6 通过（真实 SIGKILL，~160s，需单独跑） |
| `tauri-app`（Rust） | `pnpm --filter tauri-app test:rust` | 16 通过（第七十六轮 +1：无挂载时的 Session Bash 文案） |

合计 **1339 通过 / 30 跳过**（含 CLI 94 与 Rust 16；llm-session 97、vfs-core 173、vfsdriver-local 64、app-shell 133/30 跳过；各轮增量为 96→97、54→57、132→133、57→59、59→60、60→62、62→63、63→64、Rust 15→16）。**2026-09-11 第六十轮在本工作树逐项复跑核对**：`pnpm test`（`scripts/test-all.mjs`，含 crash-matrix 6 与 Rust 15）输出 `=== full matrix passed`、exit 0；逐包重采计数与上表 17 行**完全一致**（65/123+30/46/4/201/95/177/91/1/37/19/9/2/173/15/54/88，合计 1309 + CLI 94）；`pnpm build:libs`、`pnpm --filter @itookit/cli build`、`pnpm --filter mind-os build`、`pnpm --filter tauri-app build` 全部成功。注意：`apps/cli` 的 `crash-matrix` 与其他文件并行会拖慢时序敏感用例，必须单独复跑——该隔离已固化到根脚本 `pnpm test`（`scripts/test-all.mjs`：各包套件 → CLI 去掉 crash-matrix → crash-matrix → `tauri-app test:rust`，任一步失败即停止）。本轮之前 `llm-ui` / `mdxeditor` 两个套件因缺少脚本（后者还缺 vitest/jsdom 依赖）从未进入任何聚合验证；`llm-tasks` 的 `test` 曾是 watch 模式，现已改为 `vitest run` 并保留 `test:watch`。

## 3. 桌面端到端（P0-01 复验，当前工作树）

用当前树构建的生产二进制（`cargo build --features tauri/custom-protocol`）在真实 X11 窗口上
重跑验收链，`MINDOS_ROOT` 指向隔离数据根 `.tauri-acceptance/data`，模型服务为本地
OpenAI-compatible mock（`127.0.0.1:8399`），子 harness 配置 `.tauri-acceptance/work/child.yml`。

链路：窗口 → 默认 Agent → 外层 harness → Bash tool → 真实 IPC `session_shell_exec` →
bwrap（`/app` 只读仓库 + `/workspace` 可写）→ 子 CLI 两节点 DAG。

观测到的证据（外层 kernel 事件序列，本地时间）：

```
06:45:33.720 task.created                     ← 用户发送 06:45:13（P0-02 的 20.7s 空档）
06:45:39.703 agent.event tool:running         ← Bash 工具调用
06:45:41.735 effect.leased
06:45:45.387 Effect 成功事件                  ← Bash 返回 [exit 0] + 子 Run 事件
06:45:47.023 agent.event round:start          ← 第二轮模型请求（携带工具结果）
06:45:49.550 agent.event stream:content       ← "OUTER-HARNESS-DONE\n[exit 0]\n…"
06:45:51.119 task.succeeded
```

- 子 Run `20260909224543-fe0bef53`：`status=succeeded`，`first`/`second` 均 succeeded，
  `result.txt = child-first-result`。
- mock 服务日志：外层第一轮 `tools=['Bash']` → 子 CLI 两次请求（`first: child-first-result`
  证明节点传值）→ 外层第二轮 `toolResults=1` → 最终文本。
- 结论：P0-01 的调用链在当前树（含 P1 全部改动）上仍然贯通。

## 4. P0-02 发送延迟（本轮复现并定位到机制层）

同一次发送（06:45:13）到 `task.created`（06:45:33.720）为 **20.7s**，与历史记录一致。
无界面探针（`backend/app-core` + `llm-session`，进程内 LocalFS）测得同一会话的共享路径
只需 96ms/643 次后端调用（第二次 4ms/26 次）；模拟每次后端调用 1ms/5ms 时线性放大到
411ms/1532ms。Tauri 端每次后端调用走 IPC（`TauriFsOps` + `TauriSqlSidecarDb`），
因此 600–800 次调用被放大到秒级。

应用内测量（2026-09-10，`VITE_MINDOS_TRACE=1` 构建，见 `apps/tauri-app/src/log/vfs-trace.ts`，
每 2s 把 `runtime.vfs` 的 `ioStats` 增量追加到 `<rootDir>/var/log/vfs-trace.log`）：

```
06:48:18 147 stat       06:48:34 220 stat        06:48:50  47 stat
06:48:20 216 stat+list  06:48:36 190 stat+list   06:48:52  21 stat+list+write
06:48:22 217 stat       06:48:38 236 stat        06:48:54  77 stat+list
…（共 36 个区间、4242 次操作 / 70s，≈60 ops/s，99% 是 stat）
```

结论：**应用在近乎空闲时也持续产生 50–240 次 VFS 操作 / 2s**，而每次操作都是一次 Tauri IPC。
发送路径自身约 600–780 次操作，与这条后台 stat 流争用同一条 IPC 通道，因此 20s 延迟主要是
IPC 队列争用而非算法复杂度。修复方向（按收益排序）：① 侧栏/树按事件路径做增量更新，避免
重复 stat 未变化的节点；② 合并/节流结构刷新；③ 不对 `/var/lib/**` 这类非 UI 路径触发 UI 刷新。
下一步需定位产生这条 stat 流的具体订阅者（`vfs-trace.log` 已可直接观察）。
建议阈值：空闲时 VFS 操作 ≤ 5 ops/s；热路径单次发送 ≤ 2s 且 ≤ 100 次调用。

**2026-09-11 定位修正**：用无界面 app-core 探针（`.tauri-acceptance/probe-idle.mts`、
`probe-idle-attrib.mts`，同一 `.tauri-acceptance/data` 数据根，无 app-shell/DOM）逐秒采样
`engine.ioStats` 并对每次操作抓调用栈，得到与上面假设不同的结论：

```
t+2s  ops=2684 {"stat":2677,"list":7}
t+4..9s ops=0
t+10s ops=1504 {"stat":1500,"list":4}
t+20s ops=1504 {"stat":1500,"list":4}

调用栈聚合（t+10s）：
  FileSystemView.stat <- exists <- SeqFileKernelStore.listTaskIds <- SeqFileKernelStore.listTasks <- SeqFileKernelStore.sweep
  FileSystemView.stat <- exists <- SeqFileKernelStore.listTaskIds <- SeqFileKernelStore.listTasks <- Kernel.poll
  ... <- SeqFileKernelStore.listTasks <- SeqFileKernelStore.pendingEffects
  ... <- SeqFileKernelStore.listTasks <- Kernel.nextWakeDelay
```

即：无界面运行时在空闲时并非持续繁忙（多数秒为 0），但每约 10s 出现 **1504 次操作** 的突发，
全部来自 `Kernel.poll` 一个 tick 内对 `listTasks` 的多次全量调用（`sweep` / 任务循环 /
`pendingEffects` / `nextWakeDelay`，而 `listTasks` = `listTaskIds` + 每任务 `readTask`，
该 Session 有 364 条 Task 记录）。因此「持续 stat 流」至少有两个独立来源：内核轮询对全量任务
记录的重复读取（周期性大突发，无 UI 也存在），以及应用侧 UI 刷新。修复顺序应改为：① 内核每
tick 只读一次任务列表（或分页/增量），复核 ~10s 的重触发条件；② 再做侧栏增量更新与 `/var/lib/**`
刷新屏蔽。原「定位 UI 订阅者」的目标仍有效，但不再是唯一来源。

**2026-09-11 内核侧修复与复测**：`probe-poll-trigger.mts` 抓到 10s 重触发的来源——
app-core 的 Session 租约心跳每 10s 写 `/var/lib/kernel/session-leases.seq`，该路径就在内核
catalog 根下，而 `Kernel` 的 catalog 监听器原先对 `catalogFs` 的**任意** `seq:committed` 都
`schedulePoll` 所有 Session。修复三处：`Kernel.poll` 每 tick 只读一次 `listTasks` 并共享给任务
循环/`pendingEffects`/`nextWakeDelay`；`SeqFileKernelStore.listTasks` 复用 `listTaskIds` 已读记录
（不再每任务二次 `readTask`）；catalog 监听器按 `catalog.seq` 路径过滤。同一数据根复测：

```
修复前：t+2s 2684 | t+10s 1504 | t+20s 1504
修复后：t+2s  767 | t+10s    5 | t+20s    5      ← 空闲稳态 ≈0.5 ops/s
```

剩余的 5 次即租约续期本身；`nextWakeDelay` 在无待办时返回 `undefined`（轮询正常停止）。回归见
`backend/durable-kernel/src/kernel.test.ts` 的「reschedules polls only for catalog commits」。
UI 侧的连续空闲流仍未定位。

## 5. 复审补丁（同日第二轮）

随后的代码复审发现并修复了两处本记录覆盖范围内的缺陷，并记录一处未修的行为缺口：

| 问题 | 处理 |
|---|---|
| `export` 对崩溃的 Run 导出空节点列表：`exportCommand` 只遍历 `manifest.nodeTaskIds`，而非交互 Run 的 monitor 从不运行，SIGKILL 后该字段为空 | 已修：改为按 Session 的 Task 记录（`labels.flowNodeId`，同节点取最新 `createdAt`）合并 manifest，并在缺 `rootTaskId` 时用 `findFlowRootTask`；`crash-matrix` 首个用例新增断言（崩溃后 `nodeTaskIds == {}` 仍能导出 `finish` 节点与其 transcript） |
| monitor 每个 tick 两次 `listSessionTasks`（P1-01 引入 `decideBlockedEffects` 后与 `refreshTaskStatuses` 重复） | 已修：每 tick 只列一次，两个消费者共用 |
| CLI 非交互 Run 没有监控窗口（`submit` 晚解析）→ per-task `timeout`、stall 诊断、SIGINT→cancel、`--follow` 对 fresh run 不生效 | 未修，记为 P1-10；实测 `run.started` 在 +3014ms 打印（1.5s mock 的单节点 run 此时已结束） |
| `backend/app-core` 无 AGENTS.md，且 `scripts/check-docs.mjs` 只把**已存在**的包 AGENTS.md 纳入检查，缺失不会被发现 | 已补 `backend/app-core/AGENTS.md`；检查脚本新增 `[missing-doc]` 告警（仍缺 5 个包，见 todo P2-06） |
| app-core 包内边界问题（装配根混策略与 i18n、测试在 app-shell 经 shim 导入、`files/` 归类、`index.ts` 转发外家符号、两套租约、静默失败、`any` 读 VFS 私有字段） | 未修，逐条记为 todo P2-06（含代码位置与证据） |

复审后的测试：`apps/cli` 76 通过（含新增断言）、`llm-flow` 166 通过、`20-kernel-ipc` 28 通过（与协议文档声称一致）、typecheck / docs:check / styles:check 通过。

## 6. 仍未通过的验收项

| 项 | 状态 |
|---|---|
| P0-00 两端真实入口对等（CLI 与 Tauri 同一项目规则/Skill 的模型请求对照） | 未完成；本轮只复验了 Tauri 单端链路 |
| P0-02 应用级失败/取消闭环（超时、取消、Session 关闭/授权撤销、IPC 错误的 UI 与持久状态一致） | 未完成；本轮只复现并量化了发送延迟 |
| P0-03 真实 Tauri 操作教程与子进程凭证注入交付 | 教程与注入约定已写入 [最小系统](minimal-system.md)；凭证注入仍属操作约定，无独立 UI |
| P0-04 平台实机验证（Bubblewrap/目录边界、其他平台支持范围） | 仅 Linux + bwrap 组合测试与本次桌面复验；其他平台未验证 |
| GUI 观察者区分“已接受/已变化/已停止”、真实设备停止确认 | 未验收（见 [Durable 证据映射](design/durable-harness-evidence.md)） |

## 7. 后续修复：P1-10 监控窗口（2026-09-11）

| 问题 | 处理 |
|---|---|
| P1-10 CLI 非交互 Run 缺少监控窗口：`submit` 直到整张图跑完才解析，per-task `timeout`、stall 诊断、SIGINT→cancel、`--follow` 对 fresh run 全部不生效 | 已修：`DurableFlowExecutor` 在持久根任务与调度租约就绪后、派发任何节点前 `publish`，fresh 与 restored 一致；CLI `run.started` 改用 `spec.nodes.length`，节点→Task 映射交给 monitor 从 Session 记录读取。发布后的调度期失败（运行期边校验、动态 patch、工作区清理）通过根任务的 `flow.schedule.failed` 承载，payload 合并主因与清理错误。 |

验证：`backend/llm-flow/__tests__/durable-flow-executor.test.ts` 新增
「returns a live handle for a fresh Run before it finishes」（旧实现在该 await 上死锁），
并把 40 个假定 `submit` 返回完整句柄的用例改为显式等待（`llm-flow` 167 通过 / 15 文件）。
CLI 实测（单节点 + 1.5s mock 响应，探针 `.tauri-acceptance/probe-publish.mjs`）：
`run.started` 由修复前 **+2925ms**（与 `run.succeeded` 相差约 48ms）提前到 **+1268ms**。
同轮复跑：`llm-session` 90、`app-shell` 154 / 30 跳过、`apps/cli` 76（`session-delete-localfs`
在并行 heavy 套件下曾超时，单独复跑通过）、`pnpm typecheck` / `docs:check` / `styles:check` 通过。

本节只覆盖该修复，不改变 §1/§2 的数字，也不构成新的 P0-05 全量验收。

## 8. 后续修复：CLI 超时/取消闭环与适配器取消确认（2026-09-11 第三轮）

| 问题 | 处理 |
|---|---|
| `llm.chat` Effect 适配器没有 `cancel`：任何在途模型调用的取消都抛 `Failed to cancel effects for task …`，Run 报 failed、节点停在 `waiting`，取消无法确认 | 已修：新增 `kernel-adapters/src/effects/in-flight.ts`，`llm.chat`/`tool.call`/`bash`(`process.exec`)/`tty` 适配器记录在途执行并在 `cancel` 中等待其结束才确认停止。回归：`effect-adapters.test.ts`「adapter-confirmed cancellation」、`llm-chat-effect.test.ts` 的取消确认用例 |
| SIGINT / max-duration 取消路径保存 manifest 时没有投影节点终态（首个 tick 内取消会留下空 `taskStatuses`） | 已修：`cancelInterrupted`/`cancelExpiredRun` 在保存前调用 `projectTerminalStatuses`（失败不影响取消结果） |
| CLI 入口缺少超时/取消的真实验收（P0-02 要求“不能把取消请求发出等同于进程已停止”） | 新增 `apps/cli/tests/run-control.test.ts`：① `timeout: 400ms` + 永不回包的模型服务 → 节点 cancelled、Run failed、退出码 1、模型服务观察到客户端断开；② 运行中 SIGINT → 退出码 130、Run cancelled、`taskStatuses.finish=cancelled`、`resume` 不重发节点（模型请求数不变） |
| `NodeNativeShell.runProcess` 在 abort 时只发 SIGTERM 就 resolve，且不等待进程退出：取消“已发出”被当成“已停止” | 已修：SIGTERM 进程组 → 1s 未退出则 SIGKILL → 只在 `close`（或 SIGKILL 后 2s 兜底）时 resolve。新增 `apps/cli/tests/process-cancel.test.ts`：命令 `trap '' TERM` 的**进程组**在 cancel 返回后 pid 必须已消失（无修复时该用例失败：`expected true to be false`） |
| `skill.load`/`skill.unload` 适配器仍无 `cancel` | 已补齐：6 个适配器（含 skill.*）现全部实现 cancel；`effect-adapters.test.ts` 增加对应等待用例 |
| 跨进程 `mindos cancel` 的边界未记录：Session 单写者租约使活宿主的 Run 无法被第二个进程取消 | 已验收为**明确的拒绝语义**：`apps/cli/tests/run-live-owner-refusal.test.ts` 断言第二个进程退出码 2、stderr 含 `is owned by`、在途请求不受影响，只有宿主 SIGINT 能停止（退出码 130、Run cancelled） |
| 宿主已死、Effect 阻塞（`indeterminate`）的 Run 能否可靠取消并阻止重放 | 已验收：`crash-matrix.test.ts` 新增用例——SIGKILL 后 `cancelCommand` 成功（持久 `cancelled`），`resumeCommand` 返回 1 且模型请求数不增加，证明 blocked Effect 未被重放 |
| Session 关闭时在途 Effect 是否确认停止后才返回 | 已验收（内核层）：`backend/durable-kernel/src/protocol.test.ts`「closes a Session only after the in-flight Effect confirms it stopped」——适配器故意延迟确认，断言 `closeSession(id, cancelRunning)` 在确认前不完成；之后 Task `cancelled`、无 `cleanupPending`、Session 持久 `closed`，重启 Kernel 仍为 `closed` |
| `SessionLeaseStore.init()` 每次操作都 `exists`（热路径 VFS 往返）+ 租约续期/Skill 同步静默失败 | 已修（P2-06）：`init()` 只 ensure 一次（失败清除以便重试），续期与同步失败改为带上下文的 `console.warn`。回归 `backend/app-core/tests/session-lease.test.ts`；无界面探针 10s 空闲突发 5 → **0** 次 stat |
| P1-01 缺 graph patch 崩溃点：patch 已应用后杀进程，恢复时是否会重复应用 | 已验收：`crash-matrix.test.ts` 新增用例——`spawn` 图在派生子节点模型调用在途时 SIGKILL，`resume --retry-indeterminate` 后 Run succeeded 且模型请求数恰为 2（1 次被杀 + 1 次重放）；若重复应用 patch 会出现第 3 次调用 |
| P1-01 缺动态委派崩溃点：宿主重启后是否会二次 fan-out | 已验收（包级）：`llm-flow` 新增「resumes a delegation group after a host restart without duplicating child tasks」——子代理 Effect 在途时重启 Kernel，`resume` + 显式 `retry` 后节点集合恰为 `parent:delegate:1:0/1:1`。CLI schema 不支持 delegation，故仅在包级覆盖 |
| P1-05 cache 缺三项验收：依赖版本、generation fencing、策略矩阵 | 已验收：`backend/durable-kernel/src/protocol.test.ts` 新增/明确——fingerprint 变化与 `expectedVersion` 不符 → miss（匹配才 hit）；`invalidate` 后新 operationId miss、旧 generation 的 publish 冲突；`prefer-cache`/`cache-only` 命中，`refresh`/`bypass` 恒 bypass 且不消费 single-use。`durable-harness-evidence.md` §5 对应行由「缺口」改为证据（终态清理与 provider 能力差异仍记为缺口，因为 cache 只有内置 SeqFile 实现） |
| P2-06 `any` 读取 VFS 私有字段 `_engine` | 已修：vfs-core 暴露 `IO_OPERATIONS`/`IOOperation` 与 `IVFSManager.ioStats`/`resetIOStats()`；app-core 启动埋点与 `vfs-trace.ts` 改用公开 API。回归 `https://github.com/mushuanli/vfs-core/blob/main/tests/23-io-stats.test.ts`（vfs-core 173） |
| P1-04 被丢弃实例的 token 退款语义 | 已实现：`applyGraphRetry` 丢弃已提交下游实例时按 `output.usage` 从 `consumedTokens` 退款；`llm-flow` 新增「refunds discarded downstream tokens so a graph retry is not double-charged」（`maxTokens: 6`，无退款则 8/6 失败；有退款 exit succeeded、usage=4） |
| P2-06 `app-core/index.ts` 转发外家符号与历史别名 | 已修：移除 `registerKernelPrograms` 转发与 `createMindOSRuntime`/`MindOSRuntime`/`CreateMindOSRuntimeOptions`/`MindOSKernelPorts` 别名；CLI HTTP 主机与文档改用 `createApplicationRuntime`/`ApplicationRuntime`。回归：app-core 测试改从 `@itookit/llm-flow` 导入 `registerDurablePrograms`（app-core 11 通过） |
| P0-02② UI 侧空闲流来源 | 证据（jsdom）：真实 vfs-ui 侧栏 + `SessionWorkbench` + 真实 VFS 静置 6s → **0 次 VFS 操作**，转为回归测试 `ui/app-shell/tests/session-workbench-idle.test.ts`。与内核修复（1504→0 ops/10s）及 trace 算术一致。**第六十七轮补齐 sidecar 通道**：`LocalFSBackend.sidecarStats` 计量 SQLite 调用，trace 同时输出两条通道，并在 LocalFS 后端上回归验证静置 1s 内 VFS 与 sidecar 增量均为 0；真实 Tauri IPC 的 llm-ui 聊天视图与真实窗口仍未覆盖 |
| P2-06 `createApplicationRuntime` 单函数承担策略 | 大部分完成：抽出 `recoverSessionsWithLeases` 与 `createConversationSystem` 与其返回的实例 dispose；主函数只剩接线与清理。剩余 `createInfrastructure` 拆分与启动埋点收口 |
| P1-04 委派组的图级重算 | 已实现：`applyGraphRetry` 丢弃父节点前先 `discardDelegationGroups`（取消/移除子实例与合成节点/边/组状态，并递增子节点 generation 以避免回放旧 Task）；仅拒绝「源本身是 `:delegate:` 合成子节点」。回归 `llm-flow`「recomputes a delegation group after a graph retry of an upstream node」；隔离工作区同样覆盖：「recomputes a delegation group inside an isolated workspace without re-preparing it」（`prepare` 1 次 / `restore` 1 次；llm-flow 171） |
| P1-04 DagWorkbench 图级 retry 入口 | 已实现：Run 根非终态且节点终态时显示「重试并重算下游」（`downstream: true`，独立 pending key），Run 终态后隐藏。回归 `app-shell/tests/dag-run-retry.test.ts` 两条用例；app-shell 115 通过 / 30 跳过 |
| P2-06 app-core 用户文案泄漏（挂载守卫/目录来源） | 已修：新增 `vfs/errors.ts` 的 `SessionUnfinishedTasksError`(EBUSY)/`DirectorySourceUnavailableError`(EACCES)，挂载守卫与 `createUnavailableDirectory` 改抛结构化错误；app-shell 经 `localizeMountError` 用 `t('error.*')` 本地化（mount-dialog 与 `directoryCommands` 包装）。回归：`app-core/tests/mount-errors.test.ts`、`app-shell/tests/mount-error-localization.test.ts` |
| P2-06 app-core 全部用户文案 | 已完成：挂载守卫/目录来源改结构化错误并由 `localizeMountError` 本地化；`directory-mounts.ts`/`session-browser.ts`/启动 `logStep` 改用 `t('mount.*')`/`t('session.tasks.more')`/`t('boot.*')`。守卫 `app-core/tests/no-user-copy.test.ts`（源码非注释行无 CJK），app-core 14 通过 |
| P2-06 app-core 测试被 shim 覆盖（假绿灯） | 已完成：8 个纯 app-core 测试迁回 `backend/app-core/tests/`（含 `session-files`，app-core 补 `fake-indexeddb`/`@itookit/vfsdriver-indexeddb` devDeps），app-shell 的 11 个兼容 shim 全部删除。app-core 58 通过、app-shell 113 通过 / 30 跳过（迁移前合计 171 不变） |
| P1-02 CLI 本机 SQLite 锁与通用调度租约未统一：共享存储上 `delete` 只靠本地文件锁，可能删掉另一宿主正在推进的 Run | 已修：新增 `apps/cli/src/run-scheduler-lease.ts`（`openProfileInspectionFs` 只开数据根 VFS，不取 Session 租约），`deleteCommand` 在本地锁 + manifest 终态检查之后再读 Session shared 的 `flow.run.<rootTaskId>.scheduler-owner`——另一宿主租约未到期时以 `Run … is scheduled by … until …` 拒绝并保留 Run 目录，租约到期即放行。回归 `apps/cli/tests/run-scheduler-lease-delete.test.ts` 2 通过：用被 SIGKILL 的真实 CLI 宿主留下的租约（TTL 60s / 1s）分别验证拒绝与到期放行；注释掉守卫后「拒绝」用例失败。记录解析复用 llm-flow 新导出的 `parseSchedulerLeaseRecord`（原为包内私有），保证两侧 schema 一致 |
| P1-03 宿主未装配 worktree 模式的 workspaceManager（隔离工作区只有包级证据） | 已装配（CLI）：YAML 新增 `runtime.workspace`（mode/base/merge/cleanup）→ `RunDefinition.policy.runPolicy.workspace` → `createCliRuntime` 构造 `GitWorktreeFlowWorkspaceManager`（`<stateDir>/worktrees/<sessionId>`，argv-safe git 适配宿主 shell）；`read-only` 与「worktree + OCI」fail closed。接入时修掉两个真实缺陷：节点被硬编码 `workingDirectory=workspaceRoot`（导致隔离模式仍跑在基础仓库）与未声明 `workspace_access: write` 时工具句柄缺失。回归 `apps/cli/tests/worktree-run.test.ts` 4 通过（worktree 内执行且基础仓库无污染 / 干净工作区按默认策略移除 / 脏工作区保留且不改写 Run 结果 / SIGKILL 后 `resume` 复用同一 worktree），`config.test.ts` 增补 3 条策略校验。未完成：Web/Tauri 端装配 |
| P2-06 app-core `files/` 目录混合 VFS 视图服务、导航模型、数据交换格式与生命周期 | 已拆分（2026-09-11）：`src/files/` → `src/session/`（browser/bundle/lifecycle/route/workspace-paths）+ `src/vfs/`（session-files/directory-mounts/session-attachments/session-process-context/tool-context/unavailable-directory/errors），依赖单向 `session/ → vfs/`；同步改 `index.ts`、`create-application-runtime.ts`、8 个测试的导入与活文档/`AGENTS.md` 结构表。回归：app-core 15/58、app-shell 21/115（+30 跳过）、`pnpm typecheck`、`pnpm docs:check` 通过。顺带移除 `ui/app-shell/package.json` 中指向已删除 shim（`src/files/workspace-paths.ts`）且无消费者的 `./layout` 子路径导出 |
| P1-05 Cache §10「Task cache 到终态清理」未实现 | 已实现（2026-09-11）：`cleanupTaskCachesTx` 在 Task 进入终态的同一事务（`commitTask` 终态分支与 `finishWithoutClaim`）删除该 Task 的 `step`/`task` scope namespace、全部 entry 与每 key 发布序号、`handle`/`resource` 记录，并追加 `cache.cleaned` 事件；`session` scope 的 namespace 与 owner 索引保留（创建者归档后另一 Task 仍可凭 grant 命中），artifact 族资源、`effect/<id>` 幂等事实、`cache-operation/<id>` 回执均不清理。`createCacheTx` 新增可重建 owner 索引 `cache/owner/<taskId>/<namespaceId>`，清理只遍历此前缀，避免每次终态全量扫 `resources.seq`。回归 `backend/durable-kernel/src/protocol.test.ts`「cleans Task-scope cache at Task terminal while keeping session scope and other facts」；durable-kernel 188、llm-flow 171、vfsdriver-local 54、kernel-adapters 91、CLI 91 全通过 |
| P1-05 Cache §10「Session scope 保留到 Session 关闭」未落地物理回收 | 已实现（2026-09-11 第二十六轮）：`cleanupSessionCachesTx` 在 Session 转为 `closed` 的同一事务删除该 Session 全部 cache namespace（含 `session` scope）、entry、发布序号、owner 索引与 handle/resource，并追加 `cache.cleaned`（`scope: session`）。`closed` 转换前已校验无未结束 Task，cache 操作对 closed Session 一律拒绝，故回收时无活跃引用；artifact 族资源、其 handle 与 `cache-operation` 回执保留。回归 `backend/durable-kernel/src/protocol.test.ts`「reclaims every cache namespace when the Session closes, including session scope」；durable-kernel 189，vfsdriver-local 54、llm-flow 171、app-core 58、llm-session 89、CLI 91 全通过 |
| P1-07「无消费边输出的契约验证」缺失：终止节点/Run 结果/旁路输出无人消费时其自身端口 schema 从不校验 | 已实现（2026-09-11 第二十七轮）：新增 `assertUnconsumedOutputs(node, edges, plugins, output)`，执行器在节点成功结算（`completed.add`）后只对「该节点声明了 schema 且无 active data edge 消费」的输出端口做内容校验，不通过则 Run 失败且不派发下游（合成委派实例无声明节点，跳过）。回归 `backend/llm-flow/__tests__/durable-flow-executor.test.ts`「validates a declared output no edge consumes (valid: %s)」（有效值 succeeded、无效值 failed 且报 `Invalid output only.result: $.count: expected integer`）；llm-flow 173，app-shell 115（+30 跳过）、CLI 91 无回归 |
| P1-06「UI 端按字节预算增量加载」缺失（DagWorkbench 要求先加载完才可导出） | 已实现（2026-09-11 第二十八轮）：`TaskTranscriptDialog` 交互分页每页带 `maxBytes: 256 KiB`，续页固定首页 `version` 与 `nextOffset`；被裁剪的页面在状态行显示 `flow.transcript.truncated` 与字节数。导出改为独立完整读取（按 `version` 从 offset 0 循环、不传 `maxBytes`、含 `nextOffset` 单调性与 10k Effect 上限保护），不再要求先手工翻页，导出文件无损。回归 `ui/app-shell/tests/task-transcript-dialog.test.ts` 4 通过；app-shell 115（+30 跳过）、llm-ui 15 通过且构建成功 |
| P1-02「跨主机时钟偏差」无显式约束：接管只看本地时钟的 `expiresAt > now`，快时钟宿主可抢走慢时钟宿主的活租约 | 已实现（2026-09-11 第二十九轮）：`acquireSchedulerLease` 新增 `skewMs`（默认 0，保持单机行为），接管要求 `expiresAt + skewMs <= now`，错误信息给出含预算的到期时刻与预算值；executor 经 `schedulerLeaseSkewMs` 透传，CLI 用 `MINDOS_SCHEDULER_LEASE_SKEW_MS` 配置。回归 `backend/llm-flow/__tests__/scheduler-lease.test.ts` 6 通过（新增「误差预算内拒绝、预算后接管」与「默认 0 行为不变」）；llm-flow 175，CLI 91、app-shell 115、durable-kernel 189 无回归。仍未完成：共享存储上的 authority store 时间与真实多进程接管 |
| P1-05 Storage/Resources「stream/消息/receipt 保留期与 GC 竞争」未实现 | 已实现（2026-09-11 第三十轮）：新增 `Kernel.pruneSessionMessages(sessionId, before, limit?)` → `SeqFileKernelStore.pruneMessages` → `pruneMessagesTx`，只删除**已终结**出箱记录（delivered/rejected）与**已消费或已拒绝**的收件回执；未投递出箱、已投递未消费回执、以及同库内仍有 `pending` 出箱对应 id 的回执一律保留（保护发送方尚未记录投递的 receipt）。删除时写入 `retention` 水位键并追加 `session.messages.pruned` 事件；`before` 由宿主维护、必须早于部署重放窗口（幂等重放依赖出箱身份记录）。回归 `backend/durable-kernel/src/protocol.test.ts`「prunes settled messages only, keeping undelivered and unconsumed records」；durable-kernel 190 |
| P2-06「拆 `createApplicationRuntime`」最后一项 `createInfrastructure`（VFS + LLM 驱动）未抽出 | 已完成（2026-09-11 第三十一轮）：新增 `backend/app-core/src/runtime/infrastructure.ts` 的 `createInfrastructure(options)`——VFS（`/run` 挂载、`ioStats` 埋点 `logIO`）、LLM 设备驱动 init/注册/冻结、固定用户布局预热、宿主 Codex transport 关闭句柄；`createApplicationRuntime` 215 → 181 行，只剩接线与释放顺序（VFS 最后释放写入返回契约）。新增单测 `backend/app-core/tests/application-runtime.test.ts`「application infrastructure」（/run、宿主附加挂载与 /home/admin/* 可达、设备已冻结、logIO 报告并清零、transport 被关闭）；app-core 15 文件 / 59 用例、app-shell 115（+30 跳过）、CLI 91、`pnpm typecheck` 通过。P2-06 至此全部完成 |
| P1-05「Tauri/隔离模式下的真实进程树终止取证」缺口 | 已取证（2026-09-11 第三十二轮）：`apps/cli/tests/tauri-process-tree.test.ts` 用 `rustc` 编译**真实** Tauri Rust 模块（`session_bash.rs` + `bash_process.rs`），在 bwrap（`--die-with-parent --unshare-pid`）内运行「忽略 SIGTERM + 持续写文件」的进程树并触发取消；断言 `cancelled=true`、`elapsed_ms` 远小于 30s 超时、退出码 1、取消返回后 1s 内文件不再增长（无残留进程）。隔离模式下该保证由进程组 SIGTERM→SIGKILL 与 `--die-with-parent`/PID namespace 拆除共同提供，测试断言宿主可观察行为。CLI 现 92 / 24 文件（新增 1 文件 1 用例） |
| P1-07「运行定义持久冻结」未验证 | 已取证（2026-09-11 第三十三轮）：调度检查点持久化 `spec`/`parameters`/`sessionContext`/live `nodes`+`edges`+`edgeState`（含动态 patch 结果）/`nodeDefaults`/`nodeConnections`，`resume(sessionId, rootTaskId)` 不接受宿主定义参数。新增回归 `backend/llm-flow/__tests__/durable-flow-executor.test.ts`「resumes the Run definition frozen at submit instead of a later host definition」：第一宿主 park 在 human 节点后停机，宿主侧另编译 v2 定义（不同节点 id 与指令），恢复后节点集合与模型请求仍是检查点中的 v1（含 `DEFINITION-V1`、不含 `DEFINITION-V2`）。未冻结者为宿主插件实现代码。llm-flow 176 |
| P1-02「跨主机时钟偏差」只覆盖 Run 级调度租约，外层 Session 单写者租约仍有同类漏洞 | 已补齐（2026-09-11 第三十四轮）：`apps/core` 的 `SessionLeaseStore` 新增 `skewMs`（默认 0），接管要求旧租约 `leaseUntil + skewMs` 已过；`createApplicationRuntime` 暴露 `sessionLeaseSkewMs` 选项，CLI 用 `MINDOS_SESSION_LEASE_SKEW_MS` 配置。回归 `backend/app-core/tests/session-lease.test.ts` 3 通过（预算内拒绝、预算后接管且 `fencingToken` 递增、未配置时行为不变）；app-core 15 文件 / 61 用例，CLI 92 / 24 文件无回归 |
| P1-05 Storage §5「新增 manifest 声明 layoutVersion、recordSchemas、requiredCapabilities 和 migration 状态；未支持能力必须明确拒绝」未落地 | 已实现骨架（2026-09-11 第三十五轮）：`createSession` 在 `session.seq` 的 `record` 写入 `layout`，`assertSessionLayout` 在 `kernel.openSession` 与 `requireSessionTx`（含 `listShared`）拒绝更高 `layoutVersion`、`migration.status === 'pending'`、未知 `requiredCapabilities`（如 `streams`），无该字段的旧记录按 legacy 读取。回归 `backend/durable-kernel/src/protocol.test.ts`「declares a layout manifest and refuses Sessions it cannot interpret」（4 类拒绝 + legacy 兼容）；durable-kernel 191，llm-flow 176、vfsdriver-local 54、app-core 61 无回归。§5 各记录族拆分与 compaction 仍未落地 |
| P1-05 Storage §3「retention/compaction 不删活跃引用」无实现 | 已落地一条记录族（2026-09-11 第三十六轮）：`Kernel.compactTaskHistory(sessionId, taskId, { keepVersions?, beforeVersion? })` → `SeqFileKernelStore.compactTaskHistory`，只删除 `task.seq` 的 `snapshot/<version>`，保留最新 `keepVersions`（默认 20）与 `beforeVersion` 之后的版本；主记录、attempts、effects、interactions、receipts 不动，写入 `task.history.compacted` 事件；被裁剪版本的 pinned 读返回空而非损坏。回归 `backend/durable-kernel/src/protocol.test.ts`「compacts Task version history without touching the authoritative record or facts」（裁剪计数、保留窗口、主记录相等、每次重复裁剪为 no-op、默认窗口不删）；durable-kernel 192，llm-flow 176、vfsdriver-local 54、llm-session 89、CLI 92 无回归。`events.seq` 等其它族与跨 Session GC 竞争仍待落地 |
| P0-04「Linux Bubblewrap/目录边界」实机验证：Rust 侧已有 12 项原生测试，但不在仓库验证流程里（无脚本、未记录） | 已可见并可复现（2026-09-11 第三十七轮）：`apps/tauri-app/package.json` 新增 `test:rust`（`cargo test --manifest-path src-tauri/Cargo.toml`），实跑 **12 通过 / 0 失败**（0.16s，构建 ~4.5s），覆盖 `session_bash::tests::confines_bash_to_readonly_and_writable_grants`（真实 bwrap：只读/可写授权与 cwd 边界）、`session_bash::tests::refuses_ungranted_cwd_and_reserved_or_traversing_paths`、`bash_process::tests::cancellation_stops_a_running_process_group`、`bash_process::tests::timeout_stops_children_that_ignore_term_and_closes_their_pipes`（取消/超时的进程组终止）、`directory_boundary::tests::*`（绝对/父路径与符号链接逃逸）、`scoped_directory::tests::scoped_io_rejects_escape_and_closed_handles`、`bash_process::tests::bounds_both_streams_while_draining_large_child_output`（输出上界）。结论修正：此前记为「缺证」的是**索引与执行**，不是测试本身；CLI 侧 `tauri-process-tree.test.ts` 仍提供真实模块端到端路径。 |
| 验证覆盖缺口：`llm-ui`/`mdxeditor` 的测试从未被任何聚合命令执行；`llm-tasks` 的 `test` 是 watch 模式；6 个包/应用没有 `typecheck` 脚本 | 已修复（2026-09-11 第三十八轮）：① `ui/llm-ui/package.json` 与 [mdxeditor/package.json](https://github.com/mushuanli/mdxeditor/blob/main/package.json) 新增 `test`/`test:watch`，`mdx` 补 `vitest`+`jsdom` devDeps（离线安装），两套件现可跑（15 / 6 通过）；② `llm-tasks` 的 `test` 改为 `vitest run`（保留 `test:watch`/`test:run`），消除 watch 模式挂起；③ 为 `app-settings`、`vfs-ui`、`vfsdriver-indexeddb`、`vfsdriver-local`、`apps/sync-server` 补 `typecheck`，`mdx` 的 `type-check` 更名为仓库统一的 `typecheck`——`pnpm typecheck` 覆盖从 16 增至 **24 个工程**且 exit 0；④ 验收记录 §2 的测试矩阵按本轮全量复跑重写：**1268 通过 / 30 跳过**（含 CLI 92、Rust 12）。单包 AGENTS（llm-ui/llm-tasks/mdx）同步更新脚本说明 |
| P1-05 Storage §5「`events.seq` retention：日志保留区间与可靠订阅水位/resync 契约」未落地 | 已实现（2026-09-11 第三十九轮）：`Kernel.pruneTaskEvents(sessionId, taskId, { keepEvents })` 按 Task 保留最新索引事件，删除更早的 `event/<sequence>` 与 `task-event/<taskId>/<n>` 索引项，写入 `task-event-first/<taskId>` 水位并追加 `task.events.pruned`；`taskEventPage` 从水位起读，对过期游标 clamp 后返回 `firstAvailableIndex`，`SessionWorkbench` 据此显示「更早的事件已按保留期裁剪」；会话级未索引事件不受影响。回归 `backend/durable-kernel/src/protocol.test.ts`「prunes old Task events and reports the retention watermark for resync」与 `ui/app-shell/tests/session-browser-ui.test.ts`（首屏 watermark 在翻页后仍显示）；durable-kernel 193、app-shell 115（+30 跳过）、vfsdriver-local 54、llm-flow 176、llm-session 89 无回归 |
| P1-03「VFS 文件工具仍以会话工作区为根」：worktree 模式下 Bash 在隔离副本、Write/Edit 却改基础仓库 | 已修复（2026-09-11 第四十轮）：worktree 模式下 `createCliRuntime` 预建 `<stateDir>/worktrees/<sessionId>`（`git worktree add` 接受已存在的空目录）并把 **Session 工作区**指向它——VFS `/workspace` 挂载、session cwd、`WorkspaceGrantRegistry` 授权根与系统提示的 Workspace 行一致；`cliWorktreeDirectory()` 供宿主与 executor 共用同一路径；`--set-home` 同时存在时保留该目录并在 stderr 说明隔离副本仅作为 shell cwd。回归 `apps/cli/tests/worktree-run.test.ts`「points the VFS file tools at the isolated copy, not the base repository」（Write 落盘 worktree、基础仓库无该文件、模型请求提示含隔离路径；该文件 5 通过）；CLI 87（23 文件）+6（crash-matrix）、app-core 61 无回归 |
| P1-05「跨 Session retention/GC 竞争」缺证 | 已补证（2026-09-11 第四十一轮）：`backend/durable-kernel/src/protocol.test.ts`「keeps cross-session delivery responsibility while both stores run retention」——源 Session 与目标 Session 分属不同 store，各自用独立水位跑 `pruneMessages`：水位早于投递时未投递出箱保留；投递后源库已终结出箱可回收，而目标库**已投递未消费**回执仍保留；消费落盘（`consumedAt`）后才可回收。durable-kernel 194 |
| P2-03「Memory 长期保留/压缩策略」缺失 | 已实现（2026-09-11 第四十二轮）：`MemoryPolicy.retention`（`maxEntriesPerScope`、`before` 水位）与 `SessionMemoryProvider.prune(sessionId, policy, before)`；写入后按更新时间保留最新 N 条（刚写入的条目必留、按 scope 独立计算），水位在写入与裁剪时生效，`prune` 仅作用于 `writeScopes`；非法上限/水位在打开存储前拒绝。回归 `backend/llm-session/__tests__/session-memory-provider.test.ts`「caps stored entries per scope and prunes by an explicit watermark」；llm-session 90，且原有「isolates sessions/scopes …」用例继续覆盖 Session 隔离子句。P2-02 仍未完成跨 Session 共享与显式授权协议 |
| P2-04 VFS 挂载验收 §7 只读动词与跨 Session 同名挂载点缺显式证据 | 本轮补证并逐条映射（2026-09-11 第四十三轮）：`backend/app-core/tests/directory-mounts.test.ts`——只读授权下 `writeContent`/`rename`/`move`/`delete`/`updateMetadata`/`setTags`/`createDirectory` 全部返回 `EROFS`，并补 `/demo/../notes/secret.md` 遍历拒绝与根视图仅含授权子树；新增「keeps the same mount point name bound to each Session source independently」验证两个 Session 用同名 `/demo` 指向不同来源且互不可见。挂载设计 §7 的 1–6 项现均有对应自动化证据（第 7 项 bwrap 由 `tauri-app test:rust` 覆盖，真实 GUI/网络隔离仍缺）；app-core 62 |
| P2-01「L4 编辑器 open/close 接线」缺失（服务侧 `mountByGlob` 已有能力，UI 从不调用） | 已实现（2026-09-11 第四十四轮）：`SessionSkillControls` 新增 `mountByGlob(sessionId, filePath)`/`unmountByGlob(sessionId, filePath)`（`kernel-adapters` 经 Session 操作队列串行化、空路径拒绝、不写持久 loaded 身份），`SessionWorkbench` 在文件编辑器/预览创建后挂载、在 `closeEditor()`（切换资源/销毁）时卸载，失败只报告不打断编辑器；`bootstrap` 注入 controls。回归 `backend/kernel-adapters/src/skill/session-skill-controls.test.ts`「mounts and unmounts editor targets through the Session scope in order」与 `ui/app-shell/tests/session-browser-ui.test.ts`（打开 `/workspace/note.md` → 挂载；切走 → 卸载）；kernel-adapters 92、app-shell 115（+30 跳过） |
| P2-01「初始化工具激活」缺失（初始化选中的 Skill 只注入指令，其工具不可调用） | 已完成直接聊天路径（2026-09-11 第四十五轮）：`DurableAgentInput.skillContexts` 字段 + agent program `initialState` 装载 + `buildLlmTaskInput` 透传；`ConversationRunCoordinator.initialSkillContexts` 为 `capabilityPolicy.skillIds` 中被选中且可用的 Skill 生成与运行时 `load_skill` 同形的快照（工具 = Skill 声明 ∩ `allowedToolIds` ∩ catalog 定义，external 由 catalog 标记，未选/disabled/disableModelInvocation/action 触发一律不激活）。回归 `backend/llm-session/__tests__/direct-skill-context.test.ts`（`input.skillContexts` 精确断言）与 `backend/llm-tasks/src/durable/context-compaction.test.ts`「activates initially selected Skills without a load_skill call」；llm-tasks 37、llm-session 90。Flow 节点路径仍待接线 |
| P2-01「初始化工具激活」的 **Flow 节点路径**缺失（节点 `skillIds` 只产出身份/规则消息） | 已实现（2026-09-11 第四十六轮）：`DurableFlowExecutorOptions.resolveSkillContexts(sessionId, skillIds, allowedToolIds)`，`taskSpec` 按节点 `config.skillIds`（字符串去重、非字符串忽略）取快照写入 `llm.agent` 输入，委派子节点同一路径；共享构建器 `buildSkillContexts` 移入 `@itookit/llm-tasks`，`ConversationRunCoordinator.skillContextResolver` 用它为聊天内 Flow 注入端口（工具 = Skill 声明 ∩ 节点能力 ∩ catalog 定义，不扩权；无端口/无目录时返回空数组不阻断）。回归 `backend/llm-flow/__tests__/durable-flow-executor.test.ts`「activates a node's initially selected Skills through the host port」与 `backend/llm-session/__tests__/direct-skill-context.test.ts` 的 resolver 用例；llm-flow 177、llm-session 91 |
| P0-00「相同项目规则与 Skill 在两端一致」缺 CLI 半边证据 | 已取证（2026-09-11 第四十七轮）：`apps/cli/tests/run-skill-context.test.ts` 用真实 CLI 运行时 + 记录型 mock 模型跑两次 Run——模型请求含 `_agent/AGENT.md` 项目规则、auto-load Skill 正文与 `[红线]` 关键规则（并断言非红线 compact 正文不进入该路径，符合 `aggregateCompactInstructions` 契约）；首个 Run 的 Session 内核 `kernel-adapters.skills.loaded` 持久记录该 Skill（用 `openProfileInspectionFs` + `CliStorageResolver` 直接读取验证）；第二个 Run 在同一数据根重新推导出同样上下文。Tauri/GUI 半边仍缺。CLI 94 / 25 文件 |
| P0-00「重开 Session 后新建运行 / 卸载后再运行」两个场景缺证据 | 已在包级补证（2026-09-11 第四十八轮）：`backend/kernel-adapters/src/skill/session-skill-restore.test.ts` 用真实 `createKernelAdaptersRuntime` + `Kernel`：首次运行按触发词加载并把身份写入 `kernel-adapters.skills.loaded`（`['review']`）；**新的作用域实例**（等价重开 Session/换宿主）在用户消息不再匹配时仍按持久身份恢复并重新注入正文与 `[红线]` 关键规则；显式 `unload`（经 `SessionSkillControls` CAS）后新实例不再恢复，且再次匹配可重新加载（unload 非永久禁用）。kernel-adapters 93 |

| 无单一聚合命令跑全量验证（`pnpm test` 是报错桩，`crash-matrix` 与其它 CLI 用例并行会拖慢时序敏感用例） | 已固化（2026-09-11 第四十九轮）：新增根脚本 `scripts/test-all.mjs` 并接到 `package.json` 的 `test`（另留 `test:matrix` 别名）——按序跑 `pnpm -r --filter '!@itookit/cli' test` → CLI 去掉 `crash-matrix` → `crash-matrix`（隔离运行）→ `pnpm --filter tauri-app test:rust`，任一步非零即停止并汇总失败步骤。实跑输出 `=== full matrix passed` 且 exit 0。它只编排既有套件，不新增断言；矩阵计数仍以本文件 §2 为准 |
| P2-01「运行中更新」缺失（Skill 目录变化后输入区列表要重开编辑器才更新） | 已实现（2026-09-11 第五十轮）：服务侧 `SessionSkillControls.onChange(sessionId, listener)` 转发活动作用域订阅（非函数参数拒绝，经 `SessionCapabilityRegistry` 取该 Session 的 service）；UI 侧新增 `ui/llm-ui/src/shell/skill-refresh.ts` 的 `bindSkillRefresh(controls, sessionId, refresh)`（绑定后拉取一次 + 每次变更通知重新拉取，返回解绑函数；销毁后到达的订阅立即退订，列表/订阅失败只忽略），`LLMWorkspaceEditor` 在输入区创建后订阅、`destroy()` 开头解绑。回归 `ui/llm-ui/src/shell/skill-refresh.test.ts`（4 用例：初次渲染 + 变更重取 + 解绑后不再重取 + 宿主同步抛错仍不阻断编辑器）、`backend/kernel-adapters/src/skill/session-skill-controls.test.ts`「forwards change subscriptions to the live Session scope…」、`skill-device-driver.test.ts`「notifies a Session change subscription whenever the live Skill catalog changes」（真实 driver：`saveSkill` 触发通知、解绑后不再触发）。末段用真实 `ChatInput`（jsdom）验证整链：`SessionSkillControls` 变更通知 → `bindSkillRefresh` 重新拉取 → `ChatInput.refreshSkills`，面板条目由 1 变 2——`ui/app-shell/tests/session-skill-panel.test.ts`「refreshes the visible Skill list when the Session scope reports a catalog change」。llm-ui 15→19、kernel-adapters 93→95、app-shell 115→116。**边界（不夸大）**：通知只在宿主进程内传播（`SkillDeviceDriver.notifyChange`：saveSkill/deleteSkill/文件系统来源刷新），跨进程直接改 Skill 文件不触发；已在途 Task 的 system 消息不变，新定义在下一次上下文组装（`prompt-context.ts` 的 `refreshScopedSkills`）才生效；严格版本冻结与自动委派仍未实施 |

| P1-05 Resources §9「owner leader 迁移后旧 leader 写入」缺 authority 服务 | 已落地内核侧骨架（2026-09-11 第五十一轮）：`resources.seq` 新增 `managed/authority/<id>`，保存 `{authorityId, ownerEpoch, ownerId, binding, serviceEndpoint, status, updatedAt}`；`ResourceApi.claimAuthority` 首次声明写 epoch 1、接管必须提交观察到的 `expectedEpoch` 并 CAS 递增（失配报 `Authority epoch conflict: <id> is owned by <owner> at epoch <n>`，未知 authority 拒绝接管），`ResourceApi.authority(id, scope?)` 只读且 Kernel 重建后仍可读；`ResourceCommand` 新增可选 `authority: {authorityId, epoch}`，在权威事务内校验：过期 leader 的**新**写入被拒绝，已受理请求的重放仍返回记录结果（幂等优先于 fence）。回归 `backend/durable-kernel/src/resources.test.ts`「fences a superseded authority leader by the ownerEpoch it presents」「keeps the authority binding fixed to the first claim and survives Kernel reconstruction」「rejects invalid authority claims and epoch presentations」「refuses a Decision resource write whose authority epoch was superseded」（Task Decision 内的资源命令同样在提交事务内被 fence）；durable-kernel 194→198。**边界（不宣称该验收行通过）**：资源端 adapter 执行令牌 fence、真实多进程/多 store 竞争与迁移切换屏障未实现；account/allocation/export/import（跨 Session 授权、订阅、预留账本）仍未实现，`authority/` 之外的记录族未拆分 |

| P1-05 Resources §9「预算结算后回执丢失」无幂等结算 | 已落地内核侧（2026-09-11 第五十二轮）：`chargeBudget(handleId, dimension, amount, { usageId })` 把扣费与 `resources.seq.usage/<usageId>` 回执（`BudgetUsage { usageId, resourceId, dimension, amount, accounts, settledAt }`）写在同一事务；同 id 重放返回记录回执、不再扣费，同 id 不同金额/资源/维度抛 `Budget usage <id> was already settled for another charge` 冲突；Effect 路径由内核默认按逻辑 Effect 结算（`effect:<effectId>:<handleId>:<dimension>`），adapter 无需自带 id 即免疫 attempt 重试/崩溃恢复的重复扣费；未传 `usageId` 的宿主直调保持每次调用都扣。回归 `backend/durable-kernel/src/kernel.test.ts`「settles a budget charge once per usage id and refuses a conflicting replay」（含重建 Kernel 后回执仍去重）与「charges effect-driven usage once per logical Effect even when the attempt is retried」（真实 effect retry：两次 attempt 都扣费，最终 `used` 只 +4）；durable-kernel 198→200。**边界**：真实供应商侧重复计费核对仍未取证；「未知成本不退款」指实现从不回退已记录结算，未新增退款 API |

| P0-02「IPC 错误 / 授权失败时应用 UI 与持久状态一致」未验收 | 已取证并修复缺陷（2026-09-11 第五十三轮）：新增 `ui/app-shell/tests/send-failure-consistency.test.ts`（jsdom，驱动真实 `SendMessageCommand`）5 条用例——发送失败后输入与 agentId 恢复、加载态复位、错误提示可见、失败轮次在视图（`removeMessages`）与持久状态（`session.delete-message`）中一并删除；`401` 走 `ErrorHandler` 分类并在历史区 `renderError`；附件上传失败时不发送且草稿保留；**回滚通道自身故障**（回滚用的 `GetSessions` 抛错）时仍恢复输入并提示；**清理删除失败**时以 `console.warn` 显式报告。过程中复现并修复两处真实缺陷：① `rollbackFailedSend` 抛错会从 `catch` 逃逸，导致 `restoreInput`/`setLoading(false)`/`Toast.error` 全部不执行；② `SessionCommand.DeleteMessage` 未 `await`，其拒绝成为未处理的 Promise 拒绝且幽灵轮次静默残留在持久状态。app-shell 116→121。**边界**：真实 Tauri IPC 与真实窗口下的重测未做（属 P0-02 的 GUI 部分）；授权撤销的 UI 闭环由 app-core 守卫测试 + 文案映射测试覆盖，未端到端重测 |

| P0-02「Session 关闭（运行中删除）时应用 UI 与持久状态一致」未验收 | 已取证并修复缺陷（2026-09-11 第五十四轮）：`backend/app-core/tests/session-delete-lifecycle.test.ts` 新增「cancels a running Task while deleting and removes storage, catalog and records」——在途 Effect 的 Task 被关闭取消（在 `closeSession` 返回后立刻断言 Task 为 `cancelled`，此后记录随 Session 删除），存储根、catalog 与仓库 manifest 全部移除；以及「reports a bounded failure and deletes nothing while the in-flight Effect never confirms」——设备从不确认停止时删除在 `closeTimeoutMs` 内以 `EBUSY … nothing was deleted` 失败，manifest/存储/catalog 与 Task 记录全部保留，确认后重试成功。**修复缺陷**：`closeTimeoutMs` 此前只约束 `closeSession` 之后的轮询，`closeSession` 自身（等待在途 Effect 确认停止）无上界，不确认的外部设备会让删除无限挂起且永不报错；现同一 deadline 覆盖两步，迟到的完成仍被观察而非成为未处理拒绝。app-core 62→64。**边界**：真实设备/IPC 场景与 UI 侧按钮等待/失败文案的实窗口验收未做 |

| P1-05 §2 不变量 10「观察者能区分请求已接受/逻辑状态已变化/外部是否停止」缺取消侧证据与 GUI 记录 | 已补证（2026-09-11 第五十五轮）：`backend/durable-kernel/src/kernel.test.ts`「distinguishes an accepted cancel request from a confirmed external stop」——取消在途 Effect（适配器未确认停止）时 `task.stat()` 为 `{ phase: 'done', control: { requested: 'cancel', acknowledged: false }, activeOperations: 1 }`，适配器确认后 `{ acknowledged: true, activeOperations: 0 }`；`taskStat`/`taskStats`/`sessionStat` 由 `@itookit/durable-kernel` 包入口公开导出；`@itookit/app-core` 的 `taskSummary` 增加 `control`/`activeOperations`（回归 `session-browser.test.ts`「exposes whether an accepted cancel is still waiting for the external stop」覆盖 pending 与 stopped 两态）；`SessionWorkbench` 任务视图渲染 `[data-stop-state]`（`none`/`pending`/`stopped`）+ i18n `session.tasks.stopPending|stopStopped`，jsdom 回归 `ui/app-shell/tests/session-browser-ui.test.ts`（none → pending 含在途操作数 → stopped）。durable-kernel 200→201、app-core 64→65。**边界**：真实窗口可见性验收未做（本轮为 jsdom）；pause 请求未渲染同类文案 |

| P0-00「相同项目规则与 Skill 在两端一致」缺 Tauri 应用半边证据 | 已取证（无界面宿主装配，2026-09-11 第五十六轮）：`ui/app-shell/tests/tauri-host-skill-context.test.ts` 按 `apps/tauri-app/src/main.ts` 的同一装配创建运行时（`createApplicationRuntime` + `kernelPlatform.skillSourceForSession = new TauriSkillSource(files.vfs, files.cwd)`），把含 `_agent/AGENT.md` 与 `_agent/skills/review/SKILL.md`（含 `[红线]`）的项目目录挂为 Session 工作区，经 `SessionCommand.Bind`/`Send` 发起真实聊天运行后断言**落盘运行输入**含项目规则、Skill 正文与关键规则、不含非红线 compact 正文，并断言 `kernel-adapters.skills.loaded === ['review']`（宿主持久身份）与「消息不再匹配时仍按身份恢复正文/关键规则」（调用两宿主共用的 `resolveSessionSkillContext`）。app-shell 121→122。**仓库级重开宿主已补证（第五十七轮）**：同一文件用真实本地存储根（LocalFS + 共享 sidecar）跑两个宿主实例——宿主 A 建会话/挂目录/发起首次运行并持久 `kernel-adapters.skills.loaded` 后 `dispose()`（释放 Session 租约），宿主 B 仍能列出该 Session 并用**不再匹配触发词**的消息发起新运行，新运行落盘输入仍含项目规则、Skill 正文与 `[红线]` 关键规则。**边界**：仍是无界面装配证据，不是真实窗口/IPC 或真机验收（P0-04 仍缺） |

| P0-04「无隔离能力时不回退宿主 shell」与「Session Bash 清空继承环境」缺测试 | 已补证（2026-09-11 第五十八轮，`pnpm --filter tauri-app test:rust`，Rust 12→15）：`session_bash::tests::never_falls_back_to_a_host_shell`——构建出的命令只能是 `bwrap`，脚本仅作为内层 `bash` 的单个 `-c` 参数（不存在把脚本拼进宿主 shell 的路径）；`session_bash::tests::clears_host_credentials_and_exposes_only_the_fixed_session_environment`——进程内设置 `MINDOS_HOST_SECRET` 后，会话 shell 观察不到该变量且 `HOME=/tmp`、`LANG=C.UTF-8`，显式环境恰为 `PATH`/`HOME`/`LANG` 三项；`bash_process::tests::a_missing_isolator_fails_the_command_instead_of_running_unescaped`——隔离器缺失时命令以 `bash exec failed` 失败，不会在宿主环境里静默执行。这也把 P0-03 教程里「原生 Session Bash 清空继承环境」从约定升级为有测试的行为。**边界**：非 Linux 目标平台的 `cfg!` 拒绝分支无法在本机执行；其他平台支持范围仍需真实平台确认 |

| P0-02「文件保存失败时应用 UI 与持久状态一致」缺证据 | 已取证并修复缺陷（2026-09-11 第五十九轮）：[mdxeditor/tests/save-manager.test.ts](https://github.com/mushuanli/mdxeditor/blob/main/tests/save-manager.test.ts) 新增失败契约 3 条——保存失败保持 dirty 且回调 `onError`（不误报成功）、后续保存重试成功后清除 dirty、`finalSave` 失败只报告一次并保持 dirty（不空转）；mdxeditor 6→9。同轮发现并修复应用层缺口：`SessionWorkbench` 的文件编辑器把 `saveContent` 直接透传给 VFS 写入，写失败（只读挂载/IPC/授权撤销）时只保持编辑器 dirty，**界面无任何提示**，关闭编辑器时的 `finalSave` 也静默失败；现写失败先 `this.report(error)`（渲染 `role=alert` 提示）再重新抛出，编辑器保持 dirty 可重试。回归 `ui/app-shell/tests/session-browser-ui.test.ts` 断言提示内容为 `EROFS: mount is read-only`；未修复时该断言失败（已实测），证明缺口可复现。**边界**：真实 Tauri IPC/窗口下重测未做同轮修复第五十七轮重开用例的偶发失败（宿主 A 在 dispose 前等待首个运行到达终态，宿主 B 的失败信息进入断言）；随后 5 次全量 `app-shell` 套件连跑均 123 通过（+30 跳过），`mdxeditor` 9 通过。**边界**：真实 Tauri IPC/窗口下重测未做 |

| 聚合验证与构建未在当前树复核（§2 各行计数可能漂移） | 已复核（2026-09-11 第六十轮）：`pnpm test`（全量矩阵脚本）输出 `=== full matrix passed`、exit 0——各包套件 + CLI 去掉 crash-matrix + crash-matrix（6 通过，163s，真实 SIGKILL）+ `tauri-app test:rust`（15 通过）；逐包重采计数与 §2 的 17 行全部一致（app-core 65、app-shell 123/+30、driver-llm 46、device-tty 4、durable-kernel 201、kernel-adapters 95、llm-flow 177、llm-session 91、llm-settings-ui 1、llm-tasks 37、llm-ui 19、mdxeditor 9、tools 2、vfs-core 173、vfsdriver-indexeddb 15、vfsdriver-local 54、vfs-ui 88；合计 1309 + CLI 94 + Rust 15 与文档一致）；构建面 `pnpm build:libs`（全部 packages）、`@itookit/cli`（tsup）、`mind-os`（web 前端）、`tauri-app`（桌面前端）全部成功。顺带复核文档口径：`backend/app-core/src/` 已无 `files/` 目录、`llm-flow/__tests__/transcript-budget.test.ts` 存在、`packages/*/package.json` 恰 22 个 + 4 个 app、Effect 清理与调度租约默认超时均为 30s、Rust 输出上限 1 MiB 与文档一致 |

| P0-02「区分工具 Effect 成功与子命令退出成功」与 TTY 面板终态语义缺测试 | 已补证（2026-09-11 第六十一轮）：① **Effect 与退出码可区分**——`apps/cli/tests/nested-harness.test.ts`（`it.each([false, true])`）用真实子 CLI 断言：子命令退出非 0 时外层 Task 仍 `succeeded`、Bash Effect 仍为 `succeeded`，而工具结果文本是 `[exit 1]`（成功路径为 `[exit 0]` 且含子运行结果），即「工具是否执行」与「子命令是否成功」不会互相冒充；本轮实跑该文件复核通过。② **TTY 面板契约**——新增 `ui/app-shell/tests/tty-panel.test.ts`（jsdom，驱动真实 `TtyPanel`/`TtyController`）5 条：输出与命令一律以文本节点写入（注入 `<script>`/`<img onerror>` 不产生元素）、`finalize` 之后到达的输出被忽略、`[exit 0]`/`[exit 3]` 如实报告、输出超上限只保留最新 100k 字符、meta 只路由到匹配会话且 `ttyOpen` 幂等、`destroyAll` 移除面板。同轮修复缺陷：`finalize(null)`（`tty_close` 未观测到退出码时会话被杀）此前显示 `Process exited (code ?)`，现为 `Process stopped (exit code unknown)`，与 `tty_close` 工具自身文案一致；新测试在修复前失败（`expected 'Process exited (code ?)' …`）。app-shell 123→128。③ **重开宿主用例的偶发失败已定位并修掉**：第五十七轮用例在满载并行下偶发 `ConversationError: Cannot send consecutive user messages`——「Kernel Task 已终态」并不等于「会话 round 已持久化」：宿主 A 在 round 文档状态与分支 head 落盘前 `dispose()`，重开的宿主 B 只会恢复出「以用户消息结尾」的转写并拒绝发送。用例现改为等待**持久条件**（`manifest.currentHead` 指向的 round 文档 `status === 'failed'`）再关闭宿主；此后 5 次全量 `app-shell` 连跑（含并行真实 CLI 子进程压力）均 128 通过。这也记录了宿主关闭顺序要求：应在会话 round 结算后再退出，而不是只看 Kernel Task 终态 |

| P0-02「应用被强杀/崩溃后重开，会话无法再发送」未验收 | 已修复并取证（2026-09-11 第六十二轮）：旧投影只对**终态且无输出**的 round 生成助手占位；拥有运行却仍为 `running` 的 round（宿主在途中消失）不生成任何助手消息，重开后转写以用户消息结尾，下一次发送被 `ConversationError: Cannot send consecutive user messages` 拒绝，且 `interruptedAssistantId` 为空、连「重新执行」提示都不出现——会话实际卡死。现 `roundToProjection` 对「已记录 `executions` 且状态为 `running`/`pending`」的 chat round 投影 `running` 助手占位（`waiting` 与从未启动执行的 round 保持仅用户消息），于是 `SessionRegistry.getSnapshot().interruptedAssistantId` 会命中并提示重新执行，新消息也不再被守卫拒绝。回归：`backend/llm-session/__tests__/failed-round-projection.test.ts` 新增 3 条（running+executions → running 占位且 `executionRoot.status === 'running'`；running/pending 无 execution 仍仅用户消息；`waiting` 不误报为可重跑），llm-session 91→94；`ui/app-shell/tests/host-restart-inflight.test.ts`（真实本地存储根 + 永不回包模型服务，宿主 A 在模型调用在途时 `dispose()`，宿主 B 重开：转写尾为 assistant、`interruptedAssistantId` 非空、新消息不被拒），app-shell 128→129。**非空判**：未修复时包级单测与端到端用例均失败（`expected undefined to match object …` / `[["user",null]] expected 'user' to be 'assistant'`）。**边界**：`waiting`（人工输入中）宿主消失后的恢复仍按未完成处理，未纳入本轮；真实 Tauri 强杀场景仍待实机重测 |

| P0-02「等待人工批准时宿主消失，重开后会话无法继续」未验收 | 已修复并取证（2026-09-11 第六十三轮）：`execution_task_projected` 只在**本宿主启动运行**时发出，因此重开时一个仍 `waiting`（有待处理 interaction）的 Task 不会被重新挂接——批准提示不出现、`/approve` 无对象可发，会话既不能继续也不能发送新消息。现 `LLMWorkspaceEditor` 在既有「特权任务」恢复之后调用新增的 `restoreWaitingAttachment(kernel, sessionId, attach)`（`ui/llm-ui/src/shell/pending-interaction.ts`）：按「非终态 + 存在 `pending` interaction」筛选并以 `updatedAt` 取最新，重新 attach 后会重放 `task.interaction.requested`，`RunAttachmentController` 已有的重放语义（既有用例「replays task events and exposes interaction requests」）随即触发 `onWaiting`，`/approve` 也重新可用。回归 `ui/app-shell/tests/pending-interaction-restore.test.ts` 3 条（真实 Kernel：等待批准的 Task 被选中并 attach；无等待任务时不 attach；纯函数按「非终态 + pending + 最新」选择，排除已解决/已终态项），app-shell 129→132。**边界**：编辑器内那一行接线没有端到端 UI 测试；`waiting` round 仍不投影助手占位（新消息在批准前仍被守卫拒绝，这是有意行为——恢复的是批准通道而不是新消息通道）；真实 Tauri 强杀实机重测未做 |

| P1-02「拒租的 Session 保持只读」只在恢复层成立，写入未受约束 | 已修复并取证（2026-09-11 第六十四轮）：`recoverSessionsWithLeases` 不恢复被拒的 Session，但**没有任何写入路径检查租约**——同一数据根上启动第二个宿主后，它仍能把新 round/任务写进由第一个宿主持有的 Session（实测：第二个宿主的 `session.send` 被接受）。现把租约检查做成写入门：`recovery.acquireLater` 返回是否持有租约（本宿主新建 Session 按需获取），`createApplicationRuntime` 经 `createConversationSystem({ ensureWritable })` 注入，`initializeConversationSystem` 以 `canWriteSession` 传入 `SessionManager.sendMessage`，被拒时在**追加 round 之前**抛 `Session is owned by another host; this host can only read it`。回归 `backend/llm-session/__tests__/session-write-gate.test.ts` 2 条（被拒时不写任何 round；门通过时检查的是将写入的 Session），llm-session 94→96；`backend/app-core/tests/session-recovery.test.ts` 增补 `acquireLater` 布尔断言（空闲 Session 为 true、他宿主持有为 false）。**边界**：同进程内两个 `createApplicationRuntime` 会共享进程级 `SessionManager` 单例，因此「第二个宿主」的真实端到端验收需要两个进程/两个应用实例（未做）；被拒端的 UI 只显示发送失败，尚未整体切换为只读视图 |

| P0-03 教程与实际凭证路径不符（要求桌面设置填 `api_key_env`） | 已改正并补证（2026-09-11 第六十五轮）：`api_key_env` 只存在于 CLI YAML（`apps/cli/src/{types,config,runtime}.ts` 校验/读取环境变量），桌面 Provider 设置（`ui/llm-settings-ui/src/editors/ProviderSettingsEditor.ts`）只有密码输入框，key 以明文写入 profile 的 Provider 配置；`doc/minimal-system.md` 的「模型与目录授权」第 1 步改为按宿主区分，并写明 key 的可见范围（不出现在 `getProviders()`、`.llm` 导出与 LLM 日志，但落在 profile 数据根内，交付前需与用户确认）。新增 `backend/kernel-adapters/tests/llm-management/provider-export.spec.ts` 3 条守护导出路径：单/多 Provider 导出均不含 key、导出→解析往返不会凭空产生 key；driver-llm 46→49 |

| `llm-session` 遗弃在途事件消费者：app-shell 套件「测试全过但 exit 1」并中断整仓矩阵（未处理的 `EACCES`） | 已修复并取证（2026-09-11 第六十六轮）：`ConversationRunCoordinator.consume` 先 `await handle.wait()`，宿主 `dispose()` 存储使其 reject 时直接抛出、**跳过**了 `Promise.all(consumers)`；在途 `consumeEvents`（`for await … handle.events()`）同样因存储关闭而 reject，却无人观察 → `Serialized Error: { code: 'EACCES' }` / `Errors 1 error`。现 `subscribe` 即捕获 consumer 错误、`wait()` 的 reject 记录后**始终**执行 consumer join，再按「wait 错误优先、其次 consumer 错误」抛出。回归 `backend/llm-session/__tests__/conversation-run-consumer-join.test.ts`（stub：wait reject + events 迭代器 reject）；**已验证未修复时失败并打印同形态 `EACCES`/`Errors 1 error`**。llm-session 96→97，app-shell 132 / 30 跳过且无错误 |

| CLI 全量矩阵 5s 默认超时抖动（`session-delete-localfs`） | 已修复（2026-09-11 第六十六轮）：该文件是 CLI 里**唯一**生成真实子进程（`tsx` worker ×3）却未声明超时的测试（其余 10 个进程类文件为 10–60s）；单独跑 2.4s，与最重的 `worktree-run`（约 40s）并行时超过默认 5000ms。按既有约定加超时（进程重启用例 30s、其余 15s）；同条件复跑 CLI 套件 24 文件 / 88 用例通过，整仓 `pnpm test` 恢复 `=== full matrix passed` |

| `docs:check` 长期告警的 5 个包缺 `AGENTS.md` | 已补齐（2026-09-11 第六十六轮）：`durable-kernel`、`kernel-adapters`、`ui-common`、`demo` 各按实际源码结构/依赖方向/公共入口/约束/运行命令编写（`demo` 记为 legacy 手工 playground）。`docs:check` 的 `[missing-doc]` 告警 5→0（75 份活文档，余 5 条历史表述告警） |

| P0-02② 空闲 IPC 只计 VFS 引擎、不计 SQLite sidecar（量化不完整） | 已补齐计量（2026-09-11 第六十七轮）：sidecar 是桌面端**第二条** Tauri IPC 通道（`TauriSqlSidecarDb`），`ioStats` 看不到。新增 `https://github.com/mushuanli/vfsdriver-local/blob/main/src/db/sidecar-stats.ts`（`SIDECAR_OPERATIONS` + `countSidecarOperations` 代理）与 `LocalFSBackend.sidecarStats`/`resetSidecarStats`；`transaction` 回调收到被插桩的句柄，事务内语句同样计数。`apps/tauri-app/src/log/vfs-trace.ts` 每 2s 输出 `{ ops, delta, sidecarOps, sidecar }`，`main.ts` 把 LocalFS 根后端接入 trace。回归 `https://github.com/mushuanli/vfsdriver-local/blob/main/tests/24-sidecar-stats.test.ts` 3 通过（冻结全量计数集 + reset、记录读写计数、事务内语句计数）；`ui/app-shell/tests/session-workbench-idle-localfs.test.ts` 在 LocalFS 后端装载真实 vfs-ui 侧栏 + `SessionWorkbench`，静置 1s 内 VFS 与 sidecar 增量均为 **0**。vfsdriver-local 54→57、app-shell 132→133。**边界**：这是计量能力 + jsdom 双通道回归；真实 Tauri IPC 下的聊天视图空闲流与真实窗口测量仍未验收 |

复跑：`durable-kernel` 201、`llm-session` 96、`app-core` 65、`kernel-adapters` 95、`llm-flow` 177、`llm-session` 91、`app-shell` 132 / 30 跳过、`vfs-core` 173、`apps/cli` 94（25 文件：`crash-matrix` 6、`run-control` 2、
`worktree-run` 5、`run-scheduler-lease-delete` 2、`run-live-owner-refusal` 1、`process-cancel` 1 等；`crash-matrix` 与其他文件并行会拖慢时序敏感用例，
故分别复跑）、`tauri-app test:rust` 15 通过、`llm-ui` 19、`mdxeditor` 9、`vfsdriver-indexeddb` 15 也纳入复跑、`pnpm typecheck` 覆盖 24 个工程且通过。
**2026-09-11 第六十六轮复跑**：`pnpm test` 全量矩阵 `=== full matrix passed`、exit 0；`llm-session` **97**（新增 1 条 consumer-join 回归）、`app-shell` 132 / 30 跳过且不再有 `Errors`、CLI 24 文件 / 88 通过 + `crash-matrix` 6、Rust 15；其余包计数与上列一致。本轮不改产品行为，GUI/实机验收项不受影响。
**2026-09-11 第六十七轮复跑**：`vfsdriver-local` 54→**57**、`app-shell` 132→**133**（LocalFS 双通道空闲回归）；`pnpm typecheck`、`pnpm docs:check`、`pnpm styles:check` 通过；全量矩阵 `pnpm test` 输出 `=== full matrix passed`、exit 0（llm-session 97 + vfsdriver-local 57 + app-shell 133/30 跳过 + CLI 94 + Rust 15，合计 **1331 通过 / 30 跳过**）。
**2026-09-11 第七十一轮复跑**：`vfsdriver-local` 57→**59**（journal 探测回归）；全量矩阵 `pnpm test` `=== full matrix passed`、exit 0（llm-session 97 + vfsdriver-local 59 + app-shell 133/30 跳过 + CLI 94 + Rust 15，合计 **1333 通过 / 30 跳过**）；`pnpm typecheck`、`pnpm docs:check`、`pnpm styles:check` 通过。
**2026-09-11 第七十二轮复跑**：`vfsdriver-local` 59→**60**（只读路径回归）；全量矩阵 `pnpm test` `=== full matrix passed`、exit 0（llm-session 97 + vfsdriver-local 60 + app-shell 133/30 跳过 + CLI 94 + Rust 15，合计 **1334 通过 / 30 跳过**）；`pnpm typecheck`、`pnpm docs:check`、`pnpm styles:check` 通过。
**2026-09-11 第七十三轮复跑**：`vfsdriver-local` 60→**62**（前缀检查免元数据 + 并发写临时文件回归）；全量矩阵 `pnpm test` `=== full matrix passed`、exit 0（llm-session 97 + vfs-core 173 + vfsdriver-local 62 + app-shell 133/30 跳过 + CLI 94 + Rust 15，合计 **1336 通过 / 30 跳过**）；`pnpm typecheck`、`pnpm docs:check`、`pnpm styles:check` 通过。
**2026-09-11 第七十四轮复跑**：`vfsdriver-local` 62→**63**（嵌套视图免元数据回归）；全量矩阵 `pnpm test` `=== full matrix passed`、exit 0（合计 **1337 通过 / 30 跳过**）。
**2026-09-11 第七十五轮复跑**：`vfsdriver-local` 63→**64**（前缀批量回归）；全量矩阵 `pnpm test` `=== full matrix passed`、exit 0（合计 **1338 通过 / 30 跳过**）；`pnpm typecheck`、`pnpm docs:check`、`pnpm styles:check` 通过。
**2026-09-11 第七十六轮复跑**：Rust 15→**16**（Session Bash 无挂载文案用例）；全量矩阵 `pnpm test` `=== full matrix passed`、exit 0（合计 **1339 通过 / 30 跳过**）；`pnpm docs:check`、`pnpm styles:check` 通过。
仍缺：GUI 侧空闲流与状态一致（`ioStats` 不计 SQLite sidecar
写入——该计量已在第六十七轮补齐：`LocalFSBackend.sidecarStats` + trace 双通道输出 + LocalFS 双通道空闲回归；真实 Tauri IPC 下的聊天视图空闲流仍需真实窗口测量）与真实窗口下的重测。**发送失败的 UI 闭环已于 2026-09-11
（第五十三轮）取证**（`ui/app-shell/tests/send-failure-consistency.test.ts` 5 通过：失败后输入恢复/加载态复位/错误可见/幽灵轮次从视图与持久状态一并删除、
401 显示为授权失败、附件上传失败不发送、回滚通道本身故障时仍恢复输入并告警、清理失败显式 `console.warn` 而不是未处理的 Promise 拒绝），
同轮修复两处真实缺陷（回滚 `GetSessions` 抛错会跳过输入恢复与错误提示；`DeleteMessage` 未 await 导致失败被静默吞掉）。授权撤销侧的挂载守卫与文案分别在
`backend/app-core/tests/directory-mounts.test.ts`「rejects reserved mount points, absent directories, and changes while the host guard refuses」与
`ui/app-shell/tests/mount-error-localization.test.ts` 覆盖，尚未在真实 Tauri IPC 下重测。

## 9. 真实窗口探针：Xvfb + AT-SPI 可驱动性（2026-09-11 第六十八轮）

本机**没有物理 X11 桌面**，此前 P0-04 的「真实窗口（X11）端到端验收」一直被记为缺证，且第六十五轮的 Xvfb 尝试无法确认会话恢复。本轮把「能否在虚拟显示上真实驱动应用窗口」这件事本身查清并跑通：

**关键环境约束（此前未记录）**：AT-SPI 辅助总线会尝试在 `~/.cache/at-spi/bus` 建 socket。DSH 的 `workspace-write` 文件沙箱把工作区外路径视为只读，因此 `org.a11y.Bus` 激活后在 `Failed to bind socket "/home/li/.cache/at-spi/bus": Read-only file system` 处失败，`a11y.py` 只能拿到空地址（`g-io-error-quark: The given address is empty`）。**必须在 full file access 下运行探针**；这不是产品缺陷。另一个约束是每条 shell 命令都在独立的 PID/tmp 命名空间里，Xvfb、dbus、应用与 a11y 探针必须在**同一次调用**内完成。

**步骤（可复现）**：

```bash
pnpm --filter tauri-app build                                   # 当前树前端 → apps/tauri-app/dist
cargo build --offline --features tauri/custom-protocol \
    --manifest-path apps/tauri-app/src-tauri/Cargo.toml         # 重新嵌入前端
# 在 full file access 下，于单次 shell 调用内：
#   Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
#   dbus-run-session -- bash <<'SH'
#     export DISPLAY=:99 GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=0
#     MINDOS_ROOT=<隔离数据根> ./apps/tauri-app/src-tauri/target/debug/tauri-app &
#     sleep 25
#     python3 .tauri-acceptance/a11y.py apps          # → :1.1 tauri-app
#     python3 .tauri-acceptance/a11y.py snap          # 完整 a11y 树
#     xwd -root -silent > win.xwd && node .tauri-acceptance/xwd2ascii.mjs win.xwd win.png 100 34
#   SH
```

**观测到的证据（当前树，非 d883a497）**：

- 应用进程存活（`alive=yes`），AT-SPI 注册为 `:1.1 tauri-app`，辅助栈报 `SpiRegistry daemon is running with well-known name - org.a11y.atspi.Registry`。
- 窗口节点 `[Component] 'X1' @0,0 1280x800`，根 webview 内容 `@0,0 1280x500`；a11y 树 94 行，侧栏 10 个 40–44px 工作区按钮 + 主区。
- 主区具名节点：`Files`、`+ Note`、`📁+`、`📥`、`📤`、`Search (tag:xx type:file|dir)...`、`切换侧边栏`、`切换到阅读模式`、`附件管理`、`保存`、`打印`、`×`（关闭）——即当前树的**真实窗口渲染出完整 Files 工作区外壳**。
- 截图由 `xwd` + `xwd2ascii.mjs` 转成 PNG（会话文件，未入 git；`.tauri-acceptance/` 为 gitignore 的一次性目录）。

**边界（不夸大）**：本轮证明的是「当前树二进制能在真实 X11 窗口渲染，且 a11y 树可枚举/可点击（`a11y.py` 的 `click/focus/type/press`）」，**不是** P0-01 的 `外层 harness → Bash → 子 CLI DAG` 链路复验；侧栏工作区按钮当时没有可访问名（见 §10，已修）、配置 Provider/Connection、挂载目录并发送消息的完整 E2E 仍待后续轮次用同一 harness 完成。P0-00/P0-02/P0-03/P0-04 的验收状态不因本探针改变。

## 10. GUI 自动化：导航可访问名修复与探索结果（2026-09-11 第六十九轮）

在 §9 的 harness 上尝试驱动窗口时，先解决了一个**真实可访问性缺陷**，并把自动化探索到的事实记录下来。

### 10.1 修复：图标导航链接没有可访问名

`apps/tauri-app/index.html` 的左侧工作区导航（`.app-nav-btn`）只有 `<i class="fas …">` 图标 + `title`。WebKitGTK/AT-SPI **不会**把 `title` 当作可访问名，因此 11 个导航链接的 a11y Name 全为空——屏幕阅读器无法朗读，自动化也只能靠猜几何位置。

修复：给全部图标导航链接补显式 `aria-label`（`index.html` 的 10 个静态项 + `Settings`），动态挂载项在 `apps/tauri-app/src/main.ts` 里同样补 `aria-label="${entry.label}"`。

**真实窗口验证**（重建前端 + `cargo build` 后，Xvfb + AT-SPI）：修复后 a11y 树中 11 个导航名全部出现——`AI Sessions`、`Projects`、`Anki Memory`、`Emails`、`Private Notes`、`Minds`、`Skills`、`Workflows`、`Agents`、`Settings`、`Mount directory…`（修复前一个都没有）；`a11y.py find "AI Sessions"` 直接命中带 `Action` 的按钮，可 `DoAction` 点击。`pnpm --filter tauri-app typecheck`、`pnpm styles:check` 通过。

### 10.2 探索到的事实（供后续轮次使用）

- **侧栏 y → 工作区映射**（内容区高 500px）：`y=12` Files、`y=64` AI Sessions、`y=112` Projects、`y=160` Anki、`y=208` Emails、`y=256` Private Notes、`y=304` Minds、`y=352` Skills（修复后可直接用名字定位，不再需要此映射）。
- **Files 工作区**：`+ Note` 是非 instant 创建——先弹出内联命名输入（`.vfs-node-list__item-creator-input`，自动聚焦），输入名字后 Enter 创建；实测在真实窗口点 `+ Note` 后 `<隔离 home>` 下确实出现新的 `*.md`（**真实 UI → Tauri IPC → LocalFS 落盘**，两次运行各产生 1–2 个文件）。但随后编辑器的 CodeMirror 内容**未**在 AT-SPI 中暴露为 `EditableText`，`xsend text` 的合成输入没有落进文档，落盘文件为 0 字节——即「创建」链路可验证，「输入内容并保存」尚未驱动成功。
- **AI Sessions 工作区**：`+ 会话` 同样是内联命名创建；执行「点 `+ 会话` → 输入名字 → Enter」后 `<root>/var/lib/sessions/<node-…>/` 目录被创建，但 `session.seq`/`history.seq` 为 0 字节且右侧聊天编辑器未挂载——会话创建/打开的完整路径未驱动成功。
- **原生 GTK 文件选择器**（`📁+` 触发）在 AT-SPI 中**结构完整**（`Places`/`PathBar`/`Cancel`/`Open` 均具名），是当前最容易自动化的对话框。

### 10.3 边界

本轮完成的是**导航可访问名修复 + 真实窗口验证 + 自动化现状记录**；P0-01 的 `外层 harness → Bash → 子 CLI DAG` 与「真实窗口内发送消息」仍未驱动成功（编辑器内容不可访问 / 会话打开路径未走通），P0-00/P0-02/P0-03/P0-04 的验收状态不变。

## 11. 真实窗口发送链路打通与 IPC 归因（2026-09-11 第七十轮）

§10 判定「发送未驱动成功」的两处障碍本轮都解决了，并在真实窗口上量化了 P0-02 的发送延迟。

### 11.1 打通方式（可复现）

- **长驻会话**：把 Xvfb + dbus + 应用放在**一个后台任务**里常驻（默认每条命令是独立 PID/tmp 命名空间），地址写入 `.tauri-acceptance/gui-env.sh` 后由前台命令 `source` 复用，迭代不再需要每次重启应用。应用用 `MINDOS_ROOT=<隔离根> --home <隔离 home>` 启动。
- **Mock Provider 预置**：`<根>/etc/llm/.providers/mock.json` + `.connections/default.json` 指向 `http://127.0.0.1:8399`（mock 与应用同一命名空间）。
- **键盘输入需要 X input focus**：无窗口管理器时合成按键会丢失；给 `xsend` 增加 `focus` 命令（`XQueryTree` 找可见顶层窗口 + `XSetInputFocus`）后，先 `xsend focus`、再 `a11y.py focus "Message..."`（GrabFocus），`xsend text` 才能进入聊天输入框。
- **聊天输入框不是 EditableText**：AT-SPI 只给出 `[Action,Text,Component]`（Name 是 placeholder，正文在 `Text.GetText`）。因此「读内容」用 `Text.GetText`，「写内容」用点击几何位置 + 合成按键，`EditableText.SetTextContents` 不可用。
- **打开会话**：`+ 会话` 是内联命名创建（输入名字 + Enter），随后点击列表行（约 `x=120,y=161`）才挂载聊天编辑器；编辑器出现 `Message... (Paste images or Drag & Drop)` / `Send (Enter)` / `Untitled Chat` 即成功。

### 11.2 证据：真实窗口 → Provider

`Send (Enter)`（@1213,441）触发后，mock 服务记录：

```
{"url":"/v1/chat/completions","stream":true,"model":"mock-model","n":2,"prompt":"TRACED-SEND"}
```

UI 文本树（`a11y.py texts`）同时出现：用户消息 `TRACED-SEND` → 助手 `SUCCESS` + 正文 `pong` + token/成本行。即 **当前树在真实 X11 窗口上的「输入 → 发送 → 模型请求 → 回复渲染」链路已贯通**（此前只有旧树真机记录与无界面装配证据）。

### 11.3 发送延迟与 IPC 归因（`VITE_MINDOS_TRACE=1` 构建）

三次发送的「点击 Send → Provider 收到请求」延迟：**17.1s / 18.3s / 16.5s**（第三次带 trace）。第三次（`TRACED-SEND`）16.47s 窗口内的计数：

| 通道 | 次数 | 明细 |
|---|---|---|
| VFS 引擎 | **845** | stat 823、list 12、metadata 5、mkdir 3、write 2 |
| SQLite sidecar | **3257** | getRecordField 1187、transaction 1011、getMetaExt 829、listRecordFields 147、setRecordField 75、upsertMetaExt 5、deleteRecordField 3 |
| 合计 | **4102** | ≈ 4.0ms / 次调用 |

对照阈值「单次发送 ≤ 2s 且 ≤ 100 次调用」，当前实测 **16.5s / 4102 次**，超出约 40 倍。**sidecar 占 79%**（3257/4102）——这正是第六十七轮才补上的计量通道；只看 `ioStats` 会把成本低估约 5 倍。主因方向明确：`getRecordField`（1187）与每次 `withDb` 一个的 `transaction`（1011）、以及每路径 `getMetaExt`（829）的逐条 IPC。

### 11.4 同一真实窗口的空闲流量

发送结束后静置 20s：**0 次 VFS 操作 + 10 次 sidecar**（每 10s 5 次，即 Session 租约续期）= **0.5 ops/s**，满足建议的「空闲 ≤ 5 ops/s」。即内核轮询修复在真实窗口成立，剩余成本集中在发送路径本身。

### 11.5 边界

Mock 为本地服务、单会话、无并发/取消/崩溃场景；前两次延迟（17.1s / 18.3s）测于未开 trace 的会话，日志已被后续会话覆盖，持久证据是本次带 trace 的 16.47s 与 `.tauri-acceptance/round70-*`。本轮**未**修复该延迟，只完成「真实窗口发送链路贯通 + 成本归因」；P0-02 仍要求真实窗口下的取消/超时/授权撤销闭环，P0-00/P0-03/P0-04 状态不变。

## 12. 发送路径优化：rename journal 探测按进程一次（2026-09-11 第七十一轮）

§11 的归因显示 `withDb` 事务与 `getRecordField` 是最大两块。本轮先消掉其中**明确冗余**的一块。

### 12.1 问题

`LocalFSBackend` 把 `recoverRename` 注册为记录存储的 `beforeTransaction`，于是**每个**记录事务都执行一次 `getRecordField(RENAME_JOURNAL, 'intent')`。该探测是崩溃恢复所必需的（它同时充当 rename 的执行者），但 journal 绝大多数时间为空；在桌面宿主上它是一次 SQLite Tauri IPC。§11 的 trace 中 1011 次 `transaction` / 1187 次 `getRecordField`，其中约 1000 次来自这个探测。

### 12.2 修复

`LocalFSBackend` 新增实例内 `journalDirty`：

- `init()`（真正打开 sidecar 时）置 `true` —— 新进程必须查找崩溃遗留的 intent；
- `recoverRename` 在 `journalDirty === false` 时直接返回，不再读 journal；读到空 journal 或完成/放弃一次恢复后置 `false`；
- `rename` 写入 intent 后置 `true`，使下一次事务触发恢复。

语义保持：崩溃恢复仍由「新进程启动即 dirty」保证；单写者模型下同进程不会漏掉别的进程写入的 intent（真有第二进程时，它自己的 flag 也是 dirty）。

### 12.3 验证

- 回归 `https://github.com/mushuanli/vfsdriver-local/blob/main/tests/25-journal-probe.test.ts` 2 条：启动后连续 10 次记录读写只探测 journal **1 次**；写入 intent 后仍能完成 rename 并迁移记录、随后恢复安静。**已验证未修复时失败**（`expected 11 to be 1`）。
- 全量 localfs 套件 **59 通过**（含 `20-kernel-ipc.test.ts` 的跨进程 SIGKILL rename 恢复：进程 A 在文件系统 rename 后被杀，新进程 B 读到迁移后的记录）。
- 真机复测（同一 §11 harness + `VITE_MINDOS_TRACE=1` 构建，同一发送路径）：

| | 延迟 | VFS | sidecar | 合计 IPC |
|---|---|---|---|---|
| 修复前（`TRACED-SEND`） | 16.47s | 845 | 3257 | **4102** |
| 修复后（`OPT-SEND`） | **12.35s** | 733 | 2038 | **2771** |

`getRecordField` 1187 → **184**（−1003，即探测基本消失）；总 IPC −32%，发送延迟 −25%。证据：`.tauri-acceptance/round70-*`、`round71-*`。

### 12.4 边界

延迟仍比「≤2s / ≤100 次」阈值高一个量级。剩余热点已明确：`withDb` 事务本身（896 次，Tauri 侧每次至少 `sidecar_begin`+`sidecar_finish` 两次 IPC，故真实 IPC 数高于本表计数）、`getMetaExt`（710，逐路径读取）、以及发送路径的 VFS `stat`（约 700）。下一步方向：只读记录操作不经事务、批量/缓存 `getMetaExt`、减少发送路径无谓的 `stat`；这些都需要更谨慎的并发/一致性论证，本轮未做。

## 13. 发送路径优化第二步：只读操作不再开事务（2026-09-11 第七十二轮）

§12 之后 `transaction` 仍有 896 次，而 Tauri 侧每次 `withDb` 至少是 `sidecar_begin` + `sidecar_finish` 两次 IPC。发送路径里绝大多数交互是**只读**的（`stat` 读 meta、SeqFile 记录读取、tag 查询），读不需要事务，也不需要为它付两次 IPC。

### 13.1 修复

`SidecarRecordStore` 抽出 `serialize` / `runInTransaction`（保持原有 tail 串行与 begin/commit/rollback + `AggregateError` 语义），新增 `withDbRead`：

- `journalDirty === false`（journal 干净）时直接 `operation(db)`，不 `begin`/`commit`；
- `journalDirty === true`（可能有 pending rename intent）时回退到 `runInTransaction`，保证恢复仍原子。

改走该路径的只读入口：`stat`、`listTagEntries`、`getAllTags`、`SidecarRecordStore.getRecordField`、`walkRecordFields`（`rows`）。写路径（`setRecordField`/`deleteRecordField`/`clearRecordFields`/`setAllRecordFields`/`updateMetadata`/`setTags`/`delete`/`rename`）继续走 `withDb`。

### 13.2 验证

- `25-journal-probe.test.ts` 新增「clean journal 下 `stat`/记录读/tag 读不新增事务、写新增 1 次」；**已验证未修复时失败**（`expected 6 to be 1`）。`24-sidecar-stats.test.ts` 的「写 1 次事务、读不新增」同步更新。localfs 59→**60**，含跨进程 SIGKILL rename 恢复。
- 真机复测（同一 §11 harness + trace，点击 Send → Provider 收到请求）：

| 轮次 | 延迟 | VFS | sidecar | 合计 IPC | transaction | getMetaExt | getRecordField |
|---|---|---|---|---|---|---|---|
| 第五轮基线 | 16.47s | 845 | 3257 | **4102** | 1011 | 829 | 1187 |
| 第六轮（journal 按进程） | 12.35s | 733 | 2038 | 2771 | 896 | 710 | 184 |
| 第七轮（只读不事务） | **9.31s** | 653 | 1106 | **1759** | **100** | 626 | 163 |

两轮合计：延迟 **−43%**（16.47s→9.31s）、IPC **−57%**（4102→1759）、`transaction` **−90%**（1011→100）。证据：`.tauri-acceptance/round70-*`、`round71-*`、`round72-*`。

### 13.3 边界

仍高于「≤2s / ≤100 次」阈值。剩余热点从「每条读一次事务」变成了**调用次数本身**：sidecar `getMetaExt` 626（≈每个 `stat` 一次）与 VFS `stat` 653，外加 `getRecordField` 163 / `listRecordFields` 128（SeqFile 记录读取，属必要成本）。下一步要减少发送路径无谓的 `stat` 或批量化 meta 读取，需先定位是哪些组件/订阅者在 stat（例如侧栏刷新、上下文组装、Session 文档读取），再决定是缓存还是合批——本轮未做。

## 14. 发送路径优化第三步：能力检查不再取元数据（2026-09-11 第七十三轮）

### 14.1 归因

用无界面探针 `.tauri-acceptance/probe-send-attrib.mts`（`createApplicationRuntime` + LocalFS/`NodeSqliteSidecarDb`，给 `LocalFSBackend.stat` 抓取 9 层调用栈后聚合）测一次聊天发送：

```
964 backend.stat 次（task.created 前 511）
812x  VFSEngine.stat ← DirectoryDriver.getNode ← FileSystemView.invoke ← FileSystemView.noLinks
 68x  ... ← SeqFileOps.path ← SeqFileOps.getEntry
 43x  ... ← FileSystemView.stat（noLinks 之后的目标再取一次）
 18x  ... ← SeqFileOps.walkEntries
```

即 **84% 的 stat 来自 `FileSystemView.noLinks`**：它对**每个路径前缀**调用 `driver.getNode`，而 `getNode → engine.stat → backend.stat` 会读取 sidecar `meta_ext`；可前缀检查只需要 `type`。深层路径（`/var/lib/sessions/<id>/...`）每次操作都要为此付 N 次 `getMetaExt` Tauri IPC。

### 14.2 修复

新增可选契约，缺省行为不变：

- `IStorageBackend.statType?(path)`：类型必须与 `stat` 同源，但可跳过元数据；`LocalFSBackend.statType` 只调 `fsOps.stat`（**0 次 sidecar 调用**）。
- `IFSDriver.getNodeType?(path)`；`DirectoryDriver.getNodeType` 用新增的 `VFSEngine.tryStatType`（优先 `backend.statType`，否则回退 `stat` 并只取 `type`）。
- `FileSystemView.noLinks` 优先 `getNodeType`，缺失时回退 `getNode`；类型判定（拒绝 directory/file/seqfile 之外的节点）完全不变。

因此这是**安全中性**的优化：同样的底层 stat、同样的类型结论，只是不再为前缀去读元数据。

### 14.3 验证

- `25-journal-probe.test.ts` 新增「深路径前缀检查只对目标取一次元数据」：把 backend 挂进 VFS 后 `readContent('/deep/a/b/file.md')`，统计 sidecar `getMetaExt`；**修复前 6 次，修复后 2 次**（4 个前缀不再取元数据）。
- vfs-core 173、vfsdriver-local 61 全通过（含跨进程 SIGKILL rename 恢复）。
- 真机复测（同一 §11 harness + trace）：

| 轮次 | 延迟 | VFS ops | sidecar | 合计 IPC | transaction | getMetaExt | getRecordField |
|---|---|---|---|---|---|---|---|
| 第五轮基线 | 16.47s | 845 | 3257 | **4102** | 1011 | 829 | 1187 |
| 第六轮（journal） | 12.35s | 733 | 2038 | 2771 | 896 | 710 | 184 |
| 第七轮（只读不事务） | 9.31s | 653 | 1106 | 1759 | 100 | 626 | 163 |
| 第八轮（能力检查免元数据） | **5.66s** | **114** | **504** | **618** | 81 | 108 | 142 |

三轮合计：延迟 **−66%**（16.47s→5.66s），计数 IPC **−85%**（4102→618），VFS ops **−87%**（845→114）。注意 `noLinks` 的每次前缀检查在桌面端还伴随一次 Tauri `plugin-fs` 的 `fs_stat`（两套计量都不统计它），故真实收益大于表中数字。证据：`.tauri-acceptance/round70-*`…`round73-*`。

### 14.4 边界

仍高于「≤2s / ≤100 次」。剩余：`getRecordField` 142、`getMetaExt` 108、`listRecordFields` 97、`transaction` 81、`setRecordField` 69——已是 SeqFile 记录读写的必要往返与发送路径自身的写次数。要再接近阈值需要批量读取 SeqFile 条目（一次 IPC 取多字段）或减少发送路径的写入次数/轮询频率，这是下一轮的方向。

### 14.5 顺带修复：并发写同一路径的临时文件竞态（真实缺陷）

§14 的时序变化让 `ui/app-shell/tests/vfs-chat.test.ts`「lists independent Sessions after title changes」（`Promise.all` 并发 `createSession`）**稳定失败**：

```
[EIO] createFile: Source operation failed: createFile
Caused by: ENOENT: rename '.../folders.seq.<pid>.tmp' -> '.../folders.seq'
```

根因不在 `noLinks`：`NodeFsOps.writeFile` 的原子写临时名是 `${p}.${process.pid}.tmp`，**不含唯一后缀**；对同一路径的两次并发写会共用同一个临时文件——先完成者 rename 后，另一个再 rename 该临时文件即 `ENOENT`。`apps/tauri-app/src-tauri/src/lib.rs` 的 Rust `fs_write_file` 同样有问题，且 `p.with_extension(format!("tmp.{}", pid))` 还会**替换真实扩展名**（`folders.seq` → `folders.tmp.<pid>`）。

修复：两处临时名都追加进程内单调序号（Node：`${p}.${pid}.${++seq}.tmp`；Rust：在 `as_os_str()` 后追加 `.{pid}.{seq}.tmp`，保留原文件名）。

验证：新增 `25-journal-probe.test.ts`「survives concurrent writes to the same path without sharing a temp file」（24 次并发写同一路径）——**未修复时以同样的 `ENOENT … .tmp` 失败**，修复后通过，且目录里不残留 `.tmp`；`vfs-chat.test.ts` 连跑 3 次全部通过。localfs 61→**62**，`pnpm --filter tauri-app test:rust` 15 通过（Rust 侧编译并通过）。这是本轮优化暴露出的**既有缺陷**，与元数据优化本身无关。

## 15. 能力检查扩展到嵌套视图 + 剩余热点量化（2026-09-11 第七十四轮）

### 15.1 一致性修复：view 级 driver 也暴露 `getNodeType`

§14 让前缀能力检查改用 `getNodeType`（免元数据），但 `FileSystemView.makeDriver()` 生成的 view 级 driver 没有暴露该方法；嵌套挂载（view-of-view）在 `noLinks` 里仍退回 `getNode`（带元数据）。

修复：`makeDriver()` 暴露 `getNodeType`，指向新的私有 `statType(path)`——先按 `stat` 的语义做 `noLinks` 校验（挂载边界与 link/device 判定不变），再优先用内层 driver 的 `getNodeType`，缺失才退回 `getNode`。视图嵌套是有限深度，不会递归。

验证：`25-journal-probe.test.ts` 新增「keeps a nested view prefix walk metadata-free」——外层视图读 `/nv/a/b/file.md`，sidecar `getMetaExt` ≤2；**删掉 view 级 `getNodeType` 时该断言失败（实测 6）**。vfs-core 173、localfs 63、app-shell 133 通过。

### 15.2 真机复测：无实质变化

同一 harness + trace：**5.66s → 5.79s（噪声内）**。说明当前发送热路径上的挂载多数是 DirectoryFS 直挂，嵌套层不是瓶颈；该修复的价值在于「嵌套视图不再偷偷取元数据」的一致性，而非性能。

### 15.3 新量化：前缀走查本身成为主因（且未被现有计量覆盖）

给探针 `.tauri-acceptance/probe-send-attrib.mts` 增加 `statType` 计数后，一次发送：

```
backend.stat（会取元数据） = 169
backend.statType（前缀能力检查，免元数据） = 909
```

`statType` 在桌面端每次是一次 `fs_stat` Tauri IPC，且**既不计入 `ioStats` 也不计入 `sidecarStats`**。也就是说，经 §12–§14 三轮把「SQL 事务 / journal / 元数据」逐一去掉后，**剩下 ~5.8s 的主因已经是前缀走查本身的 909 次 IPC**，而不是元数据或 SQL。

### 15.4 下一步与延后理由

把前缀走查批量成一次宿主调用（Rust `fs_stat_many` + `backend.statTypes`）预计可把 ~909 次 IPC 降到 ~160 次。本轮实现了该批量层并跑通单测，但发现**批量化必须保留每个内层视图自己的挂载边界校验**：外层 `noLinks` 若用一次批量调用替内层视图跳过它自身的 `noLinks`，就会放宽 view-of-view 的边界语义。这需要先确定「按挂载分组 → 每组一次批量校验 → 按请求顺序回填类型」的精确语义，属于安全边界设计，不宜在未定论时合入。**本轮因此撤回批量实现（接口与 Rust 命令均已移除），只保留 view 级 `getNodeType` 这一无争议的扩展**，并把「批量前缀校验」记为下一轮的待决策项。

## 16. 发送路径优化第四步：前缀走查合并为一次宿主调用（2026-09-11 第七十五轮）

### 16.1 设计（不改校验语义，只合并底层 I/O）

§15 的批量尝试被撤回，因为它改变了 `noLinks` 的逐段语义（可能替内层视图跳过其边界校验）。本轮的思路是**保持每个前缀照常校验，只把底层同 tick 的 stat 合并成一次宿主调用**：

1. `FileSystemView.noLinks`：对同一路径的各前缀**并发**发起 `getNodeType`（仍在同一函数内按前缀顺序判定；类型规则、内层视图各自的 `noLinks`、挂载边界全部照常），再统一校验；
2. `LocalFSBackend.statType`：新增**微批处理**——同一事件循环 tick 内的 `statType` 请求进入同一批，flush 时调用一次 `IFsOps.statMany`；
3. `IFsOps.statMany`：`NodeFsOps` 用 `Promise.all`（本地无 IPC）；桌面 `TauriFsOps` 走新的 Rust 命令 **`fs_stat_many`**（一次 IPC 返回多个 `Option<FsStatResult>`，逐个仍走 `is_allowed`）。

因此 link/device 拒绝与挂载边界校验**逐段保留**，只是把 N 次 `fs_stat` IPC 合并为 1 次。

### 16.2 验证

- `25-journal-probe.test.ts` 新增「coalesces a path-prefix walk into one batched stat call」：断言至少一次 `statMany` 调用携带 ≥2 个路径；**去掉批处理时该断言失败（实测 0）**。localfs 63→**64**。
- vfs-core 173、app-shell 133、`pnpm --filter tauri-app test:rust` 15 通过。
- 真机复测（同一 §11 harness + trace）：

| 轮次 | 延迟 | VFS ops | sidecar | 合计计数 IPC |
|---|---|---|---|---|
| 第五轮基线 | 16.47s | 845 | 3257 | 4102 |
| 第七轮（只读不事务） | 9.31s | 653 | 1106 | 1759 |
| 第八轮（前缀免元数据） | 5.66s | 114 | 504 | 618 |
| 第七十五轮（前缀合并 IPC） | **4.21s** | 112 | 472 | **584** |

延迟 **5.66s → 4.21s**，而计数通道几乎不变（618→584）——收益完全来自 §15.3 指出的、**此前未被任何计量统计的前缀 `fs_stat` 走查**，反过来印证了那次归因。累计（第五轮基线→本轮）：延迟 **16.47s → 4.21s（−74%）**，计数 IPC **4102 → 584（−86%）**。

### 16.3 边界

仍未达到「≤2s / ≤100 次」：4.21s / 584 次。剩余 `getRecordField` 131、`getMetaExt` 107、`listRecordFields` 91、`transaction` 76、`setRecordField` 61——已是 SeqFile 记录读写与发送路径自身的写入。下一步方向：批量读取 SeqFile 条目（一次 IPC 取多字段）与减少发送路径的写入/轮询频率。

### 16.4 附带修复：CLI 用例的即时状态断言改为等待持久条件

并发前缀检查让内核第一次 poll tick 变慢：`submit` 返回后任务短暂仍是 `ready`，下一次 tick 才转 `waiting`。`apps/cli/tests/session-delete-localfs.test.ts`「refuses to remove a Session with a live Task and deletes it after close」原先在 `submit` 之后**立即**断言 `status === 'waiting'`，因此确定性地失败。

核实：加 300ms 等待后状态确为 `waiting`，且该用例的后续语义（有活任务时拒删、关闭后删除、task 查询 `SESSION_NOT_FOUND`）全部成立——即**产品行为正确，是测试对异步 poll 的时序假设**。按仓库既有做法（例如第五十七/六十一轮把「任务终态」改为「持久条件」）把断言改为 `vi.waitFor` 等待持久状态，连跑 3 次通过。这不是产品缺陷，也不改变上面 §16.2 的性能结论。

## 17. 真实窗口的 Bash 工具链路：广告→派发已通，目录授权前拒绝（2026-09-11 第七十六轮）

§9–§16 一直在驱动聊天视图；本轮改问 P0-01 的另一半——**真实窗口里模型能否调用 Bash**。方法：在隔离数据根预置一个 `default.agent`，把工具声明放到**顶层** `capabilityPolicy.toolIds = ["Bash"]`，mock 第一轮返回 `Bash` 的 tool_call（`echo real-window-bash`），第二轮回传工具结果。

### 17.1 观测到的证据（当前树，真实窗口）

- **工具被广告给模型**：mock 记录 `{"tools":["Bash"],"toolResults":0}`——桌面宿主确实把 Bash 放进模型请求的工具列表。
- **工具调用被解析并派发**：UI 文本树出现工具节点 `🔧 Bash / RUNNING`，参数与模型发出的完全一致：`{"command": "echo real-window-bash", "timeout_ms": 30000}`。
- **执行被拒绝，但拒绝原因明确**：结果为 `FAILED`，错误文本 `Invalid Session Bash path`。

### 17.2 拒绝是设计行为，但文案不够清楚（已改）

该错误来自 Rust `session_bash::validate_target(cwd)`：本会话没有挂载任何宿主目录，因此 cwd 是 `/`，而 `/` 不是合法的 bwrap 目标（它会与只读挂载的 `/usr`、`/proc` 等冲突）。`command()` 里其实还有一条更贴切的守卫 `Bash cwd has no Session directory grant`，只是 `validate_target(cwd)` 先触发，导致用户/模型看到的是泛化的路径校验错误。

改动（`apps/tauri-app/src-tauri/src/session_bash.rs`）：当 `mounts` 为空时直接返回 **`Session Bash requires a mounted Session directory; mount one before running commands`**，其余校验顺序不变。新增 Rust 用例 `a_session_without_a_mount_explains_how_to_enable_bash`；`pnpm --filter tauri-app test:rust` 15→**16** 通过。

### 17.3 记录一个非显然契约：`capabilityPolicy` 在顶层

第一次预置时把它写在 `config.capabilityPolicy`，模型请求里 `tools: []`（工具静默缺失）；`AgentResolver.buildConfig` 读的是 **`agentDef.capabilityPolicy`（顶层）**，不是 `agentDef.config.capabilityPolicy`。已写入 [llm-session AGENTS](../backend/llm-session/AGENTS.md)。同类「配了却没生效」的静默失败值得后续加一条校验。

### 17.4 未完成与障碍

- **目录挂载未通过自动化建立**：`Mount directory…` 打开的是原生 GTK 选择器；在 Xvfb（无窗口管理器）下 `Ctrl+L` 输入路径后 Enter 进入了「搜索」态、`Open` 的 DoAction 也未完成选择，因此**没有拿到带挂载的会话**，也就没有跑出 Bash 的真实成功输出。会话内的 `📁+` 只是 VFS 新建目录，不是宿主目录挂载。
- **因此本轮不宣称 P0-01 链路在真实窗口复验通过**：已证的是「Bash 被广告 + tool_call 被解析派发 + 无授权时按设计拒绝（文案已改进）」；缺的是「挂载目录 → bash 真实执行 → 回传 stdout/exit code」。

下一步选项：① 用应用内的「挂载」对话框（`aria-label='来源目录'` + 「挂载」按钮）而不是原生 GTK 选择器；② 给 `xsend` 增加更完整的 GTK 选择器导航（Ctrl+L 后按 Return 需要先退出搜索态）；③ 直接预置会话挂载记录（需要先摸清其持久化位置）。

## 18. 真实窗口 Bash 成功执行：预置授权会话贯通 P0-01 后半（2026-09-11 第七十七轮）

§17 的障碍是「会话拿不到宿主目录授权」。本轮采用 §17.4 的第 ③ 条选项——**用当前树代码直接写入会话的授权记录**，再在真实窗口里发送，从而把 §17 缺的「授权目录 → Bash 真实执行 → stdout/exit code 回传」补上。

### 18.1 方法：用产品自身的持久化入口预置带授权的会话

一次性脚本 `.tauri-acceptance/seed-session.mts`（`.tauri-acceptance/` 已 gitignore）走的是与宿主相同的代码路径，而不是手改 SQLite：

```ts
const backend = await openLocalFSBackend({ rootDir, sidecarDir: `${rootDir}/_meta`, createDb: NodeSqliteSidecarDb.open });
const { manager } = await createVFS({ rootBackend: backend });
const fs = await manager.openFileSystem('/');
const repository = new SessionRepository(fs); await repository.init();
const id = await repository.createSession('seeded');
const files = new SessionFilesService(fs, () => []); await files.initialize();
files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
await files.configure(id, { mounts: [{ mountId: 'seed', at: '/workspace', sourceId: 'admin-home', root: '/', access: 'rw' }], cwd: '/workspace' }, 0);
```

`.tauri-acceptance/gui-session-bash.sh` 在启动应用**之前**运行该脚本，并把返回的 `sessionId` 写入 `gui-env.sh` 供后续步骤使用。授权因此来自产品自己的 `SessionFilesService.configure`（写入 `session.seq` 的 `files` 记录：`mounts` + `cwd`）、来源注册与 Session 装配路径，唯一被跳过的是 GUI 里「选中目录」这一动作。会话打开与发送仍全部经真实窗口、真实 Tauri IPC。

### 18.2 证据（当前树，真实窗口 + 真实 IPC + 真实 bwrap）

- **工具被广告、结果被回传**：mock 记录两轮——`{"tools":["Bash"],"toolResults":0}`（18:06:43.172）→ `{"tools":["Bash"],"toolResults":1}`（18:06:45.705），第二轮即携带真实工具结果。
- **界面显示真实执行输出**：a11y 文本树出现 `🔧 Bash` 工具节点、模型参数 `{"command": "echo real-window-bash", "timeout_ms": 30000}`，工具结果 `[exit 0] real-window-bash`，助手最终文本 `BASH-ROUND-DONE\n[exit 0]\nreal-window-bash`。
- **第二轮换用更强的命令复验边界**（同一个预置会话，18:07:59.649 → 18:08:01.969，两轮间隔 2.32s，含真实 `bash` 执行）：
  - 命令：`pwd; echo real-window-bash; test -w . && echo WORKSPACE-WRITABLE; test -w /app && echo APP-WRITABLE || echo APP-READ-ONLY`
  - 结果：`[exit 0] /workspace real-window-bash WORKSPACE-WRITABLE APP-READ-ONLY`
  - 即：**cwd 就是会话记录的 `/workspace`**（`--chdir` 生效）、**授权目录可写**、**仓库挂载 `/app` 只读**——与 §P0-04 的 bwrap 授权边界一致，且这是界面里取到的，不是 Rust 单测。
- **持久记录一致**：Session `node-1789149877707-ny8av9w3o` 的 `kernel/index.seq` 有 2 个 Task，均为 `{"status":"succeeded"}`（`task_46010e5b-11f7-4908-9f07-f40c3c78a1e8`、`task_9e5ed429-12a2-44f4-b68e-8d68f8a7d8b2`）；`session.seq` 的 `files` 记录保持 `revision: 1` 与预置的 mount+cwd；会话标题仍为 `seeded`。
- **截图**：`.tauri-acceptance/round77-real-window-bash.png`（`xwd` → `xwd2ascii.mjs`）。

### 18.3 结论与边界

P0-01 的后半段——**外层 harness → `tool.call` Effect → 真实 Bash（bwrap）→ stdout/退出码 → 第二轮模型请求 → Task succeeded**——已在**当前工作树 + 真实窗口**取得端到端证据，不再只依赖旧树 `d883a497` 的记录（§3）。但以下边界必须保留：

- **授权是预置的，不是 GUI 建立的**：GUI 挂载对话框/原生 GTK 选择器仍未走通（§17.4），所以 P0-04 的「GUI 人工验收」与 P0-03 的「凭证注入 UI」状态不变。
- 场景面窄：单会话、单命令、本地 mock Provider；未覆盖取消/超时/并发/崩溃（这些在 CLI 侧另有证据）。
- 只验成功路径（`[exit 0]`）；非 0 退出码由第六十一轮的 CLI 子进程用例覆盖。
- **a11y 读法（避免误判缺陷）**：AT-SPI 里输入框的 **Name 是 placeholder**，真实值要用 `Text.GetText` 读——标题输入框 Name 显示 `Untitled Chat`，实测其值为 `seeded`（与 `manifest.title` 一致），**不是**「会话标题未加载」缺陷；聊天输入框同理（Name 是 `Message...`）。本轮的两次发送都是先用 `xsend focus` + `GrabFocus` 取得焦点、再合成按键输入，最后读回文本确认。

## 19. 提交驱动的冗余资源扫描 + CLI 取消投影竞态（2026-09-11 第七十八轮）

第七十五轮后发送路径剩余 ~584 次 IPC 的归因缺少 sidecar 侧的调用点。本轮先补这个探针，再修掉其中一块明确的冗余工作，并顺带修掉一个使整仓矩阵确定性失败的 CLI 缺陷。

### 19.1 新探针：sidecar 调用点归因

`.tauri-acceptance/probe-sidecar-attrib.mts` 在无界面 `createApplicationRuntime`（LocalFS + `NodeSqliteSidecarDb`）里包一层原始 SQLite 句柄，按 **操作名 + 参数 + 调用栈** 聚合一次发送（`sendMessage` → Task 收敛 → 静置 6s）期间的每一次 sidecar 调用（桌面端每次都是 1 次 Tauri IPC）。首次运行的结论：

- 热点不是零散的字段读，而是**会话 `resources.seq` 被反复全量遍历**：`listRecordFields` 落在 `resources.seq` 上 99 次，前缀分布 `managed/request/` 65、`managed/cleanup/` 44，另有 `managed/resource/` 若干。
- 这些遍历来自 `ManagedResourceStore.sweep`：`application/kernel.ts` 的会话 `seq:committed` 监听器对**会话根下任意提交**都执行 `resourcePoller.start('session:<id>')`，而 `sweepResourceTx` 每次都要遍历 `managed/request/`、`managed/cleanup/`（`settleLifecycleTx` 还要遍历 `managed/resource/`）并开一个写事务。一次发送会产生大量 Task/Effect/事件提交，于是每次提交都换来一次与资源无关的全量扫描。

### 19.2 修复：只在该会话的 `resources.seq` 被提交时清扫

`rememberBinding` 的监听器现在与第六十七轮的 catalog 过滤同一手法：只有提交路径等于 `resourcesPath(binding.rootPath)` 时才 `resourcePoller.start('session:<id>')`。通知 UI（`notify`）与调度（`schedulePoll`）行为不变。

**回归**：`backend/durable-kernel/src/kernel.test.ts` 新增「sweeps Session managed resources only for resources.seq commits, not for other Session records」——写 `session.seq` 必须**不**重启资源清扫，写 `resources.seq` 必须重启。去掉过滤时该用例失败（`after unrelated commit: expected [ 'session:session-one' ] to deeply equal []`），修复后通过；durable-kernel **201→202**。

**探针 A/B**（同一无界面场景，修复前 → 修复后）：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 会话 `resources.seq` 遍历次数（按前缀合计） | 109（request 65 / cleanup 44 / resource 8） | 50（request 25 / cleanup 17 / resource 8） |
| sidecar 调用总数（含 6s 静置） | 1906 | 1808 |
| `begin` / `commit`（写事务） | 132 / 132 | 118 / 118 |

**真机复测（trace 构建 + Xvfb 真实窗口 + 预置会话，同一 `Send → Provider 收到` 口径）**：**4.38s / 4.44s**（两次，第二次为热态），窗口内 VFS ≈100 + sidecar ≈490 ≈ **590 次 IPC**。与第七十五轮的 **4.21s / 584 次**在噪声内没有差别。

**结论（诚实边界）**：这次修复消除的是**随提交数增长**的冗余全量扫描（每个会话提交一次 `resources.seq` 读 + 写事务），属于可扩展性问题；它**没有**改变单次发送窗口的成本，P0-02 的「≤2s / ≤100 次」仍未达成。剩余热点仍是分散的字段级读写（`getRecordField`/`getMetaExt`/`listRecordFields`/写事务），需要按「同一事务内按路径合并字段读」的方向另做设计。

### 19.3 顺带修复：CLI 取消后的终态投影竞态（真实缺陷）

`apps/cli/tests/run-control.test.ts` 的「cancels the Run and stops the in-flight request on SIGINT」在当前树**确定性失败**：已 `cancelled` 的 Run manifest 里 `taskStatuses.finish === 'waiting'`。回退 19.2 的内核改动后同样失败，故与本轮优化无关——是既有竞态。

- **根因**：`cancelInterrupted` 调 `root.cancel(...)` 只表示**取消请求被接受**，子 Task 的取消决策随后才由内核提交；`projectTerminalStatuses` 只列一次任务表就落盘，于是偶尔/稳定地把 `waiting` 写进终态 Run。
- **修复**（`apps/cli/src/commands.ts`）：`projectTerminalStatuses` 变为**有界轮询**——每 25ms 重列并投影，直到所有带 `flowNodeId` 的 Task 都终态，或到达 `PROJECTION_SETTLE_MS = 2000` 上限再落盘；`enforceTaskTimeout` 复用同一终态判定（`isTerminalTaskStatus`）。上限保证「设备始终不确认停止」时不会挂住退出路径，退出码语义不变。
- **验证**：该用例修复前 3/3 失败、修复后 3/3 通过；`pnpm --filter @itookit/cli typecheck` 通过；整仓 `pnpm test` → `=== full matrix passed`（durable-kernel 202、CLI 88 非 crash-matrix + 6 crash-matrix、Rust 16）。

### 19.4 边界

- 真机数据是单会话、单次发送、本地 mock；`4.38s/4.44s` 与 `4.21s` 的差异不足以声称改进或回退。
- 内核过滤只改变「何时触发清扫」；托管资源自身的语义（请求、清理、authority）未动，`resources.test.ts` 35 条与 `protocol.test.ts` 全绿。
- CLI 投影修复覆盖的是「取消后落盘」这条路径；其它终态落盘（超时、失败）走同一函数，行为一致。

## 20. GUI 建立的目录授权 + 真实 Bash 执行（2026-09-11 第七十九轮）

§17/§18 留下的边界是「授权是预置的，不是 GUI 建立的」。本轮把这条补上：**授权完全由应用内对话框创建**，随后在同一会话里用 Bash 工具跑出真实输出。

### 20.1 路径：会话 Files 视图 → 应用内挂载对话框

§17.4 当时走的是导航栏的 `Mount directory…`（那是 `openDirectoryDialog()` + `LocalMountService`，挂的是**全局工作区导航**），以及会话内的原生 GTK 选择器。真正的**会话目录授权**对话框在另一处：`SessionWorkbench` 在「会话的 `files` 视图」里渲染 `挂载目录 / 管理挂载` 按钮 → `manageMounts()` → `showMountDialog()`（`ui/app-shell/src/files/mount-dialog.ts`）。本轮就是走这条：

1. 预置一个**没有任何授权**的会话（`.tauri-acceptance/seed-plain-session.mts` 只做 `SessionRepository.createSession`）。
2. 真实窗口：`AI Sessions` → 展开会话节点 → 点 `files` 子项 → 面板显示「尚未挂载工作目录，此会话仅能访问附件」→ 点 `挂载目录 / 管理挂载`。
3. 对话框里：`来源目录` 输入宿主目录（`$HOSTDIR`，内含 `hello.txt`）、`会话路径` 输入 `/workspace`、勾选 `设为工作目录`、点 `挂载`。
4. 面板回显 `已挂载 /home/.../hostdir → /workspace（可读写）`，且列出 `← ... · 可读写 · 工作目录`。

注意对话框的输入框**没有** `EditableText` 接口（`a11y.py type` 会报 `No such interface`），仍用「几何点击 + `xsend text` + `Text.GetText` 读回」验证输入内容（`来源目录`、`会话路径` 都读回过）。

### 20.2 持久证据

授权落进了会话自己的记录（`session.seq` 的 `files` 字段，由 GUI 写入）：

```
{"revision":1,"state":"active","mounts":[{"mountId":"0d88c0aa-…","at":"/workspace",
  "sourceId":"directory-cd890dd2-…","root":"/","access":"rw"}],"cwd":"/workspace"}
```

### 20.3 同一个 GUI 授权会话里的 Bash 执行

在该会话（已回到聊天视图）发送消息，mock 记录两轮 `{"tools":["Bash"],"toolResults":0}` → `{"tools":["Bash"],"toolResults":1}`（间隔 2.07s）；界面显示工具节点与结果：

```
[exit 0] /workspace
real-window-bash
WORKSPACE-WRITABLE
APP-READ-ONLY
```

即 **cwd = GUI 挂载时勾选的 `/workspace`**、授权目录可写、仓库挂载 `/app` 只读；该会话的 `kernel/index.seq` 记录 `task_84eabd61-…` `{"status":"succeeded"}`。截图 `.tauri-acceptance/round79-gui-mount-bash.png`。

### 20.4 结论与仍缺的部分

- **P0-01 的真机链路现在有「GUI 建授权」的完整证据**：建会话（无授权）→ GUI 挂载目录并设为工作目录 → GUI 发送 → Bash 真实执行 → 输出/退出码 → 第二轮模型请求 → Task succeeded。§18 的「授权是预置的」这条边界**对应用内对话框路径已经关闭**。
- 仍未验收：原生 GTK 选择器（`选择宿主目录…`，即 §17.4 的障碍）没有被驱动，本轮是**直接输入路径**（对话框自身提示「也可输入应用内目录」，属产品支持的路径）；P0-03 的凭证注入 UI、P0-04 的其它平台/网络隔离仍未验收。
- 场景仍是单会话、单命令、成功路径、本地 mock。

## 21. 真实 Tauri 宿主的项目规则 + Skill 装配（P0-00 桌面半边，2026-09-11 第八十轮）

P0-00 缺的是「真实 Tauri 入口」这一半：CLI 半边与 app-shell 装配（无界面）已有证据。本轮用 §20 打通的应用内挂载把宿主目录（含项目规则与 Skill）挂进会话，然后**直接检查应用真实发出的模型请求体**。

### 21.1 场景

- 宿主目录 `proj/` 内含：`_agent/AGENT.md` = `Always cite the interface contract.`；`_agent/skills/review/SKILL.md`（frontmatter `name: Review` / `description: Review changes`，正文 `Check every changed interface.`，`## Compact Instructions` 里有 `- [红线] Preserve access checks.` 与 `- Background note.`）。
- 真实窗口：无授权会话 → `files` 视图 → 应用内挂载对话框把 `proj/` 挂到 `/workspace` 并勾选 `设为工作目录`（即 §20 的 GUI 授权路径）。
- mock（`.tauri-acceptance/mock-record.mjs`）把**每个请求体原样落盘**，供逐字断言。

### 21.2 首次运行（触发 Skill）

发送 `Review the interface change`，落盘的请求 messages 恰为：

```
system  You are a helpful assistant.
system  Always cite the interface contract.
system  Skill review:
        Check every changed interface.

        Skill review — critical rules:
        [Review]
          - Preserve access checks.
user    Review the interface change
```

即：项目规则来自挂载目录的 `_agent/AGENT.md`；Skill 正文进入上下文；`## Compact Instructions` 只把 `[红线]` 条目作为 critical rules，`Background note.` **没有**进入请求（与 CLI 半边 `run-skill-context.test.ts` 的契约一致）。会话 shared 记录 `kernel-adapters.skills.loaded = ["review"]`（version 1），Task `succeeded`。证据：`.tauri-acceptance/round80-skill-context-request.log`、`round80-real-window-skill-context.png`。

### 21.3 宿主重开后再运行

关掉应用进程、用**同一数据根**重新启动（真正的宿主重启；会话的 mount/cwd 从持久记录恢复，无需再挂载）。此时发送一条**不匹配**触发词的消息 `plain hello only`（请求里最后一条 user 消息不含 `review`），落盘的请求仍含项目规则、Skill 正文与 `[Review] - Preserve access checks.`。证据：`.tauri-acceptance/round80b-restart-skill-context.log`（3 条请求依次为：匹配触发、重启后草稿续写、`plain hello only`）。

**但这条证据不能单独证明「按持久身份恢复」**：`SKILL.md` 没有写 `trigger-strategy`，按 [skill-design](design/skill-design.md) 第 108 行它是 `reference` → `autoLoad = true`，因此**任何**新运行都会自动加载它（`loadAutomaticSkills` 的 `autoLoad || matched` 条件）。本轮如实记录为：真实窗口下「不匹配的消息仍获得 Skill 正文与关键规则」成立，但其成因是 autoLoad，而不是本次实验区分的持久身份恢复。

严格区分「持久身份恢复」与「autoLoad / 重新匹配」的语义仍只有包级证据（`backend/kernel-adapters/src/skill/session-skill-restore.test.ts`：`autoLoad: false` 的定义在不再匹配的新作用域实例里仍被恢复；显式 unload 后不再恢复；再次匹配可重新加载——unload 不是永久禁用）。

### 21.4 同轮核对到的一条设计与代码一致性（不是缺陷）

真实窗口里尝试用聊天输入区的 Skill 面板加载一个 `trigger-strategy: action` 的 skill 时，勾选框点了没有反应。核对 [skill-design](design/skill-design.md) 第 136 行：**「disabled、disableModelInvocation 和 triggerStrategy=action 的未加载项禁用勾选，已加载项仍可卸载」**——即 action skill 的**未加载**状态本来就不可从面板勾选，属设计行为。加载 action skill 的入口是 `/sk-<id>`（或 `load_skill` 工具），而 `SlashCommandPlugin` 的 skill 命令在 `cb.onSkill` 缺失（未启用 Agent Mode）时只给提示不执行；本轮 harness 没有驱动到 Agent Mode 开关，因此**没有**在真实窗口取到 action skill 的「加载 → 重开宿主 → 身份恢复 → 卸载 → 不再复活」闭环。

### 21.5 结论与仍未完成

- **已取证（真实 Tauri 入口）**：GUI 授权挂载的项目目录，其 `_agent/AGENT.md` 项目规则、Skill 正文与 `[红线]` 关键规则确实进入**应用真实发出的模型请求**（非循环 compact 不进入）；加载身份持久为 `kernel-adapters.skills.loaded = ["review"]`；宿主重启且消息不匹配时 Skill 仍在上下文（成因按 §21.3 记录为 autoLoad）。
- **仍未完成**：action skill 在真实窗口的加载/卸载闭环（需要 Agent Mode + `/sk-<id>`，或先解决合成输入驱动斜杠弹窗）；项目规则在**多挂载层级**（parent-fs/local-fs）的取舍；以及 P0-00 原有的「卸载后再运行」在真实窗口的严格验证。
- 以上三项已于 2026-09-13 收口或明确边界，见 §71。
- 场景仍是单会话、本地 mock、单层挂载。
- 场景仍是单会话、本地 mock、单层挂载。

## 22. 真实窗口的 Skill 斜杠命令：`/sk-<id>` 手动词令（2026-09-11 第八十一轮）

§21 遗留的「action skill 在真实窗口无法加载/调用」本轮查清并修好：它不是一个入口没找到，而是**三个缺陷叠在一起**。

### 22.1 找到的缺口

1. **斜杠命令从未接线**：`doc/design/skill-design.md:130` 写明 SlashCommandPlugin 为 Skill 提供 `/sk-<id>`，但 `buildSlashCallbacks`（`ui/llm-ui/src/shell/SlashCommandRouter.ts`）从未注入 `getSkills`/`onSkill`/`onSkills`/`onSkillInvoke`。后果：`/skill`、`/skills` 永远只显示「requires Agent Mode」提示，`/sk-<id>` 从不出现；而 Skill 面板对**未加载**的 action/silent 项按设计禁用勾选（skill-design:136），于是这类 Skill 在 UI 里没有任何入口。
2. **两种「enabled」被混用**：`SessionSkillControls.list` 的 `enabled` 字段含义是「面板复选框可否加载」（排除 disabled/静默/action），而 `/sk-<id>` 恰恰是为 action/silent 的**显式调用**准备的。用它过滤 `/sk-<id>` 会把该命令唯一的目标排除掉。现拆出 `definitionEnabled`（定义层启用），`/sk-<id>` 按它过滤。
3. **发送类斜杠命令捕获到 `undefined`**：`LLMWorkspaceEditor` 在 `initComponents()`（内部 `registerInputPlugins()`）构建回调，而 `this.sendCommand` 要到随后的 `initCommands()` 才创建，于是 deps 里的 `sendCommand` 是 `undefined`——**`/btw` 与新的 `/sk-<id>` 都会静默失败**（输入被清空、没有模型请求、没有消息、Toast 不可见于 AT-SPI）。改为惰性 provider `sendCommand: () => SendMessageCommand`。

### 22.2 实现

- `SlashCommandRouter` 新增 `SlashSkillCommands`（`snapshot` / `load` / `describe` / `openPanel` / `refresh`）并注入 `getSkills`、`onSkillPickerOpen`、`onSkill`、`onSkills`、`onSkillInvoke`；编辑器用 `bindSkillRefresh` 维护同步快照，弹面板前触发一次刷新（弹窗 items 只在首次显示时构建）。
- `onSkillInvoke`：模型上下文可加载的 Skill → `load` + `buildSkillPrompt`；action/silent/disabled → `buildActionSkillMessage` 把正文**内联进用户消息**，且**不调用 `load`**（`SessionSkillControls.load` 对这类定义会以 `cannot be loaded` 拒绝，这是模型上下文闸门的设计行为）。
- `SessionSkillControls` 新增 `describe(sessionId, skillId)`（tools/contracts 契约 + kernel-adapters 实现）提供定义名/类型/正文/触发策略，供上面分支判断。
- `PopupPanel`：无匹配项时不再吞掉 Enter——否则 `hasArgs` 类命令（`/sk-<id>`、`/skill`）在弹窗打开时永远发不出去。

### 22.3 真机证据（真实窗口 + 真实 IPC，GUI 挂载的项目目录）

- `/btw pre-fix-probe`（修复前）：输入被清空、**0** 次模型请求、界面无该消息 → 复现第 3 条缺陷。
- `/sk-review check the interface`（修复后）：**1** 次模型请求，messages 为
  - `system` agent 提示
  - `system` 项目规则 `Always cite the interface contract.`
  - `system` 技能索引 `Available skills (load explicitly when needed): {"skills":[{"id":"review",…}]}`
  - `user` **`[Action: review]

Check every changed interface.

Task: check the interface`**

  且会话 shared 的 `kernel-adapters.skills.loaded` **没有变化**（action Skill 按设计不进入持久加载身份）。
- `/btw post-fix-probe`（修复后）：正常发送（模型请求第 2 条 user 消息为 `post-fix-probe`），界面出现该消息。
- 证据：`.tauri-acceptance/round81-action-skill-invoke.log`、`round81-action-skill-invoke.png`。

### 22.4 回归测试

- `ui/llm-ui/src/shell/slash-skill-commands.test.ts`（新增，3 条）：未注入 controls 时无 Skill 命令；注入后 `getSkills`/`onSkill`/`onSkills`/`onSkillPickerOpen` 生效且 reference 路径 load + `buildSkillPrompt`；action 路径**不 load**、发送 `[Action: …]`；`sendCommand` 惰性解析（回调先建、命令后创建仍能发送）。llm-ui 19→**23**。
- `ui/app-shell/tests/slash-skill-invocation.test.ts`（新增 jsdom 集成）：真实 `ChatInput` + `SlashCommandPlugin` + `buildSlashCallbacks`，`plugin.onBeforeSend('/sk-review check it')` 必须返回 `false` 并发出内联 action 消息、且不调用 `load`。app-shell 133→**134**（+30 跳过）。
- [kernel-adapters 的 session-skill-controls.test](../backend/kernel-adapters/src/skill/session-skill-controls.test.ts) 新增 `describe` 用例。kernel-adapters 95→**96**。
- 整仓 `pnpm test` → `=== full matrix passed`。

### 22.5 仍未完成

- **reference Skill 的「加载 → 重开宿主 → 身份恢复 → 卸载 → 不复活」闭环仍只有包级证据**：本轮走的 action 路径按设计不产生持久加载身份；而 reference 技能 `autoLoad=true`，显式 unload 后**下一轮会自动重新加载**（skill-design:132/136 的既定语义，不是缺陷）。要在真实窗口区分「持久身份恢复」与「autoLoad」，需要一个 `autoLoad=false` 且可加载的定义，当前文件系统来源无法表达。
- `/sk-<id>` 的 `@file`/glob 参数与 `--key value` 走既有 parser，本轮未在真实窗口覆盖。
- 上条 reference Skill 的严格闭环已于 2026-09-13 用 `auto-load: false` 定义在真实窗口取到，见 §71。

## 23. 真实窗口的取消闭环与重开一致性（2026-09-11 第八十二轮）

P0-02 一直缺「取消/失败时应用层 UI 与持久状态一致」的真机证据。本轮用一个**永不结束的 mock**（`.tauri-acceptance/mock-hang.mjs`：接受请求、发一个 chunk、保持连接）在真实窗口里点 `Stop Generation`，并把同一次运行在**宿主重启前后**做对照。

### 23.1 现场证据（live）

- mock：`{"request":true,"stream":true}` → 点 Stop 后 `{"responseClosed":true,"writableEnded":false}`——**在途的 provider 请求被客户端真正中断**（不是只改界面状态）。
- 界面：助手节点 `ABORTED`、状态行 `Error`、错误行 `⚠️ 执行失败` 与 `Task cancelled: task_0caa7eb7-…`。
- 持久：会话内核 `kernel/index.seq` 的 Task 为 `{"status":"cancelled"}`。

### 23.2 发现的不一致：重开后取消轮次变成「无说明的空气泡」

同一轮在宿主用同一数据根重启后，只渲染出 `🤖 Assistant`（无状态、无原因）。逐层核对到五处不同步：

1. `round-graph-service.setConversationStatus` 只在 `status === 'failed'` 时写 `error`，取消原因被丢弃；
2. `conversation-run-coordinator.failRound` 只对 failed 传 `formatErrorMessage(error)`；
3. `session-state` 的「终态无输出 → 生成助手占位」条件写的是 `changes.status === 'aborted'`，而 `Round.status` 实际是 `'cancelled'`；
4. `branch-service.assistantGroup`（重开路径）重建 `executionRoot.data` 时不含 `error`，而 live 事件路径包含；
5. `llm-ui` 的 `NodeRenderer` 只在 `status === 'failed'` 渲染错误行。

### 23.3 修复与回归

- 上述五处对齐：终态判定统一为 `failed | cancelled`（cancelled 映射为节点 `aborted`）、占位符条件包含 cancelled 且状态映射为 `aborted`、重开分组携带 `error`、`NodeRenderer` 对 `aborted` 也渲染错误行。
- 回归：`backend/llm-session/__tests__/round-log.test.ts` 新增「cancelled 落盘 error 且 `round:updated` 携带」；`failed-round-projection.test.ts` 新增「重开路径（`projectionGroups`）与 live 路径都保留取消原因」。llm-session 97→**99**。
- 为测试导出纯函数 `projectionGroups`（`branch-service.ts`）。

### 23.4 真机复验

- 取消现场同 §23.1（`ABORTED` + `Task cancelled: task_0caa7eb7-…`，provider 连接被中断）。
- 落盘：`round-….json` 现在是 `{"status":"cancelled","error":"Task cancelled: task_0caa7eb7-…"}`。
- 宿主重启后：同一轮渲染为 `Assistant` + **`ABORTED`** + `⚠️ Task cancelled: task_0caa7eb7-…`，与 live 一致；随后发送新消息正常（1 次模型请求、正常回复）。
- 证据：`.tauri-acceptance/round82-cancel-live.log`、`round82-cancel-reload.png`。

### 23.5 边界

- 覆盖的是**手工取消**（`Stop Generation`）；超时取消走同一 `cancelInterrupted`/`failRound` 路径但未单独在真实窗口取证。
- 授权撤销、IPC 错误、Session 关闭在真实窗口的 UI 表现仍未验收；本轮只补齐取消这一条。
- 单会话、本地 mock、单层挂载。

## 24. 真实窗口的授权撤销 + 一个工具节点状态缺陷（2026-09-11 第八十三轮）

P0-02 还缺「授权撤销时应用层 UI 与持久状态一致」的真机证据。会话内的挂载管理对话框（`挂载目录 / 管理挂载`）每个挂载都有 `卸载` / `改为只读` / `设为工作目录` / `重新连接` 控件，本轮走 `卸载` 并观察撤销前后。

### 24.1 撤销前的基线

宿主目录经应用内对话框挂为 `/workspace` 并设为工作目录后，发送消息 → mock 两轮 `toolResults 0→1`，界面得到 `[exit 0] /workspace real-window-bash WORKSPACE-WRITABLE APP-READ-ONLY`，Task `succeeded`。

### 24.2 撤销（GUI）与持久状态

- 点 `卸载` 后，对话框列表清空；`session.seq` 的 `files` 记录变为
  `{"revision":2,"state":"active","mounts":[],"cwd":"/"}`——挂载被移除且工作目录回到 `/`。
- 会话 `files` 视图回到「尚未挂载工作目录，此会话只能访问附件」的提示。
- 宿主目录内容保留（`hello.txt` 仍在）——撤销不等于删除数据。

### 24.3 撤销后的访问被明确拒绝

再次发送（mock 仍会请求 Bash 工具）：

- 模型请求仍是 `tools:["Bash"], toolResults:0`（工具照旧被广告）；
- 执行被 Rust 守卫拒绝：`Session Bash requires a mounted Session directory; mount one before running commands`；
- 持久状态：内核 Task `{"status":"failed"}`，轮次 `{"status":"failed","error":"Session Bash requires a mounted Session directory; …"}`；
- 界面：`⚠️ 执行失败` + 该消息，状态行 `Error`，**没有**崩溃或挂起；随后新消息仍可发送（会话未被卡死）。

证据：`.tauri-acceptance/round83-revoke-bash.log`、`round83-revoke-record.txt`、`round83-revoke-bash.png`。

### 24.4 顺带发现：工具 Effect 失败时工具节点停在 `RUNNING`

对照两次干净运行：

- 成功路径：单轮 Bash 成功后，工具节点状态为 `SUCCESS`（界面文本里助手节点与工具节点各一个 `SUCCESS`）。
- 失败路径（撤销后再跑）：轮次正确显示 `⚠️ 执行失败` + 守卫消息，但工具节点仍显示 **`🔧 Bash RUNNING`**；切到 `files` 再切回会话（重新渲染）后该 `RUNNING` 消失。

代码定位（未修复）：`backend/llm-session/src/session/conversation-run-coordinator.ts` 的 `forwardToolEvent` 只在 `tool:queued`/`tool:running` 时 `ensureToolNode(...)`，而 `tool:success`/`tool:error` 只调用 `recordToolResult(...)`；当工具 **Effect 本身失败**（没有走到 agent program 的 `handleTool`）时不会发出任何 `tool:*` 终态事件，live 节点因此停在 `RUNNING`，直到重新渲染时由投影（`buildToolChildren`）按 `isError` 重建为终态。修复方向：在 `failRound` 里对在途工具调用补发终态（或在协调器更新节点状态并发事件），并补一条「工具 Effect 失败 → 节点为 failed」的回归。

证据：`.tauri-acceptance/round83b-tool-node-running.log`、`round83b-tool-node-running.png`、`round83b-rounds.txt`（成功轮 `completed`、失败轮 `failed` + 守卫消息）。

### 24.5 边界

- 覆盖 `卸载` 一条撤销路径；`改为只读` 与「旧句柄失效」未在真实窗口取证。
- 撤销时若正好有在途任务，本轮没有覆盖（撤销是在两次发送之间做的）。
- 单会话、本地 mock、单层挂载。

### 24.6 修复复验（同日补记）

§24.4 记录的缺陷已修复：`ConversationRunCoordinator.failRound` 现在接收本轮捕获的工具调用，并对**仍未结算**的调用补发终态 `tool:error`（`unsettledToolErrors`，含失败原因），使 live 执行节点离开 `RUNNING`。

- 代码：`backend/llm-session/src/session/conversation-run-coordinator.ts`（`failRound` 签名 + 补发；导出纯函数 `unsettledToolErrors` 供回归）。
- 回归：`backend/llm-session/__tests__/tool-failure-settlement.test.ts` 3 条（未结算→补发并带原因；已结算/已报错→不补发；混合列表只补发在途项）。llm-session 99→**102**。
- 真机复验（同一 harness：挂载 → `卸载` → 发送 Bash 请求）：工具节点由 `🔧 Bash RUNNING` 变为 **`🔧 Bash FAILED`**，助手节点 `FAILED`，轮次仍持久化 `⚠️ 执行失败` + `Session Bash requires a mounted Session directory; …`，界面无 `RUNNING` 残留。证据：`.tauri-acceptance/round84-tool-node-failed.png`、`round84-tool-node-status.txt`。
- 仍存在的信息损失（未修，记录）：失败轮次的失败轮次**重开后** `round.result` 不存在，投影因此不重建任何工具子节点——转录里看不到「曾调用过哪个工具」，只有轮级错误消息。若要保留，需要在失败路径把工具调用与其错误结果写入 `RoundResult`。

### 24.7 失败轮次保留工具调用（同日补记）

§24.6 末尾记录的「失败轮次重开后看不到调用过哪个工具」也已修复。

- **实现**：`failRound` 把本轮已开始的工具调用写入轮次结果（`failedToolResult(toolCalls, reason)`：已结算的调用保留结果，未结算的记为 `isError` + 轮次失败原因）；`RoundLog`/`RoundGraphService.setConversationStatus` 增加可选 `result` 参数；投影的失败占位符（`assistantProjection`）带上 `toolCalls: toolCallsFromResult(round.result)`，于是重开后 `buildToolChildren` 会重建该工具节点。
- **回归**：`backend/llm-session/__tests__/tool-failure-settlement.test.ts` +2（`failedToolResult` 的已结算/未结算语义、空列表返回 `undefined`）；`failed-round-projection.test.ts` +1（失败轮次带 `result` 时投影出 `toolCalls`，且重开分组里出现 `status: 'failed'` 的工具子节点）。llm-session 102→**105**。
- **真机复验（挂载 → GUI `卸载` → 发送 → 宿主重启）**：重开后的转录显示 `FAILED` 助手节点 + `🔧 Bash` 节点 + 守卫错误消息；持久记录为
  `{"status":"failed","error":"Session Bash requires a mounted Session directory; …","result":{"assistantBlocks":[{"type":"tool_use",…"Bash"}],"toolResults":[{"toolUseId":"call_bash_1","content":"Session Bash requires …","isError":true}]}}`。
  证据：`.tauri-acceptance/round85-reload-failed-tool.{png,txt}`。
- 整仓 `pnpm test` → `=== full matrix passed`。

## 25. 真实窗口的授权降级 `改为只读`（2026-09-11 第八十六轮）

P2-04 的「挂载访问边界」在包级已有证据，真实 GUI 的人工验收仍缺。本轮走挂载管理对话框的 `改为只读`，并用同一条探针命令对照降级前后的读写行为。

探针命令（`.tauri-acceptance/mock-bash.mjs`）：

```
pwd; echo real-window-bash; cat hello.txt;
(echo probe > .write-probe && echo WRITE-OK) 2>/dev/null || echo WRITE-DENIED;
test -w . && echo DOT-WRITABLE || echo DOT-READ-ONLY
```

### 25.1 降级前（rw，工作目录）

GUI 把宿主目录挂为 `/workspace`（可读写、`设为工作目录`）后发送 → 工具结果：

```
[exit 0] /workspace real-window-bash gui-mounted-file WRITE-OK DOT-WRITABLE
```

宿主目录里出现 `.write-probe`（内容 `probe`），即写入**真的落到了宿主目录**。

### 25.2 降级：`改为只读`

在挂载管理对话框点 `改为只读`：

- 对话框行变为 `… · 只读 · 工作目录`；
- 会话记录变为 `{"revision":2,…,"mounts":[{…,"access":"ro"}],"cwd":"/workspace"}`。

### 25.3 降级后（ro）

同一条命令再次执行（会话未重开、宿主未重启）：

```
[exit 0] /workspace real-window-bash gui-mounted-file WRITE-DENIED DOT-READ-ONLY
```

- **读仍成功**（`hello.txt` 内容进入输出）；
- **写被拒**：`.write-probe` 的 `mtime` 保持降级前的时间，`test -w .` 为假；
- 两轮 Round 都是 `completed`——拒绝发生在隔离层（bwrap 的只读绑定），命令自身用 `||` 兜底所以退出码仍是 0。

证据：`.tauri-acceptance/round86-readonly-downgrade.{png,log,txt}`。

### 25.4 边界

- 覆盖「运行间降级 + 下一次工具调用」；**运行中**（同一命令执行过程中）降级未测。
- 「旧句柄失效」仍只有包级证据（`backend/app-core/tests/directory-mounts.test.ts`）；GUI 侧每次工具调用重新解析授权，没有可观察的长期句柄。
- 单会话、本地 mock、单层挂载；只读挂载下未覆盖设备/链接等特殊节点类型。

## 26. 真实窗口空闲 IPC 复测：0 VFS + 0.46 次/秒（2026-09-11 第八十七轮）

P0-02 从第五轮起就挂着「UI 侧空闲流（连续 ≈60 ops/s）」未定位。内核轮询与 sidecar 事务修复后，本轮用 trace 构建在真实窗口做一次**专门的空闲测量**，给出阈值（空闲 ≤ 5 ops/s）的对照数字。

**方法**：`VITE_MINDOS_TRACE=1 pnpm --filter tauri-app build` + `cargo build --features tauri/custom-protocol`；`dbus-run-session` + Xvfb 启动应用（隔离数据根，预置会话）；打开会话（工作台/编辑器已挂载）后**不再交互** 70s；读 `<root>/var/log/vfs-trace.log`（每 2s 在有变化时输出 VFS 与 sidecar 增量）。

**结果**（`13:11:24Z → 13:12:24Z`，8 条记录、约 70s 窗口）：

| 通道 | 合计 | 速率 |
| --- | --- | --- |
| VFS 引擎操作 | **0** | 0 /s |
| sidecar（SQLite，桌面端每次 1 次 Tauri IPC） | 32 | **0.46 /s** |

**归因**：空闲期每 10s 恰好 4 次 sidecar——`getRecordField` 2、`setRecordField` 1、`transaction` 1，与 `SessionLeaseStore.renew()`（一个事务 + `getEntry` + `compareAndSet` 的再次 `getEntry` + `setEntry`）逐项吻合，即**会话租约 10s 心跳**本身，属设计行为。

对照 P0-02 的阈值「空闲 ≤ 5 ops/s」：实测 **0.46 ops/s**，达标；第五轮记录的「连续 ≈60 ops/s」在当前树不再出现。

证据：`.tauri-acceptance/round87-idle-trace.log`、`round87-idle-summary.txt`。

**边界**：trace 行不含调用路径，租约心跳的归因来自操作计数与实现逐项对照（不是栈证据）；窗口内没有其它 UI 活动（未滚动、未输入、未查询 a11y），因此不覆盖「用户交互时的额外空闲流」。

## 27. 发送路径 sidecar 读取成本的量化与决策（2026-09-11 第八十八轮）

P0-02 的发送延迟（真机 4.4s / ≈590 次 IPC，目标 ≤2s / ≤100）剩下的方向此前是「需先定语义」。本轮用探针把一次发送的 sidecar 读取按调用点量化，并给两个候选缓存方案测上界，据此做决策（决策正文见 [VFS sidecar 读取成本](../doc/design/vfs-sidecar-read-cost.md)，本节只记证据）。

**一次发送 + 静置共 1804 次 sidecar 调用**：`getRecordField` 253、`getMetaExt` 172、`listRecordFields` 141、`setRecordField` 127、`begin`/`commit` 各 118。最热的重复读：`kernel/session.seq :: __vfs_seq__:record` **57 次**、`kernel/tasks` 目录 `getMetaExt` **38 次**、`resources.seq` 的 `listRecordFields` 51 次。

**缓存上界**（探针统计「命中即可省下」的调用数）：

| 方案 | 命中 |
| --- | --- |
| 同 tick（microtask 排空即清） | **0** |
| 严格事务内（begin…commit） | 42（≈2%） |
| 写失效（任意写清全表） | 513（≈28%） |

**结论**：不做进程内读缓存（A 无收益；B 的上限仍跨不过 ≤100 次，却引入跨进程写不可见的语义风险）。真正能降一个数量级的是**协议层**：sidecar 批量原语（`getRecordField(s)` / `getMetaExtMany`）与「把每个逻辑步骤重读会话/任务记录改成显式传参」。若将来仍要做读缓存，必须满足的语义与测试义务写在设计文档 §5。

证据：`.tauri-acceptance/round88-read-cost-probe.log`（探针原始输出）。

## 28. P0-03 收口：凭证落盘范围已确认 + 设置页文案纠正（2026-09-11 第八十九轮）

**用户决定（2026-09-11）：API key 落盘范围保持明文**（不引入密钥环 / 环境变量引用）。据此 P0-03 的「独立凭证注入 UI」不再需要另建入口，剩余交付侧工作本轮完成：

1. **编辑器明确标注存储范围**（`ui/llm-settings-ui/src/editors/ProviderSettingsEditor.ts`）：API Key 字段下新增两条说明——
   - `Key 以明文保存在数据根的 /etc/llm/.providers/<id>.json；Provider 列表、.llm 导出与 LLM 日志都会剥离它，但文件本身可读。`
   - `Session Bash 不继承宿主环境：子进程需要凭证时，请在命令里显式传入，或让它从自己读取的受控文件 / 环境变量名取值。`
2. **纠正两页自相矛盾的文案**（与代码对齐：`llm-loader.ts` 注明「apiKey lives on the Provider」、「Connection 不持有 apiKey」）：
   - Provider 页原写「连接（API Key）在『LLM 连接』页配置」→ 现写「…API Key（认证信息属于 Provider 层）。连接在『LLM 连接』页把 Provider 绑定到 Agent 并设置模型层级。」
   - LLM 连接页原写「为云提供商配置 API Key…」→ 现写「把 Provider 绑定到 Agent 并设置模型层级…；API Key 属于 Provider，在『LLM Provider』页配置」。
3. **回归**：`ui/llm-settings-ui/tests/ProviderSettingsEditor.key-storage.test.ts` 2 条（Provider 页描述指向 Provider 层；编辑弹窗的 API Key 字段是 password 且带明文路径与子进程约定）。llm-settings-ui 1→**3**。
4. **真机验证**（Xvfb + 真实窗口，实现内挂载 harness）：Provider 页描述与编辑弹窗两条说明、LLM 连接页描述均按上表渲染。证据：`.tauri-acceptance/round89-provider-key-copy.png`。
5. [运行说明](minimal-system.md) 同步：§子进程凭证注入 明确「桌面端不另做注入 UI…落盘保持明文」。

**边界**：真实云厂商 key 的端到端调用仍不在验收范围（验收用本地 mock）；子进程凭证注入仍是操作约定，不是自动注入。整仓 `pnpm test` → `=== full matrix passed`。

## 29. 真实窗口的网络边界（2026-09-11 第九十轮）

P2-04 的最后一项「网络隔离」此前只是设计陈述（[minimal-system](minimal-system.md)：Bash 的 Linux 隔离**保留共享网络**，不是绝对网络沙箱）。本轮在真实窗口用会话 shell 直接探测，把边界变成实测事实。

**探针**（`.tauri-acceptance/mock-bash.mjs` 的命令）：

```
pwd; echo real-window-bash;
(exec 3<>/dev/tcp/127.0.0.1/8399) 2>/dev/null && echo NET-HOST-LOCAL-OK || echo NET-HOST-LOCAL-DENIED;
(exec 3<>/dev/tcp/1.1.1.1/443)   2>/dev/null && echo NET-EXTERNAL-OK   || echo NET-EXTERNAL-DENIED
```

**结果**（GUI 挂载 `/workspace` 为工作目录后发送）：

- **宿主本地端口可达**：`NET-HOST-LOCAL-OK` —— 会话 shell 能连上宿主 `127.0.0.1:8399` 的 mock 服务，说明它**与宿主共享网络命名空间**，没有网络隔离。
- **外网连接不可达且被超时兜底**：对 `1.1.1.1:443` 的连接一直阻塞，直到工具的 `timeout_ms: 30000` 触发，工具结果 `[exit -1]`（进程组被终止），轮次最终 `completed`（模型拿到 `[exit -1]` 后正常收尾）。即**本环境没有出网**，而挂起的连接不会挂死运行。

**结论与边界**：

- 「网络隔离」这一项按设计**不存在**：共享宿主网络；本机也给出 `host_local=OK`、`external=DENIED(超时)` 的实测。**不把「看不到外网」当成产品安全保证**——出网可达性取决于宿主环境（本轮环境无路由），部署说明不要据此宣称网络沙箱。
- 隔离能力仍是文件系统侧（只读绑定、授权目录）与凭证侧（清空继承环境），网络不在其中。

证据：`.tauri-acceptance/round90-network-boundary.{log,png,txt}`。

## 30. P1-03：app-core 隔离工作区端口打通 + Web/Tauri 不注入的边界（2026-09-11 第九十一轮）

P1-03 剩下的「Web/Tauri 端装配」本轮推进到**能推进的边界**：把宿主注入通道打通并验证 fail-closed 契约，同时查清桌面为什么不能直接装配。

### 30.1 通道（类型层贯通）

`ApplicationKernelPlatform.flowWorkspaceManager`（app-core）→ `ConversationSystemOptions.flowWorkspaceManager` → `initializeConversationSystem` → `SessionManager` → `SessionRunCoordinator` → `ConversationRunCoordinatorOptions.workspaceManager` → `DurableFlowExecutor({ workspaceManager })`。宿主注入即可让 chat 内 Flow 的非 shared 模式工作；不注入则维持既有 fail-closed 行为。

### 30.2 fail-closed 回归

`backend/llm-flow/__tests__/durable-flow-executor.test.ts` 新增「fails closed when a non-shared workspace mode has no host workspace manager」：`runPolicy.workspace.mode: 'worktree'` 且未提供 manager 时 `submit` 以 `requires a configured workspace manager` 拒绝，且**不创建任何 Task**（不会偷偷在共享工作区执行）。llm-flow 177→**178**。

### 30.3 为什么桌面当前不注入（决策）

- 桌面宿主没有「应用数据根之外执行 git」的通道：`shell_exec` 的 `is_allowed` 只放行 `root_dir`/`home_dir`（`apps/tauri-app/src-tauri/src/lib.rs:151`），而用户项目的 Session 挂载走的是 `scoped_fs` 目录句柄（只提供文件 IO，不提供进程执行）。
- 因此 worktree 模式的桌面路径**保持 fail closed**；要装配需要先补两件事：① Session 挂载 → 宿主目录路径的解析 API；② 一个**受限作用域**的宿主 git 命令（仅授权仓库 + 固定 argv），并单独做安全评审。Web 无宿主进程能力，永久 fail closed。
- 决策已写入 [Flow 执行模型](./design/flow-execution-model.md) 的宿主支持表与 [TODO](./todo.md) P1-03。

**边界**：本轮验证到「端口 + fail-closed 契约」；没有端到端「chat 内 Flow 用注入的 manager 在隔离目录执行」的真机证据（该证据在 CLI 宿主已有：`apps/cli/tests/worktree-run.test.ts`）。整仓 `pnpm test` → `=== full matrix passed`。

## 31. 受限宿主 git 通道（2026-09-11 第九十二轮）

P1-03 桌面装配的第二块前提。新增 `apps/tauri-app/src-tauri/src/host_git.rs` + `git_command(cwd, args, timeout_ms)`：

- **argv-only**，最多 16 项；首项必须在白名单（`worktree`/`rev-parse`/`status`/`branch`/`merge`/`add`/`commit`/`log`/`diff`/`show`），`worktree` 的第二项仅 `add`/`list`/`remove`/`prune`/`repair`；
- 拒绝 `-c`、`--exec-path`、`--git-dir`、`--work-tree`、`--upload-pack`、`--receive-pack`、`--config-env`、`--namespace`、`-C`（能执行代码或改指仓库），含 `--opt=value` 形式；
- `cwd` 必须是**仓库根**（存在 `.git`），因此不能拿它当通用 git 执行器；
- 运行时注入 `-c core.hooksPath=/dev/null`、`--no-pager`，`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_TERMINAL_PROMPT=0`，并移除 `GIT_SSH_COMMAND`/`GIT_EXTERNAL_DIFF`；超时 30s（上限 120s），复用既有进程组+超时+输出上界执行器。

**回归**（`pnpm --filter tauri-app test:rust`）：5 条——接受 manager 实际使用的四种 shape；拒绝非白名单子命令/`worktree` 缺子命令/超长 argv；逐项拒绝可执行代码或改指仓库的选项；非仓库根拒绝；在真实临时仓库里跑通 `rev-parse --is-inside-work-tree`。Rust 测试 16→**21**。

**边界（写进设计）**：该通道目前**没有消费者**——桌面仍不注入 worktree manager，因为还缺「Run 作用域的会话工作区覆盖」（否则 Bash 在 worktree、Write/Edit 改基础仓库）。挂载→宿主路径解析已具备（`DirectoryMountService.processMounts`）。整仓 `pnpm test` → `=== full matrix passed`。


## 32. 宿主 Git fsmonitor 执行缺陷（2026-09-13 第九十三轮）

P1-03 前置通道复核发现：禁用 `core.hooksPath` 不会禁用仓库的 `core.fsmonitor`；白名单内的 `git status --porcelain` 可以执行本地仓库配置的监控脚本。

新增 `host_git::tests::status_does_not_execute_a_repository_fsmonitor` 在真实临时仓库设置可执行脚本，以脚本写出的文件判断是否执行。旧实现实测失败：`repository fsmonitor executed outside the Session sandbox`。命令参数加入 `-c core.fsmonitor=false` 后，同一测试通过。

验证：`pnpm --filter tauri-app test:rust`，22 passed / 0 failed，包含原生 Bash 取消、超时、目录授权边界与 Git 用例；构建仍有既有 unused import/dead code 告警。未执行整仓矩阵或真实 GUI 复验。

边界：只关闭 fsmonitor 执行入口。Git 本地配置的其他程序执行入口、参数范围与 Session 授权绑定仍需复核；当前检查 `.git` 存在不能证明仓库已获 Session 授权。桌面 worktree manager 尚未装配，Run 作用域工作区覆盖仍待实现，P1-03 与整体目标均保持未完成。

## 33. 独立工作区文件上下文（2026-09-13 第九十四轮）

P1-03 的文件侧基础已落地于 `SessionFilesService.acquireWorkspaceFiles(sessionId, mountId, fs)`。宿主提供隔离副本的 `IFileSystem`，服务验证 Session 有唯一匹配的活动可写挂载及可用原来源，然后建立独立视图。副本根映射到原挂载点，cwd 指向该挂载点，其他授权和附件保持原状。长期 `files` 记录、普通会话视图均不修改。

`backend/app-core/tests/session-files.test.ts` 新增 5 项：并行视图/原目录不污染/持久记录不变/独立释放；授权配置改变、禁用、服务销毁三种撤销路径均令旧文件句柄失效；缺失或只读授权、只读副本、禁用 Session 被拒。副本来源仍由宿主持有，释放视图不销毁来源。

验证：app-core 15 文件、70 测试通过；`tsc --noEmit -p backend/app-core/tsconfig.json` 通过。没有跑整仓矩阵或桌面 GUI。

边界：这是供宿主使用的文件上下文端口，目前无 Run 消费者。还需为 `KernelAdaptersSessionRegistry` 引入按 Run 的能力选择，将 Bash 进程挂载与 VFS 工具指向同一副本，并绑定持久恢复和 finalization；不能通过修改整个 Session 的长期挂载实现并发 Run 隔离。P1-03 保持未完成。

## 34. Effect 独立能力路由（2026-09-13 第九十五轮）

kernel-adapters 新增宿主端口 `scopeForEffect`/`fileContextForScope`，app-core 的 `ApplicationKernelPlatform` 和 `createKernelRuntime` 均透传。选中作用域后，注册表为 Session + scope 建立独立的工具、Skill 与进程上下文；标准 Effect 的元数据查询与执行均走该作用域。作用域选择按 Effect 上下文固定，失败不回退。`disposeScope` 关闭后拒绝迟到调用，含尚未打开作用域的关闭，并发调用等待同一次清理。

自动化证据：`create-kernel-adapters-runtime.test.ts` 新增 3 条，用实际 ToolCall adapter 验证同一 Session 两个作用域的 Read 与 Bash 路由、默认 Session 并存、上下文只获取一次、作用域选择只计算一次、关闭后不重建、选择/获取失败不触及默认文件，以及并发释放在清理完成前均不返回。Bash 的底层 shell 是记录型替身，不是真实 Tauri IPC。

结果：kernel-adapters 14 文件/99 测试通过；app-core 15 文件/70 测试通过；全仓 `pnpm typecheck` 通过。尚无 Tauri 生产消费者，后续必须连接持久 Run 成员关系、独立文件视图、真实进程映射、恢复和 finalization。此项不构成桌面 worktree 验收，P1-03 继续未完成。

## 35. 持久 Task → Run → 工作区解析（2026-09-13 第九十六轮）

`resolveFlowRunForTask` 用 Session Task 祖先链及 Flow members/retries 解析所属 Run；`resolveFlowTaskWorkspace` 再读取冻结策略和工作区租约。普通 Task/shared 模式不选隔离作用域，隔离记录缺失拒绝。app-core 在提供作用域文件工厂且没有自定义选择器时默认使用该解析器。

证据：llm-flow 的真实执行器测试建立同一 Session 的两个暂停 Flow，确认节点的 `rootTaskId` 是自身而新解析器返回各自 Run；节点后代及持久重试身份同样正确。`task-run.test.ts` 4 项单元测试覆盖普通 Task、成员缺失/损坏/歧义、无效祖先链、最近祖先选择，以及冻结策略/租约缺失的拒绝。llm-flow 16 文件/183 测试通过。

app-core 新增 `flow-workspace-scope.test.ts`：真实 Kernel + Flow + 共享装配默认选择器，宿主文件工厂返回可识别内容，Read 读到 Run 专属上下文；删除持久工作区租约后新 Effect 上下文被拒。两包类型检查通过。

边界：工作区工厂仍为替身，没有创建真实 Git worktree 或调用 Tauri IPC。解析器只提供身份和持久租约，不证明宿主目录授权。Tauri 的文件/进程映射、prepare/restore/finalization 与实机验收仍待完成。

## 36. 隔离文件视图与 Tauri 进程映射配对（2026-09-13 第九十七轮）

`acquireWorkspaceProcessContext` 复用 `acquireWorkspaceFiles` 和既有进程上下文生命周期，以同一授权 revision 打开文件视图、核对进程挂载并替换为隔离副本。原 Session 授权与普通上下文不修改；替换后的 sourceId 为 `flow-workspace`，避免 Tauri 对 `admin-home` 的数据根转换错误地作用于绝对 worktree 路径。获取结束再次验证 revision，授权变化即释放进程及文件上下文。

app-core 新增 4 项测试，覆盖文件写入不污染原目录、映射替换、进程先于文件释放、并发释放幂等、授权变更后的清理、不匹配授权在进程打开前拒绝、IPC 初始化失败后文件视图失效。

app-shell 的 `tauri-bash.test.ts` 新增真实 TS 工厂组合测试：文件视图挂载副本，`directory_open` 参数为 `/native/worktree`，`session_shell_exec` 收到该目录句柄到 `/workspace` 的 rw 映射；原目录内容保持不变；禁用授权后再次 exec 在新 IPC 派发前拒绝；释放关闭副本句柄。桥接 9 项通过，app-core 类型检查通过。

边界：IPC 是替身，文件后端为 MemoryBackend，没有实际创建 Git worktree、运行 bwrap 或启动 GUI。生产 Tauri manager、Git 授权边界和 prepare/restore/finalization 仍未完成，P1-03 保持未完成。

## 37. worktree 已删除但清理状态未落盘的恢复（2026-09-13 第九十八轮）

发现旧证据只覆盖「restore 成功后删除目录」，未覆盖真实崩溃窗口「重开前目录已被删除」。新增 discard/auto-if-clean 回归在旧实现均以 `Worktree is missing` 失败。另一个新增回归证明 `/worktrees/run-other` 会被旧 `includes` 判作 `/worktrees/run` 存在。

修复：终态 Run 的 pending finalization 用 `forFinalization: true` 调 manager.restore；Git manager 为清理允许目录缺失，跳过不存在 cwd 的 status，继续处理分支，不创建副本；普通执行恢复仍拒绝缺失目录。列表匹配改为完整行。keep 或失败/取消下 on-success 要求保留的目录缺失仍失败。

真实 Git 证据：`git-worktree-finalization.test.ts` 建临时仓库/提交/分支/worktree，删除副本但保留分支，再重建 manager。普通 restore 拒绝；清理 restore 完成分支删除且基础文件内容不变。两种 merge 策略均通过。执行器的重建 Kernel 用例另外验证仅收尾路径传入该标记。

范围：不是 SIGKILL 或 Tauri GUI；目录删除后重建 manager 和 Kernel 分别有自动化证据。生产桌面 manager 及文件/进程作用域关闭顺序仍需接通。

本轮最终验证：llm-flow 17 文件 / 190 测试通过，包类型检查通过；文档检查 76 份通过（5 条既有历史表述告警）。

## 38. 工作区清理前等待后台任务并关闭能力（2026-09-13 第九十九轮）

FlowWorkspaceLease 新增可选 releaseCapabilities 屏障，正常结束、pending 收尾恢复、调度失败清理都先调用它。app-core 会话装配自动包装宿主 manager，按持久成员和祖先关系等待 detached 及其后代，再释放 Run 能力作用域。聚合根不在等待集合中，避免调度失败在写根终态前清理时死锁。

新增回归：能力屏障未返回时 finish 不调用；屏障失败持久记录 failed 且不调用 finish；后台成员未结束时继续等待，期间产生的新后代也要等待；持久成员找不到时拒绝清理。app-core 的真实 Kernel/Flow 装配用例验证释放顺序为 capabilities → workspace。

验证：llm-flow 18 文件/194 测试、app-core 17 文件/75 测试通过，两包类型检查通过。能力排空的时序测试使用可控替身，装配测试使用 MemoryBackend；不构成 Tauri GUI/bwrap 验收。生产桌面 manager 注入与创建/恢复工厂仍待完成。

## 39. Git 目录句柄、完整参数形状与继承环境（2026-09-13 第一百轮）

`git_command` 的当前 IPC 参数为 repositoryId/args/timeoutMs；Rust 以现存目录句柄解析工作目录，未知或关闭句柄拒绝。内部 run(cwd, ...) 仅作为 Rust 实现/测试入口，不再暴露为接受裸 cwd 的 IPC。参数只接受 manager 使用的完整形状，去掉未使用的 add/commit/log/diff/show/prune/repair 等操作及任意额外参数。

新增回归覆盖真实仓库的句柄打开→执行→关闭→拒绝、未知句柄、非 manager 参数和选项位置绕过。子进程环境回归明确复现旧实现受继承 GIT_DIR 影响：指向不存在的替代 git 目录时返回 128。修复为 env_clear + 固定 PATH/LANG 和 Git 配置后通过；测试不修改主测试进程的全局环境。

边界：worktree 目标路径只校验绝对路径，尚未绑定目录授权；仓库本地配置仍待复核。关闭句柄只影响后续请求，不是已运行 Git 的取消确认。生产 manager、真实窗口的 worktree 验收均未完成。

本轮验证：`pnpm --filter tauri-app test:rust` 25 项通过；文档检查 76 份通过，5 条既有历史表述告警。

## 40. worktree 目标目录授权（2026-09-13 第一百零一轮）

Git IPC 新增 workspaceId。worktree add/remove 启动前要求它指向有效目录授权；目标必须是该目录的严格子路径，拒绝授权根、越界、父目录穿越和符号链接祖先。对 repositoryId 的根也重新检查符号链接，避免根被替换后继续使用。其他只读或分支命令不要求 workspaceId。

Rust 新增 3 项测试：真实临时 Git 仓库 + 提交 + 目录授权，缺失 workspaceId 时不创建目标；正确授权可创建并删除真实 worktree；关闭后再次操作拒绝；分别验证 add/remove 的越界、穿越、根目标被拒及文件不受影响；链接祖先指向外部目录时不在外部创建副本。

验证：`pnpm --filter tauri-app test:rust` 28 passed。这是原生模块与真实 Git 证据，没有通过 GUI/IPC 驱动，也未接入生产 Tauri manager。路径检查到 Git 启动之间仍存在普通路径校验的竞态边界；本地仓库配置的执行和重定向仍需复核。

## 41. 本地 core.worktree 重定向与 checkout filter（2026-09-13 第一百零二轮）

两条真实仓库回归均在旧实现上失败：core.worktree 指向外部目录后，status 显示 outside-only.txt；worktree add 执行 smudge 命令并创建测试标记文件。

修复分别为：显式指定工作目录以覆盖本地 core.worktree；在执行前读取有效 Git 配置（含 include），发现 filter 的 clean/smudge/process 项时明确拒绝。不会运行这些命令，也不会通过禁用 filter 后继续 checkout 来改变预期内容。配置损坏同样拒绝，预检计入原请求总超时。

新增测试覆盖 core.worktree 固定目录、smudge 不执行且不创建目标 worktree、include 配置中三类 filter 的拒绝、损坏配置的拒绝。工作区创建/删除的真实 Git 回归仍通过。

边界：配置 filter 的仓库当前不支持宿主 Git 通道；未验证并发恶意配置/路径替换防御，不将命令前校验宣称为原生隔离沙箱。Tauri 生产 manager 和真实窗口 worktree 验收仍未完成。

本轮验证：Rust 31 项测试通过；文档同步检查 76 份通过（5 条既有历史表述告警）。


## 42. 桌面 Git 命令适配器（2026-09-13 第一百零三轮）

`TauriWorkspaceGitRunner` 将共享 worktree manager 的命令接口接到 `git_command`：cwd 限构造时指定的仓库或副本，worktree 创建/删除目标限该副本；按调用打开仓库目录授权，修改 worktree 时另开目标父目录授权。调用结束释放全部已获取句柄，部分获取失败也回收先前句柄；命令错误与多个关闭错误一起保留。

验证：`pnpm --filter @itookit/app-shell exec vitest run tests/tauri-workspace-git.test.ts` 6 项通过；Tauri TypeScript 检查通过。测试覆盖共享 manager 经真实 TypeScript 适配器创建与收尾，但 IPC 为替身。生产入口尚未注入工作区 manager，未进行本轮真实窗口验收，P1-03 仍未完成。


## 43. 恢复前宿主绑定与工作区授权解析（2026-09-13 第一百零四轮）

平台 configure 回调获得实际运行时的文件和目录挂载服务。真实内存后端应用启动测试检查：服务已可用，异步回调完成后才扫描恢复 Session，回调收到的服务与最终 runtime 相同。

Tauri 仓库解析返回授权 revision、挂载及来源身份和原生路径；测试验证 admin-home 与外部路径转换，禁用/只读/多可写挂载/子目录 cwd 拒绝，文件与进程映射来源不一致拒绝，异步解析期间 revision 改变拒绝。

验证：app-core application-runtime 测试 3 项通过；app-shell 两份桌面授权/Git 适配器测试共 11 项通过；Tauri 类型检查通过。授权测试使用服务替身，尚未注入生产 worktree manager；P1-03 及整体目标仍未完成。


## 44. Tauri worktree manager 生产注入（2026-09-13 第一百零五轮）

新增 TauriFlowWorkspaces，main 注入 workspace manager、Run 文件工厂与恢复前绑定回调。租约包含 Session 授权和 Git 身份，副本按 UUID 区分，恢复重新核对授权；工具 cwd 为虚拟挂载根。Run 工厂单独打开副本来源，同时获取文件和原生进程能力，并在返回前再次核对授权，释放按能力到来源顺序执行。

4 项新测试通过：并发准备生成独立副本，重建 manager 后恢复同一租约，跨 Session/变更授权拒绝，缺失副本仅允许收尾恢复，文件与原生映射均取副本且普通 Session 仍读原目录，并发 release 只关闭一次。测试使用真实 SessionFilesService 和内存 VFS，Git IPC/副本来源为替身；Tauri 类型检查通过。真实桌面运行与重启验收仍待完成；read-only、孤儿副本窗口和合并冲突 UI 未据此完成。

本轮生产构建：`pnpm --filter tauri-app build` 通过（897 个模块，保留大 chunk 提示）；文档检查 76 份通过、5 条既有历史表述告警。


## 45. Tauri 来源释放失败与在途获取（2026-09-13 第一百零六轮）

修复来源 owner 关闭失败导致目录句柄及后续来源不释放的问题；dispose 现等待已开始的获取（包括还未解析 canonical 路径者），按来源去重，继续尝试所有关闭并汇总错误。并发 dispose 共用结果，关闭后拒绝新获取。

新增两项测试：owner 和目录关闭各自失败时仍尝试全部来源/句柄；directory_open 挂起时启动两个 dispose，等待获取结束后只释放一次。与 4 项 worktree 装配测试合计 6 项通过，Tauri 类型检查通过。首次测试有一处未计入 Tauri invoke 第三个 undefined 参数的断言，修正后复跑通过。这些是 IPC/后端替身证据，真实桌面验收仍未完成。


## 46. worktree 原生文件与 Bash 贯通（2026-09-13 第一百零七轮）

新增 host_git::tests::worktree_file_io_and_bash_share_the_copy_without_changing_the_repository。使用真实临时 Git 仓库与目录授权，通过受限 Git 创建 worktree；directory_io 写入 from-file，真实 Bubblewrap Bash 在 /workspace 读取并改成 from-bash，再由 directory_io 读回。基础仓库未生成对应文件，副本中的 .git 是文件且不妨碍普通文件/Bash 操作。关闭目录句柄后读取拒绝，最后受限 Git 删除副本成功。

单项测试已通过。这是原生模块集成证据；没有经过 WebView IPC、Tauri SQL sidecar 初始化或窗口交互，也不证明 Bash 内 Git 元数据路径可用。完整桌面 worktree 验收仍待完成。

本轮完整原生套件：`pnpm --filter tauri-app test:rust` 32 项通过；文档检查 76 份通过、5 条既有历史表述告警。


## 47. 工作区授权变化期间的回收（2026-09-13 第一百零八轮）

新增两项测试，均通过真实 SessionFilesService.configure 改变授权 revision：Git 创建返回前改变授权，prepare 拒绝并删除未发布副本及分支，cleanup=keep 不阻止此次回滚；打开来源期间改变授权，fileContext 拒绝并关闭已获取进程句柄及来源，但保留已持久化副本。

`pnpm --filter @itookit/app-shell exec vitest run tests/tauri-flow-workspaces.test.ts` 共 6 项通过。Git IPC 和来源后端使用替身；本轮没有 GUI 或进程崩溃验证。Git 成功但返回前失败及创建到租约持久化之间的孤儿窗口仍待处理，未据此完成 P1-03。


## 48. Git 创建前的宿主恢复记录（2026-09-13 第一百零九轮）

共享 manager 在 Git add 前等待 beforeCreate；Tauri 写入 .intents/<id>.json，包含授权及 Git 身份。测试让 Git 已创建副本后 directory_close 失败，验证 prepare 拒绝但恢复记录仍存在；另一测试使记录写入失败，验证不执行任何 Git 命令。删除记录使用原生 fs_remove，缺失幂等，其他错误传播。

这些测试使用 IPC 替身，证明调用顺序和错误路径，不是进程崩溃或断电试验。启动孤儿扫描及自动恢复尚未实现；不能据此勾选孤儿恢复或 P1-03。

验证：Tauri 工作区套件 8 项、共享 Git manager/真实 Git 收尾恢复 12 项通过；文档检查 76 份通过、5 条既有历史告警。


## 49. 新运行前回收无归属创建意图（2026-09-13 第一百一十轮）

Tauri prepare 在执行宿主已持有 Session 写租约的前提下，读取创建意图和持久 flow-root 租约，保留有归属副本及本进程仍持有的副本；无归属且授权匹配时清理副本/分支及意图。并发核对合并；校验、读取及清理错误传播。

新增测试重建 manager 后删除无归属旧副本，再创建新副本；另一测试提供持久 Run 租约，验证旧副本保留。原并发准备测试继续验证本进程尚未发布副本不被删除。测试使用 IPC 状态替身，不是实际进程崩溃。主动启动扫描、授权变化遗留项的处理及真实桌面验收仍待完成。

验证：Tauri 工作区套件 10 项通过，Tauri 类型检查通过；文档检查 76 份通过、5 条既有历史表述告警。


## 50. 写租约之后的启动工作区核对（2026-09-13 第一百一十一轮）

平台 beforeSessionRecovery 回调接在 Session 写租约获取成功之后、Kernel 恢复之前，Tauri 在这里执行工作区意图核对。拒租会话不执行回调；回调失败阻止任务恢复，停止心跳并释放已获取租约，应用装配关闭 Kernel。

真实内存租约测试在回调内读取 owner 验证顺序，并确认另一宿主持有的会话不执行回调；失败用例验证后续宿主可以重新取得租约。应用装配测试验证回调拒绝启动时 Kernel 被关闭。测试不涉及真实进程 SIGKILL 或桌面重启，后者仍待验收。

本轮验证：应用启动/Session 恢复两份测试共 6 项通过，app-core 与 Tauri 类型检查通过；文档检查 76 份通过、5 条既有历史表述告警。


## 51. 未发布工作区的真实进程崩溃（2026-09-13 第一百一十二轮）

新增 tauri-workspace-crash.test.ts 和独立 workspace-crash-host.ts 夹具。子进程运行真实 TauriFlowWorkspaces，使用真实临时磁盘/Git；分别在意图 rename 完成、Git 创建副本完成后通知父进程。父进程发送 SIGKILL 并确认 signal=SIGKILL、exitCode=null，再启动全新子进程执行 reconcile。

两项通过：第一窗口没有副本，恢复删除意图；第二窗口确有真实 worktree，恢复后 worktree list 不含旧目录、分支不存在、意图目录为空。app-shell 新增 tsx 测试依赖并离线更新锁文件，避免依赖其他包的隐式 loader。

边界：IPC 由 Node 传输替身实现，Session 授权以相同配置重建；没有真实 WebView/native IPC/sidecar/桌面启动，也不验证已发布 Run 的恢复。完整目标仍未完成。


## 52. 已发布 Run 的真实持久崩溃恢复（2026-09-13 第一百一十三轮）

workspace-crash-host 夹具升级为 LocalFS + Node SQLite sidecar，真实 SessionFilesService 授权、Kernel Task/共享记录与 DurableFlowExecutor。已有两个窗口也改用此持久后端。

新窗口在 executor.submit 发布持久 Run 后发送确认，父进程 SIGKILL 并等待退出。新进程先 reconcile 并验证原副本仍存在；等待持久调度租约 expiresAt 后接管 Kernel/Flow，恢复原人工节点并响应，等待根和收尾完成。父进程验证根状态 succeeded、共享 workspace 状态 succeeded，旧目录不在 worktree list、分支不存在且意图清空。

首次运行被未到期的旧调度租约正确拒绝；夹具随后改为根据持久到期时间等待，没有强制绕过租约。最终 `tauri-workspace-crash.test.ts` 3 项通过（意图、创建、发布三个 SIGKILL 窗口）。IPC 仍由 Node 传输替身提供；不覆盖 Tauri SQL 插件、WebView/native IPC 或真实窗口重启，完整桌面验收仍未完成。


## 53. 工作区装配后的整包回归（2026-09-13 第一百一十四轮）

当前树完整执行 app-shell 和 app-core 测试：app-shell 33 文件通过/3 文件跳过，161 项通过/30 项跳过；app-core 17 文件、78 项通过。未发布与已发布三个 SIGKILL 窗口在 app-shell 整包并行执行中均通过。日志位于 /tmp/x1-shell-workspace-regression.log 和 /tmp/x1-core-workspace-regression.log。

跳过项仍是未执行证据，不算通过。本轮不扩大为完整矩阵或真实桌面已验收；Tauri WebView/native IPC/SQL 插件和窗口工作区验收仍待完成。

整仓 `pnpm typecheck` exit 0（26/27 工作区项目范围内执行已有类型检查脚本）；文档检查 76 份通过、5 条既有历史表述告警。


## 54. 真实 Tauri 工作区探针及两处收尾修复（2026-09-13 第一百一十五轮）

通过临时验收入口构建隔离诊断二进制，Xvfb/dbus 中运行真实 Tauri。探针用生产运行时、TauriFlowWorkspaces 和实际副本来源执行 Flow：Write 写 file-tool，Bash 读取该内容并写 native-bash，Read 返回 native-bash，普通 Session 同名文件保持 base。

首次产物 `.tauri-acceptance/native-workspace-8wx98ol4/workspace-probe-result.json` 显示工具成功而收尾/持久化失败。定位为 TauriSqlSidecarDb.close() 无参数调用插件，会关闭全部数据库池；同时 discard 对含工具修改的副本使用普通 remove 被 Git 拒绝。修复为 close(databaseUrl)，以及 discard 清理使用 --force；版本不兼容的关闭路径也只关闭本数据库。

修复后产物 `.tauri-acceptance/native-workspace-fixed-8oevilpx/workspace-probe-result.json`：Write/Bash/Read success=true，Bash exit 0，base=base，exit=succeeded，finalization.status=succeeded。宿主磁盘复核 git worktree list 仅基础仓库，意图目录为空，基础文件仍为 base。数据库关闭回归 1 项通过；共享 Git manager 10 项及真实 Git 收尾 3 项通过（含新增脏副本 discard）。

这是实际 WebView/native IPC/SQL 插件/Bubblewrap 自动探针，未经过用户点击启动 Flow，亦未验证真实桌面重启。进程由 45 秒 timeout 退出，非应用崩溃。临时 main 探针调用已移除，随后重建正常前端与原生二进制，避免日常启动执行验收动作。其他有效待办与整体目标仍未完成。


## 55. 工作区活文档状态复核（2026-09-13 第一百一十六轮）

根据 main 的平台注入、TauriFlowWorkspaces、app-core 恢复回调及 §52–54 的现有证据，更新 todo P1-03、Flow 执行模型和 app-core 指引中的宿主装配状态。只读模式、OCI、合并交互、用户窗口/真实桌面重启、特殊遗留意图与跨主机排他继续列为未完成；未扩大自动探针的验收范围。


## 56. 只读工作区共享能力边界（2026-09-13 第一百一十七轮）

文件和进程获取支持显式 ro（默认仍 rw）。ro 派生视图/进程挂载将全部用户挂载降权，原只读授权不能升级为可写；不改普通 Session 授权，其他来源仍可由其原作者更新。

两项新增测试覆盖独立双来源的文件/进程降权、读仍可用且两处写均 EROFS、普通 Session 可继续写原来源，以及只读挂载获取 rw 被拒、获取 ro 成功。首轮夹具误用同一来源的重叠可写别名，被既有防护拒绝；改成两个独立来源后复测。Tauri/CLI 策略仍未接入，不能据此宣称 read-only 模式完成。


## 57. Tauri read-only 策略装配（2026-09-13 第一百一十八轮）

Tauri manager 支持 read-only：创建独立 Git 副本并持久化 mode，恢复拒绝 mode 与冻结策略不一致；文件/进程工厂同取 ro 权限，收尾不合并副本改动。显式 manual/auto-if-clean 在创建任何资源前拒绝，cleanup 沿用策略。创建 Git 元数据仍要求基础仓库可写授权，不能据此对只读授权仓库执行写操作。

新增测试重建 manager 恢复只读副本、读成功/写 EROFS、实际 Tauri Bash 工厂传 writable=false，以及策略不一致和非法合并拒绝。工作区装配 12 项 + 真实持久崩溃 3 项共 15 项通过，Tauri 类型检查通过。本轮 Bash IPC 使用替身；原三个崩溃窗口是 worktree 模式，不能算只读崩溃实测。CLI 实现与真实桌面只读验收仍未完成。


## 58. 真实桌面只读工作区（2026-09-13 第一百一十九轮）

在新的隔离数据根运行 read-only 版自动探针，经实际 Tauri WebView、目录/Git IPC、SQL sidecar 与 Bubblewrap。产物 `.tauri-acceptance/native-workspace-readonly-uzuph560/workspace-probe-result.json` 记录：Write success=false、EROFS；Bash 输出 base 后写入被拒，exit 1、Read-only file system；Read success=true、内容 base；普通 Session base=base；Run exit=succeeded、finalization.status=succeeded。

宿主磁盘复核基础文件仍 base，git worktree list 仅基础仓库，.intents 为空。Bash 的 success=true 表示工具调用完成，不能掩盖输出中的 exit 1；本例该退出码是只读拒绝的预期证据。

测试使用临时 main 探针入口，构建后已恢复源码，验收后重建正常前端/原生二进制。探针进程由 45 秒 timeout 退出。此证据不是用户点击操作或真实桌面重启验收；CLI 只读实现及完整目标仍未完成。


## 59. CLI OCI 只读装配（2026-09-13 第一百二十轮）

CLI 配置接受 OCI read-only，禁止 native 和回合并；运行时文件挂载、Bash、TTY 和新增授权均限制为只读。Git 副本管理由宿主 shell 单独执行，Agent 不复用该管理 shell。恢复复用共享 manager 的租约，--set-home 组合在创建运行时资源前拒绝。

配置/OCI 参数/授权测试验证单次与交互挂载均 ro，即使 Task 或历史 grant 标记 write 也不会放宽。最终执行 `pnpm --filter @itookit/cli test tests/config.test.ts tests/shell.test.ts tests/workspace.test.ts tests/worktree-run.test.ts`，4 个文件、33 项全部通过，其中 5 项真实 Git worktree 回归覆盖文件工具定位、清理、脏副本保留及崩溃恢复复用。CLI TypeScript 检查通过；文档检查通过（76 份活文档、5 条历史表述告警）。当前 command -v podman/docker 无输出，没有真实容器端到端证据；此实现不声明 CLI 只读完整验收通过。


## 60. OCI 工作目录映射修复（2026-09-13 第一百二十一轮）

额外挂载 `/external/data → /data` 时，原实现把 cwd 映射到未挂载的 `/mnt/grants/extra/sub`；会话虚拟 cwd `/workspace/sub` 则静默退回 `/workspace`。新增单次命令/交互 TTY 两条回归先复现失败，再修复为按实际挂载目标映射；保留虚拟子目录，嵌套宿主来源优先匹配最具体挂载，越出挂载范围的 cwd 明确拒绝。

`pnpm --filter @itookit/cli test tests/config.test.ts tests/shell.test.ts tests/workspace.test.ts`：3 个文件、30 项通过。CLI TypeScript 检查通过；文档检查通过（76 份、5 条历史告警）。这些是参数构造证据，不能替代真实 OCI 容器执行；P1-03 仍开放。


## 61. 记忆管理界面持久化（2026-09-13 第一百二十六轮）

`ui/app-shell/tests/memory-dialog-storage.test.ts` 使用真实 LocalFSBackend、NodeSqliteSidecarDb、Kernel、SessionRepository、SessionManager，DOM 驱动生产记忆对话框。新建后编辑，完全关闭 VFS/数据库与 Kernel 再重建，条目正文仍为编辑值；通过重开对话框删除，再次关闭重建后列表为空。对话框打开后把 SessionManager 绑定切到另一会话，窗口写操作仍指向原 Session，另一会话无条目。测试中仅 Agent 配置与宿主租约决定使用固定替身，原生 showModal 用 jsdom 适配；不包含真实 WebView、Tauri IPC、OS 进程重启或断电持久性。


## 62. Memory 已提交操作的 CLI 进程恢复（2026-09-13）

新增 `apps/cli/tests/crash-matrix.test.ts` 的两个参数化场景，执行真实 CLI 子进程、HTTP mock 模型和 LocalFS/SQLite 存储。模型先调用 `memory_write`；删除场景再调用 `memory_remove`。服务器收到包含工具成功结果的下一轮请求时，对 CLI 发送 SIGKILL，不返回该轮模型结果。

恢复前重新打开磁盘，核对记忆内容（写入存在、删除为空）和工具 Effect 的成功回执、单次执行次数。普通 `resume` 在未决 LLM Effect 上退出 3，未增加模型请求；显式 `retryIndeterminate` 后仅补模型调用，Run 成功。恢复前后对整个记忆版本记录和工具 Effect 记录做相等断言，避免重复删除因结果仍为空而漏检。

验证命令：`pnpm --filter @itookit/cli test tests/crash-matrix.test.ts -t 'preserves a committed memory'`。两项通过，其余六个既有故障场景因筛选未执行；CLI 类型检查通过。进程崩溃后仍等待未决 Effect 的既有 30 秒租约，不将观察等待当作停止失败。

边界：此处覆盖记忆操作及其成功回执已持久化、下一轮模型调用尚未返回的窗口。尚未覆盖记忆 CAS 提交与 Effect 回执之间的强杀、提交前强杀、真实云供应商或 Tauri 窗口；不据此宣称 Memory 故障矩阵完成。


## 63. Memory 缺失成功回执的 CLI 进程恢复（2026-09-13）

`apps/cli/tests/fixtures/memory-crash.ts` 是专用测试入口：包装 TaskMemoryService.invoke，在目标服务调用前，或真实服务完成存储变更后、返回工具结果前，直接向本进程发送 SIGKILL。生产 CLI 不加载该入口，也没有增加故障注入开关。实际 CLI、Durable Agent、tool.call、LocalFS/SQLite 和 HTTP mock 均参与执行。

`crash-matrix.test.ts` 的 `blocks an unreceipted` 参数化用例覆盖 memory_write/memory_remove × before/after 四个窗口。删除场景先完成写入。每次崩溃后重开磁盘，分别核对条目是否存在，以及目标工具 Effect 仍处于 leased、尚无成功回执。普通 resume 等待租约并将工具置为 TOOL_INDETERMINATE，退出 3；期间模型请求数不增加，记忆版本不变。显式 retryIndeterminate 后才重放未决工具并继续模型调用，检查最终数据、成功 Effect 和 Run 终态。

验证命令：`pnpm --filter @itookit/cli test tests/crash-matrix.test.ts -t 'blocks an unreceipted'`。四项通过（124.76 秒），其余八项因筛选未执行；CLI 类型检查通过。

边界：这是服务调用前、服务已提交且回执未写入的进程崩溃，未注入 SQLite 事务内部断电。无法从缺失回执推断存储操作是否发生，故默认阻断是预期行为。显式重放无条件写可能再次更新记忆版本；不提供 exactly-once 承诺，也不把内容摘要条件视为操作去重标识。真实云模型、Tauri 窗口、条件写冲突后的人工处置及独立 retention/GC 故障仍需各自证据。


## 64. 发送成本归因口径修正（2026-09-13）

新增可维护探针 `apps/cli/tests/fixtures/profile-send-cost.ts`，修正旧临时探针合并操作/归因计数、混入事件轮询与收敛期的问题。详见 [sidecar 读取成本 §0](design/vfs-sidecar-read-cost.md)。两次独立临时数据根运行均为发送前 554 次 sidecar 逻辑调用，本地耗时 63/64 ms；操作分布一致。CLI 类型检查通过。

命令：`pnpm --filter @itookit/cli exec node --import tsx tests/fixtures/profile-send-cost.ts`。需要本地 HTTP 监听权限，沙箱拒绝后按权限机制重试。探针不访问用户 profile，完成后释放运行时、关闭服务并删除本次临时数据根。

这项仅建立当前树的无 GUI 归因基线，没有修改执行路径，也没有改善或重新验证真实 Tauri 发送性能。旧 1804 总数与缓存百分比不再作性能决策证据；P0-02 的 ≤2 秒 / ≤100 次完整 IPC 目标仍未达成。


## 65. 合并托管资源清理候选事务（2026-09-13）

`ManagedResourceStore.sweep` 在资源状态扫描事务内收集 cleanup 候选，避免随后为枚举候选重复开启事务。候选不作为执行授权：`runCleanups` 在认领每条清理操作时仍重读状态/重试期限；外部清理、停止回执与释放容量保持原路径。

验证：`pnpm --filter @itookit/durable-kernel test` 最终实现 4 文件 / 202 项通过，含 35 项资源测试；同包类型检查通过。发送成本探针最终树 532 次 sidecar 逻辑调用，begin/commit 各 64 次，对照改动前 554 次、各 74 次。中间测量 520–533 次表明后台调度有波动，详见 [读取成本 §0.1](design/vfs-sidecar-read-cost.md)。

未运行新的 Tauri 窗口性能验收，不能换算成真实 IPC 降幅或宣称 ≤2 秒 / ≤100 次目标达成；未缩减任何持久化、清理确认或恢复要求。


## 66. 减少目录布局前置读取（2026-09-13）

`ensureTree` 改为从目标向上找最近已有父目录，再按顺序创建缺失目录。未引入缓存或跳过底层访问检查。`protocol.test.ts` 新增计数和删除重建回归：已有深目录一次 exists、两级缺失目录三次 exists，删除后再次确保目录可重建。内核整包 203 项通过，类型检查通过。

同一发送探针本轮 486 次 sidecar 逻辑调用、getMetaExt 70 次、事务 59 组、本地 65 ms。与上轮 532 次的差值含调度波动，不整体归因于本改动；尚无新真实桌面延迟或总 IPC 证据。详见 [读取成本 §0.2](design/vfs-sidecar-read-cost.md)。


## 67. SeqFile 批量读取复用路径解析（2026-09-13）

`SeqFileOps.getEntries` 在同一次批量调用内只解析一次路径；不跨调用缓存。新增两项回归核对 N 字段一次解析、下一批目标变化、空批次无读取与路径失效时拒绝后端读取。VFS 19 文件 / 175 项与类型检查通过；内核调用方整包 203 项通过。

发送探针本轮 482 次 sidecar 逻辑调用、getMetaExt 66 次、59 组事务、本地 66 ms。比前次少四次元数据读取，但没有合并字段 SQL；实机 IPC 与延迟目标仍待验证，详见 [读取成本 §0.3](design/vfs-sidecar-read-cost.md)。


## 68. 桌面公开 invoke 计量入口（2026-09-13）

trace 开关新增公开 API 命令计数，采用 Vite alias 包装，避免写入 Tauri 不可变内部属性。原 VFS/sidecar 归因字段继续保留；诊断写入旁路计数，记录失败调用但不记录载荷。两项测试验证冻结内部对象、普通/trace 分支、计数快照及日志旁路；桌面类型检查、正常前端构建通过。

追加构建级验证：`node apps/tauri-app/scripts/verify-ipc-trace.mjs` 通过，覆盖官方事件模块相对 core 导入、订阅/退订计数及冻结宿主对象。构建不写生产 dist。尚未运行新的 trace 桌面窗口。公开 invoke 计数不能代替底层 IPC 总量；Tauri 内部直接调用和传输重试仍需核对，见 [读取成本 §0.4](design/vfs-sidecar-read-cost.md)。


## 69. 真实 WebView 验证公开 IPC 计量（2026-09-13）

使用 `VITE_MINDOS_TRACE=1 pnpm --filter tauri-app build` 和 `cargo build --offline --features tauri/custom-protocol --manifest-path apps/tauri-app/src-tauri/Cargo.toml` 构建。全新 `/tmp/mindos-trace-window-VPy9Iq` 数据根经 Xvfb + dbus-run-session 启动，设置 MINDOS_ROOT 和 `--home` 指向该目录；未使用用户 profile。30 秒 timeout 返回 124，属于预定结束，不作为自然退出或取消确认验收。

真实 WebView 在 `2026-09-13T14:14:55.745Z` 写入一条 trace：VFS ops=23（stat 22、mkdir 1），sidecarOps=11（getMetaExt 11），公开 API ipcOps=70。命令分布为 fs_mkdir 1、plugin:sql|select 28、fs_stat 36、fs_stat_many 4、fs_read_dir 1。同一窗口逻辑计数 34 与 API 调用 70 的差异，直接证明二者不可等同。30 秒内只产生此一条变化日志，不据此推算发送延迟或长期空闲指标。

验证后已重新执行普通前端构建及同一 cargo 构建，均通过；当前 dist 与原生二进制未保留 trace 开关。原始日志位于上述临时目录，持久证据以本节记录及 `src/log/vfs-trace.ts`、`src/log/traced-core.ts`、构建验证脚本为准。

本次没有发送消息，没有核对内部 Channel 直接调用或底层重试，不关闭 P0-02 的真实发送 ≤2 秒 / ≤100 次完整 IPC 要求。


## 70. 当前树真实窗口发送样本（2026-09-13）

使用 trace 前端与自包含原生二进制、Xvfb/dbus-run-session、新建数据根 `/tmp/mindos-send-window-1Ebh04` 及本地 OpenAI-compatible mock（18439 端口）。通过窗口“会话 → + 会话”输入名称 probe 并确认，再双击会话行；无障碍树确认消息框位于 @367,383 882×54，点击后输入 ping 并按 Return。旧 focusbig 依赖 EditableText，而当前树的输入框只暴露 Action/Text/Component，故不能继续以该脚本返回值判定输入框不存在。前面的未打开输入框尝试未产生模型请求，不计为样本。

按键前时间为 `2026-09-13T14:24:55.489Z`，mock 收齐请求为 `14:24:58.196Z`：**2.707 秒**。请求为 `/v1/chat/completions`、stream=true、mock-model，最后用户内容 ping。该计时包含按键注入与实际发送处理，不是服务端完成响应时间，仍高于 ≤2 秒目标。

trace 的两个覆盖区间为 `(14:24:55.246, 14:24:57.260]` 和 `(14:24:57.260, 14:24:59.262]`，公开 API 请求分别 353 / 600，合计 **953**。区间含发送前约 243ms 和请求到达后约 1066ms 的操作，不能记作精确“发送到 Provider”IPC 总数，也不能与旧 584–590 逻辑计数直接比较；尚需动作边界快照和内部直调覆盖。消息回复内容未在此次无障碍快照中核验，本轮只作为请求到达与计量样本，不证明整个回复链路成功。

原始 mock.log、send-at.txt、var/log/vfs-trace.log 与快照均在上述临时根；关键数值持久记录于本节。实验后已恢复普通前端和普通原生构建，均通过。P0-02 保持未完成。


## 71. P0-00 收口：`auto-load` 覆盖、多层级规则取舍与真实窗口严格闭环（2026-09-13）

P0-00 此前只有「项目规则 + Skill 进入真实窗口请求」的证据，无法严格区分**持久身份恢复**与 `autoLoad`/重新匹配：文件系统来源只能表达 `reference → autoLoad=true` 与 `action → 不可加载`。本轮补上表达能力和取舍，并在真实窗口取到四段闭环。

### 71.1 实现与设计

- `SKILL.md` frontmatter 新增 `auto-load`（可选布尔）：`autoLoad` 仍由 `trigger-strategy` 推导（reference 默认 true、action 恒 false），但 reference 可用 `auto-load: false` 显式关闭自动注入。这类定义仍可被 `load_skill`、Skill 面板和 `/sk-<id>` 显式加载并登记持久身份，只是新运行不因策略自动注入——正是区分「持久身份恢复」与「autoLoad」所需的定义。见 [Skill 设计 §5](design/skill-design.md) 与 `SkillFrontmatter`（`tools/src/contracts/fs-skill-types.ts`）。
- **多层级规则取舍**：项目规则只取项目根的 `_agent/AGENT.md`；parent-fs/local-fs 层级的 `_agent/AGENT.md` 既不合并也不替换，避免切换 cwd 静默换掉项目指令。Skill 仍按层级级联发现，同名 id 由更深层级覆盖。见 [Skill 设计 §3](design/skill-design.md)。

### 71.2 包级 / CLI / 宿主装配回归

| 范围 | 证据 |
| --- | --- |
| 文件来源 | `kernel-adapters/src/skill/session-file-source.test.ts`（新增 3 项）：`auto-load:false` 保持 reference 且 `autoLoad=false`；action 即使写 `auto-load:true` 也不自动加载；Skill 级联且项目规则锚定项目根；cwd 离开项目根返回空 |
| 严格语义（真实 runtime + Kernel + 文件来源） | `session-skill-restore.test.ts`（2 项）：从未加载的 Session 在非匹配消息下拿不到正文（证明 autoLoad 关闭）；命中后加载并持久 `["review"]`；重建作用域后非匹配消息按持久身份恢复；显式 unload 后新作用域不再恢复；再次命中可重新加载 |
| 桌面宿主装配 | `app-shell/tests/tauri-host-skill-context.test.ts`（3 项）：`createApplicationRuntime({ownerKind:'tauri'})` + `TauriSkillSource` 经 `createSessionSkillControls` 完成同一严格闭环 |
| 文件来源（Tauri 薄封装） | `app-shell/tests/tauri-skill-source.test.ts`（4 项）：新增 `auto-load` 覆盖与「嵌套 AGENT.md 不替换项目根规则」 |
| CLI 半边 | `apps/cli/tests/run-skill-context.test.ts`（2 项）：真实 CLI runtime + 记录型 mock；`auto-load:false` 的非匹配新 Run 只有项目规则、无 Skill 正文且 `kernel-adapters.skills.loaded` 未写入；命中的 Run 注入正文并持久身份 |

计数：kernel-adapters 100→**104**（15 文件）、llm-common/app-core/tauri-app 类型检查通过、CLI 类型检查通过、`docs:check` 76 份通过（5 条历史告警）。

### 71.3 真实窗口严格闭环（Xvfb + dbus-run-session + AT-SPI）

用当前前端 dist 重新 `cargo build --offline --features tauri/custom-protocol`（embedded assets），全新数据根 `MINDOS_ROOT` + `--home`，通过种子脚本把宿主目录 `<root>/home/admin/proj` 以 `admin-home:/proj` 挂到 `/workspace` 并设为 cwd；`_agent/AGENT.md` 为 `Always cite the interface contract.`，`_agent/skills/review/SKILL.md` 为 `description: Review changes interface` + `auto-load: false`、正文 `Check every changed interface.`、compact `[红线] Preserve access checks.` + `Background note.`。mock 逐字落盘每个请求体；每段都是**新进程 + 新 Xvfb/dbus**（真实宿主重开），段间使上一实例的租约过期。

| 段 | 输入 | 当前运行的系统消息 | 持久 `kernel-adapters.skills.loaded` |
| --- | --- | --- | --- |
| p1 命中 | `review changes now` | agent 提示 + 项目规则 + `Skill review:` 正文 + `[Review] - Preserve access checks.` | `["review"]` |
| p2 重开非匹配 | `plain hello only` | 同上（仍含正文与关键规则） | `["review"]` |
| p3 卸载后非匹配 | `plain hello only` | agent 提示 + 项目规则 + **仅 L2 索引** `Available skills … {"id":"review",…}`，无正文 | `[]` |
| p4 再次命中 | `review changes now` | agent 提示 + 项目规则 + 正文 + 关键规则 | `["review"]` |

即：p2 证明**按持久身份恢复**（消息不匹配、`autoLoad=false`）；p3 证明卸载记录生效后不复活，但定义仍可发现（索引在、正文不在）；p4 证明卸载不是永久禁用。三段均未出现非红线的 `Background note.`，与 `aggregateCompactInstructions` 契约一致。

**边界（如实记录）**：

- p3 的「卸载」是把持久身份记录置为 `[]`，与实际面板/skill.unload 处理器写入的是同一条 `kernel-adapters.skills.loaded`；但**没有**通过真实窗口的设置面板复选框触发。本轮尝试点击面板 `Disable skill` 未生效：AT-SPI `Action.DoAction` 返回 `False`，按节点上报 extents 的 XTest 点击也无变化；该 Skill 列表渲染在 WebView 可达视口（约 500px 高）之下。真实 GUI 勾选/取消勾选的交互验收仍归 P0-04。
- 场景是单会话、单层挂载、本地 mock、Linux/Xvfb；多层级规则取舍只有来源与宿主装配级证据，没有嵌套挂载的真实窗口场景。真实云模型、其它平台与原生 GTK 选择器不在本轮范围。

## 2026-09-14：运行中 Session 删除后的界面收尾

验收基线为 `98e5407b`；从隔离快照执行 Tauri 前端构建与 `cargo build --offline --features tauri/custom-protocol --manifest-path apps/tauri-app/src-tauri/Cargo.toml`，使用嵌入资源的真实二进制、Xvfb/D-Bus/AT-SPI 和全新临时 profile。Provider 为本地 OpenAI-compatible mock，收齐请求后延迟 120 秒才回复。

复现：通过会话面板创建 live-close，输入消息并发送；窗口出现 RUNNING / Stop Generation，mock 收到 `/v1/chat/completions`。右键会话行 → 删除 → 原生 OK 确认后，列表与 `/var/lib/sessions` 下该 Session 目录已删除，但旧聊天仍显示 FAILED / Fetch is aborted、重试按钮和 Session not found。不能把这个结果记作完整删除 UI 验收通过。

修复：SessionWorkbench 的刷新与导航共用串行队列。已选 Session 的 manifest 明确返回 ENOENT 时关闭编辑器、释放文件上下文、显示会话选择提示并替换旧路由；普通 EIO 等错误仍可见，不推断成删除。核对覆盖 Session 及其文件/任务路径；分支变化仍更新路由。

复测：用修复后的前端与原生二进制重新创建临时 profile，连续执行创建 → 发送 → 确认运行 → 右键删除 → 原生 OK。模型请求在 01:10:58 UTC 收齐，确认删除发生在 120 秒延迟回复前；删除后无旧聊天、重试或 Session not found。结束该应用进程，重新启动同一数据根，列表仍为空，Session 目录未复活。过程没有调用内部删除 API。

本地定位：失败 profile `/tmp/mindos-live-close-r2gvit`，修复与重开 profile `/tmp/mindos-live-close-RVCjog`，其中 running/context/confirm/deleted/reopen 文本与 PNG 为当次证据；临时目录不是长期交付物。重现时按上述步骤建立新数据根，并将 mock 回复延迟到删除确认之后。窗口开发者工具中的字体 CSP 告警仍存在，本批未验收其修复。

自动回归先复现了删除后 active route 仍保留的失败，再验证 ENOENT 清理、EIO 保留和核对期间切换新 Session 不误关新编辑器。隔离 app-shell 196 项通过，30 项既有跳过；Tauri 类型、前端与原生构建通过。本场景只证明模型请求在途时的 Session 删除及重开；原生设备不确认停止、单独关闭但保留记录、真实超时/IPC 故障和其余 P0-02 矩阵仍开放。

## 2026-09-14：桌面本地字体与导航可访问名称

基线 `bc4a04fa` 的真实窗口报告 FontAwesome 兼容字体被 font-src CSP 拦截。生产 CSS 中一个较小的 woff2 被 Vite 内联为 data:font；桌面配置只允许同源文件及既有字体 CDN。Tauri Vite 构建设置 assetsInlineLimit=0，使资源以独立同源文件输出。未扩大 font-src 策略。

隔离构建核对 10 个 FontAwesome font-face 的 URL：均非 data URL，且各自引用的文件存在。重新构建嵌入资源的原生二进制，在全新 profile 的真实 Xvfb/WebKit 窗口，通过开发者控制台对 document.fonts 中 family 匹配 /Font.?Awesome/ 的每个 FontFace 调用 load()；10 项均返回 loaded，包含 Font Awesome 7/5 Brands、Free 与 FontAwesome 兼容面。初始控制台不再出现该字体 CSP 错误。诊断只加载字体并把结果临时显示为 DOM 文本，没有修改应用字体定义或 CSP。

静态导航链接补 aria-label，保留已有 title。AT-SPI 在鼠标停留于开发者工具时读到全部 11 个名称：AI Sessions、Projects、Anki Memory、Emails、Private Notes、Minds、Skills、Workflows、Agents、Mount directory…、Settings。此前多个导航链接只有悬停后才出现名称，不能把这种临时提示当稳定的无障碍名称。

证据定位：`/tmp/mindos-live-close-OJI72o/fonts.txt`、`fonts.png` 与 `nav-labels.txt`。复核命令：Tauri 前端构建、custom-protocol 原生构建、Tauri 类型检查、`node apps/tauri-app/scripts/verify-ipc-trace.mjs`（真实 Vite 配置的 trace 开关/内部调用回归）均通过。临时文件不是长期交付物，复测应从新 profile 重建窗口并重复上述 FontFace/AT-SPI 检查。

边界：本轮文件列表仍观察到部分方框字符，其来源需继续核对；FontAwesome 成功加载不证明所有 emoji、系统字体回退或全部控件都正确渲染。该项保留在 P0-04，未关闭其他平台、GTK 目录选择器、Skill 复选框或完整无障碍验收。

## 2026-09-14：Skill 复选框真实加载、卸载与重开

验收版本 `0113f24b`，沿用该提交已构建的嵌入资源 Tauri 二进制。使用三个独立应用进程及 Xvfb/D-Bus 会话，同一全新 profile；进程间等待 SQLite 中旧拥有者的 leaseUntil 自然到期。没有修改租约、Skill 加载身份或 UI DOM 来模拟交互。

准备：种子仅创建 p000 会话和 `/workspace` 项目目录授权；项目规则为 `Always cite the interface contract.`。`_agent/skills/review/SKILL.md` 定义 name=Review、description=Review changes interface、auto-load=false，正文为 `Check every changed interface.`。起始不预写 loaded 身份。模型使用记录请求体的本地 OpenAI-compatible mock，四次输入分别为 hello loaded、hello reopened-loaded、hello unloaded、hello reopened-unloaded，均不匹配 Skill 名称或描述。

操作：打开 AI Sessions → p000 → Chat Settings，在设置面板内部向下滚动，将 Review 的开关滚入可见区后鼠标点击。验收关闭了开发者工具，使用 1280×800 视口；在此布局中开关从 y=930 滚到 y≈643。无需改变面板 CSS。此前条目在视口下方只证明旧驱动未完成滚动，不证明该控件不能操作。

| 阶段 | 真实 UI / 进程 | 持久 loaded / version | 当次系统消息 |
| --- | --- | --- | --- |
| 加载 | 第一个进程点击 Enable skill，变为 Disable skill | `["review"]` / 1 | 有 Skill 正文、有项目规则 |
| 加载后重开 | 第二个进程面板仍为 Disable skill | `["review"]` / 1 | 有 Skill 正文、有项目规则 |
| 卸载 | 第二个进程点击可见开关，变为 Enable skill | `[]` / 2 | 无 Skill 正文、有项目规则 |
| 卸载后重开 | 第三个进程面板仍为 Enable skill | `[]` / 2 | 无 Skill 正文、有项目规则 |

身份由只读 SQLite 连接读取 kernel/shared.seq 的 kernel-adapters.skills.loaded 记录核对，模型侧只检查每次请求的 system 消息，避免把历史用户文本当作当前注入。四次请求的 UTC 时间为 01:40:07.843、01:44:42.642、01:45:16.069、01:47:03.232。临时证据根 `/tmp/mindos-skill-toggle-CGsFtZ` 包含四段 request/state JSON、截图、mock.log 与开关前后 AT-SPI 文本；这些临时产物不作为永久测试入口。

本轮无需修改实现，补齐 P0-04 的真实 GUI 勾选/取消及持久恢复证据。多层级嵌套挂载的项目规则窗口验收、严格 Skill 版本冻结、跨进程通知及其他平台要求仍开放。复现时使用新的临时 profile，保持 auto-load=false，不直接改 loaded 记录，并等待旧实例租约到期后重开。

## 2026-09-14：类型检查覆盖与包清单收口

基线 `35d63f53` 加本批清单变更的隔离快照通过根 `pnpm typecheck`，日志确认实际执行 24 个 workspace。新增 sync-server、app-settings、mdxeditor、vfs-ui、IndexedDB/LocalFS 后端的统一 typecheck 入口；编辑器原有 type-check 命令保留兼容。此前递归命令会跳过这些缺少同名脚本的包，不能仅用根命令退出成功推断覆盖完整。

其余两个 workspace：demo 是无独立 tsconfig 的手工 JavaScript 示例；app-shell 由宿主程序检查。使用 Web 与 Tauri 的 `tsc --noEmit --listFilesOnly` 合并列表，核对覆盖 app-shell 全部 12 个 src TypeScript 文件。此事实不包含测试文件，也不把 demo 的构建当作行为验收。

清单同时补齐 Tauri 对 llm-flow 的直接依赖与 app-shell 工作区崩溃测试对 tsx 的开发依赖，同步锁文件；移除 app-shell 指向已不存在文件的 ./layout 导出。仓库现有 TypeScript/JavaScript 消费端未发现该导入。`pnpm install --offline --frozen-lockfile --lockfile-only --ignore-scripts` 通过：这是 manifest/锁文件核对，不是全新依赖安装验收。

构建：`pnpm build:libs` 的 20 个带构建脚本的库全部通过；`pnpm --filter './apps/*' build` 的 CLI、同步服务、Web、Tauri 前端四个应用全部通过，CLI dist 的 help 命令通过。TypeScript 声明生成未报告错误，前端仍有体积提示。与 tsx 入口直接相关的 tauri-workspace-crash 三项真实 SIGKILL 回归通过。

本轮使用 Node 26.8.1 / pnpm 10.20.0 与已有依赖缓存，未运行完整测试矩阵、原生 Rust 重建或 GUI，不替代 P0-05 的最终验收。对应临时日志为 `/tmp/x1-manifest-types.log`、`x1-manifest-libs-build.log`、`x1-manifest-apps-build.log`、`x1-manifest-lock.log`、`x1-manifest-tsx-test.log`；长期复核应执行上述命令。

## 2026-09-14：Run 取消所有权与动态图崩溃恢复

基线 `bf477a12` 加本批测试/文档的隔离快照：完整 CLI crash-matrix 12 项通过（约 374 秒），另一个真实双进程取消拒绝用例通过，共 13 项。CLI 类型检查通过。本轮未修改生产实现，补强了既有功能的故障证据。

新增崩溃取消场景由本地模型服务器收到首个请求后、回复前 SIGKILL 真正的 CLI；测试确认 exit signal 为 SIGKILL，等待旧 Session/调度租约自然到期。新的测试宿主调用真实 resumeCommand，不授权重放时返回 3；持久 Effect 确认为 indeterminate，模型提交仍为一次。再调用 cancelCommand 返回 0，manifest 为 cancelled；再次 resume 返回 1，没有新增模型请求，持久 Task ID 集合保持不变。恢复与取消是命令 API 的新宿主实例，不将它描述为独立 cancel 可执行文件进程。

新增动态 spawn 场景在补丁产生的节点已经向模型提交请求时杀死 CLI。恢复前确有一个 leased Effect；先验证缺少重放授权时阻塞，再显式授权同一逻辑 Effect 重放。恢复后 Run succeeded，所有持久 Task succeeded，Task ID 集合与崩溃前完全相同；模型请求恰为初次请求和授权重放两次。Task 身份核对比单独比较请求次数更强，但不覆盖补丁提交与检查点写入之间的全部窗口，也不代表自动委派 TaskGroup 故障矩阵完成。

另一侧边界由 run-live-owner-refusal.test.ts 启动两个真实 CLI：第一进程的模型请求挂起且持有租约；第二进程执行 cancel，以退出码 2 拒绝并报告持有者。拒绝后连接保持、拥有者仍存活；向拥有者发送 SIGINT 后退出码 130，模型连接关闭，manifest 持久为 cancelled，模型只收到一次请求。测试排空两个子进程输出，避免管道填满干扰运行。

复核：`pnpm --filter @itookit/cli exec vitest run tests/crash-matrix.test.ts` 与 `pnpm --filter @itookit/cli exec vitest run tests/run-live-owner-refusal.test.ts`。临时日志 `/tmp/x1-crash-complete.log`、`/tmp/x1-cancel-owner.log`；测试源包含配置、故障点、持久记录读取与断言，临时数据根在测试后清理。

范围为本机真实 Node/SQLite/CLI 与本地 HTTP mock，不证明供应商不会重复计费、跨主机时钟/存储排他或物理资源 fencing。crash-matrix 内既有 after-reply 故障以发送回复后杀进程为触发，不声称精确锁定所有持久提交间隙。P1-01/P1-02 及其余协议故障矩阵继续开放。
## 2026-09-14：Session 新建目标与桌面关闭语义复核

基线 `87613126` 加本批选定代码，复用隔离快照 `/tmp/x1-feature-verify-w_wua9ix` 的本机依赖与 Rust 缓存。真实 Linux Tauri/Xvfb/D-Bus/AT-SPI，正常前端与 `tauri/custom-protocol` 原生构建；本地 OpenAI-compatible mock 收齐请求后等待 120 秒，并记录响应连接关闭时间。未替换 UI 删除/发送行为或直接修改 Session 持久记录。

- 复现：创建并选中 `close-preserve`，点击“+ 会话”再输入名称，旧实现试图在 Session 虚拟目录内创建，原生弹窗显示 `创建失败: [ENOENT] getNodeType: Source operation failed: getNodeType`。新实现经 `FileCreationConfig.resolveParent` 将 Session/Task 容器映射到所属虚拟分组；Files 内仍保留真实目录。映射覆盖内联新建和直接创建命令。它不授予写权限，后端继续校验。
- 回归：`ui/app-shell/tests/session-create-parent.test.ts` 使用真实 SessionRepository/SessionFilesService/VFS UI，分别覆盖根目录和分组内选中已有 Session 后新建同级会话，并在原 Session 的 attachments 内创建文件、断言没有产生第三个 Session。修复前两项均失败，修复后两项通过。app-shell 完整回归 198 项通过、30 项既有跳过；vfs-ui 88 项通过。增加附件断言后两项定向重跑通过；不重复累加测试数。第一次沙箱内 app-shell 的三项 SIGKILL 测试因 `spawnSync git EPERM` 被阻止，正常提权重跑完整包通过。
- Tauri 类型、前端及原生构建通过。真实窗口使用新构建重开原数据根，在已有 Session 选中时创建 `second-session` 成功：侧栏两个会话并存，原会话的失败消息仍在，未弹新建错误。
- 关闭边界：切换到 Projects 只隐藏缓存工作区；在 Session 列表切到另一个会话会解绑旧编辑器，但后台请求仍运行。两者都不是 Kernel `closeSession`。目前独立“关闭 Session 并保留记录”的窗口入口仍缺，P0-02 保留该要求，不能用切换或删除替代。
- 超时观察：第一条请求 `hello close-preserve` 于 `02:47:06.090Z` 收齐，`02:48:06.075Z` 连接关闭且 `responseEnded=false`；第二条 `hello switch-close` 于 `03:11:08.550Z` 收齐，`03:12:08.538Z` 同样关闭。约 60 秒的客户端超时发生在 mock 120 秒回复前，不能归因于窗口切换。SQLite 只读核对两个 Task 均持久 `failed`、两个 Session 数据目录保留；重开首条显示 `FAILED / Fetch is aborted`。超时期间曾出现总体 Error 而消息仍 RUNNING 的画面，live 状态收敛和明确超时原因尚未据此完成。

复现步骤：配置本地等待 120 秒的 mock；新建并选中 Session；再次点“+ 会话”应在同组产生同级会话；发送请求后切到 Projects 或另一个 Session，观察服务端连接仍在，等待约 60 秒超时，再重开原 Session 查看记录。关闭内核的验收需另有明确操作入口，不能把这些导航当作停止。

临时证据：数据根 `/tmp/mindos-live-close-VYKRwL`，`second-created.png`（旧错误）、`fixed-create.png`、`timeout-reopened.png`、`switch-inflight.png`、`actually-switched.png`、`mock.log`、`closed-storage.json`。日志 `/tmp/x1-close-create-before.log`、`/tmp/x1-close-create-files.log`、`/tmp/x1-close-shell-final.log`、`/tmp/x1-close-vfsui.log`、`/tmp/x1-close-types.log`、`/tmp/x1-close-front.log`、`/tmp/x1-close-native.log`。长期复核以本提交回归和上述步骤为准；临时文件会消失。验收后关闭本次应用与 mock，产物保留正常入口。
## 2026-09-14：模型超时与用户取消的原因保留

基线 `abacbe43` 加本批选定文件，隔离快照 `/tmp/x1-feature-verify-w_wua9ix`。修复 LLMDriver 将内部首响应/流中停顿超时与调用方取消都转为无原因 AbortError 的问题：RequestCancellation 保留首个取消原因，即使 fetch/ReadableStream 用 `Fetch is aborted` 覆盖原因，也分别返回 TIMEOUT 或 ABORTED。流式迭代异常经过同一原因恢复；完成、失败及消费者结束迭代均清理计时器和外部监听器。已取消请求不派发，已超时的同一请求不继续在失效 signal 上重试。这里没有用 Promise.race 把设备未停止伪装成已停止，仍等待实际 Provider 读取结束。

六项驱动回归覆盖流式/非流式首响应超时、首块后滚动停顿期限、用户取消、调用前已取消、消费者结束流。HTTP 传输替身故意丢弃 signal.reason 并抛 AbortError；旧驱动六项均失败，新驱动六项通过。完整 driver-llm 55 项、app-shell 199 项通过，30 项既有跳过。宿主新增真实 runtime/Kernel/模型失败事件回归，核对终态 message:status 指向已挂载的助手节点；该场景旧代码也通过，不将其声称为 UI 残留缺陷的复现。设备层/Tauri 类型、前端与 custom-protocol 原生构建通过。

真实 Linux Tauri/Xvfb/D-Bus/AT-SPI：新建会话，窗口发送 `hello timeout-check`；本地 mock 收齐请求后等待 120 秒。请求于 `03:27:47.271Z` 收齐，`03:28:47.256Z` 响应连接关闭且 `responseEnded=false`，即客户端约 60 秒超时、早于 mock 回复。SQLite 只读核对 Task `task_9c43e467-32d1-4359-b620-3aeafc974bee` 及 Effect 为 failed，持久错误为 `Request timed out after 60000 ms without a response`，Task updatedAt 为 `1789356527314`（连接断开后约 58 ms）。真实画面随后显示 FAILED 与相同错误文本。

边界：连接断开后 2 秒的第一张截图仍显示总体 Error / 助手 RUNNING；打开 Inspector 后画面已显示 FAILED 和错误卡片。现有证据无法区分绘制延迟与事件消费延迟，不能以最终画面替代有界 live 收敛证明，P0-02 保留此项。原生已停止这里只指本地 HTTP 连接被关闭，不证明远端供应商计算或计费已停止。原始结构化错误码并未据此宣称完整穿透所有持久错误序列化层。

可复现命令：`pnpm --filter @itookit/driver-llm test`、`pnpm --filter @itookit/app-shell test`；窗口步骤：本地 OpenAI-compatible mock 等待 120 秒后回复，发送消息并观察约 60 秒连接断开，核对错误卡片和 Task/Effect 持久错误。数据根 `/tmp/mindos-live-close-VIgRBk`；截图 `timeout-inflight.png`、`timeout-live.png`、`console.png`，持久摘录 `timeout-persisted.json`，请求日志 `mock.log`。测试/构建日志 `/tmp/x1-timeout-before.log`、`/tmp/x1-timeout-device.log`、`/tmp/x1-timeout-shell.log`、`/tmp/x1-timeout-types.log`、`/tmp/x1-timeout-front.log`、`/tmp/x1-timeout-native.log`。临时文件会消失，长期证据以本提交测试与步骤为准。

补验：旧拥有者租约自然过期后，用新进程重开同一数据根，`timeout-reopened.png` 显示原消息 FAILED 与同一 60000 ms 超时原因。随后发送 `hello user-cancel`，mock 于 `03:36:49.210Z` 收齐，点击真实停止按钮后 `03:36:49.883Z` 记录连接关闭；`user-cancel-live.png` 显示 ABORTED，SQLite 中 Task `task_23d85d37-042a-4541-9a95-f48722ea2592` 和 Effect 为 cancelled、cleanupPending=false，未误写 TIMEOUT，前一条超时仍为 failed。摘录见 `timeout-and-cancel-persisted.json`。取消卡片仍写“执行失败”和 Task cancelled，用户取消文案优化仍属 P0-02，不据此宣称三态文案完成。验收结束后关闭本次应用和 mock，正常构建产物保留。

## 2026-09-14：发送→Provider 动作边界的真实 IPC 计量

此前只有覆盖较宽的区间计数（§70 的 953 次含边界外操作），不能与“单次发送 ≤2s / ≤100 次”直接比较。本轮补上缺失的那一段接线，并取得**动作边界内**的真实数字。

实现：`apps/tauri-app/src/log/send-boundary.ts` 定义一个不嵌套、有上界的 `send-to-provider` 动作；起点是命令总线上的 `SessionCommand.Send`（Session 事件按已绑定 Session 分频道，启动期订阅会因尚未绑定而是空订阅，故改在总线处观察），终点是 Provider 响应头（`TauriLLMLogger.logResponse`，即设备已收到请求并开始应答）。超过 120 秒无应答的窗口会被有界关闭并留下记录，避免下一次发送被静默吞掉。仅在 `VITE_MINDOS_TRACE=1` 时生效，普通构建不接线。

真实 Linux Tauri（Xvfb `:98` + 会话总线 + AT-SPI；自包含正常前端与 `tauri/custom-protocol` 原生构建；全新数据根；本地 OpenAI-compatible mock `18471`；窗口内点消息框输入 `ping`/`ping2` 后按 Return）：

| 样本 | 按键→mock 收齐 | 动作 `elapsedMs` | 公开 IPC | sidecar 逻辑调用 | begin/finish 事务对 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2.644 s | 2870 | **1301** | 863 | 213 / 213 |
| 2 | 2.736 s | 2731 | **1173** | 787 | 193 / 192 |

样本 1 的 IPC 分布：`sidecar_select` 541、`sidecar_begin`/`sidecar_finish` 213/213、`fs_stat` 121、`sidecar_execute` 95、`fs_stat_many` 86、`plugin:sql|select` 14、`fs_read_dir` 9、其余少量。逻辑热点为 `getRecordField` 376 / `getMetaExt` 106 / `setRecordField` 87 / `listRecordFields` 73。

**结论：≤2 秒 / ≤100 次两个阈值均未达成**，分别超出约 1.4 倍与 12–13 倍。延迟与 IPC 数近似线性（约 2.2 ms/次），说明瓶颈是宿主往返次数本身，而不是某一次慢调用。同口径的 Node 无界面探针（`apps/cli/tests/fixtures/profile-send-cost.ts`，进程内 LocalFS/Node SQLite）为 868 次逻辑调用 / 67 ms，与桌面 `ipcOps` 的差值即 Tauri 通道与 `fs_*` 命令的额外往返；两个入口不可互相换算。

方向与边界：`https://github.com/mushuanli/vfsdriver-local/blob/main/AGENTS.md` 明确要求减少 IPC 只能走**原子批量操作**，不得为省往返省略事务内的跨进程 rename journal 恢复检查；因此“只读操作不经事务”这条捷径不可用。真正能跨过阈值的是协议层改动（把逐字段/逐路径的 SeqFile 读写合批，或让调用方显式传参而不是每个逻辑步骤重读同一记录），属尚未实施的设计，不能以本次测量宣称完成。

复现：`VITE_MINDOS_TRACE=1 pnpm --filter tauri-app build` 加 `cargo build --offline --features tauri/custom-protocol --manifest-path apps/tauri-app/src-tauri/Cargo.toml`，Xvfb + 会话总线 + AT-SPI 启动，发送后在 `<rootDir>/var/log/vfs-trace.log` 取 `"kind":"action","label":"send-to-provider"` 行。窗口驱动与数据根在临时目录（`.tauri-acceptance/measure/`，已 gitignore），长期证据以本节数字、`send-boundary.ts` 与 `ui/app-shell/tests/trace-send-boundary.test.ts` 为准。验收后已恢复普通前端与原生构建。

环境注意（可复现性）：本机 `/run/user/<uid>` 对沙箱只读，AT-SPI bridge 无法在其下绑定套接字并会导致应用进程被带走；`XDG_RUNTIME_DIR`/`XDG_CACHE_HOME` 必须指向可写目录。命令隔离环境各自持有独立 `/tmp` 与 PID 命名空间，会话总线套接字因此要放在共享的数据目录下（X11 走抽象套接字不受影响），否则跨调用驱动无障碍树会连接失败。这两点此前未记录，是“AT-SPI 需要可写缓存与显示会话”之外的具体原因。

## 2026-09-14：运行中的 Session 真实窗口关闭并保留记录

此前没有任何窗口入口能在运行中停止一个 Session 而保留历史（切换工作区/会话都不是 Kernel `closeSession`，删除又会清掉记录）。本批新增 `SessionLifecycleService.closeSession`（停跑、等待外部停止确认、保留存储/manifest/文档）与 Session 侧栏右键项「关闭会话（停止执行，保留记录）」，与「删除」并列。

真实 Linux Tauri + Xvfb `:98` + 会话总线 + AT-SPI，本地 mock 接受请求后流一个分块且永不结束（`mock-hang.mjs`）：

- 侧栏右键真实出现菜单项「关闭会话（停止执行，保留记录）」（`@151,368 234x35`），与「新建 会话」「重命名」「删除」并列。
- 在运行的 Session 上（界面显示 `Stop Generation`、mock 已收齐请求于 `04:31:11.002Z`）点击该项（`04:31:22.378Z`）；mock 于 `04:31:22.831Z` 记录 `responseClosed:true, writableEnded:false`，即约 0.45 秒内确认外部连接停止。
- 只读核对 sidecar（`_meta/index.db`）：Task `task_99cfbf59-f212-41f3-b17b-dc5a194c0000` 持久 `status: "cancelled"`。
- **记录保留**：Session 数据目录 `var/lib/sessions/node-1789360202786-x8cphg2fg` 与其 `kernel/tasks/task_99cfbf59-…` 仍在磁盘；关闭不是删除。界面回到可再次发送的状态（出现「重试」）。

边界：本轮只核对了持久 Task 状态与记录存在性，未逐像素确认 live 状态文案与「执行已取消」气泡文本（无障碍树中聊天区因滚动坐标偏移，未取得可判读的文本节点）；该文案断言由 `ui/app-shell/tests/cancelled-history.test.ts` 与 `session-workbench.test.ts` 在 DOM 层覆盖。设备不确认停止时的有界失败仍只有包级证据（`session-delete-lifecycle.test.ts`），未做真实窗口版本。

同一窗口的第三次发送样本（同一边界口径）：`elapsedMs` 2753、公开 IPC **1290**、sidecar 逻辑调用 854、事务对 212/211，与上文两次独立样本一致。

## 2026-09-14：当前树全量回归（P0-05 阶段批次）

工作树 `3c3afe5d`，`git status` 干净（`dirty=0`）。Node 26.8.1 / pnpm 10.20.0 / cargo 1.98.1。复用本机依赖与 Rust 编译缓存，**未做全新依赖安装**。按 [TODO §4](todo.md) 列出的入口逐条执行，全部 rc=0：

| 阶段 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm typecheck` | 25 个 workspace 全部通过 | 32 s |
| `pnpm docs:check` | 76 份活文档通过（5 条历史表述告警） | <1 s |
| `pnpm styles:check` | 63 样式表 / 842 markup / 3939 类，无未覆盖类名 | 1 s |
| `pnpm build:libs` | 20 个库构建通过 | 31 s |
| `pnpm --filter @itookit/cli build` | 通过 | 1 s |
| `pnpm --filter tauri-app build` | 通过（普通前端，非 trace） | 5 s |
| `cargo test`（tauri-app src-tauri，offline） | **36 passed**, 0 failed | 3 s |
| `pnpm -r --filter '!@itookit/cli' test` | **1508 passed / 30 skipped**（190 文件，3 文件整体跳过） | 46 s |
| CLI 非崩溃测试（`--exclude tests/crash-matrix.test.ts`） | **108 passed**（27 文件） | 42 s |
| CLI crash-matrix（单独进程） | **12 passed** | 377 s |
| `cargo build --features tauri/custom-protocol` | 通过 | 3 s |
| `node --test scripts/tests/test-all.test.mjs` | **3 passed** | 1 s |

合计 **1667 项通过、30 项既有跳过**。与 2026-09-14 上一批记录（Vitest 1593 + 调度器 3 + Rust 36 = 1632）相差 +35；两批的 Vitest 快照并不相同（上批为 `a308eb65` 加选定文件的隔离快照），因此**不逐项归因**。可直接核对的确定增量是本批新增文件：`trace-send-boundary` 4、`cancelled-history` 4、`session-delete-lifecycle` +2、`session-workbench` +1、`host-restart-inflight` +1，以及 `session-terminal-node` 由 1 改为 2。app-shell 也首次纳入显式 typecheck（此前只有经宿主程序的间接覆盖）。

**这不是最终验收**：P0-02 的性能阈值仍未达成、P0-04 仍有未做窗口场景（见各自条目的剩余项），因此本批次证明的是“当前树在类型/文档/样式/构建/测试矩阵上全绿”，不能替代最终整树与 GUI 验收。真实安装包（`bundle.targets: "all"`）未构建：本机没有 AppImage/linuxdeploy 工具，也没有网络，故发布产物边界仍未验证。`release/dist/` 是**受版本控制但停留在 2026-09-04** 的 Web 静态产物，与当前树不同步，本轮未重新生成。

复现：在干净工作树按上表命令顺序执行；日志与阶段退出码见 `.tauri-acceptance/regress/`（已 gitignore，临时文件会消失，长期证据以本表数字与命令为准）。

## 2026-09-14：P0-04 平台边界——图标字体与原生目录选择器

**图标方框字符（根因已定位）。** 文件列表/导航栏图标是 emoji 码位，来自 `@itookit/common` 的 `getFileIcon`/`ENTITY_ICONS`（另有少量在 `vfs-ui` 中硬编码，如 `📁`/`📄`/`📁+`）。本机**没有安装任何 emoji 字体**：`fc-list | grep -ci emoji` 为 0，且 `fc-list ':charset=1F4C1'`（📁）、`':charset=1F5D1'`（🗑）、`':charset=2795'`（➕）**均为 0 条**——即没有任何已安装字体包含这些码位，所以必然渲染为方框。这与上一轮“10 个本地 FontAwesome 字体面加载成功”不冲突：FontAwesome 覆盖的是私有使用区图标，与这些 emoji 码位无关。结论是**宿主字体依赖**，不是本轮代码回归；标准桌面发行版（GNOME/KDE）自带 Noto Color Emoji 时正常，本容器/最小化系统上会显示方框。应用不自带 emoji 字体，这属于已记录的**支持边界**，未在本轮通过捆绑字体解决。

**原生 GTK 目录选择器（部分验证）。** 真实窗口点击导航栏 `#btn-add-mount`（`title="Mount directory…"`）后，经 `@tauri-apps/plugin-dialog` → XDG Desktop Portal（日志显示 `Successfully activated service 'org.freedesktop.portal.desktop'` 与 `org.freedesktop.impl.portal.desktop.gtk`）弹出了**真实原生对话框** `Select Folder`（1494×1144，AT-SPI 暴露“文件选择小部件”、侧栏“主目录”、`取消(C)`/`打开(O)`），而不是应用内自绘控件。截图 `.tauri-acceptance/measure/native-folder-chooser.png`（临时）。

边界：**未能完成一次真实选择**。选择收尾需要驱动原生对话框的路径输入，本环境的合成输入不可靠——键入 `/` 触发 GTK 位置栏时会出现丢字/重复字符（实测得到 `/ome/...`、`/home/lli/...` 两次错误路径），随后 `打开(O)` 未产生挂载记录（`/var/lib/kernel/local-sources` 为空，导航未新增工作区）。另外门户自身报告文档门户不可用：`fuse: device /dev/fuse not found` 与 `error: fuse init failed`，因为容器内没有 `/dev/fuse`。因此“原生选择器可用”只证明了**能打开且能返回**（对话框正常关闭），未证明选中目录后的挂载链路；P0-04 保留该要求。

**发布产物边界。** `apps/tauri-app/src-tauri/tauri.conf.json` 为 `bundle.targets: "all"`，但本机没有 AppImage/linuxdeploy 工具且无网络，未构建任何安装包；所有验收证据都基于 `target/debug/tauri-app` 开发二进制，不代表发布安装包的平台行为。受版本控制的 `release/dist/` 是 Web 静态产物且停留在 2026-09-04，与当前树不同步。

**其他平台。** 本机只有 Linux；Windows/macOS 的构建、安装、窗口行为与沙箱能力均**未验证**，不能由 Linux 证据外推。

仍未做的窗口场景（P0-04 保留）：多层级嵌套挂载下的项目规则（`_agent/AGENT.md` parent-fs/local-fs 不合并）真实窗口验收；原生选择器选中后的挂载链路；发布安装包。
## 2026-09-14：取消事件与界面终态文案

基线 `52754e9a` 加本批选定文件，隔离快照 `/tmp/x1-feature-verify-w_wua9ix`。SessionRunCoordinator 在执行取消后的 error 事件保留 `code: ABORTED`，HistoryView 和状态指示器按该标记显示“执行已取消”，操作为“重新执行”，取消卡片使用中性色；非取消错误仍为失败和重试，不从 message 中是否含 aborted 猜测原因。新文案中英同步。重开的 aborted 节点原因区同样使用中性色，保留原始原因文本。

回归覆盖真实 runtime/Kernel 的失败与取消终态事件、DOM error 消费、TIMEOUT/缺失 code 不误判、原因文本转义、取消状态结束 loading。app-shell 204 项与 llm-session 116 项通过，共 320 项；30 项既有跳过。llm-session、llm-ui、Tauri 类型检查与样式检查通过，样式检查不等于清空历史 allowlist。前端和 custom-protocol 原生构建通过；新增历史取消配色后重新构建。

真实 Linux Tauri/Xvfb/D-Bus/AT-SPI：使用已有数据根 `/tmp/mindos-live-close-VIgRBk`，打开原会话、发送 `hello cancel-ui-verified`，mock 于 `04:53:23.006Z` 收齐请求；点击实际停止按钮后于 `04:53:23.604Z` 关闭连接（responseEnded=false）。`cancel-ui-live.png` 显示顶部“执行已取消”、消息 ABORTED、中性卡片“执行已取消”与“重新执行”。这验证 UI 取消路径；Task 取消语义不自动证明任意外部设备或供应商已停止，此处只确认本地 HTTP 连接断开。

剩余边界：首次超时后消息状态的短暂 RUNNING 残留及其有界收敛仍需定位；pause 三态及未确认物理停止的真实窗口场景仍未完成。独立关闭并保留记录已由后续 `d393d2fc` / `3c3afe5d` 实现和验收，不再作为本条剩余入口。重新打开 Session 时顶部可显示 Ready（当前没有活跃执行），不把它当作历史 Task 状态。本文不宣称整个 P0-02 完成。

可复核命令：`pnpm --filter @itookit/app-shell test`、`pnpm --filter @itookit/llm-session test`、`pnpm styles:check`。长期回归在 `cancelled-history.test.ts` 与 `session-terminal-node.test.ts`；窗口步骤为发送至等待响应的本地 mock，再点停止并重开原会话。临时日志 `/tmp/x1-cancel-ui-shell.log`、`/tmp/x1-cancel-ui-session.log`、`/tmp/x1-cancel-ui-types.log`、`/tmp/x1-cancel-ui-styles.log`、`/tmp/x1-cancel-ui-front-final.log`、`/tmp/x1-cancel-ui-native-final.log`；临时记录会消失，不替代源码回归。

重开补验：在旧租约自然过期后，用含历史取消配色的原生快照重开同一数据根，`cancel-ui-reopened.png` 显示 ABORTED、原 Task cancelled 原因及中性底色。该 GUI 快照含 `52754e9a` 与取消文案/配色选定文件，不含后续独立关闭、发送计量等功能，不能作为当前 HEAD 全量 GUI 证明。随后工作树已推进到 `390079cb`；最终合入仅补历史原因区配色和事件说明，并在当前工作树重做文档/样式检查及正常前端构建。

## 2026-09-14：模型超时的 live 收敛上界与重开原因

针对上文遗留的“首次超时后消息状态的短暂 RUNNING 残留及其有界收敛仍需定位”，本轮用约 0.5 秒分辨率的连续采样把它做成有界结论，并修正上一轮的方法学问题——上一轮先打印时间戳再跑无障碍遍历，会把观测时刻标早（报出的 `+10 ms`/`+3 s` 实际对应该次遍历返回的时刻）。

装置：真实 Linux Tauri + Xvfb `:98` + 会话总线 + AT-SPI；provider 指向**收到请求后一个字节都不写**的本地 mock（`mock-silent.mjs`），因此命中首响应 60 秒超时。窗口内发送 `timeout-live-probe2`，随后连续快照，记录每次遍历**返回之后**的时刻，以及是否仍存在 `Stop Generation`（运行中）/ `重试`（终态）：

| 事件 | 时刻 (UTC) | 相对连接关闭 |
| --- | --- | --- |
| mock 收到请求 | 05:02:03.215 | — |
| 客户端关闭连接（60 秒超时） | 05:03:03.209 | +0（59994 ms） |
| `effect.failed` 持久事件 | 05:03:03.305 | **+96 ms** |
| 采样：仍 `Stop Generation` | 05:03:03.960 | +751 ms |
| 采样：已终态（有 `重试`，无 `Stop Generation`） | 05:03:04.735 | **+1526 ms** |

结论：**durable 层在 +96 ms 写入明确原因，live UI 在 +0.75 秒与 +1.53 秒之间收敛**，上界约 1.5 秒；不是此前无法界定的“至少 2 秒仍 RUNNING”。同轮前一次样本（`timeout-live-probe`，请求 `04:57:27.797Z`、连接关闭 `04:58:27.788Z`）也在连接关闭后 2 秒内进入终态。持久事件与 round 文档均写明 `Request timed out after 60000 ms without a response`（`retryable: false`），Task 快照为 ready → running → failed。

重开一致性：用同一数据根重启应用（不重建数据）后打开该 Session，转写重新渲染该 round（`Chat history` 子节点含 `↻`/`✎`/`🗑️` 与 `Create Branch`），未卡死也未停留在运行态；持久 round 文档为 `status: "failed"`、`error: "Request timed out after 60000 ms without a response"`，即重开路径读取的正是该原因。

边界：AT-SPI 树中错误气泡的文本节点名为空，本轮**没有**用无障碍接口重新断言屏幕文本；“显示同一 60000 ms 原因”依据的是渲染器所读的持久 round 文档与上一轮截图，不是本轮的新文本断言。此处“已停止”只指本地 HTTP 连接关闭，不代表远端供应商计算或计费停止。pause 三态与未确认物理停止的真实窗口场景仍未完成。

## 2026-09-14：项目规则在真实窗口的嵌套边界（P0-04）

**先纠正一个前提：「多层级嵌套挂载」在本实现里不可表达。** `SessionFilesService.create` 对每个挂载点做 `if (!/^\/[a-zA-Z0-9_-]+$/.test(at) || [...保留名...].includes(at.slice(1)))` 校验（`backend/app-core/src/vfs/session-files.ts:195`）——`at` 只允许**一个顶层路径段**。实测把 `at` 设成 `/workspace/inner` 时 `configure` 直接抛 `FSError [EACCES] Reserved or invalid mount point`。因此挂载点之间不存在父子关系；真正会出现的嵌套是**一个挂载内部的多层目录树**（以及它带来的 `parent-fs` / `local-fs` 作用域层级）。P0-04 该项按此收窄后验证。

装置：真实 Linux Tauri + Xvfb `:98` + 会话总线 + AT-SPI；数据根内构造一棵带嵌套规则与嵌套 Skill 的树，并用 Node 侧 `SessionFilesService.configure` 预置一个 Session（`mounts: [{ at: '/workspace', sourceId: 'admin-home', root: '/nest/outer', access: 'rw' }]`，`cwd: '/workspace'`）：

```
<nest>/outer/_agent/AGENT.md                          → OUTER-PROJECT-RULE-MARKER
<nest>/outer/_agent/skills/outer-skill/SKILL.md       → OUTER-SKILL-BODY-MARKER
<nest>/outer/inner/_agent/AGENT.md                    → INNER-NESTED-RULE-MARKER
<nest>/outer/inner/_agent/skills/inner-skill/SKILL.md → INNER-SKILL-BODY-MARKER
```

窗口内打开该 Session 并发送 `nested-rules-probe`，用记录完整请求体的 mock 核对（请求 `05:08:31.048Z`，360 字节）：

| 消息 | 内容 |
| --- | --- |
| system 1 | `You are a helpful assistant.` |
| system 2 | `OUTER-PROJECT-RULE-MARKER: project root instructions only.` |
| system 3 | `Skill outer-skill:\nOUTER-SKILL-BODY-MARKER` |
| user | `nested-rules-probe` |

标记出现次数：`OUTER-PROJECT-RULE-MARKER` **1**、`OUTER-SKILL-BODY-MARKER` **1**、`INNER-NESTED-RULE-MARKER` **0**、`INNER-SKILL-BODY-MARKER` **0**。

结论：项目规则来自挂载的项目根并被注入；同一挂载树内层的 `_agent/AGENT.md` **既不被合并也不被替换**，符合 `session-file-source.ts` 的注释契约。`cwd` 等于项目根时 `scopeRoots` 只返回根一级，所以内层 Skill 也不参与级联——这与“Skill 按层级级联”不矛盾：级联需要更深的 `cwd`，而普通发送路径使用配置的 `cwd`；更深作用域只在 Flow/工作区作用域路径出现，本窗口场景没有覆盖。

复现：`node --import tsx .tauri-acceptance/seed-nested-mounts.mts <rootDir>` 预置挂载（临时助手，`at` 只允许单段，脚本内注明原因），随后按上述窗口步骤发送并读取 `mock-record.log` 的请求体。长期证据以本节标记计数、`session-file-source.ts` 契约与其包级回归为准；窗口驱动脚本与数据根在已 gitignore 的 `.tauri-acceptance/`，临时文件会消失。

## 2026-09-14：原生目录选择器的静默失败（P0-04）

上一节（[平台边界验收](minimal-system-acceptance.md#2026-09-14p0-04-平台边界图标字体与原生目录选择器)）记录“原生选择器能弹出但未能完成选择”。本轮继续追查，找到一个**代码缺陷**并修复，同时如实记录未能完成的验证。

**缺陷**：`apps/tauri-app/src/main.ts` 的 `openDirectoryDialog` 写成
`try { … } catch { return null }`，把“用户取消”和“选择器损坏”合并成同一个返回值；`#btn-add-mount` 的点击处理又完全没有 `catch`。于是选择器失效时既没有提示、也没有日志，唯一症状是**按钮点了没反应**——与项目自身“静默失败可见化”的原则相冲突。

**修复**：抽出 `apps/tauri-app/src/services/directory-dialog.ts`，取消仍解析为 `null`，真实失败则记录并**重新抛出**；点击处理捕获后 `console.error` + `alert` 报告失败原因，挂载失败（原先是一个未被观察的 rejection）同样可见。回归 `ui/app-shell/tests/directory-dialog.test.ts` 3 项：成功返回路径、取消返回 `null` 且不记错误、失败重新抛出并记录；Tauri 与 app-shell 类型检查通过。

**验证缺口（必须如实说明）**：改动后在本环境**未能**再让窗口响应合成输入——点击 `Mount directory…` 时点击处理从未执行（用临时写入 `document.title` 的诊断证明标题始终是 `X1`，`DIAG-*` 从未出现），同期点击导航项也不再生效，说明是该实例的输入/焦点问题而不是本改动导致。因此“修复后的选择器在窗口中的端到端行为”**没有**取到证据；其正确性只建立在包级回归与“成功/取消路径逐字未变”之上。最终产物已移除诊断代码并恢复普通前端与 `custom-protocol` 原生构建。

环境侧证据（未变）：选择器由 XDG Portal 承载，`xdg-desktop-portal` 报告 `fuse: device /dev/fuse not found`、`error: fuse init failed`、`Document portal fuse mount point unknown`，本容器没有 `/dev/fuse`，门户文档门户不可用；点击门户的“打开(O)”后对话框关闭，但既没有 `sources.json` 落盘也没有新增导航项，`/var/lib/kernel/local-sources` 为空。**门户选择失败的确切形态（reject / 返回 null / 停留不返回）本轮仍未判定**，不能据此宣称原生选择器在本机可用或不可用。

复现：`pnpm --filter @itookit/app-shell exec vitest run tests/directory-dialog.test.ts`（包级）；窗口部分需要可用的合成输入与 `/dev/fuse`，本环境未满足。


## 2026-09-14：P1 审计、提交间隙与契约漂移

工作树基线 `0625e1e3`，本节为未提交改动的验证记录；Node 26.8.1 / pnpm 10.20.0。保留本轮开始时 `doc/todo.md` 与本文的已有修改。**P1 整体未完成**，不把局部修复和本机证据替代所有未勾选要求。

### 审计结论

| 工作项 | 本轮核对 / 处理 | 尚未闭合 |
| --- | --- | --- |
| P1-01 | 原提交间隙测试通过修改内存存储检查点模拟；新增真实 CLI 进程 SIGKILL，直接在提交/检查点公开边界杀进程，未重写持久状态 | Protocol §15 其余窗口及组合、完整外部副作用故障矩阵 |
| P1-02 | 已有租约/epoch/skew 实现仍不能证明共享后端原子性或执行端 fencing | 未提供共享存储部署与第二主机；不能由 LocalFS/SQLite 推导 S3/NFS 保证 |
| P1-03 | CLI/Tauri 工作区装配已有证据，映射中“仍缺装配”和“VFS 仍指向原仓库”属于过时描述，已修正 | 真实 OCI、合并/冲突、完整用户窗口启动与重启、遗留意图回收；本机无 Docker/Podman |
| P1-04 | 证据映射误称整项已完成，已与 todo 的未完成状态对齐 | 真实窗口重算与结果收敛提示 |
| P1-05 | 五篇映射保留有效缺口，未把 authority 元数据等同物理执行端隔离 | adapter 执行令牌 fence、多 store 迁移、记录族布局、provider 能力/收费、完整 GC/stream/receipt 矩阵及 GUI 停止三态 |
| P1-07 | 修复生产者自身契约被宽松消费者绕过；新检查点保存插件清单/schema，恢复拒绝契约漂移 | 节点级 responseFormat 端口绑定、端口 repair/continue；不能检测同名版本的 JS 实现漂移 |
| P1-06/08/09/10 | 保持已有完成状态；本轮没有发现需要撤销的证据 | 本轮不重新声称完整桌面或其他 P0 验收 |

### 新增故障窗口

`apps/cli/tests/fixtures/scheduler-crash.ts` 只包装公开 `Kernel.submit` / `Kernel.setShared` / `DurableFlowExecutor.submit`，生产代码无测试开关。初始 CLI 子进程由真实 SIGKILL 终止，正常宿主用原数据根执行 `resumeCommand`。存储为真实 LocalFS/SQLite，模型为本地 HTTP mock。

| 杀进程位置 | 核对事实 |
| --- | --- |
| 普通节点提交返回、尚未写成员/检查点 | Task 已存在而检查点 instances 不含该 id；恢复复用它，模型恰调用一次 |
| 首个委派子节点提交返回、尚未写检查点 | 恢复后根/父/两子恰四个 Task，父模型不重跑、无二次 fan-out |
| 第二个委派子节点提交返回、尚未写检查点 | 父与首个成功子 Task 全记录不变，恢复补齐原第二子 Task；模型总计三次 |
| 委派首子模型请求在途 | 默认恢复返回 3 且无新增请求，显式重放后成功；同子 Task 身份，模型总计四次 |
| 循环 entry#2 成功落盘、完成检查点提交前 | 检查点含 entry#1、不含 entry#2，两个入口 Task 已成功；恢复后入口/循环体各三次模型调用，所有旧成功 Task 全记录不变 |

委派配置由测试夹具在 CLI 编译后注入公开 DagRunSpec 并正常持久化，恢复不重新注入。**CLI YAML 仍未暴露 delegation**。这些测试证明列出的本机进程故障窗口，不证明任意指令处崩溃、断电、真实供应商幂等或跨主机行为。

### 契约修复与兼容边界

- `assertNodeOutputs` 校验生产者全部声明的输出；下游的宽松 schema（例如 number 接收声明为 integer 的输出）或无 schema 都不能放过生产者实际输出 1.5。消费者输入仍独立验证；无效值使 Run 失败，保存原输出、不派发下游。
- 新调度检查点保存已解析的清单和 schema，含动态节点与缺失引用。恢复在派发新 Task 前核对宿主注册表，清单/schema 变化或消失即明确拒绝，Task 记录不变；对象键顺序不影响比较。
- 旧检查点没有 `catalog` 时沿用宿主定义；宿主仍须保留不可变插件版本。当前机制不校验可执行代码内容，不能证明同 id/version 实现未变化。

### 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @itookit/llm-flow test` | 18 文件，220 通过 |
| `pnpm --filter @itookit/cli exec vitest run --exclude tests/crash-matrix.test.ts` | 27 文件，108 通过 |
| `pnpm --filter @itookit/cli exec vitest run tests/crash-matrix.test.ts` | 当时 16 项完整矩阵通过，约 416 秒（真实 Effect lease 到期） |
| `pnpm --filter @itookit/cli exec vitest run tests/crash-matrix.test.ts -t 'loop iteration whose checkpoint'` | 后增循环窗口 1 通过；其余 16 为选择器未选，不是功能跳过 |
| `pnpm --filter @itookit/cli exec vitest run tests/crash-matrix.test.ts -t 'scheduler SIGKILL window\|loop iteration whose checkpoint'` | 最终夹具五个新增窗口全部通过（约 45 秒）；其余 12 为选择器未选 |
| `pnpm --filter @itookit/llm-flow typecheck` / `pnpm --filter @itookit/cli typecheck` | 通过 |
| `pnpm docs:check` | 76 份活文档通过，5 条既有历史表述告警 |

HTTP 监听首次在沙箱内遭 EPERM，随后经正常提权运行通过。日志：`/tmp/p1-flow.log`、`/tmp/p1-cli.log`、`/tmp/p1-crash-full.log`、`/tmp/p1-loop-gap.log`，临时文件不作为长期唯一证据。没有执行全仓最终矩阵、发布产物构建或本轮真实窗口验收。


## 2026-09-14：P1 过渡设计与同机事务租约条件

先按用户要求提交上一批：`b2ee748a`（`fix(flow): persist contracts and verify scheduler crash recovery`）。本节记录之后的未提交工作树改进，Node 26.8.1 / pnpm 10.20.0。

[过渡设计](design/p1-transition.md)明确三个阶段：同机持久调度、节点级输出契约/停写迁移、指定后端多主机验证。当前实现 A1/A2；A3 所列执行端/其他命令/混合版本边界仍开放，P1 总项不勾选。

- Run 租约到期或释放即失效，无需等待其他 owner。迟到心跳不续活旧租约，已失权句柄不复活。
- Kernel 的 Task 提交、共享状态写入/删除、Session signal 支持事务内 `LeaseGuardOptions.lease` 条件；校验 owner/epoch/期限失败返回 STALE_SHARED_LEASE，不写业务事实。新 owner 可复用原 requestId，条件不进入 TaskSpec 指纹。
- Flow 节点、检查点、成员、metadata 与根终态信号使用条件。旧宿主在 task.started 回调内停顿、新宿主完成后旧回调返回或抛错，两种交错均不重复提交、不把 Run 判失败、不触发工作区失败清理。
- 工作区清理状态写入完成前保持租约，waitIdle 包含该收尾。旧实现提前释放租约导致清理终态写入被新的条件拒绝，已修复；清理失败仍只通过 workspaceCompletion/持久状态报告。
- 既有 poll-snapshot 测试在读取时才生成“现在 +10s”的期限，偶发算出 10001ms。修正为读取前固定期限，未放宽断言或修改轮询实现。

| 验证 | 最终结果 |
| --- | --- |
| `pnpm --filter @itookit/durable-kernel test` | 257 通过 |
| `pnpm --filter @itookit/llm-flow test` | 225 通过 |
| `pnpm --filter @itookit/cli exec vitest run --exclude tests/crash-matrix.test.ts` | 108 通过 |
| `pnpm --filter @itookit/cli exec vitest run tests/crash-matrix.test.ts -t 'scheduler SIGKILL window\|loop iteration whose checkpoint'` | 5 通过；12 为选择器未选 |
| `pnpm typecheck` | 全仓通过 |
| `pnpm docs:check` / `git diff --check` | 通过；文档检查 77 份、5 条既有历史告警 |

日志位于 `/tmp/p1-transition-{kernel,flow,cli,crash,types,docs}.log`。未执行本批完整 17 项崩溃矩阵、全仓测试/构建或 GUI/OCI/跨主机验收；不能以本机条件推导物理 adapter fencing。API 省略 lease 条件保持旧行为，混合版本写者保护仍须单独设计与验证。

## 2026-09-14：本地 P1 分功能补齐

本轮按功能独立提交，迁移、跨主机和通用资源服务后移。以下是本轮新增证据，取代前文“CLI YAML 未暴露 delegation”的当前状态描述：

- CLI YAML 支持有界 `delegation`、父子工具交集和 Agent 引用校验；夹具只在 Kernel 边界发送 SIGKILL，不再注入图。
- `portSchemas` 与 Agent `responseFormat` 绑定、目录冻结和严格失败通过 Flow 正反例；真实 CLI 正反例证明结构化结果写 `result.json`，不符合端口 schema 时 Run 失败。
- 根 input 携带初始调度快照和工作区身份；根提交后、首 shared 检查点前 SIGKILL 的独立用例通过。Tauri 意图回收识别根中的认领；终态尚无 pending 收尾记录也会恢复清理。
- 控制命令共用 Session 写权限与本 Kernel 的 Run 租约；旧回调、只读宿主和另一 Kernel 的活跃租约测试拒绝写入。暂停一个 Run 不再暂停整个 Session。
- 清理超过 5 秒仍保持 pending 并记录说明；CLI 等待退出时报告，桌面沿用 pending 轮询。未确认物理停止时不释放租约或删除文件。遗留意图在授权变化/Session 不可读取时保留，错误包含人工处置路径。
- `crash-matrix.test.ts` 新增 capability-bound、task-started、graph-patched、delegation-joined 四个真实进程用例通过。模型调用次数、任务身份和已完成输出均受断言保护；动态 patch 用例使用正式 YAML spawn 配置。

分组验证：Kernel 257、Flow 最终阶段 237、llm-tasks 43、llm-session 116、Tauri 工作区 IPC 16；CLI 配置/编译 24、结构化输出集成 2、原 17 项真实崩溃矩阵通过，后增根窗口 1 与能力/启动/patch/join 4 分别通过。计数属于不同阶段，不能累加为唯一测试总数。CLI/Tauri/AppShell 类型检查与活文档检查通过。全量最终矩阵及真实窗口验收须以之后的明确记录为准，以上 IPC/DOM 测试不冒充真实窗口操作。


### 本地 Run 控制台真实窗口（2026-09-14）

发现并补齐 `DagWorkbench.openRun` 无生产调用者的问题。工作流工具栏提供「运行记录」，可查看已保存 Run、返回设计及继续调度；图级重试会继续调度。读取列表、快照和固定版本 transcript 不调用 `openSession` 激活任务。

使用正式 Tauri debug 构建、Xvfb :103、独立 dbus/AT-SPI 与隔离 profile `/tmp/x1-p1-window-UX0yFe`。普通 `.flow` 草稿包含 source(transform) → gate(human) → after(transform)，通过窗口 Run 启动，不修改 Kernel 持久记录、不注入应用 API。窗口中选择运行记录并点击 source 的「重试并重算下游」；source 两次执行成功、原 gate 取消、新 gate 等待。重启应用，重新选中同一 Run，点击「继续运行」并在 Respond 对话框键入 yes；新 gate、after、根均 succeeded。再次重启后列表仍为 succeeded，并保留两代 source、取消的 gate 及新 gate。根 ID `task_5c17c63d-6905-4156-80aa-200176c291be`；终态耗时 1248.5 秒包含人工等待及两次重开，不能用作性能样本。

验证：Flow 238、Kernel 257、Run UI 9 项通过；全仓 typecheck、docs:check（77 份 / 5 条既有历史告警）、styles:check、Tauri Vite 与 Cargo offline 构建通过。本段不代替工作区专门验收，也不推导其他桌面平台支持。


### 同机暂停宿主恢复后的控制隔离（2026-09-14）

`scheduler-paused-owner.test.ts` 使用两个真实 Node 进程、LocalFS 与 Node SQLite：第一进程取得 Run 租约后 SIGSTOP，等待实际期限过期，第二进程取得 epoch 2；SIGCONT 恢复第一进程后 cancel/pause/resume/start/signal/retry/createResource/setShared 八种迟到写入均报 `STALE_SHARED_LEASE`。旧句柄 release 不撤销新租约；新进程 assertOwned 成功，任务仍 created、无额外 retry/共享写入/control。测试不改持久租约或注入时钟。该独立用例与 AppShell typecheck 通过。既有 CLI `run-live-owner-refusal.test.ts` 覆盖活跃宿主下另一真实进程取消被拒。

包含 `8de85fbb` 的全量 `pnpm test` 矩阵通过（`/tmp/local-p1-final-matrix3.log`，含 CLI 22 项 crash matrix 与 Rust）；本新增暂停用例在矩阵之后独立运行通过。


### 本地消息、GC 与物理资源故障矩阵（2026-09-14）

`20-kernel-ipc.test.ts` 增加消息消费提交后、源端结算前 SIGKILL 窗口。两个新进程并发裁剪发送/接收 Session：未结算 outbox 与已消费 inbox 均保留；重投递返回 false，接收任务无重复事件；双边 settlement acknowledgement 后，各自 GC 才删除对应记录，再重启为空。root/module 两种挂载均覆盖，未修改持久回执或绕过事务。

该文件 32 项全部通过，包含既有物理 adapter/receipt 清理中 SIGKILL（恢复前 held=1/waiting=1，确认后复用容量、重放不新建 claim）、single-use cache 提交前/后 SIGKILL、竞争领取以及取消树恢复。Kernel 257 项覆盖未知/错配/超时清理保持容量、暂停与 Session 关闭屏障、authority epoch、usageId 结算幂等及历史/消息裁剪规则。日志 `/tmp/local-p1-receipt-gc.log`。这些证据针对现有本机存储与 adapter 协议，不宣称供应商收费幂等或跨主机硬件 fencing。


### 工作区收尾的人工处理报告（2026-09-14）

Git 工作区 `finish` 现在返回可选说明；按策略保留的目录/分支及基础仓库进入 Run 持久 finalization，Tauri 保留此结果，CLI 执行退出时输出到 stderr。Git 失败同时附上目录、分支和检查后重试建议；无需查数据库寻找工作区。Flow 240、Tauri 工作区/控制台/崩溃 29、真实 CLI 工作区 5 项通过（含 stderr 路径断言）。全仓类型检查除测试中误加的一处 stderr 引用外通过，修正后 CLI 与 AppShell 类型检查分别通过；文档检查通过。

真实 Tauri 窗口、隔离 profile 沿用 `/tmp/x1-p1-window-UX0yFe`：首次工作区执行因未授权拒绝；通过会话 `/add-dir` 对话框挂载 `/home/admin → /workspace`、可读写并设为工作目录后发送 go，建立原生 worktree。重启后从运行记录继续，再取消 gate，Run `task_06e22644-bbfe-47d4-87f3-179eac8f1180` 失败，工作区收尾成功；磁盘 worktree 列表仅剩基础仓库，创建意图清空。

第二个 Flow 选择 auto-if-clean/on-success；窗口启动后在测试副本中编辑普通文件 `p1-base.txt` 为 `retained local work`（不改 Kernel 记录），Respond 后 Run `task_9a0fe0c0-74b7-4920-bb84-e805029af4ed` succeeded，清理 failed，窗口与持久状态均显示未提交更改、目录 `.../var/lib/worktrees/445bc50d-5738-4259-af77-eb59f3881099`、分支 `flow/445bc50d-5738-4259-af77-eb59f3881099-mu19kedf`。基础文件仍为 base，重启后副本仍为脏状态。后续人工处理/重新收尾以追加记录为准。


### 已打开控制台的终态用量刷新（2026-09-14）

真实窗口发现：运行中打开的独立控制台缓存初始 usage，终态仍显示 0.0s，重开才显示持久的 289.8s。`dag.run.get` 现在每次读取保存的 metadata 用量，保留同一已打开视图时也能同步最终值。Flow 回归用独立观察者在执行完成前打开快照，随后断言终态用量与持久 metadata 一致且 elapsedMs > 0；240 项通过。全仓 typecheck 与 Tauri Vite 构建通过。


### 工作区人工处理后的恢复闭环（2026-09-14）

接上前述 `task_9a0fe0c0-74b7-4920-bb84-e805029af4ed`：真实桌面重启后，Run 保持 succeeded、收尾 failed，目录/分支说明与 289.8s 持久耗时可读；磁盘副本仍为修改后的内容，基础仓库仍为 base。人工在报告目录中检查并提交 `p1-base.txt`（测试仓库提交 `21ce907`），然后点击窗口「继续运行」。窗口转为「工作区清理完成」，Run 与全部节点保持原终态；基础仓库快进到该提交且文件为 `retained local work`，worktree 列表仅基础仓库，临时 flow 分支及意图目录均为空。未直接更改 Kernel 记录；人工 Git 处理是当前支持路径，未宣称内置冲突编辑器。

至此本地 P1-01–10 的实现与分层验收闭合；迁移、跨主机、OCI/其他平台与 P0 性能不纳入此次完成声明。临时测试窗口已关闭，独立 profile 保留用于复核。


### 本地 P1 最终验证汇总（2026-09-14）

- `pnpm test` 配置矩阵通过，日志 `/tmp/local-p1-final-matrix4.log`；包含 Kernel、Flow、AppShell、CLI 普通测试、CLI 22 项 crash matrix 和 Rust。AppShell 配置仍有既有 3 个文件 / 30 项跳过，未将其计算为通过。
- 矩阵运行期间补的终态用量刷新另外完成 Flow 240 项回归；最终源码全仓 `pnpm typecheck` 通过（`/tmp/local-p1-complete-types.log`）。
- 最终 Tauri Vite 与 Cargo offline 构建通过；构建仍有既有 chunk 体积提示和 2 条 Rust 告警。`styles:check` 通过，此后无样式改动。
- `pnpm docs:check` 与 `git diff --check` 通过；77 份活文档、5 条既有历史表述告警。
- 真实窗口完成运行记录/图重试/重开/继续，以及会话授权、工作区创建/重启/失败清理/脏副本保留/人工处理/再次收尾。测试窗口已退出，用户数据未参与验收。

功能改动分别提交；本地 P1 不再有未勾选项。P0 性能与其他平台、P2 扩展的未完成状态继续由 `todo.md` 单独维护。

## P2 版本与共享 Memory 提交批次

日期：2026-09-14。本批提交功能实现与已有回归，不将 P2 整体勾选。语义/向量检索由用户明确延期；自动委派、完整 Skill 生命周期竞态、真实窗口及云模型、IndexedDB 和 VFS 消费者矩阵继续开放。

实现入口：`kernel-adapters/src/skill/version-snapshot.ts`、`session-prompt-context.ts`、`llm-session/src/session/shared-memory-store.ts`、`session-memory-provider.ts`、`task-memory-service.ts`、`app-shell/src/files/memory-sharing-dialog.ts`、`apps/cli/src/shared-memory-command.ts`。Skill 选择持久 format:2 的快照和漂移标记；keep-old 保留旧正文但不保留撤销权限，require-reload 拒绝漂移版本，纯 ID 旧记录需要显式 reload。初始 Agent 选择和运行时加载共用版本入口。

共享 Memory 使用系统 SeqFile 独立资源。两个真实 Session / 两个 Node 进程在同一 LocalFS/SQLite 数据根竞争同一预期 revision，恰好一方成功；创建者 Session 删除后另一方读取不变。写入、删除、prune 和压缩各覆盖数据写入后、回执写入后、事务提交后的 SIGKILL：前两处重开回滚，提交后数据/回执/审计一致；重复工具操作不复活删除内容、不覆盖更新版本。压缩保存源 revision/hash 和模型，原文保留；仅有写授权不足以读取源内容并提交摘要。

回归命令与结果：

- `pnpm --filter @itookit/kernel-adapters test`：128 项通过。
- `pnpm --filter @itookit/llm-session test`：124 项通过。
- `pnpm --filter @itookit/app-core test`：103 项通过。
- `pnpm --filter @itookit/cli test tests/run-memory.test.ts tests/run-skill-context.test.ts`：4 项通过，使用本地 HTTP mock。
- `pnpm --filter @itookit/cli test tests/shared-memory.test.ts`：13 项通过（12 个事务 SIGKILL 窗口 + 1 个双进程/创建者删除场景）。测试宿主关闭在 dispose 后等待 Kernel.waitIdle，再释放 SQLite，避免在途轮询访问已关闭文件视图。
- `pnpm --filter @itookit/app-shell test`：221 项通过、30 项既有跳过；`scheduler-paused-owner.test.ts` 一个既有用例返回 `Host exited: 1`，单独重跑仍失败，不能记为整包通过。本批 Memory/Skill DOM 与宿主回归均通过；共享管理 DOM 使用生产 controls/provider/store，覆盖创建、读/写授权、撤权、审计与删除。
- 全仓 `pnpm typecheck` 通过；`pnpm styles:check` 通过，剩余 48 个选择器/状态类豁免；`pnpm docs:check` 通过并保留既有历史表述告警。

样式实际规则补在所属包，打印 CSS 同时覆盖独立打印文档和编辑器打印容器；已删除 59 个待补/待复核类名豁免。此次没有执行真实窗口视觉检查、Tauri/CLI 发布构建、全仓最终测试矩阵、真实云模型、其他平台及跨主机验收，不用包级结果代替这些要求。共享资源墓碑、审计和幂等回执当前永久保留，未实施物理历史 GC；history 默认返回前 100 项、最多 1000 项，未提供分页归档。


## 系统沙箱模块接入桌面 Bash（2026-09-22）

Tauri `session_shell_exec` 通过宿主目录句柄解析 grants，调用 `backend/sanbox/native` 的 `session_command`；基础参数与 TypeScript 入口共用 `runtime-policy.json`。Linux 使用 Bubblewrap 并默认隔离网络，保留虚拟挂载路径；macOS 已有 Seatbelt 分支，使用真实 cwd，尚待 macOS 实机确认。CLI native/OCI 未改，MCP 与持久 TTY 不在本次桌面 Bash 覆盖范围。

真实 Tauri WebView 探针在隔离数据根 `/tmp/x1-sanbox-desktop-probe/profile` 运行，通过生产 `createApplicationRuntime`、`SessionCommand.Send` 的 agent 模式、LLM task/kernel/tool 链、`createTauriSessionProcesses`、Rust IPC 和新模块执行 Bash。仅模型响应使用确定性模拟：第一轮发起 Bash tool call，第二轮消费真实工具结果；文件操作、VFS 授权、IPC、进程执行与 `llm-ui` HistoryView 渲染都为真实实现。

`sanbox-result.json` 记录 `phase=complete`，模型收到工具结果 `[exit 0]\nSANBOX_PROBE_PASS\n`；HistoryView DOM 包含同一标记。实际核验：授权目录可读写、宿主未授权文件不可读、net/mnt/pid namespace 与宿主不同、宿主测试环境变量未进入子进程、子 Bash 继承边界。宿主复核工作目录 output.txt=written、外部 marker 未改变。该探针经 xvfb/WebView 执行，不代表真实云模型或用户手动点击验收，也不代表重启恢复或 macOS 验收。

回归：Rust 沙箱包 6 项与 Tauri 全部 46 项通过；app-shell 的 tauri-bash、tauri-flow-workspaces、chat-execution-mode 共 30 项通过。Tauri 取消测试先确认沙箱内脚本已经启动，再触发超时并等待超过后台写入延迟，确认没有迟到写入。TypeScript 沙箱测试、类型检查与双格式构建通过；Linux 原生隔离证据同时来自 Rust 用例和上述 WebView 探针。

探针使用独立前端与二进制副本，未修改生产 main.ts 或 tauri.conf.json，未访问用户现有 profile。正常应用按原配置重新构建；启动新代码需重启开发版桌面应用。设计、限制与调用链见 [系统沙箱](design/system-sandbox.md)。

## Session 切换录制后的 I/O 与渲染批处理（2026-09-22）

`localhost-recording.json` 的 14.15 秒录制包含 2091 次公开 IPC：`sidecar_select` 729、`sidecar_begin`/`sidecar_finish` 各 302、`directory_stat_many` 313、`fs_stat_many` 271、`fs_stat` 103。302 个事务均保留一次 rename journal 探针；非探针 payload 查询 453 次，只对应 107 个不同的 path/field 组合。1885 个 stat 路径只对应 60 个路径。该文件没有完整 JavaScript 调用栈，因此只能支持次数与时间相关性，不能把全部主线程时间精确归到单个函数。

实施内容：

- 四层嵌套 `FileSystemView` 的目标类型检查从 16 次降为 1 次；`noLinks` 返回并复用本轮目标，缺失目标同样只查一次，前缀链接拒绝语义不变。
- sidecar 新增 `getMetaExtMany` 与 `getRecordFields`。完整目录每 64 项批量读取元数据；SeqFile 精确字段集合在原外层事务内一次读取，Task event 页的指针和正文分别一批。路径映射层转发批量能力，journal 探针仍按外层事务执行。
- Mermaid 默认本地动态导入，Tauri 输出独立 `mermaid-runtime`（2232.94 kB，gzip 634.32 kB），`index.html` 不预加载该 chunk；启动 vendor 从 3777.81 kB 降至 1534.57 kB。普通 Markdown 不加载 Mermaid/MathJax，公式出现后才创建 MathJax 脚本。

回归结果：VFS 22 文件 / 195 项、LocalFS 9 文件 / 86 项、Durable Kernel 8 文件 / 266 项、MDX 3 文件 / 14 项通过；Tauri sidecar 批量 IPC 定向测试 8 项通过。四个相关包类型检查与 Tauri Vite 构建通过。AppShell 整包在受限沙箱中运行到工作区崩溃用例时，子进程 `spawnSync git` 返回 EPERM；本次相关的 sidecar 定向测试独立通过，未把该环境失败记成功。

本节没有改后真实 WebView 录制，因此只证明请求合并、嵌套放大消除和启动 chunk 拆分已经落地；P0-02 的 ≤2 秒 / ≤100 次仍保持开放，下一步须用同一 profile、同一 Session 和同一动作边界重录。
