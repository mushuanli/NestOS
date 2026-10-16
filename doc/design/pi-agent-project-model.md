# pi-agent 项目与同步模型

## 结论与重构原因

原实现的文件导出、短命进程、Codex workspace 和 sync project 是不同实体。客户端可选导出目录的子目录，但服务端没有共享项目身份；Codex 直接使用宿主路径，不能继承进程的目录挂载与只读策略。单纯增加 MCP 接口不能解决这个边界。

现在分成两个业务服务：项目管理负责真实目录及其执行授权；sync 负责对象、manifest、replica 和数据集同步。两者共享认证与连接，配置和数据目录互相隔离。sync 的 project ID 不等于可执行目录项目 ID，不自动创建执行授权。

## 目录与身份

```text
pi-agent installation (stable server_id)
├── exports: authorized directory roots
│   └── home = /srv/work
│       ├── team/a -> executable project A
│       └── team/b -> executable project B
├── projects: private project catalog outside exported directories
│   └── project = alias + relative path + access + mount policy + revision
├── harnesses: explicitly configured native runtime homes and executable commands
└── sync: independent object and metadata storage
```

`exports` 是可选择项目根的范围，不要求导出根本身就是一个项目。项目根可以是任意合法层级的子目录。`project_register` 默认绑定已有目录；`createDirectory=true` 只在已有父目录下创建一个新目录，不递归创建未知父目录。路径拒绝遍历、链接、宿主绝对路径，按组件规范化重复和尾部斜杠。

服务端在稳定安装与认证身份内按 alias、相对路径去重，为首次注册生成并持久化项目 ID；重复注册返回已有项目，保留名称、权限和挂载。目录设备/inode/创建时间身份也保存在私有 catalog；原路径被其他目录替换时拒绝访问，不自动改绑。元数据使用单实例文件锁、8 MiB/1024 项上限、原子替换和目录 fsync；替换后持久化状态不明时停止服务该 catalog。

itookit 保存自己的项目 ID 与服务端项目引用，显示「服务器名:项目名」。工作台组织和 MindOS Session 记录仍存客户端 profile；Codex 原生会话仍由 native harness 的 home 管理。新项目协议支持只读和读写文件根，旧无项目协议的远程绑定继续只读。历史 `.mindos/readonly` 元数据路径保留以免迁移已有会话，不再代表文件根必须只读。

服务端导出 `rw` 是授权上限；MindOS 创建远程项目默认保存 `ro` 绑定，修改服务端配置不会自动升权。远程项目菜单只提供重命名、重新挂载和卸载等项目管理操作，不提供根项目的复制/移动/删除入口；项目内文件保留其文件操作。重新挂载使用 `remountProject` 用例：切为 `rw` 时读取服务端登记，必要时调用带 revision 的 `project_remount`；切为 `ro` 只收窄客户端视图，不下调其他客户端的服务端授权。持久绑定更新后撤销旧视图及会话授权，释放旧来源，保留项目 ID、文件和原生会话。切换前保存并关闭本项目编辑视图，本地在途任务由应用层拒绝，服务端权限修改由文件执行门拒绝；响应丢失后重读登记核对，不盲目重放。

卸载经独立 `ApplicationBackend.unmountProject` 用例，仅撤销客户端挂载、移除本地项目接入和本地 Session；离线仍可卸载，不遍历远端树，不调用服务端 `project_forget` 或原生删除。MCP 详情将 ProjectRemoteMountService 的挂载、客户端权限与连通状态投影为列表，不把挂载记录复制进 MCP 配置。pi-agent 启动日志单独展示实际导出权限，避免将导出上限与项目绑定混为一谈。

## 同一项目授权用于三种访问

| 能力 | 授权来源 | 传输 |
|---|---|---|
| 文件、结构修改、SeqFile | projectId + revision + alias/path，读写权限可衰减 | 原 HTTP 文件协议，增加项目上下文 headers |
| bash / tools | 服务端项目根与 mounts，客户端不能自带更多目录 | MCP `project_exec`；HTTP 查询、取消与回收沿用进程协议 |
| Codex 会话 | 同一项目授权、profile 与策略 revision | MCP harness 工具携带 projectId/revision；native stdio 留在服务端 |
| sync | sync principal/namespace/dataset/replica 授权 | 原 sync HTTP 协议 |

文件请求携带 `x-fsagent-project`、`x-fsagent-project-revision`，只读视图还携带 `x-fsagent-project-readonly`。服务端检查批量 stat、列表、内容读写、重命名两端和 SeqFile 路径；只允许项目根与已配置挂载来源。初始化允许必要的祖先目录 stat，不开放祖先目录列表或内容。根目录或挂载身份变化、策略 revision 过期均拒绝访问。未带项目上下文的旧文件接口仍受安装级导出授权约束，是兼容的管理接口，不作为项目的执行授权。

项目根在 bash 里映射到 `/workspace`，在 Codex runtime 里映射到稳定的 `/projects/<projectId>`。后者使同一个 native home 中的会话能够按项目 cwd 区分。项目会话列表只返回该项目 cwd 的会话，历史读取和恢复也检查边界；旧 CLI 的宿主 cwd 只有落在当前项目真实根内才允许映射到虚拟 cwd 后恢复，不将原宿主路径交给沙箱内执行。接管仍拒绝其他客户端正在运行的原生会话。

额外挂载只能来自已授权导出 alias，目标必须位于项目主目录内。目标目录需预先存在，防止 launcher 在创建挂载点时偷偷修改项目文件。只读挂载不允许升权，重叠来源不能同时获得 ro/rw，当前一个执行环境最多写一个导出。客户端绑定会导入服务端额外挂载；服务端策略发生变化后，旧文件版本拒绝访问，旧客户端执行视图也拒绝静默扩大授权，需刷新绑定。

## 执行与后续 VMM

`ProjectLauncher` 是 bash 与 harness 共用的启动端口，输入为已经授权并解析的目录 Plan 与保留锁，输出为受监管的启动命令和能力句柄。当前实现为 bubblewrap，目录通过 fd 挂载并核对持久目录身份。将来 VMM 应实现同一端口及相应生命周期，不能接受客户端提交宿主目录或任意 backend。当前没有实现 VMM。

项目 Codex app-server 在外层项目沙箱中运行；其 native sandbox 设为 danger-full-access，让真正的目录边界由外层沙箱统一执行，native approval 仍为 on-request。审批无法扩大外层挂载。明确的 harness home 挂到 `/harness`，运行时系统目录和 harness 可执行文件也在权限范围内；不会因为配置 executable 而挂载它的整个父目录。部署需使用可独立运行的 native executable。

默认隔离网络；`projects.network=true` 明确允许联网，并只读提供解析器和证书文件。命令和运行时 home 来自部署配置，远程请求不能修改。没有可用的 bubblewrap/user namespaces 时执行拒绝启动，不能退回直接宿主执行。

进程执行和 Codex turn 与文件访问共用 FileGate。Codex 收到完成事件后失效文件 revision 并释放 gate；中断需确认原生完成，断开控制面板不会被当作完成。清理不能确认时保留未知/拒绝状态。当前 gate 是安装级，运行期间其他项目的文件访问也可能收到 EBUSY；项目级并发、强跨进程 lease 和 VMM guest 回收属于后续工作。

旧 profile 的显式宿主 workspace 保留历史管理兼容，仍禁止与 exclusive rw exports 重叠；它们不成为新项目的执行路径。新 profile 通过 `projects=true` 授权项目 runtime，原 workspaces 不再需要逐项目列出。未来 harness 继续实现 HarnessDriver，项目授权不放进具体 native adapter。

## itookit 连接诊断

### 目录显示：C4 组件与等待分析

```mermaid
C4Component
    title 工作台远程目录显示（优化后）
    Person(user, "用户", "点击目录或使用键盘激活")
    Container_Boundary(client, "MindOS 客户端") {
        Component(view, "SessionWorkbench", "原生 DOM / TypeScript", "目录正文、标签、取消过期读取")
        Component(sidebar, "ProjectNavigation / VFSUI", "原生 DOM", "后台展开、选择与刷新")
        Component(browser, "SessionBrowser", "app-core", "一次投影目录节点及条目")
        Component(project, "ProjectService", "app-core", "项目目录、重叠校验、授权文件视图")
        Component(ignore, "directory-visibility", "app-shell / FileIgnoreFilter", "并行祖先规则读取、保留忽略语义")
        Component(http, "HttpFSBackend", "piagent-driver", "项目授权 HTTP 文件读取、stat 批处理")
    }
    System_Ext(remote, "pi-agent 文件服务", "项目授权、目录分页、文件属性及规则内容")
    Rel(user, view, "激活资源")
    Rel(view, browser, "readFileDirectory：目录节点与条目")
    Rel(view, sidebar, "后台同步，不阻塞正文")
    Rel(sidebar, browser, "读取树节点；刷新不发起打开")
    Rel(browser, project, "获取一个授权文件视图及项目投影")
    Rel(browser, ignore, "过滤已列出的节点")
    Rel(project, http, "复用远程来源，装配文件视图")
    Rel(ignore, http, "各祖先规则并行：stat 后按需读取字节")
    Rel(browser, http, "目录 stat 与 entries 并行")
    Rel(http, remote, "首次来源初始化；目录分页、stat、content", "HTTP")
```

HTTP 关系经过授权 VFS 视图；图中的组件关系不是 UI 绕过 VFS 直接访问远程服务。组织项目页展示“文件、收藏、会话”等入口，物理文件目录页读取项目目录条目，两者不要混为一个请求。

| 阶段 | 原等待或冗余流程 | 当前实现 |
| --- | --- | --- |
| 资源打开 | 点击与刷新共用选中事件；刷新可能重新打开旧资源 | 启动时恢复选中项；之后只用资源激活事件打开。移除 `selectionSync` 及重复导航抑制逻辑 |
| 已知目录 | 先进入文件编辑器查询类型，再切到目录页面 | 从侧栏、目录列表和文件根取得目录提示，直接读取目录；仍由真实源验证类型 |
| 未知深链 | stat 后释放文件视图，再重新打开读取目录 | 识别为目录后保留已开的视图与节点，目录完成或失败时释放一次 |
| 目录头与行 | 分别获取项目投影、收藏、文件视图；串行类型查询再列目录 | `readFileDirectory` 共用一个视图及投影；stat、entries、项目投影并行，已取得的 stat 不再查询 |
| 项目文件视图 | `forFolder`、`openFiles`、重叠检查分别读取目录清单 | 同一次打开共用清单，保留来源与重叠校验 |
| 忽略规则 | 每次过滤递归串行读取祖先；规则文件查询类型、属性，文本读取再触发类型检查 | 祖先规则并行，展示策略每个规则文件只调用一次属性查询及一次原始字节读取；同次调用按路径去重，VFS 保留必要校验 |
| HTTP stat 批次 | VFS 路径校验可能在同一批次多次提交相同祖先路径 | 同一批次按路径去重，向每个订阅者分发对应结果；订阅者取消与期限仍独立，不跨批次缓存 |
| 权限 | 映射节点已有只读状态，正文再查浏览器投影的 capability | 使用授权来源映射出的只读/禁用状态，保留行操作策略；实际写入仍由源授权校验 |
| 刷新 | 列表返回前等待侧栏刷新与展开 | 条目返回后后台刷新侧栏，不再额外展开 |

若有 K 个祖先目录、其中 S 个包含 `.gitignore`，展示策略调用 K 次 `getNode` 和 S 次原始内容读取；不查询每个普通文件的内容。VFS 读取仍验证文件类型，挂载视图仍检查路径中的链接，实际 HTTP stat 数量不能直接等同于 K。祖先请求同时启动，共享同次读取的 Promise，不跨次缓存，因此外部修改、删除规则文件会在下次目录读取生效。挂载的 discovery root 仍限制规则读取范围，保留父规则、否定规则、已忽略父目录及无内置默认排除的语义。投机读取的错误只有在规则实际被过滤器使用时传播；全部读取结束后才释放文件视图。

已知目录的正文路径为：获取授权视图 → 并行目录 stat / entries / 项目投影 → 并行祖先规则 → 节点映射 → 渲染。首次来源初始化与非在线连接的有界探测仍需要等待；大目录仍按协议读完分页，不伪造完成。`projectDirectory.read` 记录正文总耗时，`projectFile.navigation` 记录后台导航耗时。测试验证源获取次数、规则请求数量与并行启动、修改后的刷新、取消与故障、只读创建限制以及侧栏刷新不会打开旧资源；真实远程网络的耗时需现场观测，不能由单元测试推断。

远程项目持久保存 `connectionId`，运行时从工具箱 MCP 配置投影连接。原来的 `[ENOENT] fs: Remote file system not found` 来自本地连接查询，不能据此判断 pi-agent 上的目录或原生 session 已丢失。配置存在但未通过 pi-agent 能力验证时也不会进入连接投影。

连接访问现使用结构化 `RemoteConnectionUnavailableError`，区分 `mcp-not-found`、`catalog-not-loaded`、`auth-missing`、`extension-missing`、`invalid-descriptor`、`endpoint-mismatch`、`invalid-endpoint` 和 `unsupported-transport`。界面显示配置名称与修复提示；目录说明及菜单生成容忍暂不可用的连接。异步 harness、连接检测、能力查询和目录浏览会先恢复当前引用的 MCP 配置，不按名称或服务器地址猜测并重绑项目。

“设置 → 日志管理”按 `pi-agent` 模块可查看 `remote.operation.failed`，包括阶段、缺失连接 ID、配置名称、原因、MCP catalog revision、现有配置的 ID/名称/验证状态，以及引用该连接的项目 ID。失败也输出到开发者控制台，时间在前；同一个异常沿调用链传播仅输出一次 ERROR。目录列表中的离线占位不再吞掉诊断；原生 session 打开失败记录 `session-open` 阶段，历史读取等编辑器内调用记录 `harness.read` 等具体阶段。恢复旧路由时保留连接故障原因，不误报为书签已过期。日志不记录 API Key、认证引用、请求头、端点地址或会话正文，provider 异常仅记录结构化错误码。

常规 catalog 刷新只写 DEBUG；需要追踪时在日志管理中将 `pi-agent` 设为 DEBUG，复现后查看 `mcp.catalog.refreshed` 和 `mcp.connection.recovery.started`。能力验证恢复成功写一条 `mcp.connection.recovery.completed`。日志保留在现有内存缓冲区，刷新或重启客户端前应复制所需诊断。

同步控制记录也独立保存 MCP `connectionId`。旧同步绑定的失效引用不属于原生 harness session；状态读取只读本地记录，不能因刷新项目菜单而创建远程客户端并抛 ENOENT。项目同步图标、当前项目状态按钮及悬停异常列表展示失效原因，保留显式解绑；实际同步操作才恢复当前引用。未发送命令的绑定可离线解除，结果未知的命令及序号继续保留，不推断为未提交。

工具箱的 MCP 图标显示管理器实际观测的未连接、连接中、已连接或异常状态，悬停显示失败阶段、原因与观测时间。配置刷新不发起网络探测；未连接不能推断为服务器异常。连接与能力发现失败保留诊断，显式测试成功清除旧异常；主动断开显示未连接，意外断开显示异常。状态属于运行时，不随 MCP 配置保存，也不包含凭据或原始错误正文。

## 接口与配置

MCP 增加 `project_roots`、`project_list`、`project_read`、`project_register`、`project_configure`、`project_forget`、`project_exec`。`project_configure` 使用 revision CAS，运行中拒绝修改；项目根不可通过 configure 改绑。`project_forget` 只撤销授权和目录映射，不删除数据；重新注册产生新项目 ID，旧会话不会静默绑定到新目录。文件系统需支持目录创建时间，否则项目目录身份校验拒绝开放。注册可按目录身份查回结果，配置结果未知时读取 project_read 对账，不能盲目重放。进程、harness 继续使用各自 epoch/requestId 与查询/回收机制。

```toml
listen = "127.0.0.1:8787"
server_id = "office-node"
execution = true
api_key_env = "PI_AGENT_API_KEY"

[projects]
root = "/var/lib/pi-agent/projects"
network = true

[[exports]]
alias = "home"
path = "/srv/work"
access = "rw"

[[exports]]
alias = "reference"
path = "/srv/reference"
access = "ro"

[[harnesses]]
id = "codex"
kind = "codex"
command = "/opt/codex/codex"
home = "/var/lib/pi-agent/codex"
projects = true
```

服务端路径需存在且被部署账号授权。catalog、sync 存储、harness home 不能与导出根相互包含。原有纯文件、纯 sync、历史 harness 配置不用开启 `[projects]`。

## 验证与范围

测试覆盖深层目录注册、单级目录创建、目录去重和重启恢复、挂载衰减、版本冲突、运行中拒绝修改、目录替换拒绝、文件路径越界拒绝、项目会话隔离及 turn/file 互斥。MCP SDK v2 → Rust → HTTP 文件链已验证；真实 bubblewrap 验证 bash 写主目录与只读参考目录；真实 Codex CLI 验证临时 home 内的会话创建与跨项目历史拒绝，没有调用模型或读取个人会话。

未声称验证实际模型工具执行、VMM、PTY、Windows/macOS sandbox 或安装级 gate 的并发性能。远程挂载策略更新后需要显式刷新客户端绑定；不自动将新增服务端目录授权发给已有 Session。

## 手动单向同步到项目目录

目录同步由两条独立关系组成：itookit 本地项目 ↔ files 数据集，以及 files 数据集 ↔ 服务器项目中的已有目录。两条关系各自选择方向、预览并确认执行；打开目录面板不会修改本地同步方向。服务端必须同时开启 `[projects]` 和 `[sync]`，sync 存储保持私有。Web 已装配交互；Tauri／CLI 可以使用相同协议，其宿主同步入口仍需单独装配。

默认使用更新模式：复制新增／修改项，保留目标独有文件，不自动传播删除；双向模式将独立编辑收敛，同一路径双方改变时保留冲突。目录类型转换、符号链接、读取不完整和超限项阻塞目录计划，不能通过普通选侧绕过。目录同步不穿透附加挂载和 `.mindos`。镜像删除、自动触发和目录结构转换未开放。

`piagent_capabilities.directorySyncVersion=2` 表示支持完整方向及比较接口；只有旧 directorySync 布尔能力的服务器在界面中限定为数据集落地，并说明升级入口。

| MCP 工具 | 作用 |
| --- | --- |
| `project_sync_directories` | 按执行项目 ID／revision 浏览项目内已有子目录，不允许任意服务器路径 |
| `project_sync_bind/status/unbind` | 建立、读取、解除持久目录映射；解绑保留文件 |
| `project_sync_configure` | 按 policyRevision CAS 改方向，清除旧计划；applying 时拒绝 |
| `project_sync_preview` | 捕获固定数据集 head 与目录内容，返回带 side 的新增／覆盖 actions 及结构化 conflictDetails |
| `project_sync_compare` | 绑定 planId／冲突路径，返回基线、dataset、directory 摘要与最多 256 KiB UTF-8 文本；缺失、二进制、超大／不可用版本明确表示 |
| `project_sync_resolve` | 选择 dataset 或 directory 作为内容来源，仅允许当前方向及可处理冲突，生成新 planId 供再次审阅 |
| `project_sync_execute` | 按当前 planId 应用或恢复；执行前复核目标与来源，存在未解决冲突时保留文件并拒绝目录执行 |

绑定保存稳定 bindingId、执行项目与策略 revision、sync 项目／dataset、authority／namespace／historyEpoch、目标子目录及目录身份。重复／父子重叠目标拒绝，重试 bind 只能返回同一目标。基线、计划、方向 revision、目录回传的 replicaId／nextSeq／publishCommand 保存在私有 catalog。

目录回传直接复用 sync 命令的条件发布、持久序号及回执，不另建发布事务。对象与 manifest 验证后，在发布前保存 applying 意图及精确 command；恢复首先查询同一 replica／序号的回执，后续 head 改变不会覆盖原结果。确定拒绝后计划标记 rejected，可重新预览；未知／过期回执保留原证据并阻塞。下载的逐项持久化／baseline checkpoint 保持原恢复边界；外部 shell 不参与文件锁，内容变化时条件应用拒绝覆盖。

界面先选择服务器项目及相对子目录，可以逐层浏览，再选择“数据集落地／目录回传／双向”。预览展示数量、路径、操作及修改目标，支持按路径筛选。冲突显示原因和两侧摘要，按需读取正文并标出文本差异；可逐项或批量选择来源，选侧只产生新预览，第二次确认才写入。旧预览、已发送操作及关闭面板各自保留明确语义。
## 工作台与 llm-ui 的远程会话

完整远程项目绑定在项目树下增加「远程会话」，再按服务器实际声明的 project harness profile 分类。目录参考挂载不会授权该目录所属项目的会话。会话节点使用远程图标，路由为 `<项目组织路径>/@harness/<profile>/<native-session-id>`，与本地 Session ID 分开。下一页目录使用单个 `@page:<编码游标>` 路径段，每页会话和后续分页目录都是当前目录的直接子项，满足 VFS 列目录边界；分页路径仍解析到相同 profile/native session 身份。离线节点显示不可用，不让整个项目导航失败。

Codex 会话从显式配置的 home 通过原生 `thread/list` 发现，再以项目目录授权过滤；历史记录中的宿主 cwd 先解析真实路径，允许同一目录的符号链接入口，但不能越过项目根。不用会话文件所在路径作为项目归属，也不要求用户把 home 再导出成项目目录。

项目沙箱同时挂载 home 的真实绝对路径和 `/harness` 兼容入口，保留原生索引保存的日志位置。浏览器 stat 使用 `harness_session_info`，不加载完整历史。paginated 历史及摘要请求从受限 JSONL 窗口分页读取，每页最多 100 项/2 MiB，`nextCursor` 继续加载更早记录。JSONL 使用真实 turn_context/task_started 身份和记录时间，兼容 function_call/custom_tool_call，不再把整份历史标为同一个假轮次。session.native 不重复返回 turns。工具摘要在预算前移除详细输入及输出，避免大工具结果挤占消息页。

原生分支通过 `harness_fork` → `thread/fork` 创建，名称存入原生会话，epoch/requestId 回执覆盖创建与未知结果恢复。`parentSessionId` 定义分支家族，界面可查看、切换及创建分支；创建后导航到新原生 session 路由，不生成本地 Session。只读项目、空历史、活动会话或待确认操作禁用创建。会话继续使用原生 resume；CLI 不支持的操作保持明确失败，不自动转换或重放。

原生会话节点使用语义标题显示模式，路由和原生 ID 保持稳定。名称优先原生 name，再使用 preview；均为空时显示未命名会话。createdAt 与 updatedAt 独立保留为毫秒，驱动兼容旧服务的原生秒时间和 native.createdAt，未知时间不显示 1970 年。侧栏显示创建／修改时间，目录列表的修改时间列和名称悬浮提示使用真实时间；会话标题悬浮提示也包含两种时间。侧栏和目录列表默认按最后修改时间倒序，未知时间排末尾；新建／分页操作保持独立顺序。

原生会话与本地会话共用 llm-ui 的标题栏、历史展示、输入组件、复制/折叠与历史可见性控制。`ConversationWorkspaceView` 装配共享视图，`RemoteConversationEditor` 仅将宿主的 `ConversationControls` 绑定到视图。`remote-rounds` 按原生 turnId 汇总：每轮一个用户请求 MDxEditor 和一个响应 MDxEditor，用户内容数组经 contentParts 保留文字项边界，展示和复制时在各项之间插入 `\n\n---\n\n`；保留同轮全部助手回复及思考，真实重复请求不会按文本去重。工具显示名称、操作、首个非空命令行和目标路径；命令预览最多 240 个字符，不展开后续代码、完整参数或结果；助手正文的代码块仍使用现有折叠控件。时间从原生日志及事件保留为毫秒，未知时间留空。分支标签使用 branchName，根分支为 main；未命名原生分支明确显示未命名，不使用请求预览冒充分支名。缺少 turnId 的旧数据按用户消息边界投影。同一原生轮次的编辑器标识不因分页或增量输出改变，快照刷新保留现有实例。打开会话先显示最近一页，再自动逐页补齐到开头；顶部显示加载进度，失败保留已加载内容并允许手动重试，不随轮询重复失败请求。驱动检测重复和循环游标，并保留已加载的全部页面，刷新和事件缺口恢复不丢弃早期历史。总容量达到 10,000 条或 32 MiB 时明确失败，保留现有历史和游标，不静默裁剪。发送、停止及审批直达远端，不创建本地会话或走本地模型驱动。界面根据原生控制权禁用发送、停止与审批，未知结果保留草稿并提供核对入口。

打开原生会话与创建、切换原生分支均保留项目选择器的当前范围；只有显式选择项目才切换侧栏范围。宿主通过 `hostContext.toggleSidebar` 注入侧栏控制，远程编辑器不把侧栏按钮视为 harness 执行能力。标题栏事件、响应式更多菜单由共享 `EventBinder` 管理；上一条/下一条展开消息、消息导航和打印复用 HistoryView、FloatingNavPanel、MDxRenderer 与 LLMPrintService。原生导航只提供浏览、复制与折叠，不提供本地上下文修改或历史删除。分支按钮和下拉列表使用共同的 BranchIndicatorTemplates，原生 ID 用于切换，分支名称仅用于显示；创建入口收进下拉菜单，未支持的分支删除不显示。状态点经 StatusIndicatorView 显示就绪、运行、待核对和异常。原生 HTML 在屏幕与打印中均按字面呈现。

绑定打开时按其 MCP ID 恢复连接投影；如保存的能力扩展缺失，仅重新验证该配置，验证成功后修复缓存及扩展。不会按显示名称猜测绑定，也不会探测全部 MCP。刷新带版本围栏，较旧异步结果不能覆盖更新后的目录。

工具箱 Agent 将各个已验证的 pi-agent MCP 配置所声明的项目 harness 投影为只读条目，显示服务器、kind 和 profile。条目不保存为本地 AgentDefinition；详情只能选择同一服务器上已绑定的项目浏览会话或创建会话。当前服务端实际实现包括 Codex 与 Claude Code，DeepSeek 等不会凭名称生成虚假的可执行条目；增加驱动后由服务端能力声明决定显示。

项目聊天和草稿的 Agent 选择器通过宿主注入 `RemoteAgentControls` 获取可用远程目标；本地会话仍使用原执行链。选择远程目标后，输入直接进入远程会话，不创建本地 Session、不经本地模型 Provider，也不把本地 Slash 工具提前执行。远程模式隐藏本地模型/执行模式设置，使用原生 harness 的配置。原生 capability 声明附件时可发送内联 UTF-8 文本及 PNG/JPEG/WebP 图片：每次最多 5 个，文本每个 64 KiB、图片解码每个 256 KiB、全部编码内容 512 KiB。浏览器和服务端分别核验格式、容量与文件名，不接受远程 URL 或宿主路径。附件草稿与输入一起保存在客户端，不支持的格式在发送前拒绝并保留输入。

`piagent-driver/HarnessConversation` 封装原生会话读取、创建/恢复、turn、事件、审批、中断和回执查询；`app-core` 为它提供项目授权及恢复记录，调用前检查当前本地挂载授权与连接仍与打开时一致。`ui-common/ConversationControls` 是注入 llm-ui 的展示接口，UI 不调用 MCP 或设备协议。远程编辑器显示原生 user/assistant 历史、工具摘要、增量回复及审批/人工输入卡片。内容通过共享 MDx 渲染，远端 HTML 按字面显示。打开历史不自动恢复执行；读档不可恢复、只读绑定、运行中、失联或结果未知时禁用发送，中断与审批按授权和网关原生会话控制权开放。

事件按原生 item ID 合并；完成内容替换增量，迟到增量不覆写已完成卡片。事件游标缺口或 epoch 改变时重读原生历史，避免把已经记录的 delta 再附加一次。关闭编辑器只释放客户端，不隐式中断远程 turn。

客户端 `/etc/fs/harness-conversations.seq` 只记录服务器/项目/profile/native session 引用、未发送的输入草稿和待确认操作，原生历史仍以服务器为准。每个修改操作先以 CAS 持久化 requestId 与 epoch，再发送；结果未知时禁止重发。重新打开或客户端重启后可通过原 epoch 查询 receipt，确认创建后切换到原生 session 路由。若服务器重启导致原 epoch 的回执不可查询，保留未知状态，不把它当作未执行。独立控制面板继续用于安装级诊断，不替代项目会话的授权。

验证包括纯驱动事件/回执恢复测试、项目投影/分页/离线/参考挂载测试、只读工具箱投影，以及应用运行时 → 项目工作台 → llm-ui → 原生会话端口的集成测试。该集成使用可控 harness fixture，没有调用真实模型。

### MCP API Key 认证

服务配置使用 `api_key` 或 `api_key_env`，以 Bearer 认证（兼容旧 `token`/`token_env`）。启动连接提示在 console 输出实际 API Key；结构化事件和 HTTP 响应不携带密钥。itookit 只需填写 MCP endpoint 和 API Key；通用 MCP 发现后，app-core 注册的扩展验证 `server/discover._meta['itookit/pi-agent']` 中的能力描述，同源端点和项目协议符合要求才生成远程连接。旧服务通过同一连接调用已声明的能力工具。名称或 API Key 本身不授予项目绑定资格。

API Key 通过既有 MCP 配置持久保存，启动时恢复到 piagent-driver 的凭据解析器；文件、sync、bash 与 harness 共用 Bearer。项目挂载记录只保留 credentialRef，不复制密钥。旧 Basic 连接仍兼容；已被项目引用的连接不能直接改变认证身份，需先解除绑定。

通用 MCP 管理器负责认证、协议协商、扩展注册及验证缓存。普通 MCP 只执行标准发现；pi-agent 测试后的保存和改名不再单独调用 driver 验证。地址、API Key 或 headers 变化重新验证，错误描述不生成绑定。UI 只按已验证扩展显示控制中心。多个 harness 共用一个 pi-agent MCP 连接，原生协议适配留在服务端插件内。

### Harness 内置插件

`HarnessPlugin` 定义 kind、配置校验及实例创建，`HarnessPlugins` 注册并查找实现。`Harnesses` 通过注册表创建普通和项目作用域的 `HarnessDriver`，不直接引用 Codex。`State::from_config_with_plugins` 允许嵌入宿主注入注册表，默认二进制注册 Codex 与 Claude Code；未知 kind、重复注册及插件配置错误都会拒绝启动。

公共层保留项目目录授权、revision、回执、epoch、请求去重及实例生命周期。插件负责原生历史读取、进程初始化、协议转换，并输出现有统一 session/history/event/interaction 格式；项目实例获得 `ProjectRuntime`，启动参数由插件给出，目录挂载和联网仍由 ProjectLauncher 负责。新增 harness 必须完成其输出与审批格式的适配，不能仅替换 command。

当前采用可信进程内、编译时注册的插件，不提供动态加载或外部插件进程协议。测试用独立 fixture 插件证明配置识别、非 Codex 调用路由、项目作用域、回执去重与关闭；Claude Code 已提供独立 SDK 驱动；DeepSeek CLI 尚未实现。

### 删除被项目引用的 MCP 配置

工作台删除项目时先检查运行保护并持久移除挂载引用，再删除本地会话、导航及项目身份。引用清理失败时保留可见项目，允许重试。启动和 MCP 删除预览会核对本地项目身份，自动清除身份已不存在的远程根项目全部挂载残留；不会因为服务器离线或导航隐藏而清除仍存在的项目，也不自动清除本地项目附加挂载。身份存储读取失败时终止核对，不把读取失败当成项目已删除。清理只修改本地绑定，不访问或删除服务器数据。

删除弹窗基于应用命令生成预览，列出引用的项目与挂载路径；存在引用时必须显式勾选强制移除所有引用。提交重新核对 MCP 配置及挂载 catalog revision，引用变化则要求重新预览。强制操作先检查所有受影响项目的运行保护，再清理确认过的本地远程项目和会话，一次持久提交本地引用移除，释放文件视图并删除 MCP 配置及其运行时凭据。

预览显示 MCP 名称、项目名称、挂载路径和会话标题，不以 UUID 作为展示名称。以目标 MCP 为根目录来源的本地远程项目及其 itookit 本地会话一并删除，其他本地项目只移除相关附加挂载。预览同时包含将删除的本地会话，提交后才经 SessionLifecycleService 关闭并清理；新增会话会使预览失效。服务器目录和原生 harness 会话保留，不调用服务端 project_forget 或文件删除。普通直接删除仍以 EBUSY 阻止遗漏引用；强制路径只处理用户确认过的预览。跨配置删除失败会报告已完成的挂载和配置操作，不能宣称跨文件事务。


## 命名兼容

服务及工具目录为 pi-agent（Personal Information Agent），统一接入包为 piagent-driver，公开创建函数为 createPiAgentDriver。新 MCP 扩展键为 itookit/pi-agent；读取旧 itookit/fs-agent 配置时保留 serverId、项目、挂载与凭据引用。能力描述优先随标准发现返回，能力工具 piagent_capabilities 和兼容别名 fsagent_capabilities 保留；无标准元数据的旧服务使用工具发现。共享文件／项目协议标识、HTTP 授权头和 fs-agent.files／fs-agent.bundle 规范编码保持原值，避免使已有内容摘要、回执或上游同步库失效。升级继续沿用原配置数据根及原生会话 home。


## 原生状态观察与项目检索

`HarnessObservation` 分离 execution（unknown/idle/running/waiting-approval/waiting-input）、lastResult、原生 systemError、连接、时效、receipt 未知及控制能力。列表保留 statusDetails.activeFlags；未知枚举退化为 unknown。`HarnessStatusObserver` 共享有界列表和 profile 事件，不读取每行完整历史，不 resume/adopt。app-core 的 `RemoteSessionStatus` 按项目完整 grant 身份共享订阅，授权变更立即使缓存失效；隐藏视图和项目退出释放订阅。正文、侧栏及标签使用同一状态解释。独立 Codex CLI 的 `notLoaded` 保持 execution=unknown，界面显示“未加载 · 外部运行状态不可见”；原生 idle 显示“就绪”，active 与审批/输入等待使用原生状态及请求证据。不能推断外部执行已完成或获得控制权。

`project_search` 接收 projectId/revision/query/mode（path/content），固定 rg argv、字面匹配、默认忽略大小写，复用只读 pinned Bubblewrap 项目视图及 mount 遮蔽，禁止网络、隐藏/私有目录、二进制、链接跟随及原生 home。遵守 gitignore，最多 100 条命中、2 MiB 输出、2 MiB 单文件、10 秒和 4 个并发；stderr/隔离失败明确报不可用，无 rg 明确降级。超限返回 truncated，不承诺续页。

`harness_session_search` 通过 Codex 插件遍历授权会话与解析后的用户/assistant 文本及命令摘要，不全扫 home。查询限定 profile/project/archived，最多 20 页会话、每会话 64 页历史、16 MiB、100 条命中、15 秒及 2 个并发。结果保留 sessionId/turnId/itemId；授权和 revision 在返回前再核对。旧服务不支持时返回能力不可用。

工作台共用侧栏搜索输入框，默认筛选已加载树；非空查询时显示范围选项，可切换异步项目检索，清空即收起。异步搜索视图区分文件路径、文件正文、原生标题、原生正文及归档范围，取消旧查询、丢弃旧响应、返回身份校验后导航；较早原生命中自动加载历史并定位。已注册项目的附加挂载通过完整远程身份匹配提供来源导航，普通目录挂载不授予原生控制。远程收藏包含 MCP/server/project/profile/session 身份，失效绑定不回退到同名服务器。归档视图只读；导出 `mindos-native-history` v1 JSON 保留原生来源和摘要历史，executable=false，不是本地 Kernel bundle。侧栏提供只读原生家族导航。Codex 已声明 rename/archive/unarchive/delete 和 text/image 附件能力。原生标题直接通过 thread/name/set 修改；归档允许本服务持有且明确 idle 的会话或 notLoaded 原生历史；未加载不等于外部执行空闲，归档不会停止独立 CLI。运行中的受控会话显示禁用的归档菜单。归档前检查派生子会话的授权与状态，归档后释放所有权；恢复归档不 resume、不发送 turn。以上操作共享 epoch/requestId 回执与客户端 CAS journal，未知结果只核对回执。归档与恢复同步已有收藏的路由和标题。永久删除调用原生 thread/delete，要求受控 idle 或已归档 notLoaded，前置有界检查全部派生子会话的项目授权及可删除状态；保留项目文件，移除原生历史/元数据及对应已有收藏，关闭被删除会话的标签。客户端保存删除 tombstone；丢失响应后先核对 receipt，不读取已删除的历史，不重新提交删除。Claude 尚未声明归档或删除能力。共享观察记录将标题通知用于侧栏及标签；fileChange 完成、turn 完成和重连快照修复触发项目目录有限刷新，文本 delta 不刷新。独立 CLI 的文件变化通过项目目录 watcher 刷新；Claude Code 已接入，DeepSeek CLI 和 VMM 尚未实现。


## Claude Code 与目录 watcher

Claude 配置 `kind="claude"`、显式 command 和私有 home（CLAUDE_CONFIG_DIR），项目实例使用共同授权及 Bubblewrap。SDK stream-json 控制协议独立于 Codex app-server：initialize、原生 user UUID replay、can_use_tool 审批、AskUserQuestion 和 interrupt 映射到统一接口。每会话独立子进程，最多 16 个；断线仅影响对应会话。turn 回执等待相同 user UUID 确认，结果未知不得自动重放。支持 create/resume/history/search/interactions/text/image，未声明 fork/rename/archive/unarchive。

原生 projects JSONL 按实际 cwd/sessionId 核验，拒绝链接与目录逃逸；目录名称只用于缩小扫描，不能决定授权。历史分页最多 100 项/2 MiB，用户 UUID 定义真实轮次；工具摘要和增量消息共用原生 item 身份。目录元信息扫描有 2048 个目录名称、8192 个文件、16 MiB/5 秒上限。恢复使用核验后的日志绝对路径，兼容宿主 cwd 与沙箱虚拟路径；整份恢复日志最多 16 MiB并逐记录核验。独立 CLI 仅返回 notLoaded/owned=false，显式 resume 建立新受控进程，不能接管外部进程。真实 CLI 2.1.209 在临时数据和本地 Anthropic peer 下完成原生审批写文件、图片、历史、独立 CLI 发现与恢复；未做桌面人工视觉验收。

`fileWatch` 协商 project_watch/project_unwatch。服务端使用 pinned 根及 mount 的有界 inotify，返回不含路径/正文的 watchId/version/gap/truncated；owner/project/revision 和根身份在观察前后核验。排除隐藏目录、私有 home、链接与挂载遮蔽；新目录及队列溢出重扫，溢出报告 gap。最多 16 个观察，60 秒空闲后在后续请求清理；扫描上限 2048 个目录、50000 项、2 秒，truncated 时 driver 以 30 秒补充刷新。客户端 close 释放，项目配置变化移除监听。共享状态观察在零会话时仍轮询目录版本，宿主合并通知刷新项目树；此版本不推断外部执行状态或控制所有权。


## 会话活跃提示

共享展示优先采用原生 ready、running、waiting-approval、waiting-input 等观测状态。对于执行状态 unknown（包括 notLoaded）的在线会话，原生更新时间距当前时间不超过 2 分钟时显示“近期活跃（推测）”；超过窗口显示“最近更新于…”；缺失或无效时间保留未加载/未知提示，未来时间不推测活跃。离线及原生错误优先显示。提示注明更新时间不能确认执行状态，使用静态未知图标，不修改 execution、所有权或归档/删除/停止权限。侧栏和标签以单一定时器在窗口到期时刷新，隐藏工作台和销毁时释放；编辑器随现有轮询刷新，不增加原生 API 请求。

## 项目选择与目录正文

侧栏点击项目根及项目选择器显式切换项目范围，复用已打开目录标签时也应用当前选择；文件和会话子项继续保留所在浏览范围。已知范围从当前目录清单立即显示，正文目录读取不等待整个侧栏导航、会话区和文件区展开。侧栏在后台补齐展开与选中状态，旧结果不得覆盖新路由，后台同步期间仍接受显式点击。

目录读取复用已知节点，其他情况下并行读取条目与元数据；正文不重复执行侧栏展开。远程探测和打开错误停留在目标标签，显示原因并允许重试，不隐式回退到本地项目。项目文件、目录和原生会话错误使用统一带时间的 pi-agent 结构化日志，包含阶段、身份和错误码，不记录凭据或正文。

## 2026-10-16：目录共享 ACL 与稳定身份

目录共享采用一个非重叠 export 对应一个权限范围，不为不同用户重复导出同一个真实根。pi-agent 的 `principals` 将凭据映射到稳定 ID；exports 的 public/grants 决定文件 ro/rw 和独立执行权限。匿名请求仅能访问显式公开目录；无效认证不能退回匿名。项目绑定、harness profile/home、历史、事件和回执不因目录公开而共享。项目和目录同步绑定的持久 owner 从数组下标升级为稳定字符串；旧单用户 0 只映射 owner，用户重排与凭据轮换不转移所有权。

`config/authorization.rs` 编译部署策略；`auth.rs` 提供身份解析、权限查询及缓存的授权版本；文件与进程边界消费同一授权。Bearer 使用摘要索引、Basic 使用用户名索引，读取不扫描全部用户。授权版本包含有效操作、可见目录物理身份和原生 home 范围；请求 headers 可绑定 principal/revision，旧上下文在执行前拒绝。文件 revision、项目布局 revision、授权 revision 各自独立。权限配置目前重启生效，没有在线 ACL 修改、组或任意嵌套规则。

piagent-driver 的纯 authorization 入口负责校验 DTO，连接支持显式匿名，来源池包含身份、授权版本和认证模式。app-core 持有连接与挂载策略，阻止引用中的连接改为其他 principal；授权变化释放旧来源。服务端 ProjectCapabilities 分别投影 fileRead/fileWrite/run/sessionRead/sessionControl。只读挂载可以显式允许自己的原生会话，旧节点无该能力快照时仍按旧只读行为处理。UI 只展示认证模式、文件能力及会话控制能力，不解释 ACL。

配置示例见 [config.access.example.toml](../../tools/pi-agent/config.access.example.toml)。同一 pi-agent 可由不同用户的独立 itookit 实例连接；单个 httpd 的多租户 profile、凭据和订阅隔离尚未实现，不能把 mTLS 准入作为多人应用隔离。同步仍是单个配置主体的 namespace，不隐式共享。

## DSH 驱动

pi-agent@0.3.1 内置 `kind = "dsh"`，通过 DSH Remote HTTP/WebSocket 适配通用 HarnessDriver。驱动目录 `tools/pi-agent/src/harness/dsh/` 持有原生传输、历史投影和进程生命周期；通用 harness 服务继续持有目录授权、epoch/requestId 回执与会话修改队列，itookit 前端不依赖 DSH 协议。

托管模式启动 DSH `web` profile，项目实例使用 ProjectRuntime/launcher 与独立授权的模型 home；多个会话共享该实例的 WS mux，HTTP 只等提交回执。连接已有服务时必须显式配置 origin、令牌环境变量和 legacy workspaces，拒绝声明项目沙箱或多身份隔离。配置示例见 [config.dsh.example.toml](../../tools/pi-agent/config.dsh.example.toml)。

已实现新建/继续、历史分页、流式文本/推理、工具摘要、交互确认、中断、重命名和归档；能力描述不声明未实现的分支、永久删除、附件、取消归档或用量。网络结果不明时保留 unknown，不自动重放；WS 断线后实例拒绝续写，节点重启后可显式恢复持久会话。

2026-10-16 的真实 DeepSeek 验收通过已发布 npm 客户端和 MCP 完成新建、追加、4 会话并发及重启续写，10 个模型 turn 均完成并持久记录用量。修复托管绑定被 profile 覆盖、新建响应缺少 updatedAt，以及 SIGTERM 不关闭原生进程而遗留写锁的问题。测试数据使用隔离 home、专用目录和会话，全部归档；永久删除返回 ECAPABILITY，不能以归档替代其验收。
