# 同步宿主适配

同步核心仍是独立的 `@itookit/vfs-sync`。本包实现平台存储与 pi-agent 协议，不把同步策略放进 VFS 驱动。

| 共用实现 | 职责 |
| --- | --- |
| `src/shared/control.ts` | SeqFile 状态读取、校验、原子更新与计划持久化 |
| `src/shared/records.ts` | 绑定 schema、路径限制、便携计划序列化 |
| `src/shared/coordinator.ts`、`src/shared/lease.ts` | 租约准入、续租、释放、递增 fence 和所有权判断 |
| `src/shared/local.ts` | 快照缓存、对象、计划及 FileLocal 端口 |
| `vfs-sync`、`http/client.ts` | 三方规划、发布／回执恢复、远端协议 |

浏览器入口 `@itookit/sync-adapters` 提供 IndexedDB 实现，不加载 Node 模块。Node/POSIX 本地目录入口单独放在 `@itookit/sync-adapters/local`；Tauri 的 IPC 文件端口尚未接入此 Node 入口。

```ts
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { LocalSyncStore, createLocalSyncSession } from '@itookit/sync-adapters/local';

const backend = await openLocalFSBackend({
    rootDir: '/absolute/storage',
    sidecarDir: '/absolute/metadata',
    durability: 'full',
});
// 首次绑定由宿主准备 SyncState，并调用 new LocalSyncStore(...).initialize(state)。
// 服务器准备仍复用 prepareProjectSync；remote 实现 FileRemote。
const sync = createLocalSyncSession(backend, bindingId, remote, {
    scope: { includes: [''], excludes: ['.mindos'], propagateDeletes: false },
});
const preview = await sync.preview();
await sync.execute(preview.id);
await sync.recover();
```

两端使用 `/var/lib/sync/<bindingId>/state.seq`，字段和 opSeq 语义一致；`coordination.seq` 是当前设备的本地协调记录，不上传服务器。

IndexedDB 在一个原生事务中提交文件、基线和应用证据。local 的普通文件与 SQLite 分开：先在 FULL 事务中保存 `applyPending` 意图，再按资源保留原文件、安装内容并 fsync，随后在同一 SQLite 事务推进对应资源基线及 journal 进度。完成后保存 `apply:<id>`。中断后，原文件身份和新文件的 inode/dev 证据用于恢复；同 inode 的后续正文编辑被保留为新变化。原内容及安装阶段内容保存在 `journal/<id>/`，首版保守保留，尚不自动清理这些文件。

普通文件使用独占硬链接安装，目标已出现时不会覆盖；删除目录前检查完整子树及排除项，替换前保存原文件。捕获输入包含正文摘要、inode/dev、mtime、权限与 sidecar 元数据，项目根目录也校验身份。扫描失败与不支持的文件保持未知／不可同步，不能推导删除。SeqFile 正文需要领域同步，不上传其空占位文件。

准确边界：支持 Node/POSIX，同步工作目录和 journal 必须处于同一文件系统，拒绝符号链接、sidecar 位于同步范围内、NORMAL/未知提交持久性。持久目录创建与 SQLite 提交之间若崩溃且无法确认归属，或外部编辑器原子替换目标导致证据歧义，保持 `LOCAL_APPLY_AMBIGUOUS` 和全部内容，不猜测终态、不推进未确认资源基线。外部程序持有旧文件句柄持续写入时，租约无法阻止它；宿主应协调活跃编辑／执行者，备份内容不自动删除。

Native 文件与 SQLite 事务由同一个 sidecar 写锁协调，事务中检查全部租约守卫；跨进程接管不能绕过仍由活进程持有的 SQLite 写锁。FULL 模式的忙锁等待通过异步重试进行，避免同一 Node 进程的第二个连接阻塞第一个连接的异步提交。

验证：`pnpm --filter @itookit/sync-adapters test`，含 IndexedDB/local 的真实 pi-agent 互通、SIGKILL 恢复及租约接管。进程故障测试不等同于实际断电或硬件故障验收。
