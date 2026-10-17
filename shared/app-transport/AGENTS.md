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
