# @itookit/http-app

独立 Node.js 应用宿主。服务端持有 ApplicationRuntime，浏览器通过 ApplicationPort 展示和控制。

- `src/server/` 装配 LocalFS、Node SQLite 和静态 UI；装配唯一应用 Runtime；浏览器不能再装配另一套执行 Runtime。
- `src/client/` 不导入 Node、LocalFS、Tauri。Web UI 经 mind-os 的公开入口导入。
- 对外 API 暴露应用查询、命令、回执和事件，不提供 SQL、任意宿主路径、原始托管状态写入或 Tauri invoke；原始 VFS 存储协议仅用于内部监听。
- SeqFile 事务缓存写入，服务端在同一原生事务中先校验读观察再批量提交。不可把跨文件事务改成逐条非原子写入，不自动重试回调或结果未知的提交。
- `_meta` 和 LocalFS rename journal 是宿主内部路径，不向客户端暴露。

- 根目录 `pnpm httpd` 启动；默认读取共享 `mindos.json`（遵循 XDG_CONFIG_HOME），数据根优先级为 --root → MINDOS_ROOT → rootDir → 配置目录/data。
- 对外默认 HTTPS 0.0.0.0:2000，TLS 强制验证客户端证书和 clients.json 的 SHA-256 指纹；不能提供无认证降级。VFS 独立监听 127.0.0.1:2001，并要求每次启动生成的内部凭据，浏览器只访问对外入口。
- 证书、CA 私钥、浏览器导入包及审计日志必须保存在 VFS 数据根之外；证书不能置于静态目录。日志仅记录认证与请求元数据，不记录请求头、参数、文件正文、模型消息和密钥。
- `audit-log` 的 JSONL 文件权限 0600；每份 10 MiB，保留当前及 3 份轮转记录。客户端证书撤销在下一次 HTTP 请求重新核对，包括已有连接。

验证：`pnpm --filter @itookit/http-app test`、`typecheck`、`build`。
