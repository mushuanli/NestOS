# IndexedDB 同步适配

通过 `@itookit/sync-adapters` 开放，依赖 vfs-sync 契约与 IndexedDB 驱动公共存储端口。驱动不得反向依赖本包。业务比较与恢复编排归 vfs-sync，项目接入策略归 app-core。

- IndexedDB 控制状态使用 `/var/lib/sync/<bindingId>/state.seq`，复用既有 nodes/records，不创建同步专用表。
- SeqFile 字段使用可序列化值；快照二进制显式编码，不依赖 IndexedDB 专属 structured clone 格式。
- 文件、baseline 与应用证据在同一原生事务提交；事务中不做网络或摘要运算。
- 控制记录缺失必须拒绝执行旧计划，不能自动创建空 baseline。
- 默认使用 coordination.seq 持久租约与递增 fence；每次受保护读写须在同一原生事务核对全部守卫，旧任务不能写入。
- Web Locks 可显式选用；默认协调器不依赖安全上下文。浏览器持久存储状态属于宿主能力，不进入 app-core 或 vfs-sync。

运行 `pnpm --filter @itookit/sync-adapters test` 和 `typecheck`。
