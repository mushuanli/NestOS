# @itookit/node-host

CLI 与 httpd 共用的 Node 宿主适配包，不是业务策略层，不导入 UI。

- runtime/ 统一装配 app-core 和生命周期；公开 openNodeApplication。存储借用与所有权必须显式，先关闭视图、Runtime，再释放授权、日志、存储与锁。
- runtime/tool-modules 只按可信宿主环境 NESTOS_TOOL_MODULES（绝对模块路径 JSON 数组）加载外部 createTools 工厂；提供 Tool/Zod 构造 API，经 additionalTools 注入。核心不按业务名加载包。CLI 和 HTTP 共用该加载入口；模型输入不能修改模块路径。
- runtime/tool-packages/ 从可信 NESTOS_TOOL_PACKAGE_DIRS（绝对目录 JSON 数组）或 INIT_CWD/tools 读取 nestos-tool.json，只按逻辑工具 ID 与版本解析依赖。module/files/default executable 都是包内相对路径，拒绝穿越和符号链接；优先复用显式执行文件环境、PATH 命令或包内已有产物，不下载或编译。运行包位于 XDG_DATA_HOME/nestos/tools/<id>/<version>（默认 ~/.local/share/nestos/tools），XDG_CONFIG_HOME/nestos/tool-packages.json 仅保存注册元数据；配置目录不保存模块或可执行文件。
- 工具包安装按包串行、同版本幂等；指纹涵盖清单、运行文件及实际复制的二进制，已有内容和版本冲突明确报错。注册元数据使用跨进程 SQLite OS 锁、锁内重读合并及原子替换，崩溃不留下进程锁；当前 catalog 和已创建/未来 Session 通过 kernel.registerTools 热更新。旧 NESTOS_TOOL_MODULES 同工具版本复用已有实例，停用工具不自动启用；factory 只临时注入执行文件环境，成功注册持有绑定租约，失败或宿主销毁恢复原绑定，不允许跨包替换已有执行文件绑定。
- NodeToolPackages 在 createNodeRuntime 创建应用前恢复已登记工具，并在 kernelPlatform.configure 中绑定注册器，早于 Flow 安装/系统恢复；保留原 configure 与运行时释放顺序。工具包日志只记录操作、阶段、结果、安全错误分类、数量与耗时，不记录路径、环境值、工具参数或清单正文。定向回归：pnpm --filter @itookit/cli exec vitest run --root ../node-host tests/tool-packages.test.ts。
- storage/ 只适配 Node SQLite、LocalFS 和主机锁；保留 httpd-host-lock.sqlite 文件名兼容旧宿主。
- authorization/ 私密凭据、OAuth loopback 与 PKCE/OIDC；凭据不得进入应用服务图、VFS、静态目录或日志。
- logging/ 审计只写操作元数据；日志路径/模式由宿主入口选择。
- SSE 按视图保留最多 256 帧 / 2 MiB 内存事件日志；恢复请求必须匹配证书、已有初始化视图、协议版本及保留序号，不能为过期句柄创建新视图。回调超时或流过载使该视图失效；事件日志不跨 daemon 重启，不提供写命令重放。
- http/ 只处理 mTLS、能力 API、SSE 和静态文件；应用 server readiness 成功后才 listen。
- HTTP 退出先结束 SSE、停止接入并等待连接排空，5 秒后关闭残留 HTTP 连接，再释放视图、Runtime、存储和锁；不能因客户端未结束请求而无限持锁。进程名可能为 node/node-MainThread，定位 httpd 应匹配完整命令行。
- client/ 为共享传输注入 Node mTLS fetch；必须验证证书，不跟随跨地址重定向。
- 项目、会话、配置、授权规则位于 app-core；宿主不复制策略。通过本包公开子入口引用，测试位于 apps/http-app/tests 与 apps/cli/tests。

- JSON 应用请求通过 requestId 关联 bodyReadMs/viewReadyMs/rpcMs/responseFlushMs 四段耗时；flush 只表示 Node 提交后至 finish/close，不表示浏览器接收完成，不记录正文或参数。
- 应用审计使用实际命令注册目录记录 rpcCommands，用 rpcErrorCount/rpcErrorCodes 记录 HTTP 200 内的业务失败。输入图片仅记录 MIME/字节元数据；错误回复附加 HTTP requestId 供前端关联，绝不记录图片、文件名或原始异常正文。

- v14 bootstrap 可携带 initialView 与 knownSnapshots；view-bootstrap 先打开目标并登记观察，再导出能力图。纯数据缓存归 ViewApi，不能缓存或复用其他视图的能力句柄；bootstrap-data 只重读当前客户端的已准备响应，绝不重新激活。bootstrap 也记录 rpcMs 与 application.complete。
- 通知刷新、序列化或输出失败时，关闭通知队列并使事件日志失效；不得丢弃已出队应用事件后继续发送下一序号。客户端随后按视图过期提供重载入口，不能重放业务写命令。

httpd 仅在 http.editorSwap=true 时装配 EditorSwapStore，默认 ~/swap；不开放到 VFS/静态目录。每个编辑器独立 0600 swap，修改防抖写入，>=512KiB 不写；正常关闭删自己的文件，句柄断连 dispose 保留异常残留。启动和每小时清理本数据根作用域下更新超过48小时的文件。原始存储只由后端用例通过受限文件能力创建句柄，不进入公共服务图，日志不记录正文或路径。

- http/user-host 按 mTLS 登记的 userId 选择 Runtime/ViewApi；http/user-application 组合用户数据包和共享定义。禁止从 body、query、clientId、证书 CN 或 X-NestOS-User 选择用户目录；该请求头只用于拒绝身份变化。
- storage/UserFiles 将逻辑 /home/admin 映射到当前物理 home，其他状态及统一 sidecar 位于 .nestos；顶层 .nestos 永不进入用户文件能力。保持单用户记录事务，不把项目正文与 /var/lib 拆成不同 backend。home 中的项目内部 .nestos 仍为原有合法布局。
- 总审计的请求/业务事件带 userId，用户初始化、共享配置、存储就绪、关闭和离线导入事件带 operationId、stage、result、code、durationMs；HOST_LOCK_BUSY 和 CLIENT_POLICY_INVALID 必须保留分类，不记录正文、参数或凭据。
