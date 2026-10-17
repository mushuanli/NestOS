# @itookit/node-host

CLI 与 httpd 共用的 Node 宿主适配包，不是业务策略层，不导入 UI。

- runtime/ 统一装配 app-core 和生命周期；公开 openNodeApplication。存储借用与所有权必须显式，先关闭视图、Runtime，再释放授权、日志、存储与锁。
- storage/ 只适配 Node SQLite、LocalFS 和主机锁；保留 httpd-host-lock.sqlite 文件名兼容旧宿主。
- authorization/ 私密凭据、OAuth loopback 与 PKCE/OIDC；凭据不得进入应用服务图、VFS、静态目录或日志。
- logging/ 审计只写操作元数据；日志路径/模式由宿主入口选择。
- SSE 按视图保留最多 256 帧 / 2 MiB 内存事件日志；恢复请求必须匹配证书、已有初始化视图、协议版本及保留序号，不能为过期句柄创建新视图。回调超时或流过载使该视图失效；事件日志不跨 daemon 重启，不提供写命令重放。
- http/ 只处理 mTLS、能力 API、SSE 和静态文件；应用 server readiness 成功后才 listen。
- HTTP 退出先结束 SSE、停止接入并等待连接排空，5 秒后关闭残留 HTTP 连接，再释放视图、Runtime、存储和锁；不能因客户端未结束请求而无限持锁。进程名可能为 node/node-MainThread，定位 httpd 应匹配完整命令行。
- client/ 为共享传输注入 Node mTLS fetch；必须验证证书，不跟随跨地址重定向。
- 项目、会话、配置、授权规则位于 app-core；宿主不复制策略。通过本包公开子入口引用，测试位于 apps/http-app/tests 与 apps/cli/tests。
