# nestos-node 与 Harness：统一工作目录、挂载与执行环境

状态：收敛后的设计规范，2026-09-29。本文替代此前以同步、不可变版本、私有副本和结果回传为主线的方案。当前实现与差距见第 9 节，不能把设计接口视为已交付能力。

相关约束：[HTTP 文件协议](vfs-http-driver.md)、[Session 挂载边界](vfs-session-mount-access.md)、[系统沙箱](system-sandbox.md)。

## 1. 范围与核心决策

Harness 只要求：一个 cwd、一张挂载表、一套目录权限，以及访问这些目录的文件和进程能力。File Tools 与 Bash 必须访问同一执行环境中的相同文件；UI 是这个环境的展示层。

默认 cwd 为 `/workspace`，当前项目位于 `/workspace`，额外授权目录位于同级路径，例如 `/reference`、`/datasets`。撤销“Shell 的 `/` 必须等于项目目录”的要求。UI 可以隐藏项目根前缀，但路径复制、附件引用和工具参数必须使用规范路径。

nestos-node 是可选的远端文件/执行适配服务，不拥有另一套 Agent、Session、审批或任务调度系统。推理、工具授权和 Kernel 继续由应用层负责。

拟新增的云存储与多端同步能力见 [项目多端同步设计](project-sync.md)。该设计独立管理云端项目版本、设备副本和条件发布，不改变本文普通远程挂载与执行的基础契约；项目数据布局及可选 .nestos 便携目录见其第 18 节。

MVP 不要求自动同步、PublishedRevision、SyncBatch、版本发布 CAS、结果 sealing、ResultRevision、apply-back、可转移工作区租约或持久输出重放。已有独立工作区功能继续服务其原有用途，不成为普通 Harness 的必经步骤。远端复制与结果导出将来可由 RemoteBackend 扩展，不进入 Harness 核心模型。

## 2. 唯一规范路径

```text
执行环境 /
├── workspace/     当前项目；默认工作目录
├── reference/     额外授权目录，例如 ro
├── datasets/      额外授权目录，例如 ro
├── tmp/           执行环境临时目录
└── bin/、usr/…    后端提供的程序运行目录
```

| 输入/入口 | 对应路径 |
| --- | --- |
| 工作台项目文件树根 | `/workspace` |
| 文件树显示 `src/a.ts` | `/workspace/src/a.ts` |
| `Read("src/a.ts")` / `Edit("src/a.ts")` | `/workspace/src/a.ts` |
| `Read("../reference/a.md")` | `/reference/a.md` |
| `Read("/reference/a.md")` | `/reference/a.md` |
| `!ls` / `!ls .` | 默认查看 `/workspace` |
| `!pwd` | 默认返回 `/workspace` |
| `!ls ../reference` | 查看 `/reference` |
| `!ls /` | 查看执行环境根；不等于项目文件树 |

相对路径相对当前工具调用的 cwd 解析，绝对路径相对执行环境根解析。Bash 命令内的 `cd` 按 Shell 规则影响该进程及子进程；普通一次性 exec 不自动改变后续工具调用的 cwd。需要改变会话 cwd 时，由宿主显式更新并验证其位于授权目录内。

项目文件只有一种 agent 规范路径：`/workspace/...`。UI 的 `/` 是根标题或面包屑展示，不作为另一份可持久化文件标识。UI 导航路由仍可包含项目/会话 ID，但它是资源定位信息，不直接传给工具作为文件路径。UI 数据源应使用以 `/workspace` 为根的子树投影；展示层只裁剪前缀，不在各个操作入口拼接字符串。

文件工具、文件引用与 Bash 都必须从同一个环境描述中取得 cwd 和挂载表。禁止仅改 `Read` 的绝对路径解释而保留 Bash 的另一种解释；也禁止用正则替换命令文本、脚本内容或任意 stdout 来模拟映射。

## 3. 小型核心契约

下列类型是职责草图；实施时复用现有 Session 文件授权、进程端口和取消类型，不创建平行模型。

```ts
interface WorkspaceSpec {
  cwd: string;
  mounts: readonly MountSpec[];
}
interface MountSpec {
  at: string;
  source: DirectorySource;
  access: 'ro' | 'rw';
}
```

`DirectorySource` 是宿主已经授权的目录引用。它可以由宿主目录、VFS source 或远端 export 别名解析而来；Agent 不提交宿主 root、凭据、挂载驱动参数或任意服务 endpoint。模型只看到 cwd、挂载路径、权限及必要的能力说明。

准备后的环境同时交付文件能力、进程能力、有效保证和释放操作。公开能力沿用 `ToolVFSContext`、`INativeShell`；PTY 仍为独立可选能力。File-only 后端可以没有进程能力，但不能偷偷借用另一节点的 Shell。

```text
WorkspaceSpec
    ↓ prepare(spec, signal)
PreparedEnvironment
    ├── cwd + effective mounts
    ├── files
    ├── process（可选）
    ├── 实际路径/权限保证
    └── dispose()
```

后端内部可以有 prepare、spawn、dispose；Harness 不关心目录来自 bind mount、容器卷还是已经准备好的远端目录。生命周期句柄是资源释放机制，不需要附带同步版本、结果发布或所有权移交协议。

## 4. 挂载解析与权限

1. 宿主在 prepare 前解析所有 source，检查它们能否进入同一执行环境；不能一部分 File Tools 访问 Web VFS，另一部分 Bash 访问未同步的磁盘目录。
2. 默认项目挂在 `/workspace`；额外挂载使用明确且唯一的名称。MVP 优先使用同级挂载；现有嵌套挂载只有在文件和进程后端均支持相同遮蔽、权限和冲突语义时才接入。
3. 拒绝重复目标、保留运行目录冲突和未定义的遮蔽。对同一物理目录的多个别名及重叠 source，也要校验 ro/rw 冲突，不能通过另一个 rw 别名绕过只读要求。
4. 目录解析必须处理符号链接、挂载穿越和路径边界；文本规范化不是访问控制。File Tools 与进程权限分别由实际文件后端及 OS/容器机制落实。
5. 运行中的环境使用固定授权配置。变更挂载先经过现有任务守卫，再撤销缓存环境并重建；不得让同一 Task 的文件和进程能力各持有不同版本的挂载表。
6. UI 从有效权限派生新建、导入、编辑、标签、重命名、删除及移动入口。UI 禁用只是反馈，后端仍验证权限；只读文件目录不应让项目已有会话不可查看。

共享挂载表是实现一致性的必要条件，不是自动实现强制只读的证明。后端应分别报告：

| 保证 | 示例 |
| --- | --- |
| 路径模型 | virtual-root / host-mapped |
| 只读落实 | kernel-enforced / file-tools-only |
| 执行隔离 | sandbox / trusted-cooperative-host / none |
| 进程能力 | exec / PTY 各自是否可用 |

需要严格只读时，`file-tools-only` 必须拒绝接入进程执行。低权限用户、cwd、进程组和普通目录复制都不等于 sandbox。

`/bin`、`/usr`、`/proc` 等运行时目录属于后端提供的系统环境，不伪装成用户文件挂载。File Tools 不必提供这些目录的访问能力。因此一致性验收针对**已授权数据挂载**：相同路径读取相同文件、遵守同一访问权限；不能要求受限 VFS 的根列表包含 Bash 的所有系统目录。

## 5. 执行后端与平台差异

| 后端 | 目录与路径机制 | 核心限制 |
| --- | --- | --- |
| Local sandbox / Container | 将宿主授权目录挂到规定目标路径，设置 cwd | 挂载、权限及运行目录必须可实际落实 |
| Trusted host | 使用宿主真实目录和 OS 权限 | 仅设置 cwd 不能生成 `/workspace`、`/reference` 别名 |
| Remote | 在目标节点解析已授权目录，文件和命令都发往该节点 | 不能回退客户端 Shell；不隐式复制来源 |
| Web file-only | 浏览器 VFS 或 HTTP 文件驱动 | 未取得远端执行能力时没有 Bash |

Linux 当前 bubblewrap 路径可表达虚拟挂载；macOS 当前 Seatbelt 实现只限制宿主路径并切换真实 cwd，不自动重映射任意绝对路径。CLI 的普通宿主执行、OCI 执行也需区分。不能因为它们都实现 INativeShell 就宣称已有相同 namespace。

需要统一 `/workspace` 语义的环境必须使用真正支持该映射的后端，例如容器或虚拟机。无法提供时，报告能力不足，或明确选择一套所有工具共享的 host-mapped 路径；后者不能冒充 virtual-root，也不能只翻译 Bash 的 cwd 而让命令参数仍落入另一命名空间。

源目录直接挂载意味着 Bash 与文件 API 都可能修改它。MVP 采用普通文件系统一致性，不承诺跨工具事务、时间点快照或写入回滚。只允许在后端真实支持时宣告条件写入；不能在开放 Bash 写入后继续使用“独占 HTTP writer 的内存 revision”冒充强 CAS。现有 HTTP exclusive 写入契约保留：当前实现通过服务端文件/进程互斥门隔离两条写入通道，进程完整回收后使此前的 revision 全部失效。外部进程不得绕过服务修改 exclusive export。

## 6. nestos-node 的最小职责

目录为 `tools/nestos-node`，仓库为 `mushuanli/nestos-node`，二进制为 `nestos-node`，Rust library 为 `nestos_node`。

首期保留认证、export 别名、路径限制和文件能力发现；执行扩展只需要目录授权解析、命令启动、状态、有界输出、取消及清理。文件与进程共享服务端解析的授权目录，复用连接配置与凭据机制；HTTP 文件 driver 不承担项目策略或进程编排。

同一远端环境的主项目和额外挂载必须能在该节点实际访问。Web VFS、本机目录或另一服务器的目录尚未复制到该节点时，prepare 拒绝混合执行；用户可以显式复制/上传后，将其作为新的远端目录挂载。同步不是 exec 的隐式副作用。

服务端最低工程要求仍包括认证与操作归属、凭据环境清洗、受控执行身份、超时、并发和输出上限。撤销旧方案的强制专用身份切换方式不代表可以继承所有 daemon 凭据；具体隔离与运行用户由部署和后端决定并公开实际保证。

进程控制必须保留以下语义，但不强制引入通用 WorkspaceLease：

- 启动成功返回带身份归属的进程句柄；取消不能仅凭可猜测的裸 PID。
- AbortSignal 表示取消请求，不表示命令从未执行，也不表示文件修改回滚。
- 释放时先请求停止并等待后端确认回收，再释放目录能力；需要区分调用者停止等待与资源已清理。
- 网络断开时由服务端配置的命令超时/断线宽限策略负责回收；不以浏览器关闭事件作为唯一清理依据。
- 启动响应丢失不得自动重放。若没有可查询的请求记录，向调用者报告 unknown；不承诺 exactly-once。
- 不支持重启续接时明确失效旧句柄；不得将重启前遗留的进程视为已自动停止。重启协调可先以拒绝新执行直到完成清理实现。

## 7. 展示过滤与路径引用

`.gitignore` 只影响约定的界面展示；既有 Glob/Grep/候选发现的忽略策略独立保留。nestos-node 和原始 VFS stat/read/list 不因 `.gitignore` 删除或隐藏实际文件。

因此，文件树隐藏 ignored 项而 `ls` 列出它们可以是正常差异。界面应明确过滤状态，并可提供展示忽略项的入口；这属于展示功能，不改变执行目录。比较目录一致性时使用 raw list 和对应的 Shell 目录枚举，不直接拿过滤后的 UI 树作等价断言。

复制路径和发送给 Agent 的引用统一使用 `/workspace/...`、`/reference/...`；用户手输相对路径按 cwd 解析。结构化进程错误中的路径可由后端提供映射信息，任意命令输出保持原文，不进行盲目替换。

## 8. 实施顺序与验收

### A0：统一目录契约

复用 SessionFiles 的 cwd/mounts、DirectoryMountService 的授权来源和 SessionProcessFactory，消除项目视图、文件工具及进程端口独立决定目录的分支。UI 项目文件树改为统一环境中 `/workspace` 的子树投影；项目目录内嵌挂载和会话额外挂载必须显式区分，不能静默移动已存在的文件路径。

验收：Read/Edit/Bash 对 `src/a.ts`、`../reference/a.md`、`/reference/a.md` 命中同一数据；复制路径可直接用于工具；默认 `pwd` 和 cwd 一致；只读挂载在每种可执行后端均不可通过命令写入。过滤差异不计为命名空间差异。

### A1：现有平台适配

先验证 Tauri/Linux 与 CLI sandbox 的同一挂载表；覆盖只读、重叠别名、符号链接、cwd 子目录、挂载撤销、取消和释放。macOS/host-mapped 后端声明差异，不能通过路径字符串重写声称验收通过。

### A2：最小远端执行

nestos-node 为同节点已有目录增加 exec；Web/Tauri/CLI 复用相同环境端口。先完成文件/进程一致性、认证、权限、取消和 unknown 行为；未通过前继续报告 process.exec=false。不以前置同步和结果回传扩大交付范围。

### 后续可选

PTY、自动 materialization、增量传输、缓存和结果导出，分别按实际需求增加。不可变发布、回传 CAS 等仅在需要跨节点副本一致性时设计为 RemoteBackend 子模块，不恢复为 Harness 强制基础设施。

## 9. 当前实现与迁移边界

已存在的基础：

- nestos-node 提供 `/v1/capabilities`；命令执行默认开启，配置 execution=false 可关闭；启动探测成功后，宣告 Linux bubblewrap virtual-root、kernel-enforced readonly 与 exec=true；sync/PTY 仍为 false。
- HTTP provider 已接入能力发现；仅 capabilities 的 HTTP 404 触发旧文件服务器兼容路径。
- SessionFiles 已有 cwd/mounts，DirectoryMountService 将项目放在 `/workspace` 并提供进程授权；Tauri/Linux 通过 bubblewrap 装配授权目录。
- UI 项目文件入口和编辑器已改用 `/workspace` 子树视图；导航路由保持兼容，引用传递规范路径。文件工具允许相对 cwd 解析 `..`，访问仍受挂载表约束。项目内部 source view 继续服务归档等内部操作。
- `ProjectExecutionService` 按远程根目录的连接和 nestos-node 能力声明自动获取文件/进程上下文。工作台不持久化执行开关、不提供启用/禁用菜单；历史 execution 记录不再读取，服务器关闭 `execution` 时只保留文件能力。当前挂载授权摘要、隔离要求和服务端身份仍在获取期间校验。Web/Tauri/CLI 共用此策略。
- Tauri 原生适配在 macOS 拒绝源路径与目标路径不同的挂载，避免 seatbelt 仅改变 cwd 而制造假命名空间；完整虚拟目录执行仍需 namespace-capable 后端。
- Rust `workspaces/leases` 是独立的未接路由机制；不作为 Harness MVP 的必选依赖，也不据此新增工作区租约协议。删除或复用它应在专门代码变更中进行。
- 已有 `.gitignore` 展示过滤、只读 UI 联动和取消基础可以继续复用。

已完成 A0 与 Linux/远端 A2 的最小链路，包含真实 HTTP 客户端到 Rust/bubblewrap 验收。未迁移既有挂载位置；macOS 原生虚拟目录支持仍需其他执行后端。


## 10. 最小远端执行的实现契约

- 开启方式：nestos-node 默认启用执行，顶层 `execution = false` 显式关闭。`server_id` 可指定稳定身份；未指定时生成本次启动的随机节点身份，不承诺跨重启稳定。启动时探测真实 bubblewrap 启动、fd mount 和禁用嵌套 user namespace；失败即拒绝服务启动，不回退宿主 Shell。
- `POST /v1/processes` 接收 serverId、epoch、requestId、command/args、cwd、mounts、timeoutMs；mount 只含 export alias、相对 path、虚拟 at、ro/rw。服务端 openat2 拒绝符号链接和越界，再通过 `--bind-fd`/`--ro-bind-fd` 挂载，客户端不能提交宿主路径。
- `GET /v1/processes/:epoch/:id` 查询，`POST .../cancel` 取消。状态为 running/exited/cancelled/timed-out/failed/unknown。ID 绑定认证身份和启动 epoch；重复启动只返回既有状态。取消可先于启动形成拒绝执行记录。启动 POST 不自动重试；响应丢失时以原 ID 取消并报告 unknown，不能伪称没有执行。
- 首版最多运行一个命令，命令最长 300 秒，stdout/stderr 各 64 KiB；超量触发取消并标记 truncated。状态查询返回最终有界输出，目前不提供实时流、stdin 或 PTY。最多保留 1024 条请求记录，达到上限拒绝新命令，需管理员重启；重启 epoch 改变，旧请求不得重放。
- 文件 API 与命令由进程级读写门互斥。流式下载持有读门至结束，上传/后台阻塞提交持有读门至清理完成；命令期间所有 export 的 stat/list/read/mutation 返回 EBUSY。进程回收后、开放读门前，清空所有 export revision 映射，旧条件写入返回冲突。回收失败保持关闭文件门并报告 unknown。
- bubblewrap 使用独立 PID/网络/用户命名空间、只读运行库、临时 HOME、环境白名单和禁用后续 user namespace。首版一条命令最多使用一个 rw export（可含多个子目录）；其他 export 必须 ro。该 rw export 的独占锁经 `--sync-fd` 保留给 monitor，避免 daemon 死亡后旧命令未退出时新服务器取得同一 export 的执行权。readonly 依赖不能通过其他 rw 别名绕过。
- 这是受限目录命令能力，不等同于完整的多租户加固：未提供 cgroup 内存/CPU/磁盘配额、seccomp 策略、自动依赖安装或网络白名单。部署使用非特权服务用户，并保留 exclusive export 的单一写入边界。
- app-core 将项目路径 `/` 映射到 `/workspace`、已有项目内嵌挂载 `/ref` 映射到 `/workspace/ref`；不会悄悄改为 sibling。协议支持显式 sibling，但当前项目 UI 没有自动迁移入口。远端执行要求 Session 处于 active 且具有唯一 `/workspace` 用户挂载，取得文件上下文后再次校验授权记录；空授权、已禁用授权或额外本地用户挂载均拒绝远端执行。Session readonly 继续向进程端衰减，不能提升为 rw。
- 项目收藏夹属于导航，见 [收藏夹契约](project-favorites.md)，不影响执行授权。

## 已实现：外部 harness 控制与统一接入

nestos-node-driver 统一文件、进程、同步和外部 harness 连接。服务端在现有认证端口新增无状态 MCP 2026-07-28 `/mcp`，使用 MCP SDK 2.0 客户端验证。文件字节和原有进程接口继续 HTTP；不替换文件修订/操作收据，也不把 Codex 原生 stdio 称为 MCP。

通用 `HarnessDriver` 与注册/修改收据层分开，当前驱动为 Codex。每个配置 profile 懒启动独立 app-server，通过原生 thread/list/read/start/resume、turn/start/interrupt、通知和反向请求控制。显式 CODEX_HOME 和 workspace 白名单为部署授权，不自动扫描宿主所有 home。配置可指向 ~/.codex 的实际绝对路径，分页读取各来源和归档会话；不修改原生数据库或 JSONL。历史只读 fallback 限于 sessions/archived_sessions 中的常规 JSONL，拒绝链接与目录逃逸。

接管只允许授权 cwd 且非活跃的原生线程。网关 owned/收据是进程内控制状态，不保证跨 harness 或跨主机排他；外部 CLI 仍可访问自己的状态。旧宿主 workspace 模式与 exclusive rw exports 禁止重叠。新项目模式通过共同 ProjectLauncher 和 FileGate 控制文件、进程及 Codex turn，支持受控 rw 导出；native 运行在外层项目沙箱中。详见 [项目模型](nestos-node-project-model.md)。

操作以 epoch/requestId 保留未知/已提交/未提交收据，HTTP 超时后后台继续等待原生回执，查询可确认晚到结果。事件有界并报告 gap；控制面板安全显示文本，保留审批草稿，不因关闭面板中断原生 turn。服务关闭先封闭所有 driver，再取消监管、回收各 app-server 进程组并等待 leader；已脱离进程组的后代不宣称被回收。

Codex 0.159.2 的 paginated 历史恢复尚有兼容限制；新建显式 legacy，未物化会话展示空历史。旧 paginated 会话保留只读历史；扩展版本能力后再开放恢复。当前支持命令/文件审批与用户问题，其他原生反向请求显示不支持，不自动批准。使用与上限见 [服务 README](../../tools/nestos-node/README.md)。

## MCP 配置与项目目录绑定

客户端按多条 MCP 配置管理 nestos-node，每条有独立 ID、地址、认证引用和状态；不按显示名称判定服务类型。MCPSettingsEditor 通过中立 ConfigurationFormControls 注入应用专属 nestos-node 字段和控制中心。普通 MCP 配置不进入项目目录选择列表。新 nestos-node 配置须测试协议及 nestos_node_capabilities（兼容旧名称），验证版本、文件协议和同源 HTTP 端点；服务名称可自由修改。

服务器配置的 Codex home/workspace 仍属于部署 TOML，客户端不能改写主机授权。MCP 保存连接与验证信息，项目保存配置 ID、alias、root、access；不会把远程真实目录路径当作客户端本地目录。现有连接保留 ID 迁入 MCP 目录，旧密码转入运行期 provider 并清除持久记录。离线旧连接不因迁移而丢失，legacy 标记只用于已有文件服务兼容。

项目显示“服务器名:项目名”，项目名不是远程目录身份。同一服务器身份/账号与规范化路径的创建操作串行化，重复请求返回原项目；不同服务器允许同名项目，必要时内部 navigationName 使用稳定项目 ID 区分。服务器改名不改变路由、授权或会话位置。


项目管理现由独立服务端 catalog 管理 alias 下的真实子目录、策略 revision 和额外挂载。sync project 保持数据同步身份，不自动获得执行权限；接口、配置与 VMM 扩展端口见 [nestos-node 项目与同步模型](nestos-node-project-model.md)。
