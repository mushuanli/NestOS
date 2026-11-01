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

- v15 的 ViewUpdateReads 按浏览器视图隔离大通知读取，超过 64 KiB 的包不直接进入 SSE；32 项 / 32 MiB / 60 秒有界保留，释放视图清空。updates-read 只读取原准备结果，认证、clientId 和协议检查保持；缺失标记视图过期。审计不得包含正文。

- runtime/tool-connections 按用户私有 authDir 保存外部工具连接，目录 0700、文件 0600；Tool 工厂接收用户绑定的 register/resolve，RPC 仅提供脱敏列表及保存/删除，禁止通过模型参数或全局环境账号选择用户。组织空间不共享个人凭据。

- 工具包 manifest.flows 是包内相对路径声明，随工具代码计入快照指纹；读取只接受已注册精确版本，不执行工具工厂。工具面板通过通用 installFlows 入口安装和发布资源；业务 Flow 留在外部包。

- 工具包根目录 guide.yaml 是只读使用指南，宿主校验后通过 ToolPackageInfo.guide 投影；catalog 同版本优先、已安装副本兜底。文档不列入运行 files、不改变执行指纹，错误独立为 guideError；禁止执行示例命令或记录 YAML 正文。

- toolbox.yaml 声明预装和可配置普通参数；启动先预装并向已有同版本包分发声明，再为每个用户绑定默认停用的 Tool。用户设置位于私有 authDir/tool-preferences，configure 只接收包身份和普通设置；实际 Schema 校验与原子保存，参数值、YAML 正文不进日志。Flow ensure 不改变用户启用状态。

toolbox.yaml 的普通参数可声明 connectionType；工具包配置投影当前用户同类型连接为可选项，唯一连接提供默认建议，多个连接不猜测账号。UI 保存后才成为用户参数覆盖；参数 Schema 的默认值另行展示，空值继续继承运行时默认。配置字段不投影 Secret。

- terminal/ 只为 HTTP 管理员认证视图提供服务器 Bash PTY，经 ServerTerminals/ServerTerminal 契约开放。每视图最多两个进程，输出有界；视图与编辑器销毁释放 PTY，输入从不自动重放。普通用户不获得此能力；日志不包含命令、输出或环境值。定向回归为 http-app 的 server-terminal 与 view-api 终端场景。

- 工具包显式 switchVersion 为即时切换：按共享注册锁准备所有用户实例、持久入口与同步目录发布；稳定执行代理在业务调用前写入 Task 实现引用，旧调用/重试/核对按原指纹恢复。缺少历史绑定拒绝猜测，提交结果未知时暂停新准入并按 activationId 核对。二进制热升级要求新旧包 executionEnvironment:instance，通过工厂 executables 映射实例隔离；旧进程环境绑定变化明确拒绝。
