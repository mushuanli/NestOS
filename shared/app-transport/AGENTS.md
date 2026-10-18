# @itookit/app-transport

平台中立的应用传输适配；不依赖 DOM、Node、app-core 或 UI。

- rpc/ 仅负责协议、句柄、回调、快照和资源机制，通过注入获取应用描述；禁止反向导入 application/。
- application/ 负责能力分类和同步 selector；业务授权、发送与回执策略留在后端端口。
- http/ 实现有界查询/订阅批次、SSE、文件字节传输；fetch 和断线通知由宿主注入。
- 不自动重放写命令；跨传输保留稳定 code、remoteCode、outcome 和 requestId，不序列化整个异常对象。
- SSE 短暂中断按最后接收序号恢复同一视图，首次立即重连，连续失败按 1/2/4/8/15 秒退避，响应头成功后立即 EOF 也累计退避；连接持续 15 秒后重置，online/focus 可提前唤醒。45 秒无心跳重连，重连不重复 bootstrap 或业务写入，销毁后不再订阅。视图过期停止旧句柄的查询、命令和文件请求，由宿主处理重载。
- HTTP 连接断开与视图更新失败分别通知宿主；快照/回调异常、事件解析失败和通知过载不能误报网络断开。解析失败或过载停止事件消费，保持队列有界，不自动重放命令。
- 使用公开子入口；传输集成与资源生命周期回归在 apps/http-app/tests，pnpm modules:check 检查加载边界。
- 导航失效是有完成回执的 async 操作，不得使用 notify；ProjectService.navigation、sessionTasks 是聚合查询，createSessionDraft 是独立写命令，不自动重放。

- session.flow.invocations 是只读命令；客户端订阅屏障和请求分类使用同一动态查询规则，只读命令不等待订阅，写命令仍等待确认。

- 协议 v14 注册 openView、OpenedApplicationView 与 ApplicationViewObservation；observeView 为 async-subscribe，getViewCursor 为同步快照。通知回调的错误回执必须转为更新失败，不能静默丢掉应用事件。

- HTTP 关闭先等待已发起的 RPC（包含从取消订阅到远程释放的整个异步过程）排空再销毁远程视图；排空、关闭请求及本地清理共用 5 秒上限，超时中止请求，不重放写入。重复关闭共用同一过程。聚合视图由显式能力拥有资源，不导出游离的 dispose 回调。
- ApplicationViewObservation 只通过公开 getSessionBaseline/observeView 编码和失效快照，不读取后端会话源或私有通知方法。RPC 支持等待异步观察登记，登记失败向调用者传播，关闭后才完成的登记立即释放。

- v14 初始握手可以同时打开目标并登记观察，SSE 与 bootstrap 并行。http/snapshot-cache 仅对不含能力的 Wire DTO 做 SHA-256 缓存，校验本地内容后才声明版本；缺块只补读已准备响应，不重放打开或写命令。应用事件由有界 viewEvents 队列接收，初始观察在本地适配。

RPC 身份与能力租约使用包内 randomUUID 兼容工具，不直接调用原生 crypto.randomUUID；机制层不因此依赖 common。SessionBrowserPort 显式注册 setSessionFilter，保持每个观察实例独立。
