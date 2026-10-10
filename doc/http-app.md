# HTTP 存储应用

`apps/http-app` 是独立 Node.js 应用，复用 Web 的完整 MindOS UI。既有 CLI `-d` 仍保持原来的服务端 Runtime/remote UI 模式，详见 [CLI HTTP 模式](http-mode.md)。

```text
Browser: MindOS UI → createApplicationRuntime → VFS → HttpStorageBackend
                                                     ↓ HTTP /api/vfs
Node.js: static index.html + StorageApi → LocalFSBackend → files + SQLite
```

浏览器不使用 Tauri IPC，也不装配 LocalFS 的 Node fallback。Node.js 仅管理存储、HTTP 监听和静态文件，不初始化 MindOS Session/Kernel。模型请求、页面状态、Kernel 和数字分身在线调度属于浏览器运行时。

## 启动与路径

```bash
pnpm --filter @itookit/http-app dev --host 192.168.31.10 --port 2000 --root ./mindos-data
```

`dev` 构建静态 UI 后运行 TypeScript 服务端，不提供热更新。发布使用 `build` 后 `start`；完整参数见 [app README](../apps/http-app/README.md)。默认仅监听 `127.0.0.1`，绑定局域网地址后，同一网络能访问该地址的客户端具有数据读写权限。当前未实现账户和多租户隔离。

`--root` 是 VFS 数据根；相对路径按 `INIT_CWD`（缺失时进程 cwd）解析。默认 `<启动目录>/.mindos-http`。存储内部路径 `/home/admin/...` 始终相对于该根，不保存当前服务器机器的绝对路径。SQLite 默认 `<root>/_meta/index.db`；允许显式指定根目录外的 `--sidecar`。已有外部项目的绝对路径仍表示原宿主资源，不能直接改成相对路径推断另一份数据；未装配的来源保留引用并标记不可用。

`/_meta` 和 `/__vfs_namespace_journal__` 不在 HTTP 可访问命名空间。路径拒绝 `..`、反斜杠、控制字符与符号链接；根目录不可删除或重命名。静态文件只来自 `--static` 或构建输出 `dist`，文本资源支持 gzip。跨来源浏览器请求被拒绝，API 不发送 CORS 开放头。

## 存储协议

`POST /api/vfs`，`Content-Type: application/json`：

```json
{"method":"stat","args":["/home/admin/minds/example.md"]}
```

成功返回 `{"result": ...}`；失败返回 `{"error":{"code":"ENOENT","message":"..."}}`，客户端恢复为 `FSError`。文件内容使用 base64，避免数字数组的体积膨胀。API 支持文件 stat/list/mkdir/read/write/delete/rename、元数据与标签，以及 RecordStore 的批量读取、分页、查询和更新。

方法通过白名单分派，不暴露 SQL、SQLite 连接、任意命令执行或 `__tauri/invoke`。`HttpStorageBackend` 不声明后端未实现的搜索、符号链接、通用文件事务或条件 replace 能力。

## 跨 SeqFile 事务

`records.transaction(callback)` 使用乐观并发控制：

1. 读取记录或分页时保存观察结果；批量读取只发一个请求。事务内写入缓存在客户端，后续读取与枚举可见这些写入。
2. 回调成功后，通过一个 `records.commit` 请求提交所有观察及变更。
3. 服务端在 LocalFS 原生 SQLite 事务中重新读取观察，发现记录修改或范围新增/删除就返回 `ECONFLICT`。
4. 校验全部通过后，跨多个 SeqFile 的所有变更在同一个 SQLite 事务中提交。失败不写入其中任何一个文件的记录。

只读事务也执行最终校验。HTTP 读请求之间不持有 SQLite 锁；回调异常时不发送提交。客户端不自动重试回调或提交：网络中断时提交结果可能未知，业务通过自己的持久回执核对。事务操作只有记录，不包括普通文件字节修改或元数据修改。该并发语义适用于通过同一 LocalFS 数据库访问的写入，不协调绕过 VFS 手工修改文件的进程。

默认分页上限与单批记录数上限为 10000，单次请求/JSON 响应上限 32 MiB，超限返回 `EFBIG`。事务中对已修改范围枚举，需要合并原范围与缓存变更，该范围超过 10000 项时拒绝执行；普通有界分页直接调用 LocalFS 的页读取接口。初版仍会为顺序读取产生 HTTP 往返，没有把完整应用启动合成一个远程 RPC；性能需根据实际网络延迟和 profile 规模评估。

## 验证

`apps/http-app/tests/storage.test.ts` 使用真实 Node HTTP、LocalFS 和 SQLite：二进制内容/范围读取、元数据/标签、含记录的文件重命名、null 与缺失值、跨文件提交、回调回滚、并发修订与范围 phantom 冲突、事务内 Unicode 字段排序、目录边界和跨来源请求，以及完整应用 Runtime 启动并重开个人项目。

本轮真实 Chrome 验收覆盖局域网普通 HTTP（非安全上下文）启动、无 Tauri shim、Markdown 编辑落盘、新会话及刷新恢复。初始完整 UI 构建、原 Web app 构建、相关类型检查、架构边界、文档与样式检查均通过。
