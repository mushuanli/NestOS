# NestOS Profile

NestOS profile 是三端共享的数据根与运行定位。

它与 Session 工作目录分开：Tauri/CLI 新会话默认将宿主当前目录映射为 `/workspace`，可以在会话中修改或挂载其他目录；这不会迁移 profile 的配置、历史或 Kernel 存储。

## 配置文件

```text
$XDG_CONFIG_HOME/nestos/nestos.json
或
~/.config/nestos/nestos.json
```

CLI（desktop profile）、Tauri 和 HTTP 存储宿主启动时，如果配置文件不存在，会自动创建以下默认值。已有文件不会被覆盖；`NESTOS_ROOT`、启动目录等临时参数不会写入默认配置。HTTP 宿主可通过 `pnpm httpd` 启动，额外支持 `--root` 优先覆盖数据根。

```json
{
  "rootDir": "data",
  "storageVersion": 1,
  "layoutVersion": 1
}
```

三个宿主共用 `backend/app-core/src/profile/default-profile.json`，均将 `XDG_CONFIG_HOME` 视为配置基目录，并在其下使用 `nestos/`。可选的 `homeDir` 只在用户希望固定项目目录时填写。

HTTP 存储宿主通过 `@itookit/app-core/profile` 公开子入口复用配置默认值和数据根解析；该入口可独立打包，无需加载应用 Runtime。

Schema：

```json
{
  "rootDir": "data",
  "homeDir": "/Users/me/project",
  "storageVersion": 1,
  "layoutVersion": 1
}
```

Node HTTP 宿主还支持可选的宿主私有配置（不进入应用 VFS 或服务图）：

```json
{
  "http": {
    "certDir": "http-certs",
    "authDir": "http-auth"
  }
}
```

`http.certDir` 供证书初始化和 httpd 启动读取，`http.authDir` 是认证目录基址，release/dev 分别添加相应子目录。
显式 `--cert-dir` / `--auth-dir` 优先；参数是最终目录。配置内相对路径按配置目录解析，命令行路径按调用目录解析。
不配置时保留旧路径；不会自动迁移现有凭据。目录须在数据根、静态 UI 根之外，可使用数据根的同级 `nestos-host/`。
详细迁移和 CLI 共享规则见 [HTTP app](../apps/http-app/README.md)。

数据根解析顺序：

```text
NESTOS_ROOT
  → nestos.json#rootDir
  → <configDir>/data
```

`rootDir` 为相对路径时按 `configDir` 解析。

桌面端当前项目目录（注册到统一工作台，其新会话默认映射为 `/workspace`）解析顺序：

```text
--home <dir>
  → nestos.json#homeDir
  → INIT_CWD            （启动命令所在目录；pnpm/npm 导出）
  → 进程 cwd
```

`tauri dev` 把应用进程的 cwd 设为 `src-tauri/`，所以 `INIT_CWD` 才是用户敲命令时所在的目录；该值为空或已不存在时回退进程 cwd。启动时终端会打印 `[NestOS] data root` 与 `[NestOS] workspace` 两行及其来源。

## 工作台与已有数据

统一工作台新增项目与会话的导航分组，数据根与存储版本不变。现有 `~/.config/nestos/` 只有 `data/`、`logs/` 时，无需搬迁；启动后会在同级补齐 `nestos.json`。

旧 `#/projects/<编码后的路径>` 地址会在工作台注册“原项目文档”，指向原来的 `/home/admin/projects`，再打开相应文件。`.prj` 文档保留原路径和内容，地址更新为工作台项目文件路由，刷新后继续可用。项目分组保存在 Session repository 中，应用内新项目的文件位于 `/home/admin/projects/<项目 ID>`；宿主项目仍引用其原本的本地目录。

换机器时，先退出使用该 profile 的 Tauri/CLI，再复制整个 `nestos/`（包括数据、元数据和配置）；若 `rootDir` 指向目录外，还需复制该数据根并调整配置。宿主项目目录是外部引用，需要在新机器上保留或重新配置其路径。Web 的 IndexedDB 存储属于浏览器来源（协议、地址和端口），不会自动读取宿主的 `~/.config/nestos`。

### 旧版聊天（`<rootDir>/module/chats`）

早期版本把每个会话写成 `<rootDir>/module/chats/<名称>.chat`（ChatNode 清单）+ 同级 `_<名称>.chat/` 目录下「一条消息一个文件」的 round。现布局不再读取 `module/`：模块文件树在 `/home/admin/<name>`，会话则是 `_meta` SQLite 里的 Round DAG 记录。因此 `module/` 下的旧聊天不会自动出现，需要一次性迁移。

工具：[apps/cli/scripts/migrate-legacy-chats.ts](../apps/cli/scripts/migrate-legacy-chats.ts)。默认 dry-run，只扫描、转换并在内存校验；`--apply` 才写入，并把每个来源记进 `<rootDir>/etc/legacy-chat-import.json`，重复执行是幂等的。

```bash
pnpm migrate:legacy-chats --root <数据根>            # 先看清单
pnpm migrate:legacy-chats --root <数据根> --apply    # 退出应用后写入
```

脚本放在 `apps/cli/` 内而不是顶层 `scripts/`：工作区依赖（`@itookit/*`）只链接在各包的 `node_modules` 下，模块解析锚定脚本自身位置，才能从仓库任意目录调用（顶层 `scripts/` 下没有这些链接，`pnpm dlx tsx scripts/...` 会报 `Cannot find module '@itookit/vfs-core'`）。

转换沿用仓库自身历史上的 ChatNode → Round 迁移算法：按命名分支从 head 回溯到 root，共享前缀复用同一 Round，用户消息与其回答合成一轮，重新生成的回答成为同父的兄弟 Round。旧系统轮只承载默认问候语，由会话设置取代，直接丢弃；`status: deleted` 的消息一并丢弃并重新挂接其子节点。`module/` 其余目录（`projects`/`agents`/`flows` 等）与 `/home/admin/<name>` 内容一致，无需搬运——`chats` 之外不要整体搬迁，以免覆盖 9 月之后的新内容。

## CLI profile 选择

```bash
nestos --profile desktop run -f nestos.yml   # 默认
nestos --profile /path/to/data run -f nestos.yml
```

- `desktop`：共享 `~/.config/nestos/nestos.json` 解析出的数据根。
- 其他值：显式数据根路径。

CLI 与 Tauri 统一使用 desktop profile；不再提供 `<workspace>/.nestos` 项目 profile。

运行数据、Session、Kernel 记录和授权记录默认写入所选 profile。Provider、Connection、Settings 和凭证默认只读；CLI 参数或 YAML 中的配置只作为本次运行覆盖，不自动写回 profile。

## CLI 本地目录挂载

```bash
nestos --set-home /path/to/project run -f nestos.yml
nestos --add-dir /path/to/lib:ro run -f nestos.yml
nestos --add-dir /path/to/cache:rw run -f nestos.yml
```

- `--set-home <dir>`：挂载到 `/workspace`，作为 Session 工作目录，默认 `rw`。
- `--add-dir <dir>[:ro|rw]`：追加宿主目录，默认 `ro`，可重复。
- workflow YAML 本身仍从宿主路径读取，它是 CLI 输入，不是 Agent 可见文件。

文件工具和 Bash/TTY 使用同一份 Session mount records：文件工具消费 Session VFS，平台执行适配器根据 mount records 生成执行配置。

CLI `-p` 默认启用 Read/Glob/Grep 和客户端 WebSearch；Responses 协议保留文件工具并使用服务端搜索，`--no-tools` 禁用客户端工具。文件工具的相对路径由 Session cwd 解析，不能以 workflow 的宿主根目录覆盖；native Shell 在进程启动边界将虚拟 cwd 映射到当前挂载源。

仓库搜索和聊天 `@` 文件候选共用 `vfs-core` 的 `discoverFiles`，Harness / Flow 在 Tauri、Web、CLI 的 Session VFS 中使用相同规则：

- 默认排除 node_modules、.git、dist 等目录；项目规则可用 `!` 覆盖这些默认值。
- 从当前挂载根继承 `.gitignore` 和 `.nestosignore`，子目录规则覆盖父目录；同目录内 `.nestosignore` 在 `.gitignore` 之后生效。支持通配符、根锚定、目录规则、注释、转义和 `!` 反向规则。
- 搜索子目录仍继承挂载根至该目录的规则。被忽略的目录在遍历前剪枝，内部的反向规则不能重新包含文件，必须先在可见父目录重新包含该目录。
- 每个挂载独立解析，Session 包装视图保留原挂载边界；不读取挂载源之外的宿主父目录、全局 Git excludes 或 `.git/info/exclude`。规则对已跟踪文件同样生效，不查询 Git 索引。
- 每次搜索重新读取规则，无需重启。单个规则文件上限 1 MiB，遍历最多检查 10000 个条目；取消及规则读取错误不会静默退化为无过滤搜索。
- Grep / Glob 参数 `includeIgnored: true` 跳过默认及文件规则；聊天 `@` 候选面板提供“包含忽略文件”复选框。此选项仅影响当前搜索／候选列表，不扩大挂载权限。底层 `excludeDirectories` 是调用者显式排除，即使 `includeIgnored` 为 true 也保留。

例如，在项目 `.nestosignore` 中写入 `large-datasets/` 和 `*.generated.json`，可以保留 Git 跟踪而从默认模型搜索中排除。显式 Read 不受搜索忽略规则限制，Shell 自身的命令也不会自动套用这些规则。

文件发现枚举点文件，并由规则决定是否排除；Session 工具通过 `ToolVFSContext.walkFiles` 惰性遍历，Grep/Glob 达到结果上限后同时停止目录遍历和文件读取，不先收集整棵目录树。旧适配器仍可回退到 `listFiles`。Tauri 的 Session 路径前缀检查使用按授权分组的 `directory_stat_many`（每批最多 256 个路径），LocalFS 目录列表每批最多 64 个 stat 并有界并发读取元数据；批量请求仍逐路径检查授权与链接边界。工具默认超时保持 30 秒。Tauri 的 `directory_open/close/stat_many/io/read_range` 通过异步命令进入 `spawn_blocking`，同步文件 I/O 和授权锁等待不占用原生 UI 事件线程；后台线程共享同一授权表，关闭后的访问仍被拒绝。Grep 单文件按行扫描，每 2048 行让出一次事件循环并检查取消，避免大量不匹配行拖延刷新与超时回调；单次正则求值仍为同步执行。LocalFS 列目录跳过符号链接和设备节点，显式访问仍受原有边界检查。独立 Node 搜索也使用共享发现服务，不再由 rg/fd 各自决定过滤规则。

## Session 所有权

同一 Session 同时只能有一个执行 owner。CLI 与 Tauri 都使用共享 SeqFile：

```text
<rootDir>/var/lib/kernel/session-leases.seq
```

规则：

- `run/resume/respond/cancel` 必须先获得 Session lease；
- 如果 owner 已存在，CLI 明确报错，只允许 `status/logs/runs/tasks/export-config` 等只读命令；
- lease 默认 60 秒过期，执行方每 10 秒 renew；
- Tauri 启动时只恢复能成功获取 lease 的 Session，已被 CLI 持有的 Session 保持只读；**「只读」自 2026-09-11（第六十四轮）起是强制的**：应用运行时把租约检查作为写入门（`createApplicationRuntime` 的 `ensureWritable` → `recovery.acquireLater`，经 `initializeConversationSystem` 的 `canWriteSession` 进入 `SessionManager.sendMessage`），被拒的 Session 在**追加 round 之前**就以 `Session is owned by another host; this host can only read it` 拒绝发送，因此同一数据根上的第二个宿主不会再和持有者竞争写入；本宿主新建的 Session 在首次发送时按需取租约（回归 `backend/llm-session/__tests__/session-write-gate.test.ts`、`backend/app-core/tests/session-recovery.test.ts`）。
- 跨主机共享同一数据根时用 `NESTOS_SESSION_LEASE_SKEW_MS`（或宿主的 `sessionLeaseSkewMs` 选项，默认 0）声明允许的时钟误差：接管要求旧租约 `leaseUntil + skewMs` 已过，避免快时钟主机抢走慢时钟主机的活租约（回归 `backend/app-core/tests/session-lease.test.ts`）。

## Tauri / CLI 运行日志

Tauri 启动即输出 `[Diagnostics] <日志路径>`，默认写入 `${XDG_CONFIG_HOME:-$HOME/.config}/nestos/logs/desktop/<时间>-<PID>.jsonl`；可用 `NESTOS_DIAGNOSTICS_DIR` 指定位置。日志独立于 Session data root，记录进程启动/cwd、目录授权到真实路径的映射、前端错误与未处理 rejection、工具开始/进度/终态、Rust panic/backtrace、正常退出。每个文件超过 4 MiB 后轮换为一份 previous 文件。异常日志不保存完整工具结果。

CLI 每次执行也写入 `${XDG_CONFIG_HOME:-$HOME/.config}/nestos/logs/cli/<时间>-<PID>.jsonl`，同样支持 `NESTOS_DIAGNOSTICS_DIR`（直接替换日志目录）。记录命令种类、文件系统/LLM/runtime 初始化耗时、HTTP 请求异常、执行失败、进程 warning、未捕获异常/未处理 rejection 和退出码。失败时 stderr 显示日志路径，不向 JSON/JSONL stdout 混入诊断信息；未捕获异常继续按 Node 原有行为失败退出。CLI 文件按 4 MiB 轮换一份 `.previous.jsonl`，历史进程的文件保留供排查。

桌面日志新增 `bootstrap.stage`、`bootstrap.source.start/ready/failed`、`bootstrap.ready/failed`，包含各阶段耗时、数据根与 sidecar 路径。`AggregateError.errors` 和 `Error.cause` 会递归展开（有层数、条数及消息长度上限）；启动失败页面显示内层错误与当前日志路径。日志目录不可写时会报告写入失败，但不阻止 CLI 执行。日志不主动采集完整 argv、环境变量或 prompt；错误文本和路径仍可能包含业务信息。

排查方法及桌面刷新后的 SQLite 事务回收见 [启动故障与运行日志](design/startup-diagnostics.md)。

Linux 额外监听 WebKit `web-process-terminated` 原因，并启动独立监测进程：主进程消失且没有正常退出标记时，写入 `process.unexpected_exit`。如果监测进程也被杀死，下次启动根据遗留 `.active` 文件补记 `process.previous_unclean_exit`；仍存活的进程不被误报。缺少正常退出记录只证明异常结束，不能单独断言 OOM，具体信号需结合 OS 日志；其他平台目前只覆盖 panic、前端错误和正常退出。

Grep 默认忽略 Rust `target/`，即使挂载根下没有 `.gitignore`。搜索单文件上限 2 MiB，超限明确计数并返回“不完整”；`includeIgnored` 不取消读取上限。授权 VFS 在读取前检查大小，读取时请求最多上限加 1 字节；Node/Scoped Tauri 的 LocalFS range I/O 真正限制宿主读取与 IPC 大小，防止二进制整块编码为 JSON。显式 Read 不使用此搜索上限。


编辑临时副本可由 `http.editorSwap: true` 显式开启，默认关闭；`http.swapDir` 默认 `~/swap`，支持 `~/`。
仅 httpd 开启时提供查看菜单、修改后防抖写入小文件副本；每个编辑器正常关闭时删除自己的 swap。
达到或超过 512 KiB 的文件不写 swap；httpd 启动时和每小时清理最后更新超过 48 小时的文件。
历史配置、证书及数据的兼容读取规则见仓库 `doc/nestos-rename.md`；已有私有文件不会因为产品改名重新生成。
