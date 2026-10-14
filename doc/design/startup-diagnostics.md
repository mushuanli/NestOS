# 启动故障与运行日志

## 2026-09-27 启动等待链优化

桌面在 HTML head 记录 `mindos.document`，入口模块及其静态依赖执行后写入 `frontend.bootstrap.entry`：`timeOrigin` 为页面时间原点，`documentMs` / `entryMs` 为相对时刻，`documentToEntryMs` 包含资源加载和模块执行，`resourceCount` 为已记录资源数。结合 Rust `process.start` / `app.ready` 可区分页面前与页面内的等待；该区间不能直接归因成 Vite 编译时间。原有 `bootstrap.ready` 仍只度量 JS bootstrap，不能替代端到端或首帧时间。

会话导航在整个投影内复用一次 folders / sessions 快照：根目录读取不再自我作废快照，文件夹 `stat()`、`ProjectNavigation.sync()/refresh()` 与 `ProjectService.list()/forFolder()` 都从同一份 `navigation()` 派生，启动实测 `listFolders()` 由 25 次降到 3 次、连续两次根读由 2 次 `repository.list()` 降到 1 次（sidebar 根读与项目导航各一次属跨层，未合并）。仓库变更、Kernel 结构事件、关闭浏览器或工作台刷新使快照失效；失败读取可重试。权衡：根投影与文件夹投影一样只在显式刷新时看到其它宿主实例的写入。快照仅用于导航投影，`SessionRepository.list()` 不做长期缓存，恢复和跨实例持久读取仍读存储。manifest 每批最多 64 个并发读取，所有读取结束后才提交或回滚事务，保留不完整 Session 跳过和格式错误失败语义。

Flow invocation 恢复先检查持久调用记录，空会话不再探测写租约或读取 Task 列表；有调用的会话仍先通过写入门，再重新读取恢复后的记录。`traceBoot` 在 console 分别记录 `agentService.init`、`sessionEngine.init`、`promptHistory.init`、`flowInvocations.recover`、`sessionWorkbench.sidebar`、`sessionWorkbench.currentProject`、`sessionWorkbench.projectNavigation`，用于拆解会话系统及首个工作区等待。

桌面正常窗口关闭会阻止立即销毁 WebView，等待 `app.destroy()` 完成消费者、Kernel、租约及数据源清理后再销毁窗口；重复关闭请求合并。此路径需要 `core:window:allow-destroy`，需重启 Rust 宿主加载权限。强制结束进程和页面刷新仍依靠既有租约过期及事务代次协议，不能承诺执行异步关闭清理。

基线日志 `1790468714451-924631.jsonl` 的 `process.start → frontend.bootstrap.ready` 为 9402 ms，其中 `app.ready →` 首条 bootstrap 记录为 5603 ms。到 bootstrap ready 为止记录了 10 次宿主 checkpoint、报告耗时合计 7 ms，均 `busy=0`；checkpoint 在 `sidecar_finish` 内执行，不是单独增加的前端 IPC。该基线不能用于推算本次改动后的速度，需同 profile、同路由和展开状态复测。

## 已确认的故障与修复边界

Linux 实际桌面日志展开后的错误为 `Filesystem sources could not be opened → Filesystem source root failed → (code: 5) database is locked`。这是启动阶段 root SQLite 写锁冲突，与 Session 编辑器重复绑定是不同路径；仅凭锁错误不能确定所有锁持有者。

桌面原来的 Rust 事务表跨页面存活，页面刷新丢失 JS 回调后，未提交的 `BEGIN IMMEDIATE` 仍可能留在宿主内持锁。修复后，每个新页面先建立事务代次：回滚同一 WebView 上一代事务，拒绝旧页面迟到的 begin，并保持其它窗口事务。事务语句和结束还会校验窗口、代次和数据库，不能凭可预测的事务 ID 操作其它窗口。SQLite pool 由同一协议按页面租用：刷新撤销旧租约并复用健康 pool；关闭最后一份租约前回滚遗留事务，同库打开/关闭串行，关闭 pool 最多等待两秒。该协议需要一起重新构建并重启 Rust 宿主与前端；只刷新旧版宿主不能启用新命令。

暖启动不再对已有完整 schema 重复执行 DDL。每个已初始化数据库仍执行 schema/PRAGMA 校验，但刷新不再通过 `plugin:sql|load` 新建 pool；`sidecar.database.open` 的 `reused` 与 `durationMs` 可直接确认复用和打开耗时。新库、缺少 schema 对象、版本不兼容分别保留初始化、补齐、拒绝语义。此计数不代表完整应用启动时间；后续 journal 恢复和 Session 恢复仍执行。

LocalFS journal 初始化失败会关闭已打开 sidecar，失败来源、数据库路径及清理错误都会进入错误链。不会因 `database is locked` 删除数据库，也不会绕过跨进程 journal 恢复。

## 日志位置与排查

| 宿主 | Linux 默认目录 | 重点事件 |
|---|---|---|
| Tauri | `${XDG_CONFIG_HOME:-$HOME/.config}/mindos/logs/desktop/` | `bootstrap.source.failed`、`bootstrap.stage`、`bootstrap.failed`、`sidecar.scope.open`、`sidecar.database.open`、`sidecar.sql`、WebKit/Rust/进程异常 |
| CLI（含 HTTP） | `${XDG_CONFIG_HOME:-$HOME/.config}/mindos/logs/cli/` | `cli.failed`、`command.error`、`run.failed`、`runtime.*`、`http.*`、`process.*` |

`MINDOS_DIAGNOSTICS_DIR` 可直接指定日志目录；日志独立于 `--profile` / 数据根。每个进程一个 `<时间>-<PID>.jsonl`，4 MiB 后保留一份 previous 文件，历史进程文件不自动清除。错误链最多展开 8 层、32 项，单条前端/CLI 消息截断到 4000 字符。

启动失败先打开界面/终端提示的文件，查找 `.failed` 事件，沿内层原因定位具体 source 与数据库。比较 `bootstrap.stage` / `bootstrap.source.ready` 的 `durationMs` 可区分数据库打开、runtime 和 UI 初始化耗时。`sidecar.scope.open` 的 `rolledBack` 表示本次刷新回收了多少旧事务；`sidecar.database.open` 区分新建与复用 pool。常规阶段事件只追加日志，不再逐条 `fsync`；panic、异常退出和前端 failure/error/exception/rejection 事件仍同步落盘。

`sidecar.sql` 把一次语句的**宿主耗时**拆成 `waitMs`（事务互斥锁等待、`BEGIN IMMEDIATE` 等写出锁、或 pool 取连接）、`queryMs`（SQL 本身）与 `decodeMs`（行→JSON 解码），并带 `rows`、`ok`（失败时另有 `error`）；`database_*` 语句还带 `poolSize` / `poolIdleBefore`。判定记录的条件是 **失败（`ok:false`）**、`waitMs + queryMs + decodeMs ≥ 25 ms`、或 `poolIdleBefore == 0`（pool 需要新建连接，典型是空闲超时回收后的第一条语句）；`MINDOS_SIDECAR_TRACE` 取 `1`/`true`/`yes`/`on`（不区分大小写）时记录全部语句，其余值（含 `0`）不改变默认行为。**WebKit 录制里的 IPC 时长不等于宿主耗时**：例如 `sidecar.database.open` 自报 `durationMs: 0` 却观测到 336 ms，说明差值来自命令返回之后的交付/排队，不能用它归因到 SQLite。判断启动慢属于宿主还是交付路径，必须两边对着看。

CLI 使用 `uncaughtExceptionMonitor` 记录致命异常，不安装吞错的异常处理器；同步日志追加使普通失败退出前的记录可读取。SIGKILL 等无法运行 JS 回调的结束不保证有 CLI 退出记录。桌面的 Linux 独立监测进程和下次启动补记机制见 [MindOS profile](../mindos-profile.md#tauri--cli-运行日志)。

## 回归证据

- `ui/app-shell/tests/desktop-diagnostics.test.ts`：嵌套 AggregateError/cause、循环引用、长度限制。
- `ui/app-shell/tests/tauri-sidecar-close.test.ts`：宿主 pool 命令接线、定向关闭、初始化失败保留原因、暖启动跳过 DDL、缺对象补齐。
- `apps/tauri-app/src-tauri/src/sidecar.rs`：真实 SQLite 验证重载回滚、旧代次/旧 close 拒绝、pool 租约转移、等待中 begin 拒绝、其它窗口隔离和新事务提交；另有单测固定「失败语句、慢阶段或需要新建连接时记录」、追踪开关的真值解析，以及真实 pool 上失败与解码路径仍留下计时。
- `apps/cli/tests/http-server.test.ts`：HTTP 宿主跨页面复用连接、拒绝旧 scope close，并保持记录可读。
- `https://github.com/mushuanli/vfsdriver-local/blob/main/tests/25-journal-probe.test.ts`：journal 初始化失败关闭 sidecar，随后可重试。
- `apps/cli/tests/diagnostics.test.ts`：轮换/长度限制、真实 CLI 缺文件失败、未捕获异常/未处理 rejection 的落盘与失败退出码、stdout 不受影响。

2026-09-22 Linux 真实 Tauri 临时 profile 验收：首次完整 bootstrap 9828 ms，留下一笔未提交事务后刷新为 2246 ms；原生 `sidecar.scope.open` 记录回滚 1 笔事务，重载后未提交记录不存在，新事务提交可读。上述为本机虚拟显示器中的单次观测，首次启动包含默认配置初始化，不能作为同一场景优化前后的速度比较。验收使用真实应用入口和真实 Rust IPC，仅在临时构建中注入诊断事件观察钩子。

回归检查：App Shell 307 项通过（30 项跳过）、LocalFS 83 项通过；CLI 全量 176 项通过，3 项旧原生测试夹具因直接 rustc 编译时缺少 `itookit_sanbox` 依赖失败（`tauri-process-tree` / `nested-harness`），与本次改动的文件无关。Rust 宿主 47 项通过，最终 CLI 日志/HTTP 专项 8 项通过。类型与文档检查、Tauri 前端与 CLI 构建通过。

## 2026-09-22 启动 I/O 复查

真实 Linux 桌面 PID 1945511 的首个启动为 4363 ms；日志 `frontend.bootstrap.stage` 的 duration 是两次进度通知之间的时间，标签描述的是下一阶段，不能把该 duration 直接当作标签阶段的执行时间。

| 区间 | 耗时 |
|---|---:|
| 路径与 11 个后端打开 | 287 ms（单后端约 200 ms，并行） |
| home source 与 VFS 初始化 | 128 ms |
| LLM 驱动及目录预热 | 782 ms |
| 核心服务、Kernel、租约/会话恢复 | 1783 ms |
| 对话系统、默认 Flow、主题初始化 | 993 ms |
| UI 服务及初始工作区 | 284 ms |
| 本地挂载注册/恢复与收尾 | 106 ms |

同进程两次刷新总计 5477/5211 ms，初始工作区区间分别为 1858/2114 ms。此区间包含当前路由及持久 UI 状态的恢复，现有阶段日志不能进一步归因到具体目录/会话；不能据此断言 Tauri 本身慢或在递归扫描全部挂载。

隔离临时 LocalFS + Node SQLite profile（没有 Session，没有桌面 UI）的第二次 runtime 启动，记录全部 IFsOps 与 sidecar 操作：

| 指标 | 改前 | 改后 |
|---|---:|---:|
| sidecar 事务 | 221 | 149 |
| 元数据读取 | 208 | 142 |
| record 字段读取（含 journal） | 230 | 158 |
| 普通文件读取 | 27 | 27 |
| 目录枚举 | 5 | 5 |
| 配置文件写入 | 0 | 0 |

改动：`VFSEngine.ensureDirectoryPath` 每个路径前缀改用可选 `statType`，无需读取元数据，仍逐层拒绝非目录，不缓存跨操作的存在性结果；`SystemPromptStore.seedDefaults` 用一次事务检查/补齐默认提示词，保留用户编辑，无事务能力的后端仍走原接口。没有省略 journal 或租约检查。

改后 149 次事务按同一隔离实验的启动标记拆分：LLM 驱动初始化 71 次，设备节点创建 12 次，对话系统初始化 50 次，其余 VFS、核心服务和默认 Flow 阶段合计 16 次。这不是 149 次写配置，也不代表读取了 142 个不同对象。

剩余冗余包括：`DirectoryDriver.exists/resolvePath` 仍通过完整 stat 读取元数据；普通文件 `readContent` 先在 DirectoryDriver 解析节点，再在 engine 层 stat；`getChildren({ fields: 'entry' })` 仍先加载完整节点，再投影为轻量条目。LocalFS 完整 stat 经过事务与 journal 恢复检查，逐条调用会放大 SQLite 和桌面 IPC 开销；目录枚举中的元数据读取则不逐条经过此事务包装，因此元数据次数与事务次数不一一对应。后续应减少不需要完整节点的调用、合并相关读取的事务边界，不能直接删除跨进程 journal 恢复检查。

该实验是调用量比较，不是 Tauri 总启动时间对比。剩余待细分项：设备节点创建反复验证父目录；Agent 配置目录加载；Kernel 恢复、Flow workspace intent 核对、Flow invocation 恢复对持久 Task 的读取；初始工作区恢复展开目录/选中文件；本地额外挂载逐个打开。会话恢复和 intent 核对承担崩溃恢复职责，不能简单跳过。内置 Provider/Connection/Agent/Flow 的默认值已有版本/安装记录判断，暖启动没有反复重写配置。

附带修复诊断写入：并发进入 emergency 日志时，原先直接格式化 JSON 会拆成多次 write，造成行交错。现在先序列化整行再 append，8 个线程共 64 条并发记录全部可解析。排查并发启动时应同时查看主日志与 `.emergency.jsonl`。

后续类型读取优化将上述隔离暖启动事务进一步从 149 降为 70，元数据读取从 142 降为 66，record 字段读取从 158 降为 79；文件读取/枚举/配置写入数量不变。改动覆盖 DirectoryDriver 与 FileSystemView 的存在性、类型检查及读内容路径，详见 [VFS 读取性能与架构审查](./vfs-read-performance-review.md)。

桌面新增 `frontend.session.load.ready`，一次记录 Session 编辑器的 `layout`、`bindSession`、`componentsAndSettings`、`restoreAndRender`、`branches` 分段和总耗时。每个分段表示刚完成的步骤，与 bootstrap 的下一阶段标签不同。它衡量 init 等待链，不包含路由准备、后台 Task 恢复完成、所有异步 Markdown 完成或浏览器首帧；诊断写入不阻塞编辑器 ready。

首次打开 Session 时，`branches` 阶段使用 `loadSession` 已读取的 manifest 初始化分支指示器，不再额外调用 `vcs.branch.list`；分支变更事件仍会刷新列表。因此该阶段现在只反映本地初始化耗时，不能再用于衡量分支数据库读取延迟。

## 2026-09-27 恢复投影与首屏等待链（第二轮）

Kernel 恢复不再为每个 Task 反复读取记录：一次目录扫描解出全部 `TaskRecord`，接管栅栏只在存在存活 attempt 或 leased Effect 时进入事务；索引改为比对后修复，干净重启不写任何投影，投影缺失或不一致时才按原逻辑稠密重建（同时重建 `task-order` 槽位，`listTaskPage` 要求其连续）；catalog 的 `session/`、`task/` 记录也在写前比对。等待图重建复用同一批记录，只有未完成父任务、运行中 attempt 或 leased Effect 的 Task 才会在末段被重新读取。回归在 `backend/durable-kernel/src/session-open-cost.test.ts`：旧实现在一次干净恢复中写入 25 处投影，改动后为 0 次写、每个 Task 只读一次；另有用例覆盖投影损坏时的稠密重建与 Task 分页可读性。

Flow invocation 恢复不再为每个 Session 额外调用 `sessionStat`（catalog 记录的 `status` 已足够判断 open/archived），并把已读到的持久记录传给 `list()`，避免同一前缀被 `listShared` 两次；损坏存储的 Session 跳过并留下一条告警，与原 `sessionStat` 的容错语义一致。

Context GC 的 `observeSession` 不再枚举全部 Session 寻找一条记录：调用方已持有 catalog 记录时直接传 `storage`（`create-kernel-runtime` 的恢复循环），否则只 `inspectSession` 该 Session（`Kernel.inspectSession` 新增返回 `storage` 绑定引用），观测 N 个 Session 的目录枚举从 O(N²) 降为 0/O(N)。

桌面 workspace intent 核对在没有待处理 intent 文件时直接返回（不再 inspect Session、读全部 Task 与 workspace lease），`.intents` 目录每个进程只创建一次。LLM 设备节点按每批 8 个并发创建（父目录先建），节点数很多时不会无限并发。`VFSUIShell.start()` 新增 `vfsUi.loadData` / `vfsUi.restoreExpansion` 两个 `traceBoot`，用于区分侧栏读数据与展开恢复；`create-application-runtime` 新增 `resumeSessionDeletions`、`recoverSessionsWithLeases` 两个 `traceBoot`，以及 `beforeRecover totals`（`adoptSession` / `platformBeforeRecovery` / `contextGcObserve` 逐 Session 累加后打印一次，避免逐 Session 刷屏）。

`createVFS` 的额外挂载改走 `mountBackends`：互不相关的后端并发 `prepare`（init + 根校验），再按声明顺序 `register`，因此 `mountId` 与 `listMounts()` 顺序保持确定；准备阶段失败时关闭本次已准备但未注册的后端（`close` 幂等），注册阶段失败只关闭尚未注册的尾部。原来的单点 `mountBackend` 仍是 `prepare + register`，语义不变。回归在 `https://github.com/mushuanli/vfs-core/blob/main/tests/11-mount.test.ts`：批量挂载保持声明顺序与不同 ID、失败时关闭已准备后端、同批重复路径拒绝并关闭未被注册的那个。注意基线 `IO after createVFS: stat=9` 说明该阶段读取很少，收益主要来自并发准备而非减少调用，需同场景桌面数据确认。

### 2026-09-27 第三轮：重载身份、目录懒连接与调用标记

租约标识改为**按窗口稳定**：宿主通过 `createApplicationRuntime({ sessionOwnerToken })` 传入，桌面端与 Web 端都用 `windowSessionLeaseToken()`（`app-shell/session-owner.ts`，存 `sessionStorage`）。同一窗口重载后复用同一 owner，可立即接管上一页仍持有的租约，不再出现"重载后 Session 全部只读、Kernel 恢复被跳过到 TTL 过期"；不同窗口/标签页仍各自独立。存储不可用时退回每次随机 token（改动前行为）。回归：`backend/app-core/tests/application-runtime.test.ts`「同 token 接管、异 token 拒绝」、`ui/app-shell/tests/session-owner.test.ts`。

已保存宿主目录改为**首次使用时连接**：`DirectoryMountService.init()` 只读偏好，不再为每个书签打开 sidecar；`SessionFilesService.create()` 新增 `resolveSource` 端口（`app-core/src/runtime/create-application-runtime.ts` 接到 `directoryMounts.resolveSource`），在构建 Session 视图时按需打开并注册来源，不可达时保持原有"来源缺失"降级路径，不使恢复失败。回归：`backend/app-core/tests/directory-mounts.test.ts`「启动不调用 openDirectory / resolveSource 只打开一次 / 不可达返回 undefined」、`backend/app-core/tests/session-files.test.ts`「未注册来源经 resolver 打开、resolver 拒绝时 fail closed」。

Flow 调用恢复新增**持久标记** `/var/lib/kernel/flow-invocations.json`（`llm-session/src/persistence/flow-invocation-sessions.ts`）：`FlowInvocationService.submit()` 在写调用记录之前标记 Session，`recover()` 先读一次标记，标记存在且不含某 Session 时完全跳过该 Session 的 `listShared` 探测（3 个 Session、0 条记录的重载场景实测 513ms 属纯探测开销）；标记缺失/损坏/版本不符时报告 unknown，恢复退回逐 Session 探测并把命中者补写进标记（自愈旧数据根）。标记写入串行化，并发 `mark` 不丢条目。回归：`backend/llm-session/__tests__/flow-invocation-sessions.test.ts`、`__tests__/flow-invocations.test.ts`（标记为空时零探测、unknown 时探测并补写、受理先于记录写入）。

启动外壳改为**分阶段呈现**：`#__boot-overlay` 不再是 `showLoading()` 动态创建的全屏层，而是 `apps/tauri-app/index.html` 中 `.main-content-area` 的静态子元素（首帧即绘制，只有内容区转圈，导航栏与侧栏始终可见）。`initApp` 新增 `onWorkspaceReady({ editor })` 与 `onEditorReady()`：前者在工作台布局与会话侧栏渲染完成后触发，宿主把遮罩移进编辑器区（导航 → 侧栏 → 编辑器），后者在首个编辑器挂载完成后触发，宿主移除遮罩；`waitForEditorMount` 改为后台等待，不再计入 `App 初始化完成` 与总启动耗时。`<head>` 内联脚本按 `localStorage['mindos.theme']`（`ThemeService.applyTheme` 镜像的 mode，缺失时回退 `prefers-color-scheme`）在首帧前设置 `data-theme`，消除深浅色闪烁。启动期间 `<body>` 带 `is-booting`，导航与侧栏仅可见、不接受输入，避免抢跑初始导航。

Flow 调用标记新增**封存**语义（`FlowInvocationSessions.establish`）：标记缺失（升级后的首个数据根，或标记损坏）时，恢复完整探测一遍后把结果写入标记（**空集也写**），否则零调用记录的用户会永远停留在"每次启动逐 Session 探测"；探测中出现不可读 Session 时不封存，下次继续按 unknown 处理。回归在 `backend/llm-session/__tests__/flow-invocations.test.ts`。

### 2026-09-27 第四轮：跨 SeqFile 批量读（`getEntriesMany`）

Kernel 的 Task 扫描原本是「每个 Task 读一次记录」：`listTasks`/`listTaskIds`/恢复投影都会枚举 `tasks/` 目录，然后对每个 Task 目录单独 `getEntry(path, 'record')`。在 LocalFS 上每次读取都是独立操作，各自付一次 `begin` + `/__vfs_namespace_journal__ :: intent` 探针 + `commit`，因此 N 个 Task 的成本是 N 个事务。

新增协议层批量读：`ISeqFileOperations.getEntriesMany(requests)` / `ISeqFileTransaction.getEntriesMany(requests)`（`SeqFileReadRequest = { fileIdOrPath, key }`），契约是**结果顺序与入参一致、文件或键缺失返回 `null`**（后端 ENOENT 也降级为 `null`）。它优先调用记录后端可选的 `getRecordFieldsMany(requests)`（`IRecordStore`/`IRecordTransaction`），未实现时退化为逐条读取，因此各后端可以分别接入：

- `MemoryRecordStore`（vfs-core，测试与嵌入式）、localfs `BetterSqliteSidecarDb`、CLI `NodeSqliteSidecarDb`：一条 `SELECT … WHERE (path, field) IN ((?,?),(?,?),…)`；`SidecarRecordStore` 按 200 条/批切分（每批两个绑定参数/条，受 SQLite 变量上限约束），批内共用一次 `withDbRead`、一次 rename journal 核对。`IDBRecordStore`：同一条 readonly IndexedDB 事务内同步发起全部 `get`。
- `PathMappedRecordStore`（系统路径 ↔ 后端本地路径）与 `FileSystemView.metaCall`（虚拟路径 → 挂载源路径，含挂载边界与 EACCES 校验）都必须转发；两者都按请求逐条做路径映射，不改变原有边界检查。
- `TauriSqlSidecarDb`：与 Node/CLI 同一条 SQL（`sidecar_select` 接受变长参数数组）。桌面端本轮未做运行时验收——Node 实现已在同一 schema/同一 SQL 上验证，桌面确认只需一次启动观察 `getRecordFieldsMany` 计数。

durable-kernel 的 `taskEntries`（`listTasks`/`listTaskIds` 共用）改为：一次目录枚举 → 在一个事务内一次 `getEntriesMany` 读全部 Task 记录 → 崩溃残留的空目录（无 seq 文件）自然得到 `null` 并被跳过。实测（CLI 引导成本 fixture，临时 LocalFS + Node SQLite，3 Session + 9 个终态 Task）：sidecar 调用 **994 → 814**，事务 **220 → 175**；`getRecordField` 热点中的 `tasks/task_<uuid>/task.seq :: record` 由每次 1 条降为 9 次批量调用（每次 3 条请求）。3 个空 Session 场景（无 Task）保持 **697 / 157** 不变，作为该改动只影响 Task 扫描路径的对照组。

回归：`https://github.com/mushuanli/vfs-core/blob/main/tests/06-seq-file.test.ts`（请求顺序与缺失 → `null`、事务内同样语义、后端批量能力被调用一次、后端缺少能力时退化）、`backend/durable-kernel/src/protocol.test.ts`「reads Task records once per scan and observes later changes while skipping crash leftovers」（现在断言一次事务内的一次批量调用，且崩溃残留目录被请求但不产出 Task）、`backend/durable-kernel/src/session-open-cost.test.ts`（干净恢复仍为 0 次投影写入，Task 记录读收敛为一次批量读、事务数上限不变）。

剩余可继续压缩的同类热点（本轮未动）：每个 Task 仍有约 3 次 `getMetaExt`（`tasks/task_<uuid>` 前缀检查/元数据读取）与 `graph.seq` 的 `listRecordFields` 前缀遍历；`session.seq :: record` 每个事务重复读取一次（`requireSessionTx`）。这些都不属于「按 Task 逐条记录读」，需要各自的批量原语。

### 2026-09-27 第五轮：按需摘要与有界列表读取

本轮在挂载并发准备之后，减少列表本身的工作量（不引入新的缓存或改变数据布局）：

- Task 分页把逐项指针/正文读取改为两阶段批量读取；目录扫描使用 `fields: 'entry'`。`listShared` 的布局守卫和列表共用一个事务。
- Session browser、ProjectSessions 导航/家族选择改用 `SessionRepository.listSummaries`。每 64 个候选一次跨文件批量读取，避开 history index；完整会话加载仍检查历史版本。导航父标题改用 Map，避免逐条 `find`。
- LocalFS 有限 `walkRecordFields` 使用可选 `listRecordFieldsPage`：一条 SQL 返回有界正文及精确 total。空页/越界页也保留总数，回调提前停止保持 processed 语义；不支持该能力的后端维持旧路径。BetterSqlite、CLI Node SQLite、Tauri 共用查询与解码，仍通过原事务和 rename journal 检查。COUNT 仍可能扫描匹配索引；这是减少返回数据和解码，不是消除全部数据库扫描，也不是游标分页。

确定性回归：Kernel Task 分页保序/固定上界/当前状态与损坏索引拒绝；Session 摘要不加载历史并观察后续修改；真实 BetterSqlite/Node SQLite 的 120 条记录取 3 条只返回 3 条正文，同时保留 total=120；Tauri 测试验证一条 transaction-scoped select。尚未重新执行桌面启动耗时验收，不宣称 IPC 或耗时下降百分比。

后续阶段仍需独立设计和验证：Session 目录分页投影、历史窗口加载、可靠的恢复候选索引及稳定 ID 存储迁移。本轮没有将恢复推迟到用户点击，也没有减少 authority、租约或 journal 核对。

### 2026-09-27 第六轮：项目文件正文优先与按需导航

项目文件此前按 `ProjectNavigation.sync → 展开项目/文件根 → 文件类型与正文 → 编辑器 → selectPath` 串行等待。现在先通过项目文件视图校验类型、读取正文并创建编辑器，再后台同步导航与定位；`openResource` 的完成表示文件内容已就绪，不再保证侧栏定位已经结束。`ProjectSessions.navigation({ includeSessions: false })` 用于项目文件导航及其刷新，跳过会话摘要和家族计算；默认调用仍返回完整组织快照。文件类型检查使用可选 `getNodeType`，不支持的驱动回退 `getNode`，内容仍由原文件视图读取，保留授权及 SeqFile 表示语义。

启动只恢复项目/会话分组及 Flow 库的展开，不恢复历史项目文件分支；恢复深层文件路由时，正文先打开，侧栏随后仅展开定位需要的祖先。后台导航串行执行，路由切换使旧查询/选择失效，销毁时等待在途任务后释放资源。`VFSUIShell.selectPath` 采用选择版本，慢目录返回后不能发出过期的选中事件。

新增 `projectFile.source`、`projectFile.type`、`projectFile.read`、`projectFile.editor`、`projectFile.navigation` 分段诊断。回归位于 `ui/app-shell/tests/project-navigation-reads.test.ts`（历史文件展开不打开项目目录、导航被阻塞时正文先就绪、文件导航不读会话摘要），以及 `https://github.com/mushuanli/vfs-ui/blob/main/tests/06-browser-navigation.test.ts`（慢祖先枚举后丢弃过期选择）。真实项目 UI 与启动路由测试继续覆盖编辑、保存、重命名及旧链接恢复。

边界：目录列举仍读取当前目录的全部直接子项，尚未实现分页；正文仍整文件读取与解码。此轮减少首屏前置工作，并把目录导航移出正文等待链，不代表单次目录列举或大文件渲染已经加速。桌面实际耗时需结合新增分段日志复测。

### 2026-09-27 第七轮：导航取消与保存边界

`WorkspaceController.setVisible?` 由 shell 在 nav 切换时通知缓存工作区；启动尚未完成的工作区也会在注册后检查当前可见目标。项目工作台隐藏时取消视图加载、暂停刷新计时器和侧栏读取，返回时恢复未完成的目标并刷新；通用文件工作台也暂停侧栏、丢弃过期正文并在返回时重新加载。`EngineAdapter` / `SourceAdapter` 在隐藏期间不启动事件触发的目录读取，过期读结果不覆盖恢复后的状态。该边界不停止 Kernel、LLM 执行或持久化任务。

项目工作台每次 `openResource` 入队前立即取消上一代加载。队列里的中间选择直接跳过；`ViewLoad.read` 允许新目标不等待旧正文读取或编辑器工厂返回。已经发出的、不可中断的底层操作仍会完成，旧挂载/文件上下文等到在途读取与工厂收尾后才释放；应用销毁会等待这些清理。通用文件编辑器使用独立 DOM 挂载点，迟到的旧编辑器销毁不能清空新编辑器。

`IEditor.flushPendingSave?` 是独立保存能力，隐藏工作区时调用。MDX 只保存 dirty 内容，并等待已有保存完成；保存失败时保留 dirty、DOM、事件和文件上下文，`destroy` 拒绝，用户可返回原编辑器重试。项目工作台只有在编辑器成功销毁后才清空活动状态和释放文件视图。取消信号不传给写入。当前保障为保留内存中的原编辑器，不是新增跨进程崩溃恢复草稿。

回归：`session-workbench.test.ts` 覆盖旧工厂阻塞时打开最新 Session、跳过中间目标、隐藏/恢复及保存失败保留能力；`editor-visibility.test.ts` 覆盖通用文件隐藏读与迟到工厂隔离；`bootstrap-navigation-cleanup.test.ts` 覆盖 nav 可见性通知；`06-browser-navigation.test.ts` 覆盖隐藏期间零目录/节点读取；`editor-save-lifecycle.test.ts` 使用真实 MDX 验证失败保留与重试、未修改不写盘。

限制：这是视图任务取消与分阶段停止，不是强制中止 SQLite 事务或原生文件系统调用。已进入的编辑器工厂也可能继续内部初始化，最终结果会被回收；目录首次加载仍未分页，大文件仍需整文件读取。

### 2026-09-27 第八轮：源码分流与原始字节读取

针对 WebKitGTK 录制中的 `pnpm-lock.yaml` 被默认 Markdown 预览解析，通用文件页、项目文件和 Session 文件现在统一传入 `contentFormat`。`fileContentFormat` 根据文件注册表保留 `.md/.markdown/.mdx` 及 `.prj/.mind/.anki/.email/.private` 等 Markdown 文档；其他扩展名和无扩展名文件走可编辑源码。专用编辑器选择仍由原 resolver 决定。默认 MDX 工厂不再覆盖显式的 edit 模式；源码模式只加载核心编辑、标题栏和自动保存，不启用 Markdown 语言、预览和任务等插件，禁用预览切换，打印通过文本节点生成，避免把源码当 HTML。只读能力仍取自文件视图。

超过 256 KiB UTF-8、5000 行或单行 10000 UTF-16 单元的 Markdown 默认先打开源码，显示提示，用户仍可主动切换阅读模式。大文档源码首次打开不启用 CodeMirror Markdown 语法分析。此为集中定义的初始阈值，不是 300 ms 延迟保证；主动预览仍使用现有主线程解析，并未实现 Worker 或任意长任务的中途抢占。

任务插件在整篇文档不存在 `[ ]/[x]/[X]` 候选时直接跳过额外 lexer；有候选时保留原 AST 定位，不采用容易误判代码块、表格和嵌套结构的逐行替换。行号查询改为一次扫描行首偏移，再二分查找。完整渲染耗时达到 50 ms 时输出 `[MDX render]`，分别记录 beforeParse、parse、afterRender、DOM 注入、插件后处理与总耗时；这里只记录字符数和时长，不记录正文。DOM 注入计时不等于最终布局与绘制耗时。

桌面普通文件命令集中于 `apps/tauri-app/src-tauri/src/fs_commands.rs`，由 lib.rs 注册；`fs_stat/fs_stat_many/fs_read_file/fs_read_dir/fs_exists` 改为 async 命令并使用 `spawn_blocking`；`fs_read_file` 直接返回 Tauri 原始字节响应。新增 `directory_read_file` 在原 grant 与路径约束下读取，返回原始字节，缺失文件返回 null；`ScopedFsOps.readFile` 使用此命令。HTTP 宿主保持 JSON 传输，在注入的兼容桥里将完整文件响应和预取缓存转换成同样的 ArrayBuffer；新增目录读取命令复用原 grant 校验。旧 `directory_io` 其他操作、范围读取、写入以及跨进程 journal 检查保持原协议。没有引入权限前缀缓存或任意整文件大小上限。

回归覆盖实际仓库 lockfile 的零 Markdown parse、源码编辑保存与只读状态、文档别名、阈值、任务分析跳过与表格偏移、字节完整性、空文件/缺失文件、越界/符号链接/撤销 grant，以及读取运行在线程池。涉及 Rust 与 TS IPC 的变更需要重启并重建桌面宿主，只有前端热更新不足以验证。
