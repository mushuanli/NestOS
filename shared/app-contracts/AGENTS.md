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

- workbenchView.initialSessionId 只请求目标准备，WorkbenchView.initialSession 的文件/观察租约由调用者释放；activate 仍单独执行。WorkbenchChatControls.configuration 是可选安全配置观察，不接入执行或原始配置写入。

- SessionPresentationState 位于 ports/session.ts，组合 Task、Flow、Skill 的可选启动读模型；该应用聚合类型不进入 llm-session 或 llm-ui。

- ApplicationBackend.taskAttachment 是显式 Session 的只读恢复查询，使用 durable-kernel/contracts 的 ReadTaskAttachment；不传内部 Task 记录或执行凭据。

- openView 是冷启动应用用例：UI 文档、工作台、可选激活/恢复初始数据及带水位观察一起返回；ApplicationViewObservation 只描述当前客户端事件，不能成为全局页面状态。普通切换继续保留准备/保存/激活顺序。

- HostedApplicationClient.initialView/AppOptions.initialView 连接一次打开同步握手与 Shell；ApplicationViewObservation.getSessionBaseline 成对返回当前快照和事件水位。缓存摘要不是授权或资源句柄，初始连接兴趣随打开返回。

FlowLibraryCommand 是应用层恢复入口的纯命令常量；恢复与发布策略由 app-core 实现，契约不加载执行器，也不改变核心 FlowCommand 的语义。
ToolboxInventory 的 capabilityTags 是不含凭据的派生能力列表，configuredModel 表达受支持的已配置模型，model 继续只表达聊天模型；标签用于查找，运行授权仍由连接准入校验决定。


- ports/flow-installation 定义工具依赖、可信工具包目录及 Flow 安装报告；FlowToolDependency 指具体工具身份，包版本和可执行位置由宿主管理。ToolboxResources 的 toolPackages/flowInstallations 为可选能力，InitialFiles 的 prepareDependencies 只重试现有定义依赖；导入与恢复报告不能把缺工具或待配置当作就绪。

InputAssetCommand.ImportFile/Inspect 为通用文件上传及只读核对端口，InputFileIdentity 固定 uploadId/name/MIME/bytes/SHA-256；Inspect 不携带正文且归只读传输分类。20 MiB 是宿主上传上限，不能宣称为 Harness 原生附件能力。

session/artifacts 提供已提交执行产物的纯 DTO 和 ArtifactCommand；引用固定 Session/Task、输出选择和摘要。app.artifacts.list/read 与 session.artifact.get 必须分类为只读，不能因在途提交的写屏障而阻塞。契约不导出资产读取器、Kernel 服务或 DOM。
