# Session 新建与打开性能审查

2026-09-22；优化前基线为 `081ff430`。范围包括 llm-ui 初始化、app-shell 新建入口、llm-session 历史读取，以及 Markdown 首次渲染。

## 已消除的重复工作

| 环节 | 原流程 | 当前流程 |
|---|---|---|
| 编辑器初始化 | `ensureReady` 与 `loadSession` 各绑定一次，重复 Kernel Session 准备与持久投影同步 | 只绑定一次；分支切换后、组件装配后读取内存快照 |
| 输入与显示状态 | UI 状态读取两次；HistoryView 在折叠状态读取前创建 | 读取一次并复用，HistoryView 创建时已取得保存的折叠状态 |
| Agent 与连接配置 | 初始化后立即再次刷新 Agent/连接 | 初次装配复用结果；后续配置变更与显式重载仍刷新 |
| 标题与 Flow 来源 | 单独多次读取 manifest | 共用本次加载取得的 manifest，不跨加载缓存 |
| 历史恢复 | 遍历主父链时读取一遍，再读取全部轮次；恢复分支时每个新增轮次再读取 manifest | 保留本次遍历读出的轮次和分支，正序投影；循环、缺失祖先、空分支处理保留 |
| 单轮正文读取 | manifest 校验与正文读取分别走存储入口 | 校验和正文在同一事务读取，保留身份及版本校验 |
| Markdown 初始化 | 工厂已渲染 initialContent，随后再次完整 finalize | 只有初始化期间内容变化时才补渲染；包括清空内容，关闭后迟到的编辑器立即销毁 |
| 普通 Chat 的 Flow 面板 | 没有 Flow 调用记录也枚举全部 Tasks | 没有调用记录时直接返回空列表 |
| `SessionWorkbench.createResource` | 完成侧栏全量刷新后才开始打开编辑器 | 刷新侧栏与打开编辑器并行，最后同步新条目选择 |

独立的 Agent 配置、UI 状态、Session settings 读取并行启动。分支选择、草稿保存、文件租约释放、审批恢复和持久投影同步仍遵循原有生命周期约束。

## LocalFS 对照测量

使用真实 LocalFS backend 和 SQLite sidecar，创建 100 轮普通 Chat 历史，然后每次新建 SessionRegistry 加载。每组 5 次；后端与 OS 缓存未清空，因此是注册表冷加载，不是磁盘冷启动。基线使用 Git 中原版 SessionRepository 和 SessionRegistry，同一测试夹具。

| 指标 | 优化前 | 优化后 |
|---|---:|---:|
| 每次事务 begin / commit | 602 / 602 | 101 / 101 |
| 每次记录字段读取 | 1206 | 403 |
| 每次附加元数据读取 | 200 | 0 |
| 5 次耗时（ms） | 50、39、39、38、37 | 8、8、5、6、8 |
| 中位耗时（ms） | 39 | 8 |

事务减少约 83%，记录字段读取减少约 67%。耗时仅用于描述本机本次实验；稳定回归约束使用调用次数与结果内容，不使用毫秒阈值。

上述数字不包括 Tauri IPC、编辑器 DOM 绘制、网络挂载或真实用户数据库，不能解释为整页打开快了相同比例。新建入口的验证使用挂起侧栏刷新，证明编辑器已开始创建；没有用该测试推算新建总耗时。

## 验证入口

- `pnpm --filter @itookit/llm-session test`：历史顺序、单次读取、空分支、环和缺失祖先、无 Flow 调用时不扫描 Tasks、存储校验及既有会话回归。
- `pnpm --filter @itookit/llm-ui-adapter test`：Markdown 初始内容不重复渲染，初始化期间流式更新/替换/清空，以及关闭期间迟到结果的处理。
- `pnpm --filter @itookit/app-shell test --maxWorkers=2`：真实 SessionManager + Kernel + DOM 的单次初始化、分支草稿、历史折叠、执行模式、显式重载，以及既有审批/Flow/工作区测试。
- `pnpm --filter @itookit/app-shell test session-load-localfs`：复跑优化后的 LocalFS 计数和耗时实验。
- `pnpm --filter @itookit/llm-ui-adapter --filter @itookit/llm-session --filter @itookit/app-shell typecheck`。

验证结果：llm-ui 48 项、llm-session 163 项、app-shell 304 项通过，共 515 项；app-shell 的 30 项联网测试按既有配置跳过。三个包类型检查通过。app-shell 完整回归首次受沙箱子进程/网络限制，获准在沙箱外重跑后通过。`docs:check` 通过，保留仓库原有的 5 条历史表述告警。

## 后续定位范围

### 第二轮：合并历史读取与检查完整编辑器

`SessionRepository.readHistoryChain` 在同一事务内读取 manifest 和当前主父链；注册/重载共用父链遍历实现。身份和版本校验每次 snapshot 保留，事务外才执行 Round 恢复和界面投影；不持有跨加载缓存。`getSessionSettings` 也合并校验与内容读取。

100 轮 LocalFS 实验进一步从 101 次事务、403 次 record 读取降为 **1 次事务、103 次 record 读取**，元数据和记录写入均为 0；5 次历史加载为 5/4/3/3/3 ms。这个结果只涵盖历史读取。

新增完整编辑器 LocalFS + Kernel + jsdom 测试：一次 100 轮加载约 2176 ms，其中绑定 13 ms、组件/设置 30 ms、恢复/渲染 1843 ms、分支刷新 288 ms；最后一段也可能受到异步 Markdown 工作影响。Session manifest、草稿和 settings 保持不变。整条链仍有 Kernel 初始化与运行投影写入，不能把“历史读取零写入”扩展为“整个打开过程零写入”。jsdom 不是 WebView，该数字仅用于找热点，不能据此宣称真实桌面耗时。

据代码审查消除两个随消息数增长的重复操作：折叠状态查询不再对每条消息枚举全部状态键；执行树定位保留最后一个执行根节点，避免每轮扫描全部历史 DOM。清空/删除后重新核验根节点归属。未改变历史可见内容，也未引入分页。

Tauri 日志增加 `frontend.session.load.ready` 的阶段耗时，方便在真实桌面确认瓶颈；不记录消息内容。仍为所有折叠消息初始化 Markdown 编辑器，后续应测量并实现与展开/编辑/复制/流式更新兼容的按需初始化，不能仅隐藏 DOM 就视为已经省掉工作。

VFS 层的已修问题和后续架构建议见 [VFS 读取性能与架构审查](./vfs-read-performance-review.md)。

历史恢复仍随当前分支轮次数线性增长；HistoryView 仍为全部消息创建 DOM 和 Markdown 控制器。超长会话应进一步测量可见区域之外的 Markdown 成本，再决定是否引入惰性挂载或分页。Flow 调用面板仍定时刷新，有调用记录时仍需读取 Task 快照；审批恢复的任务枚举保留。侧栏 Session 列表、宿主挂载、租约和首次加载模块也可能占用打开时间，需要真实桌面端分段追踪才能量化。

### 第三轮：折叠历史按需初始化

已实施上述 Markdown 按需初始化：折叠消息的 MDxController 仅保留内容，不创建 Markdown 编辑器或加载其插件。展开单项、展开全部或编辑时激活一次；被折叠祖先遮住的子节点继续延迟。运行中节点保持及时初始化；未初始化节点也能接收内容替换、流式追加和终态内容，首次展开读取最新值。复制读取内存内容，无需为复制创建编辑器；打印仍通过 Session Export 获取完整正文。销毁后不创建迟到的编辑器，异步初始化完成后释放已关闭的实例。

同一 100 轮 LocalFS + Kernel + jsdom 夹具，本轮一次初始化约 **426 ms**，其中绑定 12 ms、组件 32 ms、恢复/渲染 376 ms、分支 3 ms；上一轮样本为 2176 ms。它是诊断样本而非稳定耗时门槛，也不是实际 Tauri 计时。仍创建完整历史 DOM，尚未做视口虚拟化或分页。

新增回归覆盖：只初始化展开消息、复制不触发初始化、单项/全部展开、反复展开不重复创建、编辑前初始化、隐藏期间内容变化、销毁前从未展开，以及 Session 打开时不枚举持久化展开状态中的挂载目录。VFS 层本轮暖启动计数和契约见 [读取性能与架构审查](./vfs-read-performance-review.md)。

### 第四轮：同进程切换与单次加载快照

新增真实 LocalFS + SQLite + Kernel + jsdom 的 A → B → A 测量：两个 Session 各有 100 轮历史，每次销毁并重建编辑器，保留同一个 SessionManager。回到 A 前通过仓库修改标题、草稿和执行模式，验证再次打开仍能读到更新。统计分别记录编辑器 ready 时和 Kernel 后台排空后的 sidecar 调用，并记录 IFsOps 文件调用。IFsOps 计数不包含 SQLite 内部磁盘 I/O；此夹具没有 Tauri IPC，耗时不代表真实 WebView。

这与隔离暖启动不同：后者是临时 profile 上的 runtime 关闭再启动，不含 Session 编辑器；两者不能共用“切换耗时”的结论。A → B → A 测试证明首次 A/B 各读取一次历史链，返回 A 复用已注册状态，历史链读取为 0。该结论适用于测试中的 idle 会话；completed/failed 会话仍会同步历史。

本轮实施：

- `getLoadState` 在一次事务读取 manifest 和 settings；标题、Flow 来源、UI 状态及分支草稿共用结果。初始化与显式重载都使用新快照，不增加长期正文缓存。未指定导航分支时也按持久 currentBranch 恢复对应草稿。
- 单次编辑器初始化直接 `getManifest` 调用从 4 次降为 2 次，另外通过一次 `getLoadState` 取得展示所需信息；不是全链只读两次 manifest。持久投影、历史校验、分支查询仍各有职责。
- Session 列表使用轻量目录条目，manifest 每 64 个一批读取。65 个 Session 实测为 2 次事务、132 次记录字段读取、0 次扩展元数据读取、0 次记录写入。仍读取 history index 以保留原 list 契约和存储版本校验。
- 文件上下文获取在同一个 Session 串行操作中取得视图与 cwd，仅检查一次配置；下一次获取仍核验 revision，配置变更会撤销旧视图。
- 审批恢复利用已有 `task/<id>` 状态索引筛选未结束 Task，再在同一事务读取并检查 pending interaction；不枚举已完成 Task 的目录或读取其正文。仍遍历轻量状态索引，也仍读取无 pending interaction 的非终态候选。保留旧宿主端口回退、Flow 成员排除和过期挂接结果丢弃。
- 重复 Kernel Session 注册在 catalog 内容未变化时不再写入，避免无变化的 catalog 提交通知唤醒其他已打开 Session 的扫描。首次注册及中断注册修复照常执行。

回归入口增加 `session-editor-load`、`session-load-localfs`、`pending-interaction-restore`、`history-snapshot` 和 `session-files`；既有审批响应、附件恢复竞争、完整 Kernel 和编辑器测试保留。

单独运行本轮夹具的诊断样本：首次 A 432 ms、首次 B 366 ms、返回 A 355 ms；返回 A 的 `restoreAndRender` 为 315 ms。返回 A 在 ready 时为 31 次事务、61 次记录字段读取、10 次记录写入；普通文件 readFile/writeFile 都为 0，仍有 stat、目录读取和 SQLite 操作。首次 A/B 各有 8 次普通文件写入，用于夹具中首次准备 Kernel 布局。后台排空后的统计更高，受调度时机影响，不作为固定回归阈值；与前轮 352 ms 的返回 A 样本相比，没有观察到可宣称的整体耗时改善，剩余热点主要在 DOM 恢复/渲染。

验证：Kernel 263 项、llm-ui 51 项、llm-session 与 app-core 全包通过；app-shell 完整矩阵合计 314 项通过、30 项按既有配置跳过。宿主重启/工作区崩溃的 4 项首次受沙箱限制，在沙箱外重跑通过。最后单独重跑 5 项编辑器加载测量通过；6 个相关包/应用类型检查及 Tauri 前端构建通过。jsdom 中 Mermaid/布局能力告警仍存在，未将其计时视为真实浏览器性能。

当前边界：历史首次加载仍读当前分支整条父链，历史 DOM 仍全部创建。尚未实现正文分页、视口虚拟化或宿主批量 SQL/IPC；不能把减少事务与重复读取理解为每个字段只有一次 IPC。Kernel 正常调度/恢复仍可能枚举 Task 目录，审批恢复使用索引不代表整个 Kernel 不再扫描。大历史的下一步重点是 DOM 数量与按页历史读取，并需保持发送上下文、导出、分支切换和执行恢复的完整语义。

## 2026-09-22：根据真实 WebKit 录制减少绑定前置 I/O

用户提供的 `localhost-recording.json` 覆盖 3.981 秒：207 次本地 IPC，其中属性检查 58 次、SQL 查询 85 次、事务开始/结束 59 次、SQL 写入 3 次、目录枚举 2 次。点击约在录制开始后 1.598 秒，录制结束时新 Session 尚未完整显示。因此这不是完整切换时延，也不能用此前 jsdom 样本推断这次瓶颈仍是历史 DOM。录制未显示递归扫描用户挂载目录；固定 Kernel 布局检查与托管资源维护是明显的重复操作来源。

本轮实施：

- `SessionManager.bindSession` 优先 `openSession(id, expectedStorage)`，只有 `SESSION_NOT_FOUND` 才创建。打开每次读取当前 catalog/主记录、校验绑定身份和布局；同一 Kernel 已登记的相同 fs/root 复用监听器，不重写固定布局元数据、不因再次绑定唤醒资源扫描。删除、绑定冲突和新版布局仍拒绝，不缓存可变主记录。
- 固定布局文件的存在性检查合批，缺失文件顺序创建；LocalFS 的属性批次对相同路径去重，仅复用本批次结果。
- 托管资源维护复用事务内已更新的 request 行，并在同一事务计算截止时间；无到期物理清理时，不再另开事务读取 deadline。实际调用外部清理器后仍重新读取持久结果，以保留重试和容量释放语义。
- UI 状态只读写 session 记录，不触碰 history index；相同内容不写入、不增加 revision、不通知。纯 UI 状态通知不触发 sidebar 全量刷新；名称、分组、分支等变更仍刷新。
- Flow 面板空闲/全终态每 30 秒同步，活跃或失败每秒刷新，窗口焦点/恢复可见及本地调用主动刷新；销毁后停止请求与迟到渲染。

真实 LocalFS + SQLite 隔离实验，在同一实现中对已有 Session 分别调用创建检查和新的打开路径；计数窗口内暂停后台定时器，只比较前台绑定，不包含编辑器和 IPC 延迟：

| 操作 | 重复创建检查 | 已登记绑定打开 |
|---|---:|---:|
| `statMany` 宿主调用 | 9 | 2 |
| 底层 `stat`（包含批量内部调用） | 27 | 6 |
| sidecar begin/commit | 5/5 | 4/4 |
| record 字段读取（含 journal） | 8 | 6 |
| 附加元数据读取 | 2 | 2 |
| 布局元数据写入 | 1 | 0 |

空闲资源维护从两次事务、六次前缀扫描降为一次事务、三次前缀扫描；UI 状态更新从两条记录的读写降为一条，重复保存只有一次记录读取、零写入。没有新增通用 VFS 缓存或宿主批量 SQL 协议，外层事务的 journal 恢复核对完整保留。

验证入口：`durable-kernel/src/session-open-cost.test.ts`、`llm-session/__tests__/history-snapshot.test.ts`、`https://github.com/mushuanli/vfsdriver-local/blob/main/tests/25-journal-probe.test.ts`、`app-shell/tests/session-load-localfs.test.ts`、`app-shell/tests/session-sidebar-order.test.ts` 和 `app-shell/tests/flow-invocation-polling.test.ts`。本轮未完成真实桌面改动后的录制对比，不能据操作次数宣称切换已降至某个毫秒值。录制中 WebKit 主线程高负载、约 40–60 ms 的部分 IPC 响应仍需关闭截图录制并结合宿主计时验证。

本轮验证：Kernel 266 项、llm-session 167 项、llm-ui 51 项、LocalFS 86 项（含跨进程崩溃恢复）、app-core 125 项通过。app-shell 全包 314 项通过、30 项按既有配置跳过；受沙箱限制的 4 项宿主恢复测试在沙箱外重跑通过，随后新增的绑定 I/O 实验及编辑器加载共 8 项定向复跑通过。6 个相关包类型检查、Tauri 前端构建和文档检查通过；文档保留原有 5 条历史表述告警。
