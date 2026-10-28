# @itookit/http-app

HTTP 应用薄入口；Node 能力统一位于 apps/node-host，传输统一位于 shared/app-transport。服务端持有 ApplicationRuntime，浏览器通过共享服务端口展示和控制，完整复用 app-shell.initApp。

- `apps/node-host/src/http/start-host.ts` 必须等待 server 策略的 ApplicationRuntime 初始化成功后再 listen；失败清理全部资源且不开放端口。MCP 首次连接尝试可失败降级，不能吞掉本地初始化错误后仍声称 ready。
- `src/server/` 仅委托 node-host/http；node-host 装配 LocalFS、Node SQLite、静态 UI 与应用 Runtime（默认一个；--users-dir 时每用户一个）；浏览器不能再装配另一套执行 Runtime。
- `src/client/` 不导入 Node、LocalFS、Tauri。Web UI 经 nestos-web 的公开入口导入。
- 对外 API 暴露应用查询、命令、确认和事件，不提供 SQL、任意宿主路径、原始托管状态写入或 Tauri invoke；没有原始 VFS 存储 HTTP 协议。
- app-transport/application 绑定应用能力描述与共享 selector；app-transport/rpc 通过注入获得描述，不导入业务模块。协议 v15 拒绝旧客户端。
- bootstrap 不预开文件系统，主题与 UI 状态经文档端口读取；OCR、设置、恢复与聊天能力按消费创建。设置工作区以声明身份传递，后端按需解析并保持写权限保护，不能通过延迟视图绕过托管状态命令。
- bootstrap 安装后才消费 SSE；资源释放回收独占句柄和订阅，共享句柄保留，回调能力按借用寿命释放。
- 查询、订阅装配分别有界合并；写命令独立确认。快照按资源事件失效，未知写操作保留域失效兜底，通知批次保持顺序，版本补丁不得覆盖新状态。二进制通道仍使用已授权的文件视图句柄。
- SeqFile 事务缓存写入，服务端在同一原生事务中先校验读观察再批量提交。不可把跨文件事务改成逐条非原子写入，不自动重试回调或结果未知的提交。
- `_meta` 和 LocalFS rename journal 是宿主内部路径，不向客户端暴露。

- `pnpm httpd:build` 先自动执行增量 lib:build，成功后生成独立 release；库构建失败立即停止，构建不重启服务；根目录 `pnpm httpd` 直接运行选定 release，`pnpm httpd:dev` 默认端口 2001、独立数据/凭据/日志；优先读取启动目录的 `nestos.json`，缺失时读取共享 XDG 配置；不查找入口文件旁的配置，数据根优先级为 --root → NESTOS_ROOT → rootDir → 配置目录/data。
- 默认排查 release 日志 `/var/log/nestos/httpd.runtime.log` 和 `/var/log/nestos/httpd.audit.jsonl`；目录可由 `NESTOS_HTTPD_LOG_DIR` 覆盖，审计可由 `--audit-file` 覆盖。当前运行版本以认证后的 `/api/health` 返回值为准，`release/httpd/current.json` 仅选择下次启动版本。
- 对外默认 HTTPS 0.0.0.0:2000，TLS 强制验证客户端证书和 http.mtls.clients（未配置时兼容 clients.json）的 SHA-256 指纹；不能提供无认证降级。只保留一个 HTTPS 监听；LocalFS/SQLite 由 Runtime 直接使用，--internal-port 已移除。
- 证书、CA 私钥、浏览器导入包及审计日志必须保存在 VFS 数据根之外；证书不能置于静态目录。日志仅记录认证与请求元数据，不记录请求头、参数、文件正文、模型消息和密钥。
- `audit-log` 的 JSONL 文件权限 0600；每份 10 MiB，保留当前及 3 份轮转记录。客户端证书撤销在下一次 HTTP 请求重新核对，包括已有连接。

- `apps/node-host/src/authorization/` 持有 OAuth 的 loopback 回调、PKCE/OIDC 校验和私密令牌；仅安全状态及命令通过应用能力描述公开，禁止公开 credentials、令牌或私有存储。

验证：`pnpm --filter @itookit/http-app test`、`typecheck`、`build`。

- 通知只运行一个刷新循环，256 条限制包含处理中和等待中的回调；客户端通知缓存有界。查询每批最多 32 项、最多 2 批在途、队列最多 1024 项。
- `nestos:http-disconnected` 区分 reconnecting 和 expired：短暂中断由传输恢复同一 SSE，成功发出 `nestos:http-reconnected` 收起提示；视图过期才探测健康，服务就绪后由 view-recovery 捕获全部已打开标签的编辑器快照并重建应用视图，不刷新整个文档。恢复接口显式保存输入、附件、配置和滚动位置；不支持的编辑器、在途提交及尚未提交的弹窗保留原页并给出具体原因，不依赖输入事件判断是否安全恢复。恢复快照在失败重试间保留，设置密钥只留在内存，不写入浏览器存储或日志。`nestos:http-retry` 唤醒退避，不重发业务写入。`nestos:http-view-error` 显示页面更新失败和手动重载入口，不单独触发自动重载，保留当前页面未发送内容。
- 应用层决定只读命令、消息投影和快照结果引用；rpc 层只实现注入规则、不可变 DTO 编码缓存及版本补丁。静态 hash 资源私有缓存，HTML 重新验证；压缩结果最多 64 项 / 16 MiB。

- workbenchView 可带 initialSessionId 并行准备当前会话；chat.configuration 提供安全展示字段的配置快照与订阅。openSessionView/activate 保留准备与激活顺序，UI 文档按当前路由合并预读；连接检查按观察兴趣共享，不由浏览器逐项目轮询。application.complete 只记录注册能力/方法和批次数，不记录参数或用户内容。

- navigationView 聚合普通模块首层、忽略规则和 UI 文档；warmNavigation 仅预热最多两个授权根的只读元数据。二者为 query，不触发写域失效，不创建独占资源。文件事件使有界后端缓存失效，前端一次消费后使用实时端口。

- 正常启动、工作区加载和 SSE 重连静默进行，不显示加载 banner；视图过期且服务就绪后自动恢复，只有恢复受阻或真实失败时显示具体原因和重试/手动重载入口。文件未保存内容由 app-shell 的本地恢复副本保护，健康检查成功不代表文件已保存，不清除草稿、不重放写入。

- openView 聚合聊天首屏及无旧编辑器时的激活/恢复，observeView 按水位补发并共享 SSE；事件缺口与回调失败报告更新错误。CLI 临时 profile/mTLS 测试覆盖新路径和多客户端隔离。

- 轻入口先并行启动 HTTP 同步、Shell 与当前编辑器代码加载；初始目标通过 app-shell/startup 构造。初始视图随 bootstrap 进入 initApp，不重复 openView/observeView。浏览器按内容摘要缓存纯数据，首帧使用共享 HTML 的主题镜像和静态骨架，错误仍显示现有入口。
- HTML 在样式 load/error 时记录结果；HTTP/Web 共用 nestos-web/startup 读取已有结果、等待未完成样式（最长 30 秒）和显示启动失败。失败提示的必要样式内联在 HTML，CSS 不可用时仍可操作重载。
- 提前连接保存当前状态，状态 UI 订阅时同步补报；终结的 view-error/expired 不能被迟到的重连覆盖。窗口事件保留兼容通知，正常 HTTP UI 通过连接状态订阅消费。

- 手机 visible/pageshow 与 online/focus 唤醒重连；30 秒没有流活动的旧 SSE 会立即替换，健康流不额外重连。服务端 view.expired 按 requestId 区分视图不存在、未初始化、流失效、协议变化与事件历史过期，不记录参数。

- 多用户由 http.usersDir 或 --users-dir 显式启用；http.mtls.clients 将证书指纹映射到稳定 userId（未配置时兼容 clients.json），保留强制 mTLS，旧数组只代表 admin。非 admin 映射不能进入单用户 Runtime。启动先恢复 admin/公共定义，再恢复所有已登记用户，成功后 listen；新用户按需初始化并复用在途 Promise。
- 用户正文位于 <usersDir>/<userId>，私有记录、数据库、OAuth、日志与可选 swap 收在 .nestos；UserFiles 仅映射物理位置，保留 /home/admin 逻辑别名和单用户索引事务。公共 llm/agents/flows 定义由 admin 写入，普通用户只读，查询凭据脱敏。不得把公共配置文件通过设置偏好、文件能力或导出绕回浏览器。
- 浏览器先认证 /api/identity，再按 userId 隔离 DTO 缓存和文件恢复副本；后续请求钉住该 userId，不能在证书重分配后自动恢复旧页面到新账号。SSE 复验原证书及 userId。公共配置更新目前需重启全部 Runtime。
- --import-legacy-root 只做离线复制，要求完整旧 _meta/index.db；可显式带 --import-legacy-auth-dir。取得源与目标锁后，通过存储 API 复制 SeqFile 值、完整侧车元数据和标签，暂存成功后发布；源数据保留，不能覆盖现有 admin/etc。详见 doc/http-app.md。

- v15 的 Session 历史按 Session/分支分别保留有界基线，回到旧会话与自己的最新基线比较；大于 64 KiB 的数组补丁整段同步。超过 64 KiB 的 SSE 通知只带 updatesRead，客户端按序通过认证的 updates-read 读取准备好的响应，禁止重执行绑定或写命令。准备区失效按视图过期恢复，不静默漏过补丁。
