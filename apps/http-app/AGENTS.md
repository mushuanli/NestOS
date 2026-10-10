# @itookit/http-app

独立 Node.js HTTP 存储宿主。浏览器通过 IStorageBackend 复用 MindOS Web UI。

- `src/server/` 装配 LocalFS、Node SQLite 和静态 UI；不能装配第二套应用 Runtime。
- `src/client/` 不导入 Node、LocalFS、Tauri。Web UI 经 mind-os 的公开入口导入。
- API 只暴露 VFS 存储操作，不提供 SQL、任意宿主路径或 Tauri invoke。
- SeqFile 事务缓存写入，服务端在同一原生事务中先校验读观察再批量提交。不可把跨文件事务改成逐条非原子写入，不自动重试回调或结果未知的提交。
- `_meta` 和 LocalFS rename journal 是宿主内部路径，不向客户端暴露。

验证：`pnpm --filter @itookit/http-app test`、`typecheck`、`build`。
