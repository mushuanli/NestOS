# @itookit/app-transport

平台中立的应用传输适配；不依赖 DOM、Node、app-core 或 UI。

- rpc/ 仅负责协议、句柄、回调、快照和资源机制，通过注入获取应用描述；禁止反向导入 application/。
- application/ 负责能力分类和同步 selector；业务授权、发送与回执策略留在后端端口。
- http/ 实现有界查询/订阅批次、SSE、文件字节传输；fetch 和断线通知由宿主注入。
- 不自动重放写命令；跨传输保留稳定 code、remoteCode、outcome 和 requestId，不序列化整个异常对象。
- 使用公开子入口；传输集成与资源生命周期回归在 apps/http-app/tests，pnpm modules:check 检查加载边界。
