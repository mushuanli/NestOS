# HTTP 外挂文件系统与可取消 VFS 接口

状态：已实施基础读取、项目外挂与条件写入，2026-09-28。本文保留总体设计约束；本轮实际实现、验证与尚未开放的能力见第 14 节。连续操作与结束语义见第 6.3 节，评审取舍见第 13 节。

后续演进见 [mindos-node 与 Harness：统一工作目录、挂载与执行环境](agent-server.md)。该文将核心收敛为 cwd、挂载表和有效权限，不改变本文现有文件协议；远端执行按能力独立接入，同步与结果回传不作为 Harness MVP 前提。

## 1. 目标与决策

Rust HTTP 文件服务位于 tools/mindos-node，三端共用文件驱动源码已并入 libraries/mindos-node-driver/src/files，随统一接入包 @itookit/mindos-node-driver 发布。服务端仅暴露预配置目录别名；工作台可把别名中的目录外挂到项目，项目文件树、编辑器和 Agent 使用同一授权视图。

核心决策：

- 服务端采用 Axum + Tokio；只负责目录导出、文件操作、认证与请求生命周期，不装配 MindOS Kernel 或 Session 运行时；SeqFile 结构化记录使用 SQLite。
- vfs-core 后端拆为最小文件读取接口与可选写入、元数据、标签、记录、批量、搜索等能力；保留上层 IFileSystem 使用方式，通过增量扩展与适配迁移。
- HTTP 元数据使用 JSON，内容使用原始二进制；完整操作下推服务端，优先减少网络往返。
- 所有可能执行 I/O 的新接口支持 AbortSignal；取消贯穿消费者、视图、引擎、驱动、传输和服务端。
- “随时取消”指随时发出停止请求并停止客户端等待，不承诺任意系统调用立即终止，也不承诺已提交修改回滚。
- 首版完成只读外挂与取消闭环；可写阶段要求条件写入、明确提交边界及结果未知处理。
- 外挂不复制文件，解除挂载不删除远程内容；HTTP 文件源不能作为宿主进程的本地目录。

非目标：远程终端、OS/FUSE 挂载、双向同步、离线写回、分布式事务、任意 URL 静态站点解析。首版不提供单文件挂载，用户选择文件所在目录；文件级映射可另行设计。

当前需求没有要求有状态的连续命令会话、远程文件句柄或跨请求事务。v1 支持连续发起多个独立操作，不提供 begin/end/commit/rollback 指令；共享连接、operationId 和分页 cursor 均不代表事务。

## 2. 实施前的代码基础与缺口

| 当前实现 | 可复用能力 / 缺口 |
|---|---|
| [IStorageBackend](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/storage/backend.ts) | 路径式后端接口；metadata/tags 仍为必需方法，write 只接收完整字节 |
| [FileSystemSource](https://github.com/mushuanli/vfs-core/blob/main/src/impl/services/FileSystemSource.ts) | 将外部 backend 包装为独立来源，不向外部目录初始化系统目录 |
| [FileSystemView](https://github.com/mushuanli/vfs-core/blob/main/src/impl/services/FileSystemView.ts) | 挂载映射、只读校验、前缀类型检查和释放；目前 dispose 等待活动操作，没有主动取消 |
| [VFSEngine](https://github.com/mushuanli/vfs-core/blob/main/src/impl/engine/vfs-engine.ts) | 目前 expectedVersion 为先 stat 再 write；append/offset 为客户端读改写 |
| [能力探测](https://github.com/mushuanli/vfs-core/blob/main/src/impl/engine/capabilities.ts) | 部分能力默认 true，须改为真实能力派生 |
| [SessionFilesService](../../backend/app-core/src/vfs/session-files.ts) | sourceId 注册、授权挂载、revision、不可用来源占位 |
| [DirectoryMountService](../../backend/app-core/src/vfs/directory-mounts.ts) | 当前来源是内部/宿主目录，并被转换为进程目录 |
| [ProjectService](../../backend/app-core/src/projects/project-service.ts) | 当前项目绑定单一 directory；项目级额外挂载尚不存在 |
| [文件发现接口](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/services/file-discovery.ts) | 已有 signal，但普通文件接口尚未端到端传播 |

现有 [CLI HTTP 模式](../http-mode.md) 是宿主桥接与应用服务，不等同于本文文件协议。项目授权继续遵守 [Session 挂载与访问边界](./vfs-session-mount-access.md)，本文提出的项目组合视图是其增量扩展。

## 3. 分层与职责

```text
工作台文件树 / 编辑器 / Agent 文件工具 / CLI 文件访问
                         │ OperationOptions
                         ▼
              IFileSystem / 项目与 Session 视图
                         │ 授权、路径映射、事件
                         ▼
                  VFS 引擎与后端能力
                         │ 完整操作、批量、取消
                         ▼
                   HttpFSBackend
                         │ 可注入 HTTP transport
                         ▼
             fs-server → 别名目录句柄 → 文件系统
```

HttpFSBackend 不重复实现项目权限和虚拟路径映射；服务端不信任客户端授权结论，独立检查身份、别名、相对路径与导出权限。

一个 HttpFSBackend 绑定一个连接身份与一个导出别名。来源所有者维护连接及 backend 生命周期；视图借用来源，关闭某个视图不能关闭其他项目仍在使用的来源。

## 4. 服务端别名与访问范围

配置示例：

```toml
listen = "127.0.0.1:8787"
allowed_origins = ["https://mindos.example.com"]

username = "workbench"
token_env = "FS_SERVER_TOKEN"     # legacy Bearer; password / password_env for Basic

[[exports]]
path = "/srv/shared/docs"
access = "ro"                      # default; alias defaults to the directory name "docs"

[[exports]]
alias = "project"                  # optional override
path = "/srv/projects/demo"
access = "rw"                      # takes an exclusive lock, no writer_policy needed
```

配置统一使用 TOML。启动时不传参数则依次在进程当前工作目录、可执行文件所在目录查找 `config.toml`，取第一个存在的文件；显式路径参数优先，找不到时列出全部已搜索路径并拒绝启动。

客户端只提交 alias 与别名内相对路径，不能提交宿主 root、打开任意宿主目录或修改导出表。导出列表只返回当前身份可见的别名、权限、能力，不返回真实路径。生产远程连接使用 HTTPS，可由反向代理终止 TLS。

有效权限为服务端导出权限、身份权限、项目/Session 挂载权限的交集。凭据通过 Authorization 传递，不进入 URL、项目文件或 Agent 可读配置；连接记录仅保存 credentialRef。CORS 不是认证机制：`allowed_origins` 精确匹配网页 origin，`["*"]` 显式放通所有源（仅限绑定回环地址的本机/受控部署），空列表拒绝全部浏览器源，三者都不影响 CLI 与 curl。Web 开发端口 3000、Tauri 开发端口 1420，打包后的 Tauri origin 为 `tauri://localhost` 或 `http://tauri.localhost`。

endpoint 只能由用户/可信宿主配置，不接受 Agent 指定的任意服务地址。v1 transport 禁止自动跟随重定向，包括同源重定向；地址迁移由用户重新配置，不能让 Authorization 随跳转流向其他来源。诊断日志不输出认证头、配置中的 secret 或凭据解析结果。

路径与物理边界：

1. 协议路径统一使用 UTF-8、斜杠分隔的相对路径；空字符串表示根。拒绝绝对路径、父级段、反斜杠、NUL、平台路径前缀；URL 参数只解码一次。
2. 启动时由可信配置打开导出根目录句柄；实际操作基于目录句柄受限解析。不得只做字符串前缀比较或先检查路径后不受限地重新打开。
3. 首版禁止跟随符号链接以及对链接执行内容/修改操作；stat 可检查最终链接自身，详见第 5 节。设备、FIFO、socket 等特殊节点不可操作，列表不把它们伪装成普通文件。不能删除、移动或覆盖导出根。
4. rename 源与目标均校验，首版禁止跨别名移动和覆盖已有目标；跨来源复制由显式复制流程处理，不承诺事务。
5. 根目录包含的既有硬链接、嵌套文件系统和本机特权写入者属于部署信任边界。需要更严格隔离时使用专用导出目录及 OS 隔离，不能宣称目录句柄解决所有物理别名问题。

可评估 cap-std 的目录能力 API，逐项验证禁止链接、创建、重命名和递归删除语义。现有 [directory_boundary.rs](../../apps/tauri-app/src-tauri/src/directory_boundary.rs) 的检查后返回字符串路径存在使用窗口，不直接作为网络服务隔离实现。目录句柄能力参考 [cap-std 官方文档](https://docs.rs/cap-std/latest/cap_std/)。

### 4.1 文件名与大小写

- v1 只操作能无损表示为 UTF-8 的宿主名称。不做有损 OsStr 转换；列表以独立 warnings 汇报不可表示/不支持条目的计数，不为其制造可寻址的替代名称。完整遍历调用者必须获知存在被排除的条目。
- 客户端和 VFS 不执行 Unicode NFC/NFD 归一化，不自行改大小写；服务器也不通过字符串改写伪造底层名称。
- VFS 挂载名、alias 和虚拟路由按大小写敏感匹配。进入来源后遵守其真实名称等价关系，不能承诺大小写不敏感磁盘能区分 a 与 A。导出须声明 nameSemantics；无法可靠支持其路径等价规则时，不启用强版本写入。v1 取值表只有 `source`（该导出为独占可写，版本键遵从来源自身的名称等价规则）；缺失或未列入的取值一律不启用强条件写入，导出按只读处理，新增语义须先补入取值表。
- 来源的缓存键、revision 键和挂载名称冲突检查必须使用一致的物理条目身份/名称等价规则。大小写不敏感来源不能对同一物理文件分配两个互不相关的版本状态。非 UTF-8 排除、名称归一化和大小写均纳入平台验收。

## 5. vfs-core 后端接口收敛

以下为目标形状，名称与完整错误类型在实施时落定；不是当前可调用 API。

```ts
interface OperationOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}

interface FileStat {
    kind: 'file' | 'directory' | 'symlink';
    size?: number;
    createdAt?: number;
    modifiedAt?: number;
    revision?: string;
}

interface FileReader {
    stat(path: string, options?: StatOptions): Promise<FileStat | null>;
    list(path: string, options?: ListOptions): Promise<DirectoryPage>;
    read(path: string, options?: ReadOptions): Promise<ReadResult>;
}

interface StorageBackend {
    readonly name: string;
    readonly files: FileReader;
    readonly mutations?: FileMutations;
    readonly metadata?: MetadataStore;
    readonly tags?: TagStore;
    readonly records?: RecordStore;
    readonly batch?: BatchReader;
    readonly search?: FileSearch;
    readonly watch?: FileWatcher;
    init(options?: OperationOptions): Promise<void>;
    close(): Promise<void>;
}
```

StatOptions、ListOptions、ReadOptions 和各修改操作参数均包含 OperationOptions。新增共享操作选项，同时给现有 getNode、exists、capabilitiesAt 等无选项方法补充可选参数；所有视图、DirectoryDriver、FileHandle、搜索和复制辅助层必须透传。IFile 的取消扩展需要兼容共用 IIOStream 的设备消费者，不借此改变 TTY 写入语义。

后端返回文件事实，VFS 组装 path、parentPath、viewId 和可选扩展后的 FSNode；不能在组装时默认再查询全部 metadata/tags。列表提供 entry/stat 两种投影，类型查询沿用 statType 或等价轻量路径，避免仅为类型检查取完整属性。

新 FileReader.stat/statType 的语义是检查最终目录项自身，不跟随最终符号链接；HTTP v1 返回 kind=symlink 供视图拒绝访问，不返回链接目标。路径中间任一分量为链接时返回 SYMLINK_FORBIDDEN，不能穿越后再 stat。read、replace、mkdir、rename、remove 对涉及的链接均拒绝；递归删除遇到链接停止并按实际进度报告错误/partial。entries 允许标记最终链接类型，其他不支持节点以 warnings 汇报。旧后端适配需验证语义，不允许各 backend 自行决定是否跟随。cap-std 的 metadata 与 symlink_metadata 行为不同，目录能力本身不等于禁止所有链接，见 [Dir API](https://docs.rs/cap-std/latest/cap_std/fs/struct.Dir.html)。

metadata/tags/records 不存在即能力不可用；不支持的变更抛能力错误，不成功空返回。能力探测必须同步收敛，包括真实 readonly、条件写入、append、patch、stream、watch 支持范围。适配旧接口时不凭空声明新能力。

能力只有一个派生方向：backend 接口提供的结构能力 → 服务端导出/身份授权 → 项目/Session/路径授权 → capabilitiesAt(path) 的有效能力。HTTP 驱动据握手构造支持的可选接口，不再维护可与接口矛盾的静态布尔副本。存在 mutations 但某挂载 readonly 是正常的权限收缩，不是能力矛盾；能力结果不是授权凭证，实际操作仍必须校验权限。

目录分页只承诺有界消费，不默认为一致性快照：cursor 绑定身份、alias、路径和查询；过期返回明确错误。排序分页若需要扫描全目录，应显式计入成本。兼容 getChildren 可收集页面，但 UI 逐页消费之前不宣称首屏内存收益。

并发修改时分页允许重复或遗漏；去重只能消除重复，不能证明完整。要求完整结果的消费者须在目录静止后重新扫描，或等待未来的快照能力；不能声称“再扫一次”在持续修改时一定完整。cursor 使用带完整性校验的续读信息，不在请求之间持有目录句柄或锁，末页 nextCursor=null。

读取结果应将内容和 revision 关联，编辑器保存使用读取内容对应的 revision，而非之后独立 stat 得到的版本。流接口作为可选能力提供，旧 readContent 仍可缓冲；不得把服务端流响应等同于客户端端到端流式编辑。

### 5.1 完整写入操作

```ts
type ReplaceCondition =
    | { kind: 'create-only' }
    | { kind: 'match'; revision: string };

interface ReplaceOptions extends OperationOptions {
    condition: ReplaceCondition;
}

interface ReplaceResult {
    stat: FileStat;
}

interface FileMutations {
    replace(path: string, data: Uint8Array, options: ReplaceOptions): Promise<ReplaceResult>;
    mkdir(path: string, options?: OperationOptions): Promise<FileStat>;
    rename(from: string, to: string, options?: OperationOptions): Promise<void>;
    remove(path: string, options?: RemoveOptions): Promise<void>;
}
```

首个可写版本仅实现 replace：create-only 映射 If-None-Match: *；match 映射一个强 If-Match ETag，要求目标存在且版本匹配，条件失败返回 412。不提供无条件 upsert，也不混合 create/mode/revision 参数；直接缺少前置条件的 PUT 返回 428。已有无版本写入调用者须迁移为携带内容读取时的版本，或明确不支持该路径；不能在保存前补一次 stat 来冒充编辑版本。

append、patch 以后作为独立可选能力增加，不预留万能 mode enum。不在引擎中隐式下载旧文件并上传全量内容来冒充后端原子操作。条件写入不支持时明确拒绝，不能降级成先 stat 后 write。

保留数字 expectedVersion 的旧后端兼容路径，为新路径添加不透明 revision；UI、FileHandle 和错误结构同步传播，禁止把 ETag 哈希压为数字。旧后端原有弱版本行为不被描述为新增原子保证。

### 5.2 批量与检查复用

statMany 返回与输入同序的逐项结果，缺失与错误可区分；限制项数和路径总字节数。普通后端可有界并发回退，HTTP 驱动将同轮查询合并为一次请求。批量不是事务。

首版保留 FileSystemView.noLinks 检查，通过 statType 微批处理降低成本。单次顶层操作可复用同来源、同授权版本的前缀检查；跨操作、跨身份不缓存授权结论。是否以可信后端的受限路径契约替代重复检查，必须作为后续独立变更验证，不能信任服务端返回的 safe 标志。

## 6. HTTP 协议 v1

当前实现路由如下；所有 alias 和 path 均经过统一验证，固定路由不直接展开宿主路径。

| 方法与路由 | 用途 |
|---|---|
| GET /v1/exports | 协议版本、当前身份可见导出与能力 |
| POST /v1/fs/{alias}/stat | 单项或批量属性查询（当前返回完整紧凑属性） |
| GET /v1/fs/{alias}/entries?path=… | 子项、可选属性、分页 cursor |
| GET /v1/fs/{alias}/content?path=… | 二进制读取，Range、ETag |
| PUT /v1/fs/{alias}/content?path=… | 二进制覆盖，If-Match 或 If-None-Match，返回新属性 |
| POST /v1/fs/{alias}/mutate | action=mkdir/rename/remove；移动不覆盖，当前仅删除文件/空目录 |
| GET /v1/fs/{alias}/operations/{id} | 查询可写/长操作状态 |
| POST /v1/fs/{alias}/operations/{id}/cancel | 请求协作取消，不等同于回滚成功 |

搜索与变更订阅属于后续能力，不要求服务端在只读首版实现。协议扩展通过版本与能力协商；不把整个 backend 序列化成通用 execute RPC。

错误体包含 code、message、operationId（适用时）和 outcome（适用时）；不返回真实宿主路径或凭据。HTTP 状态与 VFS 错误建立固定映射：未认证/无授权、缺失、目录类型错误、目标已存在、只读、条件冲突、请求过大、超时、服务不可用分别处理。stat 仅将确实缺失映射为 null，网络和权限错误不能吞成不存在。

CORS 允许配置的来源、方法和 Authorization、Range、If-Range、If-Match、If-None-Match、X-Operation-Id、X-Timeout-Ms 等头；暴露 ETag、Content-Range 等客户端需要的响应头。预检允许缓存但不替代每次服务端授权。身份变更后不能复用旧缓存。

### 6.1 Deadline、重试与 HTTP 缓存

transport 在每次发送前计算顶层剩余预算，通过 X-Timeout-Ms 传递正整数毫秒；预算耗尽则不发送。服务端在收到请求头时以单调时钟建立 deadline，预算为客户端值与服务端上限的较小值；缺失使用服务端默认值，非法值返回 400。服务端排队、上传和锁等待均消耗此预算。相对预算不依赖两端时钟同步，也不声称精确扣除了单向网络延迟；客户端仍独立执行总超时。

只读 stat（虽为 POST）、entries、exports 和 content 允许有限重试：最多额外 2 次，退避带抖动，当前仅针对 429/502/503/504（传输异常直接报告，不自动重试），并服从剩余预算和 Retry-After。取消、权限错误、版本冲突和其他协议错误不重试。body 已交付调用者后不透明重试或自动接续；先报告流不完整。分页重试也不获得快照保证。所有文件修改默认禁止自动重试；cancel 控制请求可重复发送，不能据此重新发送原修改。

v1 所有 API 响应使用 Cache-Control: no-store，客户端 fetch 同时禁用 HTTP 缓存；保留第 9 节显式管理的应用内短期缓存。ETag 用于版本条件，不依赖浏览器/proxy 缓存。content v1 不使用内容压缩或字节转换，反向代理也应保留原始字节，避免 Range 偏移与表示版本歧义。

### 6.2 Range 与版本一致性

单个有效 byte range 返回 206 和正确 Content-Range；不可满足返回 416 及当前长度。v1 对有效多范围请求忽略 Range 返回 200，驱动必须识别整文件响应；非法语法返回 400。长度为零的本地读取直接返回空数据，不构造非法范围。普通共享目录可做单次 Range 读取，但没有强 validator 时禁止跨请求拼装为同一版本。

需要续传时必须持有强 ETag：下载场景可发送 Range + If-Range，版本不匹配返回完整新表示 200，调用者丢弃旧片段；固定版本随机访问使用 Range + If-Match，冲突返回 412。v1 VFS 驱动采用后者，避免意外下载整个大文件。每次验证 ETag、状态、范围与长度，不把两个版本拼接，也不把 200 当作指定 offset 的片段。客户端不发送弱 ETag 或日期型 If-Range；没有强版本时重开整个读取仍不构成外部并发写入下的快照。

If-Match 使用强比较，If-Range 不匹配会忽略 Range；以上行为依据 [RFC 9110 条件请求](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1) 和 [范围请求](https://www.rfc-editor.org/rfc/rfc9110.html#section-14)。

### 6.3 连续操作、结束与事务边界

**v1 支持连续调用独立操作，不支持有状态的连续操作指令。** 例如 mkdir → replace → rename 由调用者依次 await 三个请求；前一步成功后下一步失败，不回滚前一步。并发请求之间不保证顺序；同一 HTTP 连接不建立业务顺序或原子组。

| 形式 | v1 支持情况 | 正常结束 | 提前结束/失败 |
|---|---|---|---|
| 多个独立文件请求 | 支持，每个请求自行授权、提交 | 每个请求各自返回；无需 end | 取消当前/待发请求，之前已提交修改保留 |
| 单次 statMany | 支持，仅批量读取 | 返回固定项数的逐项结果 | 逐项取消；无 begin/commit，也不提供写入事务 |
| 分页遍历 | 支持，多次独立 list | nextCursor=null，迭代器 done=true | 停止请求后续页面；无关闭 cursor 请求，服务端不持有跨页句柄 |
| 单次文件响应流 | 支持传输层流式，消费者接口按能力开放 | 完整 body EOF 且长度符合预期 | AbortSignal / iterator.return / reader.cancel；截断是失败，不是正常 EOF |
| 单次 PUT 上传 | 可写阶段支持 | 完整接收 body 后自动检查条件并提交，以成功响应/状态确认 | 上传 EOF 仅表示接收结束，不表示已提交；断流或取消按第 7 节处理 |
| 受管长操作 | 可写/长操作阶段支持 | 查询到终态；无需 finish 确认 | cancel 请求停止；断开连接不是提交或回滚指令 |
| 来源 init/close | 客户端生命周期 | 最后 owner 释放时 close | 取消所属请求并 drain；close 不是 commit |
| 远程 open/read/write/close 句柄会话 | 不支持 | 不适用 | 不占用必须靠 end 释放的远程句柄 |
| begin/end/commit/rollback 指令或多请求事务 | 不支持 | 不适用 | 不把未知指令映射为成功空操作 |

受管只读长操作的终态为 succeeded/cancelled/failed；修改操作为 committed/cancelled/failed/partial。committing 不是终态，unknown 是客户端对结果的认知，不是服务端正常终态。超时先触发取消，尚未完成的系统调用仍被跟踪，不能伪造 cancelled 终态。UI 已停止等待与操作已终止必须区分。

上传使用一次 PUT，不支持跨多个请求持续追加上传数据；未来若引入分块上传、快照游标、订阅或远程句柄，必须另行定义 open/finish/abort、租约和遗弃回收，不能直接复用 operationId 当会话 ID。未来 watch 才需要显式订阅生命周期，当前不实现。

现有仓库的 begin/commit 不产生新协议要求：[CLI HTTP sidecar](../../apps/cli/src/http-server.ts) 的 sidecarBegin/sidecarFinish 用于 SQLite BEGIN/COMMIT/ROLLBACK；[DirectoryDriver.transaction](https://github.com/mushuanli/vfs-core/blob/main/src/impl/services/DirectoryDriver.ts) 当前主要缓冲事件，[LocalFS 外层 transaction](https://github.com/mushuanli/vfsdriver-local/blob/main/src/localfs-backend.ts) 与 [IndexedDB 外层 transaction](https://github.com/mushuanli/vfsdriver-indexeddb/blob/main/src/idb-backend.ts) 直接执行回调，不提供跨文件 ACID。记录存储事务另有实现，不应与上述外层文件回调混淆。end 是结束语义的泛称，不是当前统一文件 API。

新 HTTP backend 不声明跨操作文件事务能力。未来若有人要求 mkdir + 多文件替换整体提交，应作为新增需求评估；仅把多次 HTTP 调用放入 transaction(fn) 不能提供该保证。

## 7. 随时取消：端到端契约

### 7.1 通用语义

用户关闭文件、切换项目、取消搜索、停止 Agent、卸载挂载或 CLI 中断，都通过所属操作的 AbortController 发出取消。timeoutMs 从顶层调用开始计时，排队和重试消耗同一预算；子调用传递剩余预算，不能每层重置。

信号在排队前已取消时，不发送 HTTP 请求、不开始磁盘操作。排队、重试等待、读取响应体、迭代下一页和分块处理之间均检查取消。禁止仅用 Promise.race 停止等待而让底层工作无人管理。

浏览器 AbortController 可取消 fetch、响应体消费与流读取，参见 [MDN abort 文档](https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort)。超时与用户取消在应用错误中区分；原生 AbortError 在适配层归一化，保留取消原因。

### 7.2 各阶段保证

| 阶段 | 取消后的保证 |
|---|---|
| 客户端队列，未发送 | 不执行，outcome=not-started |
| 读取、列目录、搜索 | 停止消费与后续工作；已收到的部分结果标记不完整 |
| 上传临时文件、等待提交锁 | 服务端确认取消后删除临时内容，不替换目标 |
| 写入进入提交区 | 可以停止客户端等待，但不能保证取消提交 |
| 已提交 | 不回滚；取消响应必须说明已提交 |
| 请求已发送，响应丢失 | outcome=unknown；不得提示“已取消且未修改” |
| 递归删除、跨来源复制 | 已完成部分保留，返回/记录部分结果，不能伪装成整体原子操作 |

读操作取消通常无业务副作用；写操作的 AbortError 不能单独表示“未执行”。应用错误结果必须携带 not-started、not-committed、committed、partial 或 unknown 等结果分类，未获得证据时使用 unknown。

### 7.3 服务端传播与操作状态

每个请求建立取消令牌和服务端上限 deadline。上传读失败、响应流被丢弃、显式 cancel、服务停止均触发令牌；不假设 TCP 断开会立即被所有处理函数观察到。没有数据交换时由 deadline 和显式取消补充。

可写操作及长操作携带客户端生成的不可预测 operationId。它是有限保留期内的操作去重键和状态标识，不是透明重放、事务或文件句柄。首次请求在执行前按身份与 ID 登记，存储方法、alias、路径、目标路径和条件等控制字段；v1 不计算或比较整个上传 body 的指纹。

已有 ID 的再次提交绝不执行第二次修改。控制字段明显不同返回 OPERATION_ID_REUSED；字段相同也返回 409 OPERATION_ALREADY_EXISTS，附原操作状态/查询地址，不返回暗示本次上传成功的 2xx。不为检测内容是否相同而读取/hash 第二份 body；重复请求体采用有界丢弃或结束该 HTTP 流/连接。客户端应以 GET 查询原操作，不重复上传；同 ID 不同 body 仍是调用方错误，服务器不声称能检测它。

取消早于原请求到达时，在有界 TTL 表登记取消标记，随后到达的原请求被拒绝执行。取消标记与完成记录一样有保留窗口；超过窗口或服务重启后不保证抑制迟到请求，结果继续视为未知。operationId 不复用，修改不自动重放；需要跨重启和任意迟到请求的强保证时必须另设计持久协议。

修改状态机：queued → preparing → committing → committed；提交前可进入 cancelled，错误进入 failed；多步骤操作可进入 partial。只读长操作不经过 committing，以 succeeded 结束。取消与进入 committing 的决策必须同步，确保不会同时确认“未提交”并开始提交。对终态重复 cancel 返回已有状态，不改写 committed/succeeded 为 cancelled；对 committing 返回当前状态和取消未能确认的结果。

状态注册表位于内存，限定数量、TTL 和每身份配额；记录耗尽时拒绝新受管操作，不丢弃活动操作记录。GET 状态和 cancel 均要求同一身份，不凭 ID 授权。服务重启、记录过期或原请求尚未到达时，“查无记录”均不等于未执行。

该表不是持久 exactly-once 日志。发生未知结果后默认不自动重发修改；查询状态或刷新内容进行核对。服务重启后的严格重放去重不属于首版承诺。需要持久结果保证时另加操作日志，而非夸大内存去重能力。

### 7.4 Rust 任务与清理

文件系统阻塞操作使用有界阻塞工作池，不在异步 executor 上运行大段同步磁盘 I/O。长循环在目录项或数据块之间检查令牌；等待队列和锁可取消。

已开始的 spawn_blocking 任务不能靠 abort 强制停止，参见 [Tokio 官方文档](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)。因此不承诺卡住的系统调用立即退出。客户端等待可及时结束，但服务端仍跟踪任务直到完成和清理，资源计数不得提前释放后无限启动新任务。

准备阶段临时文件由操作守卫与清理队列管理，失败/取消清理；启动时清理服务自身可识别的残留临时文件。临时对象必须在协议层不可见且不可被普通请求修改。流消费者提前退出时调用 iterator.return / reader.cancel 并释放句柄。

进入提交区后由受跟踪的服务任务完成发布与结果记录，不让请求 future 的销毁把提交留在不明中间状态。原子替换和持久落盘是不同保证；如提供 durable 模式，应执行必要的文件与目录同步，并分别测试平台语义。

### 7.5 批量、共享请求和来源释放

- 微批处理保留每个调用者的信号；某项取消只拒绝该项，不取消同批其他项。
- 请求已发送后可以丢弃已取消项的返回；只有所有订阅者均取消时才中止共享 transport。
- 合并键包含连接身份、alias、路径与查询选项；不共享可消费一次的响应流，不共享写操作。
- 视图关闭先拒绝新操作、取消该视图拥有的请求，再等待受管理清理。来源关闭在最后一个 owner 释放后执行；不能通过全局 source abort 杀掉其他视图请求。
- drain 必须有上限与诊断。超时后撤销视图访问，剩余清理由来源管理器继续跟踪，不能报告所有资源已释放，也不能无限阻塞 UI。
- 用户取消是普通交互，不弹通用失败告警；编辑器保存结果未知时保留未保存内容，提供刷新核对入口。

## 8. 写入与外部修改的一致性

可写版本使用同目录临时文件接收内容。上传结束后取得协调锁，检查取消与版本条件，再进入提交区原子替换，最后记录结果。读/上传不持有全局锁；首版可用每导出的短提交锁统一协调 rename、remove 和 replace，之后根据竞争指标细化，避免过早实现复杂路径锁。

### 8.1 exclusive 的前提与 writer lock

`access = "rw"` 要求所有修改经过唯一 fs-server，且该实例持有导出对应的 OS 排他 writer lock。锁必须是持有句柄期间有效、进程退出由 OS 释放的锁，不能只凭某个 lock 文件存在判断。拿不到锁则拒绝启用可写导出，不静默降级为无锁写入。

锁定位以物理根身份为准，不以 alias 或不同拼写的 root 为准；不同实例导出同一根必须竞争同一锁。同实例拒绝物理重叠的可写导出。锁存放位置必须受保护且不能被协议删除或替换；能力不可靠的网络文件系统不启用 exclusive。父子根在不同实例间并不能靠两个不同根锁自动互斥，首版部署约束禁止这种重叠，不能声称根锁已解决它。

OS/advisory lock 只能约束遵守同一锁协议的参与者，不能阻止 IDE/Git 或特权进程绕过协议写文件。因此 exclusive 同时要求部署控制写入者；单靠配置声明或单靠锁都不够。不能保证该前提的目录以 shared 只读方式导出，不启用强 CAS。

### 8.2 revision 分配与失效算法

每个 exclusive 导出维护有界内存状态，无需数据库：

```text
ExportRevisionState
  epoch: random 128-bit
  nextGeneration: monotonically increasing u64
  entries: canonical entry key -> generation
```

1. key 使用同一根内的真实条目身份/规范路径，遵守第 4.1 节名称等价规则。取值、首次分配和修改均在导出协调锁内完成；generation 在本 epoch 内不复用，溢出前更换 epoch 并清空状态。
2. 已存在文件首次 stat/read 时分配 generation；返回以引号包围的不透明强 ETag，编码 epoch 与 generation。不存在路径返回缺失，不分配“文件版本”。全局 counter 只负责生成唯一值，entries 才是当前路径版本的真相。
3. replace/create 发布成功后分配新 generation；delete 删除对应状态；rename 失效旧路径和目标路径状态。目录 rename/delete 失效全部后代，后续访问分配新值。受影响父目录的列表版本同样失效；版本不随路径移动保持不变。
4. entries 淘汰后，下一次访问分配新 generation；旧 If-Match 必须冲突，即使内容实际未变。先重新加载或分配当前状态再比较，禁止从请求中的 revision 恢复被淘汰条目。这允许保守冲突，不允许版本倒退或复用。
5. 服务重启或无法确定发布/版本更新是否一致时更换 epoch，所有旧条件失效。提交锁内先完成必要准备，再发布文件、更新内存版本和结果；发布后失败不能声称未提交，应失效 epoch 并报告实际已知结果或 unknown。
6. 读取在短锁内打开目标文件句柄并取得对应 revision，再释放锁流式读该句柄；exclusive v1 只通过替换创建新内容，不原地 patch 旧 inode。平台不能保持这种读取/替换语义时须使用受控快照或拒绝该能力，不能单独 stat 后再打开路径。

同一 epoch 内内容未变而版本因淘汰变化是允许的保守失效；相同强 ETag 不能对应不同字节。受管流所持版本可以用于本次返回，即使内存映射后来淘汰；下一次条件操作因此冲突是允许的。重启、删除再建、目录移动、淘汰、名称别名均须覆盖测试。

### 8.3 shared 目录

普通共享目录可能同时被 IDE/Git 修改。此时 stat 指纹仅能做尽力的外部修改检测；mtime+size 不能作为强 ETag，文件监听也不能构成严格 CAS。v1 shared 导出只读，不提供强 revision/ETag、条件覆盖或跨请求固定版本拼装。单次读取也不承诺并发原地修改时的快照。需要强条件语义时必须控制全部写入者或采用另外的受控存储设计。

不在每次 stat 上计算全文件哈希。若未来使用内容摘要，它可以作为内容验证依据，但不能独自阻止外部写入发生在检查与替换之间。

## 9. 性能设计

优先级依次为网络往返、传输量、重复磁盘操作、并发控制，最后才是序列化等局部优化。

| 机制 | 实施约束 |
|---|---|
| stat 微批处理 | 合并同轮请求，有界项数与字节；取消项可脱离批次 |
| 列表携带所需属性 | 禁止返回 N 个条目后再必然执行 N 次远程 stat |
| 写入返回属性 | 保存后不额外请求 stat 来获取新版本 |
| Range 与二进制 body | 首版单范围读取，严格校验 offset/length；避免 JSON 字节数组与 Base64 |
| 流与背压 | 服务端分块读写，有界通道；客户端缓冲接口设置大小上限 |
| 连接复用 | 连接按 endpoint 与身份复用；不在每个文件请求中重新初始化来源 |
| 有界缓存 | 小容量 LRU、明确 TTL；失效覆盖修改路径与父目录；条件写入始终由服务端检查 |
| 请求合并 | 仅同身份的等价读取，取消不影响其他订阅者 |
| 并发限制 | 全局、身份、导出与阻塞池均有预算；目录查询避免被大上传长期饿死 |
| 搜索下推 | 后续在服务端遍历，保持授权与忽略规则语义；取消、深度、结果和字节上限 |

首版不做全目录内容预取、不为每个文件创建数据库、不默认递归获取属性。分页能力不会自动使现有一次性 UI 变快；流式能力也不会自动改变 Uint8Array 返回接口的内存占用。

不预先承诺所有操作一轮 HTTP：当前多层视图可能串行触发检查。基准记录每个用户动作的请求数，再决定是否优化视图层检查；服务端较快不能掩盖高 RTT 下的串行请求。

## 10. 项目与工作台接入

新增小型 RemoteSourceService，负责连接配置、凭据引用、按需打开、共享 owner 和可用性；不立即重构全部 DirectoryMountService。

项目保存独立的、带 schemaVersion/revision 的外挂描述，沿用项目 ID 定位；原 directory 字段继续作为主目录，已有项目没有外挂时行为不变。示例：

```ts
interface ProjectMount {
    mountId: string;
    sourceId: string;
    root: string;
    at: string;
    access: 'ro' | 'rw';
}
```

首版 at 仅允许项目根下一层，例如 /reference；拒绝保留名称、重复挂载、与主目录已有条目冲突。项目主目录挂到组合视图 /，外挂挂到 /reference；整个项目组合视图再挂到 Session 的 /workspace。因此 Agent 与工作台都访问同一内容，Agent 路径为 /workspace/reference。

### 10.1 动态名称冲突

活动挂载点在项目组合命名空间中是保留名称。经该视图 create/mkdir/rename/copy 覆盖挂载根，或修改挂载根祖先结构时拒绝并返回 MOUNT_POINT_CONFLICT；其内部文件操作仍按远程来源权限执行。若提供项目主目录专用操作入口，也必须先执行同一保留检查，不能绕开组合视图。检查遵守主来源的名称等价规则。

其他独立来源视图、宿主进程或 Git 仍可能在主目录创建同名条目，项目视图不是宿主目录全局锁。此时策略固定为：**挂载命名空间优先，报告 MOUNT_SHADOW_CONFLICT，不自动切换来源。** 远程路径仍指向原挂载；本地冲突条目不混入该路径，项目状态显示 degraded/conflict，用户可通过明确的宿主入口解决冲突。远程断线也不能回退到被遮蔽的本地条目。

首次打开和根目录刷新时检查冲突，未来监听可加速发现；不宣称未刷新时立即检测所有外部变化。冲突发现前后路由相同，诊断不会改变授权。卸载后本地条目才按主目录正常规则出现，UI 应说明这个结果；这不是删除/移动任何一方文件。

### 10.2 授权版本与生命周期

这不会绕过 SessionFilesService 当前仅接受顶层挂载的限制：Session 授权的是项目组合来源，内部挂载由可信项目装配完成。项目视图 revision 必须包含外挂授权版本；注册来源本身不授予会话访问权。

新增 Session 继承当前项目挂载；已有 Session 下一次获取文件上下文时使用已应用版本。涉及活动 Task 的项目挂载变更先检查所有受影响会话，首版拒绝忙时变更，不强行替换运行中视图。配置持久化成功后失效项目与受影响 Session 的缓存，旧视图 drain 后释放；授权撤回后不允许继续新操作。

工作台流程：添加远程来源 → 测试连接 → 选择别名及目录 → 选择挂载名称和权限 → 保存。所有等待均可取消，显示连接/不可用/只读状态。断线保留挂载，不替换成空目录或其他来源；重连重建请求生命周期并重验证能力。

卸载先处理编辑器未保存内容与活动任务，随后撤销关联和释放视图，不调用远程 delete。现有项目工作区固定约束应依据项目身份和授权版本，而不能继续仅比较宿主 directory 字符串。

## 11. Web、Tauri、CLI 装配

| 宿主 | 传输与取消 | 额外边界 |
|---|---|---|
| Web | 标准 fetch + AbortSignal | HTTPS/CORS；凭据由宿主配置服务持有 |
| Tauri | 优先复用标准 fetch；必要时注入原生 HTTP transport | 原生 transport 必须实现 body 取消，不仅取消 JS 等待，并配置 URL 权限 |
| CLI | Node fetch + AbortSignal，SIGINT 取消所属操作 | 不把 URL/alias 交给本地 shell 或容器目录挂载 |

Transport 接口只抽象请求、响应流和取消，不提供绕过服务端路径授权的宿主文件能力。端间共享错误映射、批量和重试逻辑。

processMounts 必须区分 VFS 可访问性与本地进程目录能力。HTTP 外挂不能自动出现在宿主 Git、编译器或终端中；使用进程工具时明确报告该挂载不可用于本地执行，不能把它替换成本地同名路径。虚拟文件工具仍可在三端一致使用。

浏览器跨源和混合内容约束参见 [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)、[MDN Mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)。Tauri 原生传输选项参见 [官方 HTTP 插件](https://v2.tauri.app/plugin/http-client/)。

## 12. 分阶段实施与验证

### 阶段 A0：VFS 契约

- 增加 OperationOptions、取消错误分类与透传；旧后端适配不得假装底层 I/O 可强制取消。
- 分离基础文件能力与 metadata/tags，增加紧凑属性、批量读取和取消一致性测试。
- 迁移 LocalFS/IndexedDB 适配并验证 stat 链接语义与能力派生；此阶段不引入 HTTP，独立验证核心回归。

### 阶段 A1：只读 HTTP 闭环

- 实现 fs-server 的配置、别名隔离、认证、stat/entries/content/Range 与服务端 deadline。
- 实现 HTTP 驱动及 CLI 装配，完成请求/响应流取消、重试、协议错误和实际网络集成测试。
- 验证连续独立操作、分页结束、截断失败；不增加远程命令会话或事务。

### 阶段 A2：项目外挂与工作台

- 项目组合视图、挂载名称保留、动态冲突诊断、Session 继承与生命周期。
- 工作台入口及 Web/Tauri transport，所有来源按需打开，完成重连与取消闭环。

### 阶段 B：可写语义

- 完整 replace、条件创建/覆盖、mkdir/rename/delete，真实能力协商。
- operationId、状态查询、显式取消、提交区、临时文件清理与 unknown 结果处理。
- exclusive revision、数字版本兼容迁移、编辑器冲突提示和未保存内容保留。

### 阶段 C：按测量扩展

- 分页 UI、流式消费者、服务端搜索及忽略规则一致性。
- 变更订阅、缓存重验证；订阅断线须全量失效或重新同步，不能漏事件后继续信任旧缓存。
- 根据指标决定前缀检查优化、锁粒度、append/patch 和大文件上传协议。

验收矩阵：

| 类别 | 必测场景 |
|---|---|
| 路径隔离 | 绝对路径、父级路径、编码变体、链接替换竞态、特殊文件、根修改、跨别名 rename、无权限别名 |
| 取消 | 发送前、排队中、批量部分取消、响应 body 中、分页中、上传中、等待锁、提交边界、共享视图独立取消 |
| 不确定结果 | 提交后响应丢失、cancel 先到、服务重启、状态过期、重复 ID、同 ID 不同控制字段/不同 body、不重复执行 |
| 文件正确性 | 空文件、二进制、非 UTF-8 排除、Unicode 不归一化、大小写来源别名、Range 200/206/412/416、大目录、只读拒绝 |
| 写入一致性 | 并发条件覆盖仅一个成功、generation 淘汰、旧 epoch、删除再建、目录 rename 后代失效、writer lock 竞争、临时文件/崩溃清理 |
| 项目授权 | 工作台/Agent 路径一致、Session 继承、忙时拒绝变更、撤权失效、挂载后同名冲突、断线不回退、卸载不删文件 |
| 连续操作结束 | 多请求无隐式原子性、nextCursor=null、流截断、上传 EOF 不等于提交、终态重复取消、无远程句柄泄漏 |
| 协议约束 | 剩余 budget 传播、只读重试上限、修改不自动重试、no-store、拒绝重定向、日志脱敏、无强版本禁止分段拼装 |
| 三端 | Web CORS 预检与 body 取消、Tauri 实际 transport 取消、CLI SIGINT 与无进程目录映射 |

性能基准固定目录规模、文件大小、并发数和网络条件，在本地及模拟 50/100 ms RTT 下记录目录首屏、深路径读取、重复打开、保存、搜索、取消响应的 p50/p95，以及每动作 HTTP 请求数、传输字节、stat 次数、峰值内存、文件句柄与清理耗时。记录缓存冷/热、是否开启持久同步及失败率；不把未实测数字写成收益。

取消验收分别计量客户端停止等待、服务端停止新工作、最终资源回收三个时间，不能用 UI 已关闭来替代底层取消证据。文档先通过 docs:check；实施时分别运行核心/驱动/应用测试、Rust 测试及三端集成验证。

## 13. 首轮评审处理

| 意见 | 处理 |
|---|---|
| revision 缺少文件 generation 闭环 | 采纳，第 8 节明确 entries、首次分配、淘汰、移动、重启与读取绑定 |
| exclusive 需要 writer lock | 采纳并限定保证：根锁不约束非合作外部写入者，也不自动覆盖跨实例父子根 |
| stat/symlink 歧义 | 采纳，第 5 节固定最终项检查与中间链接拒绝，不把 cap-std 当作默认 no-follow |
| 挂载后冲突 | 采纳，第 10.1 节固定挂载优先、保留结构名称、可见诊断；不在冲突时自动切换来源 |
| operationId 指纹过重 | 采纳简化，不读第二份 body；重复 ID 返回原状态引用的 409，不把原结果冒充新内容成功 |
| Deadline/capability/retry/pagination/cache | 采纳，分别补入第 5、6 节 |
| Range 必须 If-Range | 部分采纳：强验证必需；续传可 If-Range，固定版本随机访问采用 If-Match 更明确 |
| UTF-8/Unicode/case-sensitive | 采纳 UTF-8 与不归一化；区分 VFS 路由和物理来源，拒绝虚构底层大小写敏感性 |
| A0/A1/A2 | 采纳，让核心、协议、产品接入分别可验收 |
| replace 与 append/patch 分开 | 采纳，并将 v1 replace 收窄为 create-only/match，去掉参数非法组合 |
| 连续操作及结束要求 | 原文不够明确；新增第 6.3 节。当前没有远程事务需求，连续调用不需要统一 end |

四个 P0 缺口均成立，但不全部属于可写阶段：stat 链接语义影响 A0/A1，动态挂载冲突影响 A2；revision 和修改去重是 B 的前置契约。本轮补充不等于实现验证完成，仍需按阶段以测试证明保证成立。


## 14. 本轮实现与验收边界（2026-09-28）

服务端位于 `tools/mindos-node/`（独立 git 仓库，自带 README 与 Rust 测试）；`tools/` 另放部署用的可执行文件与 `config.toml`（均被 `.gitignore` 忽略）。配置格式见第 4 节与第 14.2 节。服务端实际采用 Linux `openat2(BENEATH | NO_SYMLINKS | NO_MAGICLINKS)` 的目录句柄实现；不在不支持的平台退化成字符串检查。三种客户端均使用可注入的 fetch，Tauri 当前复用 WebView fetch，遵守同样的 CORS/混合内容限制，尚未引入原生 HTTP 插件。

| 部分 | 已实现 |
|---|---|
| 核心 | `FileStorageBackend` / `FileReader` / 可选 `FileMutations`，旧接口的 `FileStorageAdapter`；OperationOptions 与视图独立取消；文件读取回传 opaque revision，FileHandle/工具/编辑器使用读到的 revision 保存 |
| HTTP | exports、批量 stat、目录分页、二进制内容、单段 Range、If-Match；Basic 用户名/密码与兼容 Bearer 身份、Origin 白名单、no-store、禁止重定向、body 上限、剩余 deadline、只读有限重试 |
| 可写 | exclusive 根锁、epoch + inode generation；条件 replace、mkdir、禁止覆盖的 rename、文件/空目录 remove；operationId 注册/状态/取消/过期、临时上传清理，响应丢失返回 unknown |
| 项目 | ProjectRemoteMountService；挂载名称保留、远程优先、同名诊断、断线占位、Session 继承、重连与撤权；连接描述符存 `/etc/fs/remote/<connectionId>.seq`，项目挂载存 `/etc/fs/projects/<projectId>.seq`；索引与记录事务 CAS 防止覆盖其他管理端更新 |
| 三端 | Web/Tauri 注入 provider；CLI HTTP runtime、工作流 runtime 与 `mindos fs list/read/stat/status`；项目带远程挂载时不为 Agent 装配宿主 Shell/TTY |
| 工作台 | 工具箱 → MCP 多实例配置；新建本地/远程项目，按连接和路径去重，会话仅在项目内创建；默认只读，显式授权读写；凭据不入项目配置；关闭对话框取消连接；冲突或未知结果时保留编辑内容 |

实现收窄与后续扩展：

- v1 结构修改统一使用 `POST /v1/fs/:alias/mutate` 的 action，完整内容使用 `PUT content`。无 begin/end/commit 指令，无跨请求事务。重复 ID 一律 409，不消费第二份 body 来比较内容。
- 服务端每个 `[[exports]]` 自带读权限，`access = "rw"` 的条目额外授权写；与项目/Session 权限取交集。写导出必须独占锁，普通共享目录只读。独占锁不能拦截非合作外部写入，父子根跨实例互斥仍是部署约束。
- 文件替换只退休旧 inode generation；mkdir/rename/remove 保守清空导出 revision 表，使其他旧版本也可能冲突。重启或 10 万条表淘汰后旧版本失效。暂不持久化 operation 状态；保留一小时、最多 4096 条，满载拒绝新操作，不淘汰活动操作。
- replace 的 committed 只承诺原子可见性，不承诺断电持久性。保留 `.itookit-upload-` 命名空间，正常错误/取消清理临时文件，独占启动时有界扫描崩溃遗留。尚未开放递归删除、append、patch；不以客户端读改写模拟原子能力。
- 旧 LocalFS/IndexedDB 继续走兼容接口，其部分既有 I/O 不响应 AbortSignal；本轮不声称任意本地系统调用可立即取消。分页 UI、搜索/订阅端点、原生 Tauri transport 和流式应用消费者属于阶段 C。
- 每页目录有界重扫排序，当前列表适配器汇总分页；非 UTF-8/特殊条目诊断在旧列表 API 转为明确能力错误。大目录首屏优化尚未完成，没有宣称实测性能提升倍数。
- 项目描述符 CAS 保护配置提交；授权变化在当前 runtime 撤销旧项目及 Session 视图，并检查所属 Session 租约和活动 Task。其他已打开的宿主需重新装配项目配置，不提供跨宿主实时推送。

验证记录：核心、驱动、应用核心、工作台测试；Rust 路径/认证/分页/条件写入/重复 ID/取消测试；Linux 实际启动 Rust 服务的驱动集成测试覆盖二进制与 Range、并发旧版本拒绝、创建/重命名/删除。全仓类型、文档路径、架构边界、样式检查另行执行。此记录不代表已完成 Windows/macOS 服务端、真实 Tauri WebView/浏览器跨源交互、断电故障或 50/100ms RTT 性能验收。

Settings 与断线状态补充后的回归：app-core 174 项、app-shell 420 项、vfs-ui 134 项通过；HTTP 驱动单元测试 5 项通过，工作台 TypeScript 检查和 Rust clippy（warnings-as-errors）通过。文档、样式与架构边界检查通过（文档检查保留 5 条既有符号警告）。CLI 全量回归此前为 182 项通过、3 项失败：两个既有进程测试文件通过 rustc 直接编译 fixture 时缺少 `itookit_sanbox` 外部 crate，并非远程 FS 行为测试失败；不将本轮记录表述为全仓测试全部通过。

### 14.1 Settings 与断线项目状态

工具箱 → MCP 管理多条 mindos-node 配置，名称可自定义。启用 mindos-node 并测试连接后，通过标准发现或 `mindos_node_capabilities`（兼容旧名称）验证协议和同源文件服务地址；普通 MCP 不可绑定远程项目。配置保存稳定 ID 和 credentialRef，密码仅放宿主运行期凭据缓存，重启后重新输入。旧远程连接自动迁移到 MCP 并清除旧密码记录；未升级的旧服务保留文件访问兼容，需能力验证才能启用控制中心。远程项目显示「服务器名:项目名」，显示改名不移动项目与会话。

断线仅禁用该项目的文件入口、文件操作及新建会话；项目抽屉仍可展开，已有 Session 和历史可查看，其他项目不受影响。不可用文件项置灰并阻止操作，已打开文件区保留编辑状态并禁用交互；已有会话不设 inert。工具箱 MCP 的配置入口保持可用。断线不删除文件，也不自动取消已经运行的 Task。

工作台存续期间每轮完成后 15 秒检查一次连接，单次探测预算 3 秒；读取检测到传输失败时也标记离线。状态为 unknown/checking/online/offline；成功检查或显式重连恢复状态。探测使用目录 stat，不读文件内容；缓存来源视图通过动态可用性门恢复，避免把断线当成本地同名目录。原生 WebView/浏览器的网络权限限制也会体现为连接失败。


### 14.2 命名连接与远程项目

工作台“+ 项目”提供本地/远程选择。远程项目引用 工具箱 MCP 中已验证的 mindos-node 配置，指定 `/导出别名/子目录`；例如连接“团队资料”下的 `/docs/a` 与 `/docs/b` 是两个项目。第一段 alias 保持服务端访问范围约束，不能传宿主绝对根。整个项目文件根挂到所选远程目录，Session 通过 `/workspace` 继承；本地管理目录仅保留应用组织身份，不作为断线回退文件源。全局“+ 会话”入口隐藏，只能在项目内创建；程序调用同样校验当前项目和离线状态。

项目去重键为服务身份（有 serverId 时采用该身份，否则使用规范化 endpoint）+ username + alias + root。路径折叠重复与尾斜杠，拒绝 `..`、反斜杠和 NUL，不做物理路径推断。重复选择同一服务器同一路径打开已有项目，保留名称与权限；不同服务器可使用相同项目名，其导航路由在冲突时加入稳定项目 ID，展示名仍为服务器名:项目名。当前运行期创建串行化，catalog CAS 防止跨宿主并发提交重复授权。

MCP 配置以稳定 ID 区分，名称不承担类型或身份判断，可维护多个实例。一个配置可被多个项目引用；被引用配置禁止删除或修改地址、账号、凭据引用及移除 mindos-node 标记。MCP catalog 是连接配置的唯一来源，挂载授权仍保存在 `/etc/fs/projects/`；旧 `/etc/fs/remote/` 记录迁移后清理。凭据更新检查关联会话并撤销旧视图。

Rust 服务端采用单用户配置：顶层凭据可为内联 `password`、环境变量 `password_env = "ENV"`（至少 8 字节，二者只能选一种），或旧 Bearer 的 `token` / `token_env`（至少 24 字节，与密码互斥且不设置 `username`）；用户名取 `username`，未写时读 `FS_SERVER_USER`。导出目录写成一个扁平 `[[exports]]` 列表，`alias` 默认取目录名、`access` 默认 `ro`，`rw` 直接申请独占锁，因此不再有 per-client 授权与 `writer_policy` 二次配置。Basic 内容采用 UTF-8 编码，跨机器部署使用 HTTPS；不在 URL 或日志输出密码。Web/Tauri/CLI 共用相同认证实现。密码保存在运行期凭据缓存，重启后重新输入；CLI 在没有本地密码时仍可由凭据引用环境变量注入。

命名连接补充验收：app-core 175 项、app-shell 421 项通过；HTTP 驱动单元测试 6 项、Rust 服务端 9 项通过。测试包含连接名称选择、同路径并发去重、不同路径隔离、Session 继承、目录删除后释放引用、catalog 重载、Basic 错误用户名/密码拒绝与禁止 Bearer 降级。工作台/CLI 类型检查、Rust clippy、文档/样式/架构边界检查通过。


### 14.3 Storage 整合与旧同步清理

远程服务配置现统一位于工具箱 → MCP，Storage 中的旧远程设置入口已移除。每条配置独立维护名称、认证和能力测试，只有 mindos-node 配置显示 harness 控制中心并可用于远程项目绑定；编辑器生命周期负责释放控制中心与连接测试。

移除旧远程同步 UI/Service/类型/样式、同步缓存清理入口与“上次同步”指标，同时删除 SettingsService 中重复的 HTTP 同步实现、配置加载、自动同步订阅及定时器。已有 `/etc/sync_config.json` 不再读取或执行，不自动删除用户历史数据。本地存储统计、快照、导入导出和重置功能继续保留。

失去入口的项目额外挂载对话框（`showRemoteMountDialog`）与仅为它保留的文案一并移除：当前产品流是「工具箱 MCP 管理 mindos-node 配置 → 新建项目选择配置与路径」，项目根即所选远程目录。`ProjectRemoteMountService` 仍保留多挂载点的能力与测试。

### 14.4 断线降级与契约校正（2026-09-28 修复）

- 离线项目不再抛错中断 `openResource`/启动恢复：工作台只把该项目的文件视图置灰、`inert` 并显示 `remote.projectOffline`；打开文件且挂载状态未探测时先做一次有界探测（3 秒），打开已有会话不做该探测，避免未知状态被误判为可用或不可用。
- HTTP 驱动：Range 响应与请求长度逐项比对；可读错误体优先取其 `code`；明确的 4xx 记为 `not-committed` 且不发送对账 cancel，仅结果未知才对账；批量 stat 继承订阅者剩余预算；`2024:Q1.md` 这类含冒号的名称只按平台前缀规则拒绝；`nameSemantics` 未列入 v1 取值表（仅 `source`）的导出一律不启用强条件写入。
- vfs-core：条件写入先判能力错误再判缺失 revision；删除/重命名/事务路径透传取消选项；挂载保留名检查按大小写敏感路由；`IStorageBackend.init` 可接收操作选项。
- app-core：项目去重键含用户名/身份；删除项目前先做忙时预检再删会话；连接状态与挂载状态分开存储，瞬时握手失败不再把连接永久钉成离线，取消恢复原状态；重连即使视图失效也释放被替换来源；catalog 逐条校验，坏记录进入 `loadWarnings` 而不阻断启动；同名遮蔽以 `degraded` 暴露到抽屉描述。
- 提供方按「endpoint + 身份 + 别名」复用来源并引用计数，最后一个 owner 释放才关闭连接。

### 远程文件系统配置与目录选择交互

- 工具箱 MCP 编辑器提供 mindos-node 开关、用户名、运行期密码和连接检测。启用开关只记录待验证意图，测试通过并取得能力描述后才允许远程项目绑定。
- 编辑时密码留空沿用凭据提供器中的原密码；非空密码用于连接测试，保存失败恢复先前凭据。关闭编辑器取消检测；密码仅驻留运行期缓存，不随 MCP 配置导出或持久化。
- 新建远程项目可从授权导出别名逐级浏览子目录，也可以输入路径；列表按页读取，只展示目录，切换连接/路径或关闭弹窗取消旧请求，过期响应不更新界面。目录选择不自动创建项目，仍需确认项目名称和路径。
- 无需修改 fs-server：复用 `GET /v1/exports` 与 `GET /v1/fs/{alias}/entries`。客户端不请求或展示宿主物理根路径，不全量递归扫描。

连接错误必须保留可判断的结构化信息：HTTP 状态码区分 401 认证失败、403 权限不足、404 接口地址错误、429 繁忙与 5xx 服务错误；本地凭据缺失、超时、协议解析失败分别展示对应处理提示。浏览器 fetch 的不可达错误无法可靠区分服务未启动、DNS/TCP/TLS 与 CORS，因此提示排查范围，不把它误报为密码错误。错误提示不直接展示远端响应内容或凭据；配置弹窗与目录浏览共用本地化错误映射。

断线项目的禁用粒度调整为：项目抽屉仍可展开，已有 Session 与历史记录仍可查看；仅文件入口/文件操作与新建 Session 禁用。打开已有 Session 不为可用性检查等待远程握手，底层远程文件访问仍受不可用状态限制。新建项目选择远程连接即读取导出目录，不可达显示具体错误并阻止提交；用户可重试，恢复后选择有效目录再创建。

文件列表使用统一的展开控制位、20px 图标列和名称列；同层目录与文件对齐，嵌套仅由子目录容器增加缩进。目录不显示无意义的大小占位横线；真实文件使用紧凑单行详情，窄列表优先保留文件名和大小，隐藏相对时间。默认 SVG 图标按文件名/后缀分类（包括 PDF、表格、演示、音视频及点配置文件），保留显式自定义图标，不额外读取文件内容。

图标采用形状与分类色双重提示：目录琥珀色并轻填充，代码蓝、配置紫、图片青、PDF 红、表格绿；文字保持统一颜色。颜色由 vfs-ui 的主题变量控制，深色主题使用较亮配色，显式业务图标不受覆盖。

远程项目选择器在切换到远程模式时检查各连接（最多两个并发请求）；检查中不可选择，失败的连接标注“无法连接”并禁用，可用连接才允许选中。提供“重新检查”以恢复已启动的服务器；检查返回的导出目录直接用于选择列表，避免重复握手。重新检查清空旧路径与选择，失败原因逐连接显示。

目录导航（导出目录、上一级、浏览此路径）与连接重新检查使用统一线性 SVG 图标按钮，必须提供翻译后的 `title` 与 `aria-label`。连接选择占位和错误原因保留文字，不使用图标替代语义提示；重新检查按钮与连接下拉并排。


### 配置存储布局迁移

- MCP catalog 保存连接配置；`/etc/fs/projects/<projectId>.seq` 的 `config` 保存该项目的挂载数组。旧 `/etc/fs/remote/<connectionId>.seq` 仅作为迁移输入。
- `/etc/fs/catalog.seq` 的 `index` 仅保存版本、revision 和连接/项目 ID 列表。索引与变更记录在同一 SeqFile 事务提交，加载也使用事务快照和批量记录读取。日常保存只写变更的记录；索引 CAS 拒绝陈旧管理端覆盖。
- 启动发现旧 `/etc/project-remote-mounts.seq` 而尚无新索引时，验证后自动迁移；保持连接、项目、挂载 ID 与 credentialRef。迁移前准备的空 seqfile 不代表迁移完成，只有事务提交的新索引才是完成标志。旧文件保留备份，新索引存在时不再读取它；不支持旧版本继续修改备份。
- 移除配置在事务内删除 `config` 记录与索引引用，空 seqfile 可保留，避免事务外删除与并发重新创建发生竞争。
- 项目身份由项目元数据保存，组织关系在 `/var/lib/sessions/folders.seq`；MCP 迁移保留项目和连接 ID，不移动文件及会话。旧连接密码载入宿主缓存后删除其持久记录。


凭据：MCP 记录只保存 credentialRef；密码由宿主运行期 provider 解析。编辑留空沿用当前缓存，失败回滚草稿凭据，删除配置清除运行期缓存。旧连接迁移保留引用 ID，清除旧 `config` 和 `password` 记录；应用重启后需重新输入密码，CLI 仍可通过凭据引用环境变量注入。

### 大文件读取与预览

HTTP 单次内存读取默认限制 32 MiB。超过上限返回 `EFBIG`（不是网络 `EIO`）；无编码转换时可通过 Content-Length 提前拒绝并取消响应流，未知长度继续按实际接收字节计数。该错误不使项目断线。

项目文件打开先读取文件 stat。超过 32 MiB 的文本仅用一次 Range 读取前 256 KiB，显示明确的只读截断提示并使用纯文本预览，不创建编辑器、不提供保存命令；已知二进制大文件只显示大小与无法内嵌预览说明。大小未知或 stat 后增长触发 `EFBIG` 时也转入预览。部分预览不代表完整文件，也不做跨版本分段拼接。


## 15. SQLite SeqFile 接口（2026-10-04）

mindos-node 在 export 内提供独立 `.seq` 文件的结构化记录读写。文件本身是 SQLite 数据库，记录表为 `entries(key TEXT PRIMARY KEY, value TEXT)`，value 保存 JSON。路径仍受 export 的认证、只读权限与禁止符号链接越界规则约束；不使用 sync 对象库，也不接受任意 SQL。

| API | 请求 | 响应 |
|---|---|---|
| `POST /v1/fs/:alias/seq/snapshot` | `{path}` | `{revision, entries:[{key,value}]}` |
| `POST /v1/fs/:alias/seq/transaction` | `{path, expectedRevision, changes}` | 标准文件操作回执，提交结果含新 `revision` |

`changes` 支持 `{action:"set",key,value}` 与 `{action:"delete",key}`。创建使用 `expectedRevision:null`；更新携带快照 revision。读取不存在的文件返回空快照，不创建文件；父目录必须已存在。能力发现返回 `files.seq={version:1,sqlite:true,transactionScope:"file"}`。

服务端在有界 blocking worker 中加载数据库，在内存 SQLite 事务里执行整批变更，再序列化到临时文件，通过现有文件 CAS 原子安装并持久化。并发写入只有满足 revision 条件的一方可以提交。SQL 事务成功不等于文件已发布；最终结果以文件操作回执为准。取消、响应丢失与结果未知复用 `X-Operation-Id` 及现有 operation 查询协议，客户端不得因 unknown 自动重放变更。

限制为每文件 16 MiB、每请求最多 256 项变更、key 最多 1024 字节且非空、不含 NUL；额外受到 HTTP 请求体限制约束。存储错误不会被解释成空快照或已删除。无效 SQLite 文件保持原位并报告错误。

`HttpSeqClient` 提供快照与条件事务 API。当前实现是**单文件事务**，没有把 HTTP 后端声明为完整的 VFS `IRecordStore`；跨多个 SeqFile 的会话、成员索引与身份更新尚不能作为一个事务提交。因此本接口为可写远程项目提供记录基础，但不等于完整远程项目会话存储已经开放。IndexedDB 的逻辑 SeqFile 仍由其记录后端实现，不要求与 SQLite 字节格式相同。


### 服务端项目授权

新 `[projects]` 模式支持导出目录下的子目录项目与受控挂载，文件请求附带项目 ID/revision；服务端逐路径核对授权。客户端项目支持 ro/rw，组织和 MindOS Session 数据仍存本地 profile；旧无项目协议服务保持只读项目兼容。详见 [项目与同步模型](mindos-node-project-model.md)。
