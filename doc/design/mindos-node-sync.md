# mindos-node 多端同步服务实施方案

状态：服务端首版已实施，2026-10-03。运行说明与具体请求见 [mindos-node 同步协议](../../tools/mindos-node/doc/sync.md)，配置见 [纯同步实例示例](../../tools/mindos-node/config.sync.example.toml)。itookit 客户端尚未接入；下文保留设计目标与验收要求，实际交付差异见第 16 节。

本方案细化 [项目多端同步设计](project-sync.md) 的服务端部分。mindos-node 作为单节点云存储，保存项目数据集的不可变对象、manifest、持久版本、成员目录和变更日志。A、B、C 等设备独立发布和读取，不要求同时在线。客户端决定基线、合并、覆盖与目录应用；服务器只接受经过授权和条件校验的明确发布结果。

首版实现单账号、多设备、多项目，沿用现有认证入口。存储键从第一版包含 namespace 和持久主体身份，为后续多账号留出隔离边界；首版不宣称已经提供多租户账号管理。

首版交付范围为单节点文件级增量同步、数据集级历史版本及回收站恢复、管理员停机灾备。项目整体时间点备份和会话安全接续分别按独立能力验收，不用“云备份完整”概括这些不同保证。

## 1 实施决策

| 项目 | 决策 |
| --- | --- |
| 元数据存储 | 新增 SQLite，使用 WAL、synchronous=FULL、foreign_keys=ON |
| 对象存储 | 受管目录中的不可变 SHA-256 对象，流式上传、校验和持久化 |
| 原子边界 | 单次数据集发布的 head、版本、成员变化、日志和操作回执在一个数据库事务内提交 |
| 并发 | 单服务进程持有存储锁；元数据写入串行，网络传输与摘要计算有界并行 |
| 幂等 | 新增持久操作表及副本操作序号，不复用当前内存回执语义 |
| 增量 | 数据集级变更发现、文件级对象去重；首期完整 manifest，无文件内部块级增量 |
| 版本恢复 | 支持历史枚举、指定版本查询及条件恢复；保留期从版本被替代或资源被删除时起算 |
| 项目备份点 | 首版不提供；恢复已删除项目只恢复删除时的成员状态，不提供任意时间点回滚 |
| 会话支持 | 存储通用对象包和成员身份；会话历史、分叉和上下文的语义校验由客户端承担 |
| 普通 export | 不自动变成同步项目，不允许对象库被 export 或 Bash 修改 |
| 执行 | 同步服务可独立于 execution 运行；checkout 和结果回传留待后续 |

SQLite 在 WAL 模式下使用 FULL 会在每次提交增加同步写盘，NORMAL 则可能在系统崩溃或断电后丢失最近提交。同步发布采用 FULL，并依赖存储设备正确实现同步写入；不能把进程 kill 测试声称为真实断电证明。依据见 [SQLite synchronous 文档](https://www.sqlite.org/pragma.html#pragma_synchronous)。

## 2 源码基础与改动边界

| 当前源码 | 实施处理 |
| --- | --- |
| [app::State](../../tools/mindos-node/src/app/mod.rs) | 增加可选 SyncService 装配；管理独立准入、恢复和关闭 |
| [配置模型](../../tools/mindos-node/src/config/model.rs) | 增加可选 sync 配置，缺省关闭，保持旧配置可解析 |
| [export 初始化](../../tools/mindos-node/src/config/exports.rs) | 当前拒绝空 exports；仅在 sync 启用且 execution 关闭时允许纯同步实例使用空集合 |
| [auth](../../tools/mindos-node/src/auth.rs) | 复用 Basic/Bearer 认证；把运行期 usize 身份映射为持久 principalId 和 namespace 授权 |
| [operations](../../tools/mindos-node/src/operations/mod.rs) | 当前为 Mutex<HashMap>，保留一小时，重启后未知；只保留普通文件操作用途 |
| [HTTP router](../../tools/mindos-node/src/http/mod.rs) | 增加独立 sync 子路由、对象流预算和结构化错误映射 |
| [能力发现](../../tools/mindos-node/src/http/handlers/capabilities.rs) | 增加同步协议发现入口，仅在恢复和能力验收完成后开启 |
| [文件 revision](../../tools/mindos-node/src/fs/revision.rs) | 不用于同步 generation 或内容标识 |
| [workspace journal](../../tools/mindos-node/src/workspace/journal.rs) | 可参考写盘故障分类和存储锁思路，不复用租约模型或整份 JSON journal |
| [main](../../tools/mindos-node/src/main.rs) | 启动时恢复同步存储，关闭时停止同步准入并等待持久提交 |
| [sandbox](../../tools/mindos-node/src/process/sandbox.rs) | 当前使用 bubblewrap、授权目录 fd 及只读运行库挂载；补充同步根不可达检查和真实进程验收 |

已增加并锁定 rusqlite 0.31.0（bundled SQLite）；数据库连接与文件同步操作放在专用存储执行器或有界 blocking worker 中，不阻塞 Tokio 网络线程。

## 3 模块结构

以下目录相对 mindos-node 仓库，为职责结构；实际实现增加 commands、admin、transport 和显式测试 feature，具体文件以源码为准：

```text
src/sync/
├── mod.rs                 公共服务入口和有限导出
├── model.rs               项目、数据集、head、manifest 和命令
├── policy.rs              授权、状态转换、配额和保留决策
├── manifest.rs            编码、路径、引用和预算校验
├── service.rs             上传、发布、查询和生命周期编排
├── store/
│   ├── schema.rs          表结构及单向迁移
│   ├── metadata.rs        SQLite 事务和固定快照查询
│   └── blobs.rs           暂存、hash、fsync 和原子安装
├── operations.rs          持久准入、请求去重、回执与取消
├── catalog.rs             成员清单和 changes
├── retention.rs           pin、保留根和 GC 编排
└── recovery.rs            启动恢复与存储健康状态

src/http/handlers/sync/    HTTP 参数解析、流与响应适配
tests/sync/                领域、存储、HTTP 和故障测试
```

HTTP handler 不执行 SQL，不直接拼接对象路径。policy 不执行 I/O。service 通过具体职责端口调用 metadata 和 blobs；底层存储不决定冲突赢家或项目同步方向。不增加通用插件框架、另一套任务调度器或与现有 workspace 平行的运行租约系统。

## 4 配置与身份

拟议配置示例：

```toml
listen = "127.0.0.1:8787"
execution = false
username = "li"
password_env = "FS_SERVER_PASSWORD"
allowed_origins = ["http://localhost:3000"]

[sync]
enabled = true
root = "/srv/mindos-node-sync"
principal_id = "owner"
namespace_id = "personal"
max_object_bytes = 268435456
max_manifest_bytes = 8388608
max_manifest_entries = 100000
max_retained_bytes = 10737418240
max_concurrent_uploads = 4
upload_ttl_seconds = 86400
history_retention_seconds = 2592000
trash_retention_seconds = 2592000
operation_retention_seconds = 604800
replica_expiry_seconds = 7776000
read_pin_seconds = 900
metadata_reserve_bytes = 1073741824
```

数值为首版默认建议，需要在配置测试中固定上下界。最大项目、数据集、副本、pin、回执及待接收命令数量同样必须有限；能力响应返回生效值。

持久 authorityId、historyEpoch、cursor 签名密钥在首次初始化存储时生成，正常重启保持不变。principalId 与 namespaceId 不从密码或 username 的哈希派生，密码轮换不改变授权身份。已存在根目录与配置身份不匹配时拒绝启动，要求显式迁移。

replicaId 由设备生成并通过幂等注册绑定当前主体；设备重装生成新 ID。服务端保存 reconciling、active、expired、revoked 状态；重新接入流程见第 8.5 节。副本不是独立登录凭据，同一账号首期各设备拥有同等项目权限。

sync.root 必须使用支持所需持久化和文件锁语义的本地文件系统，并与所有 export 根保持无重叠、无别名访问。SQLite WAL 依赖共享内存协调，不采用网络文件系统部署。参见 [SQLite WAL 部署约束](https://www.sqlite.org/wal.html)。

目录无重叠只证明普通 export 路径不能直接触及对象库。execution 同时启用时还需证明同步根不位于 sandbox 的宿主运行库挂载、授权目录或其他可访问别名内；应统一解析实际来源，拒绝包括只读泄露在内的重叠。继承 fd 也不能暴露存储句柄。实际 Bash 通过绝对路径、已授权挂载和可用 fd 的访问必须被测试拒绝；不能用配置测试替代该证明。具有宿主管理员权限的外部进程不属于此 sandbox 保证。

## 5 存储布局和表结构

```text
<sync.root>/
├── storage.json             初始化完成标记及预期存储身份
├── sync.lock
├── metadata.db
├── metadata.db-wal
├── metadata.db-shm
├── objects/<namespaceId>/<projectId>/<hash前两位>/<hash>
└── staging/<uploadId>
```

首版按项目物理隔离对象，只在同项目内去重，简化授权和计费。未来可以增加内部跨项目去重，但 API 仍按项目授权，不暴露全局对象存在性。所有路径组件都由服务端验证过的 ID 或摘要构造。

项目与目录的契约是：一个 itookit 项目对应一个本地工作目录，云端对应一个由 projectId 标识的独立对象目录。不同项目分开存储，目录末级同名不能触发自动合并；多端只有显式绑定同一个云端项目才共享 projectId。项目目录由服务在 sync.root 下自动管理，不要求管理员逐项目配置路径。metadata.db、服务锁与上传暂存可以共享，持久项目对象及其元数据作用域保持隔离；独立对象目录并不表示可以直接把它作为普通文件 checkout 编辑。

| 表 | 关键内容与约束 |
| --- | --- |
| store_info | schemaVersion、authorityId、historyEpoch、cursorKey、持久主体映射 |
| projects | namespaceId、projectId、owner、metadataRevision、lifecycleRevision、active/deleted、deletedAt、recoverableUntil |
| datasets | projectId、datasetId、kind、logicalId、generation、manifestHash、状态 |
| dataset_versions | generation、manifestHash、previousGeneration、committedAt、supersededAt、retainUntil、内容可用状态与 operation |
| catalog_versions | 成员的有效 sequence 区间，用于固定版本分页枚举 |
| objects | 项目作用域 hash、size、ready/deleting/corrupt/repairing、安装时间；唯一键为项目加 hash |
| manifests | 已验证 manifest、kind、format、对象数量与逻辑字节 |
| manifest_refs | manifest 到每个对象的引用，支持验证、pin 和 GC |
| changes | 项目内单调 sequence、类型、dataset、前后 head、成员状态 |
| replicas | 主体、replicaId、lastAdmittedSeq、状态、最近活动 |
| replica_acks | 副本、项目、范围 revision、ack sequence，不替客户端计算 baseline |
| operations | historyEpoch、主体、副本、opSeq、operationId、requestHash、规范请求、状态、终态回执 |
| uploads | 上传预留空间、暂存状态、安装状态、到期时间 |
| pins | owner、requestKey、manifestHash、到期时间及用途 |
| gc_items | 已确定删除的对象及文件清理进度 |

所有外键和唯一约束包含必要的项目或 namespace 作用域。generation、sequence、opSeq 在数据库中使用有上界整数，在 JSON 中使用十进制字符串；计数达到上界时拒绝新写入，不能回绕。

副本和操作唯一键同时包含 historyEpoch；旧历史代次下的序号不能匹配新操作。资源删除后保留紧凑身份记录，其保留寿命与内容恢复窗口分开，不能因正文 GC 后就允许复用 projectId、datasetId 或 logicalId。

changes sequence 同时作为项目 catalog revision。成员变更事务维护有效区间，避免跨分页返回不同时间的成员集合。dataset ID 与 logicalSessionId 在项目内唯一；已删除身份保留生命周期记录，不能按同一 ID 静默创建新资源。

## 6 manifest 和通用对象包

### 6.1 文件 manifest

```json
{
  "format": "fs-agent.files",
  "version": 1,
  "entries": [
    { "path": "src", "kind": "directory" },
    {
      "path": "src/main.ts",
      "kind": "file",
      "hash": "<64位小写SHA-256>",
      "size": "123",
      "executable": false
    }
  ]
}
```

manifest 使用 UTF-8 JSON，并按 [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785) 规范化后计算 SHA-256。文件内容对象直接对原始字节计算摘要。首版规范不允许扩展字段、重复 JSON key、非法 Unicode 或浮点业务字段；entries 按规范路径 UTF-8 字节序排序，路径唯一。

路径不以斜杠开头，不含空组件、点组件、反斜杠和 NUL；保留 Unicode 原值，不隐式大小写折叠。父目录必须显式存在，根目录隐含；文件不能有子项。首版只接受 file、directory，executable 为可选可移植属性。删除表现为新 manifest 移除条目，前后版本用于确认删除。

服务端验证 manifest 引用的每个文件对象已在当前项目 ready，实际长度等于 size。manifest 不接受宿主路径、符号链接、挂载指令和执行配置。

### 6.2 会话等通用对象包

```json
{
  "format": "fs-agent.bundle",
  "version": 1,
  "mediaType": "application/vnd.itookit.session+json",
  "root": "<入口对象摘要>",
  "objects": [
    { "hash": "<入口对象摘要>", "size": "456" },
    { "hash": "<Round对象摘要>", "size": "789" }
  ]
}
```

objects 是完整、去重、排序的直接对象清单；root 必须在清单内。首版不递归解释任意自定义对象，避免服务端依赖 llm-session。服务端只保证声明的存储闭包完整；入口正文中是否遗漏附件、Round 祖先或上下文依赖，由 itookit 会话导出与导入校验。

bundle 的通用存储能力可以先实施，能力响应标明 opaqueBundle=true；不能据此宣告已经完成“会话可接续”。同一逻辑会话的成员发现依靠 dataset.kind=session 和 logicalId，服务器不识别分支合并语义。

### 6.3 manifest 上传

manifest 经普通对象 PUT 上传。dataset create 或 publish 引用其 hash 时，服务端按预期格式解析、验证规范字节与引用清单，并缓存验证结果及 manifest_refs。实际发布事务仍要复核对象状态和项目授权，避免 GC 与发布竞态。

内容相同但编码不规范的 manifest 返回 INVALID_MANIFEST，不自动改写后用客户端旧 hash 发布。跨语言规范编码由 Rust 与 TypeScript 共用 fixture 验证。

## 7 对象上传和持久安装

上传采用整对象 PUT，无分块续传；失败时重传该对象，已验证 ready 对象可直接复用。objects/check 只返回当前项目有权访问的 ready 对象，不查询其他项目。

流程为：

1. 在短事务中检查项目授权、对象预算、并发槽和存储配额，持久登记 upload 及空间预留。
2. 在 staging 中创建唯一临时文件，流式计算摘要和大小，超预算立即停止。
3. 校验请求摘要及长度，sync_all 临时文件。
4. 在对象安装与 GC 协调锁内，以不覆盖方式安装到 hash 路径，同步目标目录及必要的新建父目录。
5. 持久事务登记 ready 对象、完成 upload 并建立暂存保留根，释放预留空间。
6. 只有对象和登记均完成后，返回上传成功。

发现同 hash 文件时校验既有长度和记录状态；不能直接信任一个未登记的残留文件。并发上传同对象可以只保留一份，但每个上传的预留和临时文件必须独立清理。

安装后、登记前崩溃留下无引用对象，恢复可验证后登记为有期限暂存对象或清理，不能凭存在就授权发布。数据库已经 ready 的对象缺失或损坏时报告存储损坏并阻止相关发布，不自动创建空文件。

采用“对象先持久化，引用后提交”的顺序，允许孤儿对象，不允许已提交 head 指向未持久化内容。上传成功只表示暂存内容可用，不表示任何设备的数据集已经更新。

### 7.1 配额计量与工作空间

逻辑当前用量按每个活跃数据集 manifest 声明的资源字节求和，文件在不同路径重复引用时重复计算；这是产品用量指标，可另设 max_current_logical_bytes。max_retained_bytes 则按 namespace 内所有项目的唯一已安装对象字节和持久预留计费：同项目同 hash 一次，跨项目分别计费，历史和暂存对象都占额度。安装完成把上传预留原子转换为已安装用量，不重复记账；GC 完成文件清理后才释放已安装用量。

并发上传同 hash 在未完成去重核对前各自预留空间，接受暂时保守拒绝；核对后按实际对象计费。物理磁盘预算还包括临时文件、数据库、WAL 和备份工具工作区，不以对象逻辑额度替代磁盘空间检查。

达到配额时拒绝新增写入，不能提前回收仍在承诺窗口内的历史、回收站或 pin。缩短保留配置只影响后续失去当前引用的版本，不缩短已持久化的 retainUntil。恢复仍在保留中的版本通常不新增对象字节，但仍需元数据空间预算。

每次上传准入和最终安装、每次发布提交都必须复核用量或消费持久预留。预留 metadata_reserve_bytes 供数据库、回执终态和 GC 工作；低于水位时停止数据增长操作。保留空间不是对外部进程耗尽磁盘的保证，真实 ENOSPC 仍按事务是否可确认分类，不能因无法写入失败回执就返回确定未提交。

### 7.2 完整性与修复

上传和管理员校验按完整 SHA-256 验证，不能只比较长度。全量下载的客户端在接收完成后验证 hash，再应用到本地；Range 下载组装完成后验证完整对象，ETag 只是对象标识和条件凭证。服务端全量读取可以同时计算摘要，发现不匹配时终止响应并标记损坏，但客户端仍必须验证已收到的字节。

发现损坏时将对象标为 corrupt，相关版本返回 contentStatus=corrupt，阻止继续发布该对象，并保留引用和诊断。普通重复 PUT 不能因 hash 路径已存在而宣告成功。

首期提供管理员修复命令：在同步维护模式下从备份或授权副本接收目标 hash 的完整对象 → 暂存并校验 → 持久登记 repair 意图 → 原子替换并同步目录 → 恢复 ready。全过程保留旧文件或诊断信息并记录审计；重启后依据 repair 意图及摘要完成或拒绝恢复。修复只恢复 hash 对应字节，不改变 manifest、generation 或既有回执。没有可信内容来源时保持损坏，不能生成替代内容伪装恢复成功。

## 8 持久操作和条件发布

### 8.1 请求身份

所有改变项目、数据集或发布状态的命令携带 operationId、replicaId 和 opSeq。opSeq 是副本在当前 namespace 和 historyEpoch 内的单调序号；首版每副本只允许一个未终结的数据命令，文件对象上传可以并行。

新命令只接受 lastAdmittedSeq+1。在事务内登记规范请求及 requestHash，并推进 lastAdmittedSeq；同序号同内容返回原状态，不同内容返回 OPERATION_REUSED。HTTP 路径、目标身份、历史代次、expectedHead 和 manifestHash 都参与请求摘要。

终态回执可在配置期限后压缩，但 lastAdmittedSeq 和副本身份不能随之遗忘。旧 opSeq 缺少回执时返回 OPERATION_EXPIRED，永不作为新命令执行。这样避免回执清理后重复执行旧请求。副本注销也保留撤销记录；历史存储重置通过新 historyEpoch 使旧请求失效。

### 8.2 发布请求

```json
{
  "operationId": "op-...",
  "replicaId": "replica-...",
  "opSeq": "12",
  "authorityId": "authority-...",
  "historyEpoch": "epoch-...",
  "expectedProjectLifecycleRevision": "3",
  "expectedHead": { "generation": "4", "manifestHash": "<H4摘要>" },
  "nextManifestHash": "<候选摘要>"
}
```

dataset 身份来自路由，连同 namespace 和项目加入请求摘要。创建首个 head 使用 datasets 创建命令和不存在条件，不用 generation=0 冒充已有版本。发布为相同 manifest 时可以记录 committed/noChange 回执而不新增 generation 和 changes；必须先满足 expectedHead。

项目 lifecycleRevision 在删除、恢复和改变写入生命周期的授权重置时递增；普通名称及描述修改只增加 metadataRevision。项目范围内的发布、创建、删除和恢复命令均携带预期生命周期 revision；项目创建使用不存在条件。项目恢复后即使某 dataset 仍为 H4，删除前准备的旧命令也必须因生命周期条件失效而拒绝。

### 8.3 事务顺序

准入事务持久化 accepted 后，由有界存储执行器运行命令：解析及校验 manifest、固定相关对象、计算配额，然后进入短写事务。

```text
BEGIN IMMEDIATE
  复核 operation 仍 accepted、未取消
  复核主体、项目和副本可写，historyEpoch 匹配
  复核 expectedProjectLifecycleRevision
  复核 expectedHead 与当前 head 完全相同
  复核 manifest 及全部对象 ready，并固定引用
  复核配额并消费持久预留
  更新旧 head 的 supersededAt 和 retainUntil
  插入 dataset_version，更新 head
  更新 catalog_versions 和 changes sequence
  写入 committed 回执及返回 head
COMMIT
```

同一事务不写对象文件，不等待网络。CAS 不匹配等确定性失败记录 not-committed 终态，head 和 changes 不变；客户端重规划后使用新 opSeq 发布。

数据库 COMMIT 返回 I/O 不确定错误时，不能映射成 not-committed。暂停同步写入准入，重新打开并核对操作回执，未恢复前对调用方返回 unknown。事务故障必须显式区分“证明回滚”和“无法确认”。

### 8.4 取消和重启

持久状态采用 accepted、committed、not-committed；running 仅为内存执行提示，unknown 表示调用方缺少终态证据。查询 accepted 返回 outcome=unknown、state=pending。客户端断开不删除命令。

取消命令与提交事务争用同一元数据写入顺序。accepted 可转 not-committed/cancelled；已经 committed 则返回原回执，不能回滚。如果客户端要在原请求尚未准入时取消，取消请求必须携带同一完整规范命令，以便登记该 opSeq 的取消终态，不能凭裸 ID 猜测目标。

正常重启后，数据库中仍为 accepted 的命令说明没有终态事务。首期恢复将其标记 not-committed/SERVER_RESTART，不自动在重启后延迟执行旧写入；若事务实际成功，committed 回执一定与 head 一同恢复。此保证依赖 metadata 与对象的持久提交边界及测试。

### 8.5 历史代次变化和副本重新接入

正常重启保持 historyEpoch 和操作序列。灾备恢复则生成新 historyEpoch，恢复后的旧 replica 和 operations 仅供历史诊断，不承接新命令。旧备份中 accepted 的请求可能在备份后实际提交过，不能套用正常重启规则断言其未提交；其最终历史结果可保持未知。

客户端检测代次变化后执行：停止自动发布 → 固定本地未发布数据及旧操作记录 → 在新代次注册新的 replicaId → 全量读取项目成员和 head 并重新对账 → 显式激活副本 → 从 opSeq=1 开始新操作。不能将旧序号 121 改成 91 重发旧请求；旧基线只作为冲突证据，不直接标记新云端已确认状态。

注册产生 reconciling 状态，允许查询和下载，不接受数据变更命令。activate 请求包含本次选择的项目范围及有效清单 cursor，服务器验证同代次的对账凭证并转 active；无项目的新账号可确认空范围。该凭证只能证明读取过清单，不能证明客户端已正确应用文件，后者仍由客户端基线和恢复协议保证。激活后新关联项目也需重新取得 head，所有写入继续做 CAS。

同代次 expired 副本只读并拒绝新命令，首版不原地复活：客户端先查询旧结果、保存证据，再注册新 replicaId 和对账激活。revoked 副本保持不可用；当前有效账号是否能注册替代副本由认证与管理策略控制。

操作查询、取消、重复提交和副本注册/激活均必须携带 historyEpoch，旧代次返回 HISTORY_EPOCH_CHANGED，不能落到新代次同序号记录。所有同步数据路由使用 X-Sync-History-Epoch 头，命令体中的同名字段必须一致；capabilities 是获得当前代次的唯一豁免入口。

## 9 目录清单和增量日志

每个项目有单调 changes sequence。事件类型为 dataset-created、dataset-published、dataset-deleted、dataset-restored、project-deleted 和 project-restored，携带适用的 datasetId、kind、logicalId、前后 head、项目 lifecycleRevision 与提交 operation。资源级文件变化由客户端比较 manifest，不在第一版日志中展开。

dataset 首次创建时，首个 head、成员清单、事件和回执在同一事务内出现。清单包含活跃与保留期内已删除成员，让 B 能发现 A 新建或删除的会话。

首次列目录在同一读取快照取得 catalog 上界 S，分页按 ID 和 catalog_versions 在 S 时的有效行查询。cursor 固定 S、最后 ID、主体、项目、过滤条件、historyEpoch、到期时间，并签名。保留对应 catalog 版本直到分页令牌期限结束；不跨 HTTP 请求持有数据库读事务。

清单返回 changes cursor=S，客户端随后读取 S 之后的事件。changes 首次分页固定上界 T，后续页不混入 T 之后的新事件；结束后返回 T 作为下一轮起点。日志保留水位落后于 cursor 时返回 CURSOR_EXPIRED，客户端重新枚举和全量对账。

ack 只表示客户端声称相应范围的恢复信息已落盘，不代表本地所有资源一致。服务端验证 ack 不回退、不超过已经签发的日志范围，并把 scope revision 一并保存；未选择的数据集不被当作已经应用。首版保留清理以配置下限为准，ack 不能提前删除尚在最低保留期内的历史。

## 10 读取 pin 和 GC

### 10.1 读取保护

客户端下载旧 head 前创建 read-pin，服务端在事务内验证 manifest 及声明闭包仍 ready，并登记有期限保留根。pin 绑定主体、项目及 requestKey；重复请求在有效期内返回同一 pin，限制每主体数量和受保护字节。

读取对象必须处于当前 head、保留历史、有效 pin 或主体自己的暂存上传授权范围之一。pin 不增加原有读取权限。pin 到期后续请求返回 READ_PIN_EXPIRED；已经打开的流持有运行期对象读保护，直到完成或取消。

客户端冲突对象长期保留归本地缓存；服务器不因设备未解决冲突就无限保留全部旧版本。pin 可续期，但受配额及策略上限约束。对象已回收时不能重新建立对该旧 manifest 的保护。

### 10.2 GC 并发协议

GC 根包括有效活跃项目中的当前 head、保留期未到的历史和回收站版本、有效 pin、暂存上传、已准入命令引用、回执读取保护窗口内的结果以及 catalog 分页保留所需版本。已删除项目中仅仅保留 head 字段，不代表该内容永久作为活跃根。

候选扫描可以在事务外进行；实际回收在短事务重新验证根和运行期读保护，标记对象 deleting 并登记 gc_items。publish、pin 和对象复用只接受 ready，因此不能在该标记之后重新引用对象。GC 再删除文件、同步目录并在事务中清理对象记录。

publish、安装、打开读取和 GC 使用固定锁顺序：对象协调锁 → metadata 执行器。严禁 metadata 执行器反向等待同一协调锁。目录树扫描和流式传输不持有这个全局短锁；对象打开后用每对象活动引用维持保护。

回收中崩溃时，以 deleting 和 gc_items 恢复删除；不能直接把 deleting 改回 ready。若之后需要相同 hash，等待清理完成再重新上传。文件消失而数据库标记未完成属于可恢复 GC，ready 对象消失则是损坏。

### 10.3 历史与回收站保留

历史窗口保护的是失去当前引用之前的内容。committedAt 用于展示，不直接作为已替代版本的 GC 起点。

| 状态转换 | 保留规则 |
| --- | --- |
| 活跃项目中有效当前 head | 持续作为根，无时间到期 |
| H1 被 H2 替代 | 同一发布事务写 supersededAt=t，retainUntil=max(已有期限, t+historyRetention) |
| 数据集删除 | 最后有效版本保留至 deletedAt+trashRetention，并记录删除 generation |
| 项目删除 | 删除时所有有效成员 head 组成回收记录，至少保护至项目 recoverableUntil |
| pin、未终结操作、分页等仍引用 | 取所有适用保留根的并集，不因其他期限已过提前回收 |

一个版本即使连续作为当前 head 存在 90 天，今天被覆盖后仍获得完整历史窗口。发布、删除及保留期限登记必须在同一事务内完成，不允许 GC 先看到新 head、后看到旧版本的延长保留。

版本状态区分 available、expired、corrupt；到期后仅因其他引用还存在的字节不能被误报为有完整恢复窗口。枚举响应给出 supersededAt、retainUntil 和实际 contentStatus；创建 pin 或提交恢复事务再次校验并固定引用，解决“列表时可用、点击时已回收”的竞争。

内容期限、changes 保留水位、历史索引和身份 tombstone 分别管理。changes 过期不影响仍在保留期内的版本查询。正文过期后可以压缩版本信息，但 projectId、datasetId、logicalId 的紧凑删除身份记录在该 authority 中保留，防止旧设备复活；达到身份记录上限时拒绝新增，不能静默遗忘。

操作回执证明命令曾提交，内容可用性是独立字段。首版成功回执在 operationRetention 内保护其结果版本；窗口过后可以保留精简结果证明而释放对应读取根。若硬件损坏导致内容不可读，也不能把原 committed 回执改成 not-committed，应同时报告 resultContentStatus=corrupt 或 expired。

### 10.4 版本发现与恢复

历史 API 按 generation 有界分页，固定列表上界并返回 generation、manifestHash、committedAt、supersededAt、retainUntil 和 contentStatus，独立于 changes。历史查询可返回过期状态，但不得返回虚假的可读取承诺。

有效数据集的恢复流程为：枚举并选择版本 → 取得读取 pin → 校验/预览 → 以当前 head 和项目生命周期 revision 为条件，正常 publish 旧 manifest。H8 恢复 H3 的内容后得到 H9，generation 不回退。单文件恢复由客户端替换对应 manifest 条目后同样发布。服务端不需要新增回滚存储引擎。

已删除数据集的 restore 请求包含 expectedDeletedGeneration、项目生命周期 revision 和所选可用 sourceGeneration。恢复重新验证内容并发布新 generation，不自动使用已过期版本。删除回收期限已经结束时，restore 明确拒绝；仍被其他合法引用保留的内容可以经正常导出和新数据集创建使用。

项目 restore 只恢复项目删除时的有效成员及其固定 head；删除前已经删除的数据集维持已删除状态，历史保留独立计算。恢复在一个元数据事务中校验项目删除 revision、回收期限及成员闭包，并重新激活项目、增加 lifecycleRevision、写事件和回执。任何必需内容缺失或损坏则整体失败，首版不做静默部分恢复。成员数量受项目上限约束，长时间 hash 校验在事务前完成，事务内复核 ready 状态及引用保护。

项目的这项恢复仅撤销删除，不表示把整个项目回到任意日期。首版声明 projectCheckpoint=false；未来项目备份清单必须显式列出各数据集固定 generation/manifestHash，作为独立 GC 根并有自己的保留期限。它固定版本组合，不证明文件和会话业务上同时采集，也不自动提供多数据集原子回滚。

## 11 HTTP 契约

所有路由位于 `/v1/sync`，复用现有认证。请求及响应包含协议版本的能力边界，mutation 命令携带持久操作身份。操作查询按副本和序号定位，避免只保留随机 ID 时无法识别过期回执。

| 方法及路径 | 请求或结果 |
| --- | --- |
| GET /capabilities | 存储身份、namespace、能力、限制和保留期限 |
| POST /replicas | 幂等注册当前主体下的 replicaId |
| GET /replicas/:replica | 副本状态、lastAdmittedSeq 和未终结命令 |
| POST /replicas/:replica/activate | 验证新代次或新副本的对账范围与 cursor，允许开始操作序列 |
| POST /projects | 创建项目，带客户端 projectId 及命令身份 |
| GET /projects?state=active\|deleted\|all | 有界枚举授权项目及回收站状态和期限 |
| POST /projects/:project/delete | 条件删除项目，固定删除时的成员回收记录 |
| POST /projects/:project/restore | 条件撤销项目删除，校验完整回收内容 |
| POST /projects/:project/datasets | kind、logicalId、首个 manifestHash 及不存在条件 |
| GET /projects/:project/datasets?state=active\|deleted\|all | 固定 catalog 清单、回收站和 changes cursor |
| GET /projects/:project/datasets/:dataset/head | generation、manifestHash、成员状态及 projectLifecycleRevision |
| GET /projects/:project/datasets/:dataset/versions | 独立于 changes 的版本枚举、保留期限和内容状态 |
| GET /projects/:project/datasets/:dataset/versions/:generation | 查询固定版本的 manifest 和可恢复状态 |
| POST /projects/:project/datasets/:dataset/publish | expectedHead、nextManifestHash |
| POST /projects/:project/datasets/:dataset/delete | expectedHead，产生 tombstone |
| POST /projects/:project/datasets/:dataset/restore | expectedDeletedGeneration、sourceGeneration、项目生命周期条件，发布为新 generation |
| POST /projects/:project/objects/check | 有界 hash 列表，返回 ready 对象 |
| PUT /projects/:project/objects/:hash | 原始字节，校验 hash 和长度，返回暂存保留期限 |
| GET /projects/:project/objects/:hash | 原始字节，支持单 Range 和 ETag |
| GET /projects/:project/manifests/:hash | 已验证固定 manifest |
| POST /projects/:project/read-pins | manifestHash、requestKey、ttl 请求 |
| POST /projects/:project/read-pins/:pin/renew | 延长读取保护，返回生效到期时间 |
| POST /projects/:project/read-pins/:pin/release | 幂等释放 |
| GET /projects/:project/changes | 固定上界分页事件 |
| POST /projects/:project/replicas/:replica/ack | cursor 与 scope revision |
| GET /replicas/:replica/operations/:seq | 持久操作状态或明确过期 |
| POST /replicas/:replica/operations/:seq/cancel | 取消已准入命令，或携带完整原命令先行取消 |

项目删除与恢复使用独立命令并校验 lifecycleRevision，与 dataset delete 相同的持久操作机制；恢复增加 lifecycleRevision，不能回退历史版本。已删除项目允许原授权主体查询回收记录、版本和恢复状态，拒绝普通发布；授权不足不透露目标资源是否存在。

新同步 API 的错误体包含 code、operation 身份和可确定的 outcome。确定未提交才返回 not-committed；网络超时和不确定的数据库错误返回 unknown。常见 code 如下：

| 状态 | code | 客户端动作 |
| --- | --- | --- |
| 409/412 | HEAD_CONFLICT、CATALOG_CONFLICT | 拉取最新状态，重新规划 |
| 409/412 | PROJECT_LIFECYCLE_CHANGED、HISTORY_EPOCH_CHANGED | 停止旧计划，按生命周期或代次重新接入 |
| 409 | OPERATION_REUSED、OPERATION_SEQUENCE | 查询副本进度，禁止换正文复用旧命令 |
| 410 | OPERATION_EXPIRED、CURSOR_EXPIRED、READ_PIN_EXPIRED | 按对应范围对账或重建读取保护 |
| 410 | VERSION_EXPIRED、TRASH_EXPIRED、REPLICA_EXPIRED | 读取恢复范围或注册新副本，不复用旧写入条件 |
| 503 | OBJECT_CORRUPT | 保留本地数据，从已验证来源修复，不能用空对象替代 |
| 422 | INVALID_MANIFEST、OBJECT_MISSING、OBJECT_HASH_MISMATCH | 修正输入或重新传输，不能直接发布 |
| 429/507 | LIMIT_EXCEEDED、QUOTA_EXCEEDED、ENOSPC | 退避或清理空间，保留客户端未发布数据 |
| 503 | SYNC_RECOVERING、SYNC_STORAGE_UNCERTAIN | 查询结果并等待恢复，不盲目重放 |

对象上传单独配置流式 body 限制，不把现有全局 512 KiB JSON 限制提高为所有路由都可无限读。manifest 作为对象流传输后按独立解析预算验证。复用 Range 解析测试，声明并暴露所需 ETag、Content-Range 与同步状态头；CORS 允许 X-Sync-History-Epoch，不新增不必要的 HTTP 方法。

## 12 能力发现与兼容

现有 `/v1/capabilities` 保持 version=1，sync 字段增加 protocolVersion 和 discovery 路径，保留 push 布尔值兼容现有解析。push 只在发布全链路恢复成功后为 true。客户端必须读取独立同步 capabilities 才能决定实际模式，不能只凭 push 开启全部同步功能。

独立响应至少包含：authorityId、historyEpoch、namespaceId、filesManifest、opaqueBundle、atomicPublish、durableOperations、changeFeed、readPins，以及 historyList、datasetVersionRestore、datasetTrashRestore、projectUndelete、projectCheckpoint 和 offlineStoreBackup。每项由测试通过的实现派生；首版 projectCheckpoint=false。若保留 historyRestore 汇总字段，只表示历史枚举及数据集条件恢复闭环，不表示项目时间点备份。

sync 默认关闭；未配置时新增路由返回不可用，原有文件及进程能力继续按原契约工作。同步服务开启且恢复失败时，首版启动失败，不以一个空数据库冒充新云端；已运行时遇到同步存储故障仅关闭同步写入并暴露不健康状态。

同步对象库不使用 FileGate 与远程命令互斥：它与 export 数据独立，普通 Bash 不应阻塞对象下载。只有未来显式 checkout 导入导出才通过受控执行边界协调。

## 13 启动关闭与备份恢复

### 13.1 初始化与正常启动

首次初始化由显式管理员 init 命令完成，只接受空的新存储根。服务启动只打开已有存储，不自动创建新的数据库身份。初始化完成标记 storage.json 包含格式和 authorityId，在数据库及初始目录持久化后最后安装；中途中断由 init 恢复流程处理，普通 serve 拒绝半初始化状态。

已有标记、对象目录或 WAL 而 metadata.db 缺失时拒绝启动，不能补建空库。标记与数据库身份不一致也拒绝。配置可固定 expectedAuthorityId，避免把误指向的另一个完整存储当成原云端。

启动顺序：验证配置与目录边界 → 获取 sync.lock → 校验初始化标记 → 打开数据库并校验 schema → 恢复未终结命令及对象安装/GC → 校验持久身份与关键引用 → 开启同步准入 → 宣告能力。

同步存储损坏不自动重建。数据库迁移在独占启动阶段事务执行，未知更高 schema 拒绝启动。启动检查不必逐字节重算所有大对象，但需要恢复日志及必要的存在性核对；另提供管理员完整校验命令，实际读取始终校验必要的长度和完整性。

关闭时停止新命令和上传准入，取消尚未提交的传输，等待正在进行的短 metadata 提交，最终关闭存储执行器。现有 main 的硬退出定时器需要纳入同步 drain；超时退出后由下次启动恢复，不能在日志中把未确认操作记录成未提交。

### 13.2 停机备份规程

首版实现管理员备份命令，不提供在线备份。步骤如下：

1. 停止服务，由备份命令取得同一个 sync.lock 并持有至复制结束，阻止合作的另一服务实例重新打开源存储。
2. 核对初始化标记和数据库状态，在需要时执行正常恢复并关闭数据库连接；形成静止的源目录。若发现受保护对象损坏，备份不能标记为完整可恢复。
3. 在目标独立目录创建未完成备份，复制数据库、仍存在的 WAL 及完整对象和恢复数据；不把进程锁的持有状态当作可复制数据。
4. 生成 backup.json，记录 backupId、格式/schema 版本、源 authorityId/historyEpoch、备份时间、受保护版本清单，以及每个文件的相对路径、长度和摘要。
5. 在独立校验目录检查数据库完整性、外键、manifest 与所有受保护引用闭包，并重新计算对象摘要；校验过程不修改最终备份副本。
6. 同步写盘数据和清单，最后原子写入完成标记并同步目标目录。中途失败的备份保持未完成，不出现在可恢复列表中。

若静止状态仍有 WAL，必须连同数据库一起复制；不能只凭停机就假设 WAL 已被清空。WAL 属于数据库持久状态，遗漏它可能丢失已提交事务。依据见 [SQLite WAL 文件说明](https://www.sqlite.org/wal.html#the_wal_file)。shm 可由 SQLite 重建，完整目录备份可携带其静止副本，但不能把它当作数据库内容的替代。

用于抵御原盘损坏的备份应放在独立故障域。认证配置、TLS、服务启动配置和恢复所需的 namespace 映射单独按部署规程保存；数据备份不自动打包明文认证凭据。备份可能包含历史正文和存储内部密钥，按原数据同等访问权限管理。

### 13.3 从备份恢复

恢复命令只接受有完成标记且经过完整性校验的备份，先恢复到新的空目标目录，取得目标锁，在关闭服务状态下验证数据库、受保护 manifest 和所有对象摘要。源备份始终保留，恢复准备过程记录可重入阶段。

同一服务灾备恢复默认保留 authorityId；作为另一服务克隆时生成新 authorityId。两种情况均生成新 historyEpoch 和 cursor 密钥，失效旧 pin、cursor、上传令牌及激活凭证；旧 operations 仅作历史诊断。新身份和恢复完成标记持久化后才允许启动 HTTP。

不能只重置 generation 或将副本 lastAdmittedSeq 从 120 调成 90。客户端按第 8.5 节重建副本并全量对账；备份之后未包含在恢复数据中的发布不能被服务器凭空确认，由设备本地证据参与恢复。

验收必须包含原 root 不可用、恢复到空目录、启动服务、通过 HTTP 枚举历史及下载所有受保护对象，并逐项验证摘要。备份复制完成和实际恢复成功分别记录；仅存在 backup.json 不等于通过恢复验收。

系统时钟只用于保留期限，不用于判断版本胜负。运行中 pin 使用单调计时维护到期；重启需核对持久时间水位，明显时钟异常时暂停 GC 而不提前回收。历史代次与 sequence 承担顺序语义。

## 14 分阶段实现与交付

| 阶段 | 服务端改动 | 完成条件 |
| --- | --- | --- |
| F1 存储基础 | 显式初始化、保留与配额字段、持久身份、SQLite、对象安装和预留 | 缺库不初始化；重启身份稳定；安装故障可恢复；旧接口回归通过 |
| F2 发布闭环 | manifest、项目生命周期 CAS、副本代次/opSeq、条件发布与回执 | 旧生命周期请求拒绝；发布登记旧版本保留期限；最终事务复核配额 |
| F3 发现与保留 | catalog、changes、历史枚举、回收站、pin、GC 与副本重接入 | 历史不因 changes 清理而丢失；保留从替代/删除起算；GC 无悬空引用 |
| F4 恢复与交付 | 版本/删除恢复、损坏修复、停机备份恢复、隔离验收和能力声明 | 空目录恢复与 HTTP 校验通过；A/B/C 可重新接入；完整矩阵通过 |

中间阶段只在测试或显式开发开关下使用，不能在 F1 就把生产能力声明成完整同步。最终交付包括 mindos-node 实现、服务端 README/config 示例、HTTP 契约 fixture 和不依赖 itookit UI 的 A/B/C 客户端测试脚本。

itookit 后续按同一协议接入。服务端完成不代表客户端基线、合并和会话接续已交付；验收报告分别记录这两个边界。

## 15 验收与故障注入

| 场景 | 必须证明 |
| --- | --- |
| A 创建项目和 files 数据集，B/C 枚举读取 | 身份和 head 一致，内容对象完整，设备互不依赖在线状态 |
| A/B 都从 H0 发布 | 一个成功、一个明确 HEAD_CONFLICT；失败不增加 generation |
| 同一命令响应丢失后重试 | 原回执返回一次结果，不增加第二次事件 |
| 同 opSeq 不同正文 | 拒绝复用，原命令与回执保持 |
| 回执清理后重放旧序号 | OPERATION_EXPIRED，永不当成新命令执行 |
| 上传在写入、fsync、安装、登记之间崩溃 | 只产生可回收暂存或孤儿，不产生有效 head 悬空 |
| 发布在事务提交前后崩溃 | head、版本、成员、日志、回执全有或全无 |
| COMMIT 返回不确定错误 | 关闭写入准入并核对，不返回假 not-committed |
| 取消与发布竞争 | 终态唯一；取消已提交命令不回滚 |
| A 新增 session 数据集，B 分页枚举期间又新增 | 固定清单加 changes 无遗漏、不混入未完整创建的成员 |
| 日志已清理、客户端持旧 cursor | 明确过期并允许全量枚举，不悄悄跳过历史 |
| pin 有效时发布新版本并运行 GC | 旧闭包可完整读取；pin 到期后明确重建或报告过期 |
| GC 标记与 publish/pin/对象重新上传竞争 | 删除对象不会重新成为已提交 head 的引用 |
| hash 正确但 manifest 引用缺失或类型冲突 | 拒绝发布，当前 head 不变 |
| 大对象、大 manifest 和慢上传 | 有界内存、并发与预留，失败释放预算 |
| namespace/项目/主体伪造、hash 探测 | 不越权读取、发布或获知其他项目对象存在性 |
| 同步存储与 export 根重叠 | 配置阶段拒绝普通文件暴露 |
| execution 同时开启，尝试绝对路径、运行库挂载和 fd 访问 | 真正的 Bash 无法读取或写入同步存储；仅路径配置通过不算验收 |
| 恢复旧备份后使用旧请求 | historyEpoch 拒绝旧条件和 cursor |
| execution=false 且无 exports | 同步全链路可用，无需 sandbox 进程能力 |
| H1 当前保持 90 天，今天被 H2 替代 | H1 从今天获得完整历史窗口，不立即 GC |
| 长期未修改的数据集或项目今天删除 | 回收站可发现，回收窗口内闭包完整可恢复 |
| changes 过期但内容保留期未到 | 仍可枚举、读取和条件恢复该历史版本 |
| 恢复 H3 为新 head 前另一设备发布 | CAS 拒绝过期计划，不覆盖其他设备新提交 |
| 项目删除后恢复，旧 H4 发布请求到达 | 即使 dataset head 未变，旧 lifecycleRevision 仍被拒绝 |
| 恢复备份后客户端 opSeq=120、服务器旧记录为90 | 新代次注册和激活后从新序列发布，不永久卡住或重放旧请求 |
| 旧代次查询或取消与新操作序号相同 | HISTORY_EPOCH_CHANGED，不查询或取消新操作 |
| expired 副本携带未发布内容重新接入 | 旧结果只读，新副本完成对账；本地修改保留 |
| 配额已满且历史仍受保护 | 拒绝新增写入，不提前清理历史；元数据空间不足准确报告不确定结果 |
| 同长度对象内容损坏 | 全量摘要检测到损坏；验证来源修复后恢复可读，generation 不变 |
| metadata.db 缺失而标记、WAL 或对象存在 | 拒绝启动，不建立空 authority |
| 备份复制期间另一服务启动 | 源锁拒绝第二实例；未完成备份不能用于恢复 |
| 原 root 不可用，从备份恢复到空目录 | 完整 HTTP 下载及摘要校验通过，持久备份与恢复结果分别记录 |
| 项目恢复时缺少一个必要对象 | 整体拒绝，不静默恢复部分成员 |
| 既有文件、命令与认证测试 | 旧协议行为和错误语义保持兼容 |

存储测试注入文件写入、rename、目录 fsync、数据库事务和回执返回边界故障；HTTP 集成测试使用真实临时存储及重启子进程。进程崩溃和 I/O 故障分别记录，真实断电保证按部署环境验证。

实现检查使用 mindos-node 仓库的 cargo fmt、cargo clippy、cargo test，并运行真实 HTTP 多客户端测试。同步关闭时现有文件和执行测试必须继续通过；同步开启时新增持久化测试不能只使用内存数据库。


## 16 首版实施记录

当前实现的 C4 架构、接口事件流、策略与机制边界及改进项见 [同步架构与代码评审](mindos-node-sync-architecture-review.md)。

实现位于 [sync](../../tools/mindos-node/src/sync/mod.rs)，纯同步启动、现有认证、独立 JSON/对象流预算、CORS、能力发现与停机 drain 已接入原服务。默认 sync 关闭；生产构建默认不启用故障注入。

| 设计职责 | 实际交付 |
| --- | --- |
| F1 | 显式 init、初始化中断恢复、身份及独占锁、SQLite FULL WAL、配额预留、流式 SHA-256、持久对象安装、孤儿清理 |
| F2 | 规范文件/bundle manifest、项目生命周期及 head CAS、独立副本序号、持久准入/回执/取消、提交不确定时停止写入 |
| F3 | SQL 固定快照分页、会话最小成员目录、changes、独立历史目录、回收站、pin、保留期限与有界 GC、副本重新接入 |
| F4 | 旧版本正常发布恢复、数据集/项目撤销删除、损坏修复及崩溃恢复、停机备份/空目录恢复、真实 HTTP A/B/C 验收 |

元数据首版采用类型化 records（scope/kind/key 唯一主键）保存项目、数据集、版本、catalog、changes、副本、pin 和操作；对象、manifest_refs、uploads 和 gc_items 使用独立关系表。设计表中的实体职责不变，但没有逐实体建立所有物理表。manifest 在发布时重新验证，持久缓存验证过的类型及对象引用。

内容回收采用当前 head 与持久对象保护期限的并集。读取中的文件使用打开的 fd 保持实际响应内容；pin、历史和回收站期限持久延长对象保护时间。GC 每分钟执行，单批最多删除 1000 个对象，deleting 意图在重启后继续完成。主动释放 pin 后允许保守保留至原承诺期限。

changes 和重复 catalog 快照按保留窗口分批压缩；历史版本目录和身份索引仍保守保留，未压缩全部旧索引；总元数据行数（含对象、引用和预留）达到 max_metadata_records 时拒绝增长。changes 游标独立到期，过期时要求全量对账，历史查询仍可使用。终态操作回执到期清理，高水位与操作身份记录继续防重放。

对象 PUT 要求 Content-Length，整体上传有 TTL，已验证存在的对象可直接复用。项目枚举受 max_projects 限制，catalog、changes 与版本查询在 SQL 中分页。activate 支持选择项目范围；已有项目时空范围拒绝，没有项目时允许空范围。服务器只验证清单凭证，不证明客户端已应用数据。

管理员支持同服务灾备恢复，保留 authorityId、更新 historyEpoch；另一个 authority 的克隆命令未在首版交付。项目时间点 checkpoint 和会话安全接续继续作为独立后续能力，当前 projectCheckpoint=false，opaqueBundle 不表示可继续旧运行。

验收入口为 [同步测试](../../tools/mindos-node/tests/sync/main.rs)、[故障测试](../../tools/mindos-node/tests/sync/crash.rs)、[共享 fixture](../../tools/mindos-node/tests/sync/fixtures/manifests.json) 和 [真实 HTTP 脚本](../../tools/mindos-node/scripts/sync-smoke.py)。故障注入使用独立测试构建，涵盖提交、安装、GC、修复与恢复边界；不把这些证据等同于真实断电、磁盘控制器故障或 itookit 客户端同步验收。

### 16.1 正确性评审修复

init.pending 续作先核对已有身份和存储证据，不能因数据库缺失创建新 authority。准入与健康门禁在数据库锁内复核，正常关闭保留已接受操作的收尾路径；ACK 增加副本状态、增长预算和消费位置单调检查。

版本可用性与存储错误分开处理，SQL/I/O 失败不冒充 expired/corrupt。SAVEPOINT 和外层事务状态显式核对，回滚/回执写入失败不返回持久终态；未知结果在释放数据库锁前停止新准入。准入预留操作身份与 pending 回执行，业务行数超限可回滚并更新既有拒绝回执。

关闭协调计入 HTTP 请求、blocking 工作、接收中的上传和异步清理。停止准入后才可排空，超时记录明确失败并依赖重启恢复；backup 仍取得独占 root 锁，服务方法同时在数据库锁内复制。verify 改为只读连接，不执行启动恢复、不重建缓存或登记 corrupt，引用修复不能隐藏在校验中。

文件摘要、健康状态处理和副本活跃规则复用，HTTP 响应映射留在 transport。changes 与回执使用同一个类型化 operation 身份，并在原子发布事务中写入。详细证据见 [修复实施结果](mindos-node-sync-architecture-review.md#11-正确性修复实施结果)；测试增加实际 SQLITE_FULL、回执 SQL 失败、关闭/取消 HTTP 流，以及旧 epoch 对新操作的隔离。


### 16.2 发现索引清理与测量驱动优化

新增 [发现索引清理](../../tools/mindos-node/src/sync/compaction.rs) 和 [性能计量](../../tools/mindos-node/src/sync/metrics.rs)。纯策略 change_cutoff 计算回收边界，存储机制在同一事务更新项目 changeFloor、清理 changes 并保留 catalog 的成员边界快照。默认 changes 保留 7 天，另加一个完整 cursor TTL；每批最多删除 2000 行发现索引。分页续读保留原期限，落后于边界的读取、ACK 和 activate 明确返回 CURSOR_EXPIRED，全量对账后重新接入。缺失可靠事件时间的旧数据保守阻止清理。

历史恢复目录、删除成员身份和防重放操作身份独立保留，不因 changes 到期丢失。单节点仍存在元数据增长上限；这次未改变永久身份契约，也未承诺无限历史审计或数据库物理压缩。

锁等待、持锁、服务事务和 COMMIT 分开计量，错误回滚计入事务时间。1000 个文件引用同一对象的测量发现重复检查和 INSERT；现在先按摘要形成唯一引用集合，拒绝不一致长度，再在原事务中验证和写入。未移动验证到锁外，没有引入新的 GC 保护竞态。负载结果和适用边界见 [批量实施结果](mindos-node-sync-architecture-review.md#12-发现索引与性能批量实施结果)。
