# @itookit/http-app

独立 Node.js 应用宿主。服务端持有 ApplicationRuntime，浏览器通过共享服务端口展示和控制，完整复用 app-shell.initApp。

- `start-host.ts` 必须等待 server 策略的 ApplicationRuntime 初始化成功后再 listen；失败清理全部资源且不开放端口。MCP 首次连接尝试可失败降级，不能吞掉本地初始化错误后仍声称 ready。
- `src/server/` 装配 LocalFS、Node SQLite 和静态 UI；装配唯一应用 Runtime；浏览器不能再装配另一套执行 Runtime。
- `src/client/` 不导入 Node、LocalFS、Tauri。Web UI 经 mind-os 的公开入口导入。
- 对外 API 暴露应用查询、命令、确认和事件，不提供 SQL、任意宿主路径、原始托管状态写入或 Tauri invoke；没有原始 VFS 存储 HTTP 协议。
- application/ 绑定统一应用门面、能力描述与共享 selector；rpc/ 通过注入获得描述，不导入业务模块。协议 v9 拒绝旧客户端。
- bootstrap 不预开文件系统，主题与 UI 状态经文档端口读取；OCR、设置、恢复与聊天能力按消费创建。设置工作区以声明身份传递，后端按需解析并保持写权限保护，不能通过延迟视图绕过托管状态命令。
- bootstrap 安装后才消费 SSE；资源释放回收独占句柄和订阅，共享句柄保留，回调能力按借用寿命释放。
- 查询、订阅装配分别有界合并；写命令独立确认。快照按资源事件失效，未知写操作保留域失效兜底，通知批次保持顺序，版本补丁不得覆盖新状态。二进制通道仍使用已授权的文件视图句柄。
- SeqFile 事务缓存写入，服务端在同一原生事务中先校验读观察再批量提交。不可把跨文件事务改成逐条非原子写入，不自动重试回调或结果未知的提交。
- `_meta` 和 LocalFS rename journal 是宿主内部路径，不向客户端暴露。

- `pnpm httpd:build` 生成独立 release；根目录 `pnpm httpd` 直接运行选定 release，`pnpm httpd:dev` 默认端口 2001、独立数据/凭据/日志；默认读取共享 `mindos.json`（遵循 XDG_CONFIG_HOME），数据根优先级为 --root → MINDOS_ROOT → rootDir → 配置目录/data。
- 对外默认 HTTPS 0.0.0.0:2000，TLS 强制验证客户端证书和 clients.json 的 SHA-256 指纹；不能提供无认证降级。只保留一个 HTTPS 监听；LocalFS/SQLite 由 Runtime 直接使用，--internal-port 已移除。
- 证书、CA 私钥、浏览器导入包及审计日志必须保存在 VFS 数据根之外；证书不能置于静态目录。日志仅记录认证与请求元数据，不记录请求头、参数、文件正文、模型消息和密钥。
- `audit-log` 的 JSONL 文件权限 0600；每份 10 MiB，保留当前及 3 份轮转记录。客户端证书撤销在下一次 HTTP 请求重新核对，包括已有连接。

- `provider-auth/` 持有 OAuth 的 loopback 回调、PKCE/OIDC 校验和私密令牌；仅安全状态及命令通过应用能力描述公开，禁止公开 credentials、令牌或私有存储。

验证：`pnpm --filter @itookit/http-app test`、`typecheck`、`build`。

- 通知只运行一个刷新循环，256 条限制包含处理中和等待中的回调；客户端通知缓存有界。查询每批最多 32 项、最多 2 批在途、队列最多 1024 项。
- 应用层决定只读命令、消息投影和快照结果引用；rpc 层只实现注入规则、不可变 DTO 编码缓存及版本补丁。静态 hash 资源私有缓存，HTML 重新验证；压缩结果最多 64 项 / 16 MiB。

- workbenchView、openSessionView/activate 和 UI 文档端口由后端聚合；连接检查按观察兴趣共享，不由浏览器逐项目轮询。application.complete 只记录注册能力/方法和批次数，不记录参数或用户内容。

- navigationView 聚合普通模块首层、忽略规则和 UI 文档；warmNavigation 仅预热最多两个授权根的只读元数据。二者为 query，不触发写域失效，不创建独占资源。文件事件使有界后端缓存失效，前端一次消费后使用实时端口。
