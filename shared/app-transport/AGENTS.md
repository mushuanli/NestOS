# @itookit/app-transport

同一观察回调的通知必须按调用顺序完成编码与传送，不能让较大的队列快照被后来的运行事件超越。只串行同一回调，普通查询及不同观察通道继续并行；失败回执继续报告，不重放写入。回归见 app-shell 的 rpc-notification-order 与 draft-promotion。

平台中立的应用传输适配；不依赖 DOM、Node、app-core 或 UI。

- rpc/ 仅负责协议、句柄、回调、快照和资源机制，通过注入获取应用描述；禁止反向导入 application/。
- application/ 负责能力分类和同步 selector；业务授权、发送与回执策略留在后端端口。
- http/ 实现有界查询/订阅批次、SSE、文件字节传输；fetch 和断线通知由宿主注入。
- 不自动重放写命令；跨传输保留稳定 code、remoteCode、outcome、requestId 和经过格式校验的 field，不序列化整个异常对象。
- SSE 短暂中断按最后接收序号恢复同一视图，首次立即重连，连续失败按 1/2/4/8/15 秒退避，响应头成功后立即 EOF 也累计退避；连接持续 15 秒后重置，online/focus 可提前唤醒；宿主在 visible/pageshow 时也可调用 retryConnection，30 秒无流活动时立即替换旧流，健康流保持。45 秒无心跳重连，重连不重复 bootstrap 或业务写入，销毁后不再订阅。视图过期停止旧句柄的查询、命令和文件请求，由宿主处理重载。
- HTTP 连接断开与视图更新失败分别通知宿主；快照/回调异常、事件解析失败和通知过载不能误报网络断开。解析失败或过载停止事件消费，保持队列有界，不自动重放命令。
- SSE 单帧与通知队列的字节预算按 UTF-8 线传字节计算，与服务端 2 MiB 上限一致，不能用字符数乘二替代；网络读块可能包含多帧，只对单帧及未完成尾部限制大小。通知仍限 256 项，临近超限时给已排队回调一次事件循环排空机会，不等待阻塞回调；真实过载报告数量/字节分类、队列量、序号和耗时，不记录正文。A→B→A 的大快照回归见 http-app 的 view-update-errors。
- 使用公开子入口；传输集成与资源生命周期回归在 apps/http-app/tests，pnpm modules:check 检查加载边界。
- 导航失效是有完成回执的 async 操作，不得使用 notify；ProjectService.navigation、sessionTasks 是聚合查询，createSessionDraft 是独立写命令，不自动重放。

- session.flow.invocations 是只读命令；客户端订阅屏障和请求分类使用同一动态查询规则，只读命令不等待订阅，写命令仍等待确认。

- 协议 v15 注册 openView、OpenedApplicationView 与 ApplicationViewObservation；observeView 为 async-subscribe，getViewCursor 为同步快照。通知回调的错误回执必须转为更新失败，不能静默丢掉应用事件。

- HTTP 关闭先等待已发起的 RPC（包含从取消订阅到远程释放的整个异步过程）排空再销毁远程视图；排空、关闭请求及本地清理共用 5 秒上限，超时中止请求，不重放写入。重复关闭共用同一过程。聚合视图由显式能力拥有资源，不导出游离的 dispose 回调。
- ApplicationViewObservation 只通过公开 getSessionBaseline/observeView 编码和失效快照，不读取后端会话源或私有通知方法。RPC 支持等待异步观察登记，登记失败向调用者传播，关闭后才完成的登记立即释放。

- v14 初始握手可以同时打开目标并登记观察，SSE 与 bootstrap 并行。http/snapshot-cache 仅对不含能力的 Wire DTO 做 SHA-256 缓存，校验本地内容后才声明版本；缺块只补读已准备响应，不重放打开或写命令。应用事件由有界 viewEvents 队列接收，初始观察在本地适配。

RPC 身份与能力租约使用包内 randomUUID 兼容工具，不直接调用原生 crypto.randomUUID；机制层不因此依赖 common。SessionBrowserPort 显式注册 setSessionFilter，保持每个观察实例独立。

HarnessClient 的能力表显式注册 subscribe/eventSnapshot 与目录订阅/快照，禁止保留已移除的轮询 RPC。变更客户端接口时同时验证真实 RpcPeer 往返和取消订阅释放，不能只用直接对象替身验证 UI。

HarnessClient.readCommandOutput 及 HarnessConversationPort.readCommandOutput/loadCommandOutput 均为 query，不参与执行或草稿写域失效；结果可用性失败不把已确认执行改为未知。前端分段读取在本地取消边界停止后续页，不能假设 RPC 编码后的 AbortSignal 会传播后续 abort。

IConnectionService 的 getPricingConfig 与管理服务一样以 snapshot 暴露，保留 reference_catalog 厂商价格来源、日期、币种及单位；模型选择 UI 不通过传输外的厂商目录补齐。真实 HTTPS 回归覆盖该只读快照。

Agent 发布的 getAgentRevision/getAgentPublicationStatus/getAgentPublicationReceipt 为只读 query，publishAgent 为独立 async 写入。回执查询不能被原发布响应悬挂阻塞；返回既有精确操作事实，不自动重放发布或创建执行。认证 HTTP 回归见 view-api 的 suspended publication 场景。

TaskHandle.withdrawPause 在应用能力表显式注册为 async，保留原 requestId、expectedEpoch 与错误码。公开内核 API 的新增方法必须同时检查远程能力表；通用 RPC 编码器不通过反射自动开放所有方法。

原生 HarnessClient 的 queryCommand/commandCatalog/readCommandOutput 是只读查询；HarnessConversationPort 的 queryCommand/reconcileQuery 需要保存报告，属于独立 async 操作，不等待发送 tail。reconcileControl 与原输入回执分开，输出读取不改变执行接纳或草稿。能力表与真实 RPC 回归一同维护。

FileSystemView 是带独立 dispose 的文件能力，RPC 通过独立类型显式保留其释放方法及 openFile 本地投影；普通 IFileSystem 不自动获得生命周期权限。SessionRepository.openAttachments 的返回值必须可经真实 RPC 释放，释放后仓库和底层 VFS 继续可用。

- v15 的 Session 历史按 Session/分支分别保留有界基线，回到旧会话与自己的最新基线比较；大于 64 KiB 的数组补丁整段同步。超过 64 KiB 的 SSE 通知只带 updatesRead，客户端按序通过认证的 updates-read 读取准备好的响应，禁止重执行绑定或写命令。准备区失效按视图过期恢复，不静默漏过补丁。

- v15 的字符串补丁支持 append/splice，splice 使用经过范围校验的 UTF-16 索引并保留版本前置条件；中间小修改不重传完整正文，数组补丁超过 64 KiB 时整段替换。
