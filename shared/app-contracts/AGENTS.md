# @itookit/app-contracts

共享应用契约与纯变换。前后端均可使用，不依赖 UI 或后端执行实现。

工具箱连接元数据只投影安全的 `credentialsReady` 和聊天模型显示名称 `model`；model 表示按 optimal、standard、fast 顺序找到的首个已配置且存在于目录的聊天模型，不等同于默认档一定能聊天。没有可用聊天模型用 null 保留跨 JSON 传输语义，不暴露 API Key 或 OAuth 凭据。

- `services.ts` / `ports/`：application-client 是显式前端契约；local 描述宿主服务与平台选项，不再保留 LocalBackendPort 工厂表，UI 禁止引用。其余能力接口按 files/projects/session/configuration/sync/digital-twin/local 拆分，不从 Runtime 或服务类派生。
- `settings.ts`：设置、工作区来源、存储估计与快照端口。SettingsPort 返回即就绪，不含 init；工作区描述与 openWorkspace 分开。OCR 通过异步 readSettings 读取，通过显式 prepareConfiguration 准备配置，不暴露同步未加载快照。
- `session/`、`vfs/`、`configuration/`、`projects/`、`digital-twin/`：身份、结构化错误、DTO、纯路由和校验。
- `presets/`：共享产品常量与持久工作区身份；无网络、初始化或服务实例。

运行时只依赖 common 与 vfs-core。领域类型通过公开入口引用，开发依赖不授予运行时实现导入权限。不得在契约里重新导出 Runtime、执行服务或 DOM 组件的值。`pnpm modules:check` 校验传递加载，`pnpm modules:buildcheck` 校验完整前端公开入口。

- WorkbenchView/SessionOpenView 是应用聚合契约：后端准备只读模型、能力与资源所有权，前端决定编辑器保存/切换时机。UI 文档保持不透明，连接兴趣按 revision 更新，不能传递实现类或前端类型。

- WorkspaceController.setNavigationVisible 是可选视图生命周期能力，和整个工作区 setVisible 分开；WorkbenchView 的 initialNavigation=false 跳过初始目录/组织投影，不改变授权或资源所有权。
- ProjectNavigationView 聚合项目归属、当前路径、离线状态与不透明分组加载路径；ProjectNavigationRequest.projectId=null 表示保持“所有项目”，省略才按目标解析归属。Session 浏览器的 invalidateNavigation 必须返回 Promise，表示后端失效屏障已完成。createSessionDraft 聚合来源解析与带初始输入的会话创建；sessionTasks 只返回任务列表所需字段。宿主观察租约 acquireConversation 只属于 local 接口。
