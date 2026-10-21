# VFS 虚拟文件系统设计

2026-09-09 按当前源码同步。本文描述通用 VFS 实现；Session 数据组织、权限配置与平台装配以 [C4 规范](vfs-c4-review.md)、[挂载规范](vfs-session-mount-access.md) 为准。旧模块注册、inode 三层 Store、ChatFileHandle 和兼容迁移均已删除，不是当前接口或待实施方案。

## 1. 分层与所有权

消费方使用 `FileSystemContext` 中的 `IFileSystem`，只拥有指定视图内的文件能力。宿主创建来源、组合挂载和管理生命周期。Session 文件视图、普通文档视图复用同一个通用实现，业务历史与 Kernel 账本通过各自服务访问。

| 层 | 当前实现 | 职责 |
| --- | --- | --- |
| 协议 | `https://github.com/mushuanli/vfs-core/blob/main/src/interfaces`、`protocol.ts` | 文件、元数据、backend、事件和能力类型 |
| 宿主 | `impl/factory.ts`、`services/VFSManager.ts` | 根 backend、挂载、设备、插件和销毁 |
| 受限视图 | `services/FileSystemView.ts` | 固定 revision 的目录组合、权限、返回值和事件过滤、撤销 |
| 来源 | `services/FileSystemSource.ts` | 将宿主已授权的 backend 包装成来源，拥有其生命周期 |
| 内部目录适配 | `DirectoryFS.ts`、`DirectoryDriver.ts`、`DirectoryContext.ts`、`ScopedView.ts` | 单目录坐标转换，委托引擎和能力类 |
| 引擎 | `impl/engine/vfs-engine.ts` | 系统路径 CRUD、backend 路由与设备分派 |
| 能力 | `impl/capabilities` | assets、tags、SeqFile 和 refs |
| 文件对象 | `impl/file-io` | IFile/IMDXFile 轻量路径句柄 |
| 后端 | Memory、IndexedDB、LocalFS | path-based 文件及记录存储 |

协议与实现的导出分别见 [protocol.ts](https://github.com/mushuanli/vfs-core/blob/main/src/protocol.ts) 和 [index.ts](https://github.com/mushuanli/vfs-core/blob/main/src/index.ts)。可信宿主可使用 manager/backend；这些管理对象不注入普通 Session 工具或编辑器。

## 2. 消费接口

完整声明见 [file-system.ts](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/services/file-system.ts)。

```ts
interface IFileSystem extends FSEventEmitter {
  readonly viewId: string;
  readonly revision: number;
  readonly capabilities: FSCapabilities;
  readonly driver: IFSDriver;
  readonly meta: IFSMetaDriver;
  /** 宿主外部目录打开的视图：不暴露也不持久化标签元数据 */
  readonly external?: boolean;
  openFile(path: string): IFile;
  capabilitiesAt(path: string): Promise<FSCapabilities>;
}
interface FileSystemContext {
  readonly fs: IFileSystem;
  readonly cwd: string;
  readonly sessionId?: string;
}
interface FileSystemContextOwner {
  readonly context: FileSystemContext;
  release(): Promise<void>;
}
```

路径是视图内的绝对 POSIX 路径。禁止 `..` 段、反斜线、NUL 和隐式宿主路径转换；不能使用 basename 搜索替代精确路径读取。`viewId` 标识视图，`revision` 标识本次配置；文件句柄的身份字段是 `path`，不是文件 ID 或模块 ID。

[IFSDriver](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/services/fs-driver.ts) 提供：

- 读取：getNode、getChildren、readContent、resolvePath、exists、search，可选 walkTree/getStats。
- `getChildren({ fields: 'entry' })` 经可选后端 listEntries 获取轻量条目，不强制读取扩展元数据；后端未实现时回退完整列表并裁剪。`readContent` 的 representation 为 auto（兼容记录投影优先）、bytes（物理内容）、records（仅记录投影）。普通配置读取显式选择 bytes；底层读取失败传播错误，不能伪装为空文件。见 [读取性能与架构审查](vfs-read-performance-review.md)。
- 修改：createFile/createDirectory、writeContent/appendContent、rename/move/delete、updateMetadata，可选 copy。
- 链接及事务：symlink/readlink/hardlink、transaction 方法存在，但可因当前能力不支持而拒绝。
- 事件：on、可选 onAny，取消订阅函数由调用方持有。

```ts
const { fs } = context;
const node = await fs.driver.createFile({
  name: 'todo.md', parentPath: '/notes', content: 'hello',
});
await fs.driver.writeContent(node.path, 'updated');
const file = fs.openFile(node.path);
const content = await file.read();
```

`FSNode` 是 file/directory/seqfile/device/symlink 判别联合，包含 path、parentPath 等公共字段。backend 本地路径、系统路径和视图路径必须在所属层转换，不能混用。

## 3. 组合视图与来源

```ts
const source = await createFileSystemSource({
  backend: authorizedBackend, viewId: 'project-source', access: 'rw',
});
const view = createFileSystemView({
  viewId: 'editor-files', revision: 1,
  mounts: [{
    mountId: 'project', at: '/workspace', fs: source.fs,
    root: '/', access: 'rw',
  }],
});
await view.driver.readContent('/workspace/README.md', { encoding: 'utf-8' });
await view.dispose();
await source.dispose();
```

`FileSystemMount` 包含 mountId、at、fs、可选 root 和 ro/rw。来源必须已经由宿主授权；构造视图不负责选择或授权任意本地路径。`createFileSystemView` 的选项除 viewId、可选 revision 与 mounts 外，还有可选 `tags`、`external`（宿主外部目录默认不暴露也不持久化标签元数据）和 `readablePaths`。

`FileSystemView` 的实际规则：

1. 挂载按最长路径前缀选择；可有根挂载，其他挂载不可重复或相互嵌套。同一来源的重叠根只要涉及写权限就拒绝，避免可写别名绕过。
2. 无真实根时合成 `/` 和挂载祖先目录。挂载点、合成目录及被其他挂载覆盖的路径不能当作普通节点修改。
3. 内容、metadata、assets、records、refs、搜索和事件共用路径/权限检查。返回节点及事件转换为当前虚拟路径，过滤来源外及被遮蔽的对象。
4. `readablePaths` 可进一步限制可读子树，祖先仅作为导航目录可见。它由宿主设置，不是调用方可扩权的参数。
5. 当前组合视图禁用 symlink/hardlink/device/watch，并拒绝 IO 路径中的链接。底层来源支持链接不等于 Session 可以使用链接。
6. `capabilities` 是保守汇总；异构挂载需查询 `capabilitiesAt(path)`。seq/refs facade 在组合视图中存在，具体操作仍可能因来源不支持而失败，不能只检查属性存在。
7. `dispose()` 立即关闭新入口、取消订阅并等待在途操作完成。旧 IFile 和派生视图继续调用会失败；dispose 不删除数据或销毁共享来源。

`createFileSystemSource()` 创建私有内存根，再将外部 backend 挂到 `/source`；bootstrap 的 `/etc`、`/dev` 不写入用户项目目录。返回的 owner 最终关闭来源 backend。应用关闭须先释放消费者，再释放来源。

内部 `DirectoryFS` 是可信目录适配器，`ScopedView` 只进行目录坐标转换；它不是独立授权服务。宿主不得将原始系统目录适配器交给受限 Session 来替代组合视图。

## 4. 宿主与系统目录

[IVFSManager](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/services/vfs-manager.ts) 提供 initialize/dispose、openFileSystem(rootPath)、mounts/devices/plugins，以及明确的设备与系统操作。没有模块注册表、getEngine 或全局便捷读写接口。

`createVFS()` 的顺序：创建引擎 → 注册插件 → 创建 manager 并初始化根 → 注册 null/zero/random 和自定义设备 → 挂额外 backend → 从 `/etc` 创建 ConfigService → 写入缺省初始配置。失败时清理 manager；返回 `{ manager, config }`。

VFS 基础系统保留目录为 `/etc`、`/dev`。`/var/lib/kernel`、`/var/lib/sessions`（含跨 Session 的 `folders.seq` 文件夹索引）、`/home/admin` 和易失 `/run` 由平台/应用启动装配，不能把完整 MindOS 布局归因于 VFS 工厂。

Session 默认只暴露 `/attachments`，显式授权后增加 `/workspace` 等根下一层挂载。history、credentials、Kernel 记录不投影到用户文件上下文。Session 配置 CAS、draining 状态下重启后的拒绝访问和任务执行期间禁止重配由 `app-core` 的 SessionFilesService 管理（`backend/app-core/src/vfs/session-files.ts`，app-shell 仅 re-export），详见 C4 规范。

## 5. Path-based 存储后端

完整接口见 [backend.ts](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/storage/backend.ts)。后端以自己的绝对路径为主键，不再有 IInodeStore/IMetaStore/IContentStore 或 mountId:ino 公共身份。

| 类别 | 方法或属性 |
| --- | --- |
| 结构 | stat、list、mkdir、delete、rename |
| 内容 | read → Uint8Array；write → FSNode |
| 元数据 | updateMetadata、setTags、getAllTags |
| 可选能力 | records、search、symlink/readlink、transaction |
| 生命周期 | init、close |

MemoryBackend 使用内存记录；IndexedDBBackend 使用 nodes/tags/records stores；LocalFSBackend 使用真实文件和 SQLite sidecar 元数据/records。LocalFS 的 `__tests__` 等目录保持原位置，不因名称前缀重定向到侧车。当前 IndexedDB schema 5 支持完整 v3/v4 数据库升级，补齐目录父路径和类型查询索引；更旧或缺失必需 store 的结构报错。SQLite schema 4 仍拒绝旧结构。

宿主 backend 挂载和用户视图挂载是两层路由。引擎将系统路径转换成 backend-local path；DirectoryContext/SeqFileOps 对 records 同样使用该 backend 的本地坐标。跨后端操作不能因为虚拟路径相邻而获得原子性。

没有 records 的目录来源不构造原生 seq/refs；ConfigService 可使用 JSON 文件。Kernel 必须要求真实的 transactionalSeqFiles，禁止用 JSON 整体覆盖降级成持久事务。

## 6. 文件事务与记录事务

两种事务不能互换：

| 接口 | 当前保证 |
| --- | --- |
| `driver.transaction(fn)` | 事件按提交重放/回滚丢弃；文件数据原子性取决于 backend，不凭函数名称保证回滚 |
| `FileSystemView.transaction(scopePath, fn)` | 宿主显式限定挂载；要求来源声明 atomicFileTransactions；跨挂载拒绝 |
| `meta.seq.transaction(fn)` | 同一受支持 records backend 内跨 SeqFile 的读写、CAS、increment、append 原子提交 |

当前 Memory/IndexedDB/LocalFS 的普通文件 transaction 包装不提供跨操作文件 ACID；组合视图会拒绝不具备 atomicFileTransactions 的来源。底层单次 IndexedDB 操作的事务不等于多次文件操作的共同事务。

SeqFile 事务只操作记录，不能混入普通文件写入并声称一起回滚。组合视图首次记录访问绑定事务来源，后续路径必须在同一挂载，并验证权限与生命周期。为避免 IndexedDB 在无关异步 IO 期间自动提交，事务内不做链接解析，支持链接的来源会被拒绝。

```ts
const seq = fs.meta.seq;
if (!seq?.transaction || !fs.capabilities.transactionalSeqFiles) {
  throw new Error('Transactional records are required');
}
await seq.transaction(async tx => {
  const accepted = await tx.compareAndSet('/state.seq', 'revision', {
    expected: '1', value: '2',
  });
  if (!accepted) throw new Error('Revision conflict');
  await tx.setEntry('/events.seq', 'event/2', JSON.stringify({ type: 'updated' }));
});
```

大文件/artifact 先写内容，再提交记录引用；记录回滚只可能留下未引用内容，不能保证文件也回滚。掉电持久性和进程故障验收由具体 backend/平台给出证据。

## 7. 附件、标签、记录和引用

[IFSMetaDriver](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/services/fs-meta-driver.ts) 聚合 assets/tags、可选 seq/refs/watcher。空附件/标签返回空值；能力不支持、越权、来源失效不能被包装成“没有数据”。

普通文档伴生目录为 `_report.md/`，首次 putAsset 按需创建；rename/move 默认跟随，delete 按 assetDirStrategy 处理。内部状态通过 metadata 标记，不能把所有下划线目录都当作任意可访问的附件。`IFile` 只有 read/write、readRaw/writeRaw、rename/copy/move/delete 以及 `asset()`/`listAssets()`/`hasAssetDir()`；putAsset/getAsset/getAssetDirPath/ensureAssetDir/listAssets/deleteAsset/removeAssetDir 属于 `IFSMetaDriver.assets`（`capabilities/asset-ops.ts`），不在文件句柄上。

Session 上传使用该 Session 的 `attachments/`，Round/history 存在业务记录中。普通文档 IMDXFile 附件模型继续使用，但不再存在 ChatFileHandle 或 `.chat` 文件身份。

搜索不直接返回 assetdir 内部命中：映射到可见宿主文件并去重。标签枚举、refs 两端和元数据返回都经过视图范围过滤；records 不能借原始路径访问相邻 Session 账本。

前缀约定为 `.` 隐藏、`_` 伴生目录、`__` 内部名称；默认列表依据 includeHidden/includeAssetDirs/includeInternalDirs 过滤。文件名规则拒绝空名、`.`/`..`、路径分隔符、超长名称和单下划线前缀，允许点和双下划线。前缀不是操作系统权限，也不存在“只有系统模块能创建点文件”的旧规则。

## 8. 事件、插件与设备

[FSEvent](https://github.com/mushuanli/vfs-core/blob/main/src/interfaces/core/events.ts) 携带 type/payload/timestamp，可附 fromTransaction、mountId、viewId、revision。载荷采用路径，不是旧 nodeId/parentId：

| 事件 | 主要载荷 |
| --- | --- |
| node:created / node:updated | nodes 数组，path 与 parentPath/type 或 changedFields |
| node:deleted | requestedPaths、allDeletedPaths |
| node:moved / node:renamed | nodes 数组，oldPath/newPath 与父路径或名称 |
| node:copied | copies 数组，sourcePath/targetPath/targetParentPath |
| seq:committed | paths 数组，记录提交后发出 |
| mount:added / mount:removed | mountPath、mountId |
| error | code、message、operation、path 等 |

事件在所属层完成写入后发出；记录回滚不发成功通知。事务事件缓冲在提交后逐条重放，回滚丢弃。视图订阅只投递获授权的映射事件，并添加本视图身份；来源挂载使用 mount:added / mount:removed，视图释放由其生命周期拥有者管理。

PluginPipeline 是可信宿主注册的中间件链。它按优先级执行 before/core/after，可修改参数、短路或调整结果。设备注册也属于宿主，manager.openDevice 返回独立句柄；流式设备使用 write/readStream/close。Session 文件视图禁用设备节点，LLM 等工具通过授权 adapter 调用。

ConfigService 使用注入的 `/etc` 来源，有 records 时用 `.seq`，否则 `.json`，提供 getString/getNumber/getBoolean/getJson、批量写入和 onChange。配置缓存和通知是服务本地机制，不能当作跨进程一致订阅协议。

## 9. 验证与未覆盖边界

当前测试位于 `https://github.com/mushuanli/vfs-core/blob/main/tests`：01–12 覆盖 CRUD、目录、assets/tags/refs/seq、链接、事务、搜索、事件、挂载和配置；18–22 覆盖 pipe、回归、组合视图、复制、归档与生命周期。IndexedDB 和 LocalFS 测试位于各自包，平台 Session 装配测试在 app-shell。

重点验收不止“能读写”：包括路径逃逸、只读写入、旧句柄撤销、来源关闭、records 坐标、事务回滚、搜索和事件信息泄漏、挂载覆盖及应用退出顺序。验证范围、命令及历史结果见 [实现状态](vfs-implementation-status.md)，当前结果以对应版本重新执行为准。

仍需独立验收或扩展的能力：完整原生进程隔离、真实 GUI/Tauri 全机编译、多宿主同时改挂载/历史、完整 Session/Kernel 系统备份及业务 GC。当前 watcher 类型保留，但 DirectoryFS 和组合视图未提供 OS 文件 watcher。普通文件跨操作原子事务也不能以现有透传实现宣称完成。


## 2026-09-14：跨宿主批量路径类型检查

VFS 的路径前缀检查使用不读取 sidecar 元数据的 getNodeType/statType，嵌套视图也保持该路径；同批前缀通过 Node statMany 或 Tauri fs_stat_many 读取，保留逐路径权限检查。宿主响应条数不匹配时拒绝所有等待者，单个链接不影响同批合法路径。

Node lstat 与 Rust symlink_metadata 保留符号链接/普通文件类型，Tauri 映射不丢字段，DirectoryDriver 不再把权限错误吞成空节点。真实文件系统回归复现了原先链接指向挂载根外文件并被读取的问题；修复后该视图读取被拒绝。此检查不构成抵御恶意并发替换路径的原子防护，也不替代原生进程沙箱。

读取与 rename journal 恢复仍处于同一事务；不使用实例内「日志曾经干净」作为跨进程跳过恢复的依据。真实两个进程覆盖读者先打开、写者在文件 rename 后 SIGKILL、原读者恢复目标记录的 root/module 两条路径。新增 sidecarStats 统计逻辑方法调用（含事务回调），不把该数字等同于真实 IPC 数。

本批完成批量类型检查、链接拒绝和跨进程恢复这条链；P0-02 的桌面 ≤2 秒 / ≤100 次 IPC 仍开放，需继续对正确实现减少宿主往返并重测。

隔离快照验证：VFS 175、LocalFS 69、Kernel 239、app-core 92、Tauri stat 映射 2、Rust 34 项通过，共 611 项；VFS/LocalFS/Tauri 类型检查、Tauri 前端构建与文档检查通过。未替代真实窗口及恶意路径替换竞态验收。


## 2026-09-14：跨宿主并发保存与编辑器失败重试

Node 使用 UUID + wx 独占创建临时文件，Rust 以 create_new 创建候选文件并跳过已占用名称；并发写入不共享临时文件，不覆盖其他写者的临时内容。写完后 rename 发布，失败清理本次临时文件，原目标保持。两端测试覆盖并发完整值与发布失败后的原内容/目录保留。

SaveManager 修复同步抛错后把已完成 Promise 留作正在保存、导致后续重试失效的问题；没有保存回调时最终保存直接返回并保留 dirty。真实 Node 文件写入接入 SaveManager 的回归覆盖：发布失败 → 原文件保留且 dirty → 编辑新内容 → 重试成功且 dirty 清除。

隔离快照：LocalFS 74、MDX 11、Rust 36 项测试通过，共 121 项；LocalFS/MDX/Tauri 类型检查、Tauri 前端构建与文档检查通过。P0-02 真实窗口保存失败/重试、其他平台行为与最终全仓验收仍开放；原子 rename 不代表断电 fsync 持久性。


## 2026-09-14：数据库初始化失败与定向释放

Tauri sidecar.close 显式传入当前 databaseUrl，避免无参数关闭所有池；初始化的 schema 读取、建表或版本检查失败统一释放本次池，失败与清理错误同时发生时保留 AggregateError 及原始 cause。事务内句柄不能关闭数据库池。通过真实 plugin-sql JavaScript 门面的宿主调用桩验证定向关闭、其他池继续可用及不兼容版本只关闭一次，不作为真实原生多池窗口验收。

LocalFS 不再把探针不可用、未知/空结果、普通探针关闭错误当成损坏。只在明确完整性诊断或 SQLITE_CORRUPT/SQLITE_NOTADB 时沿用重建流程，否则保留数据库文件并抛出原初始化错误。三个误删窗口修复前均实际导致测试文件被删，修复后保留；另补空结果边界，既有真实损坏数据库重建回归仍通过。

隔离 LocalFS 78、app-shell 193 项测试通过，共 271 项，另有 30 项既有跳过；LocalFS/Tauri 类型检查、Tauri 前端构建与文档检查通过。P0-02 真实窗口 Session 关闭/删除与故障恢复、完整持久性验收仍开放。
