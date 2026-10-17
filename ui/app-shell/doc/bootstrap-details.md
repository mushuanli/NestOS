# app-shell 启动与装配

`initApp(options)` 是唯一顶层初始化函数，只负责 UI 装配；平台无关的 VFS / LLM / Kernel / Session 组合由 `@itookit/app-core` 的 `createApplicationRuntime()` 完成。

```text
1. 宿主注入 options.services 与 options.backend（后端创建只在宿主执行）
   → vfs / llmDriver / agentService / sessionRepository / flowEngine /
     sessionFiles / directoryMounts / kernel / sessionManager / commandBus
2. themeService.init(uiDocs)，只读取主题偏好
3. createSettingsAccess() → 本地设置目录、按需加载的 settingsFactory
4. 按 WorkspaceConfig.type 建 EditorFactory 表（factories / editorFactoryMap）
5. 绑定路由（routeMap / reverseRouteMap + popstate、NAVIGATION_EVENTS.NAVIGATE）
6. onShellReady 关闭全局提示；无深链显示 #/start，选择模块后 loadWorkspace(wsConfig)
7. 显式资源导航才 restoreWorkspaceResource；managerCache 缓存 + pendingLoads 并发去重
```

`initApp` 要求 `AppOptions.services` 与 `AppOptions.backend`；编辑器、AI 菜单和 LLM 设置编辑器经 `AppOptions.ui` 注入。普通文档启动只等待主题和当前工作区，不加载 OCR、设置数据、恢复能力或聊天权限。设置编辑器第一次打开时 backend.settings 返回已初始化端口；目录导航始终在本地生成。OCR 首次操作才获取后端服务，readSettings 只读，prepareConfiguration 仅在打开配置时创建缺省文件和提示词。订阅空输入框不触发 OCR 加载。

chat 工作区由 `SessionWorkbench` 承载（Session 侧栏 + 路由 + 文件上下文），其余工作区由 `Workbench` 承载，二者都用 `EditorFactory` 选择编辑器。

Web、HTTP、Tauri 的正常入口启用 startPage，默认进入 `#/start` 轻量功能页；点击品牌可回到入口。显式 URL 深链仍直接进入对应资源；`home` 等旧别名保持原映射。全局启动提示在路由监听安装后的 `onShellReady` 关闭，不等待工作区、会话或编辑器。`initApp` 的返回仍等待初始路由完成，后续消费者可依赖完成的句柄。

工作区创建和正文导航分开：加载中的工作区共享 Promise，只有最新路由可在加载完成后打开资源。`onWorkspaceMounted` 报告两列 DOM，`onWorkspaceReady` 报告侧栏就绪，chat 的 `onSidebarInteractive` 表示侧栏可交互；`onEditorReady` 根据模块打开操作的 Promise 报告，不参与全局提示，也不再通过 DOM 或 15 秒超时猜测挂载。工作区显示局部加载提示，失败局部重试并释放半初始化资源，导航始终可用。后台完成的旧工作区不改写 URL。

首次进入工作区只加载侧栏、排序/展开/布局偏好和标签入口；不恢复持久 activeId/selectedItemIds，不自动打开上次 Session、当前项目目录或普通文件正文，也不额外创建根目录正文视图。点击标签/浏览树或明确 URL 时才读取正文、绑定会话、取得租约及创建编辑器。当前页面内返回已经加载的模块继续保留其当前编辑器和草稿。保存的历史标签不删除。

移动端 `setupMobileWorkspaceView` 在工作台标签初始化时保留列表，只根据可见活动面板中的实际正文切换详情，标签栏与空面板不算编辑器。观察面板挂载和 hidden 状态变化；用户返回列表后，正文的后台 DOM 更新不会再次强制切换详情。

Web 入口的图标与各工作区 CSS 由 HTML 引用的首批样式提供；`llm-ui/startup` 只带启动所需菜单和模板，编辑器工厂首次打开正文才导入完整 UI。MDX 默认编辑器与 MentionPlugin 也按正文打开延迟加载，避免侧栏数据加载等待正文模块图。

普通 Chat 走 `ConversationRunCoordinator` 的直接任务路径（`directTaskSpec`），不包装成单节点 DAG。文件工具的 `ToolExecutionContext.vfs`（`ToolVFSContext`）由 `kernel-adapters` 注入：有该字段时走虚拟文件系统，没有时回退到 `node:fs/promises`，浏览器环境下因此不需要真实文件系统。

## Flow 定义库和右键运行

内置 Flow 模板由后端按安装记录准备；已有持久草稿不覆盖。AppUI.createFlowContextMenu 通过 Workbench.uiOptions.contextMenu 装配到 flows 工作区，菜单执行依赖命令总线，导航依赖宿主回调。Web/Tauri 均已接线。

参数确认后创建 Session 并导航到 chat；会话 manifest.flow 保存固定 revision 和参数，LLMWorkspaceEditor 首次打开空会话后自动执行。定义与 UI 边界见 [作文评审实现](../../../doc/design/essay-review-flow.md)。

内置模板安装通过 `flow.draft.install` 保存独立安装记录；删除 `.flow` 后记录仍在，重启不再恢复该模板。聊天侧栏将同一 FlowEngine 挂到 `/@flows`，支持展开、打开和右键运行/删除。新增作文文件统一名为 `essay-review-isolated.flow`。

## 编辑标签与侧栏布局

普通 Workbench、SessionWorkbench 与工具箱连接器共用 `src/workbench/tabs.ts` 的标签机制。项目和普通文件工作区由 `src/workbench/sidebar.ts` 提供一个可调侧栏，上区导航、下区已打开；主区域的目录详情在 `src/workbench/directory-list.ts`。工具箱保留其资源导航，避免宿主覆盖连接器拥有的标签 DOM；释放连接器后再释放其文件视图。

bootstrap 为普通工作区和 Session 浏览器注入 VfsUIPersistence.workbenchPort，与浏览器的 uiPersistence 分开存储。恢复的标签先展示入口，活动资源只由明确 URL 或用户点击打开；后台标签首次选择时才装配编辑器。

项目选择器替换浏览器标题行，集合当前项目、所有项目及新建项目；目录和文件保留在同一侧栏树。目录行通过 rowCreation 提供悬停新建图标，主区域列表通过 directory-selection 管理全选和批量操作，复用 vfs-ui 菜单权限与命令。已打开区用关闭/Pin 图标并提供保留固定项的批量关闭。

## 导航首屏与缓存

普通文件模块通过 `backend.navigationView({root, scope})` 聚合首层目录、根 `.gitignore` 和两份 UI 文档；UI 负责解释布局、标签和展示偏好。`browser/initial-directory.ts` 在首次消费时提供元数据，原文件能力承担实际读写，变化事件使尚未消费的快照失效。外部来源和特殊逻辑工作区的文件端口与两份 UI 状态并行取得。首层展示完成后再执行 deferExpansion。

普通 Workbench 和 SessionWorkbench 保留已打开编辑器，在 15 秒有效期内不因切回就全量刷新；文件/组织/连接变更标脏，隐藏期间合并，恢复可见时刷新。工具箱也暂停隐藏期间的目录读取并合并变化。

前端只装配已访问的工作区，不预热未打开模块。文件和会话深链先打开当前正文，目录与组织不参与正文等待链；侧栏实际可见后再加载导航。隐藏导航停止目录读取和非当前会话状态观察，变化只标脏；后台执行及持久状态仍归后端 runtime。正常加载与重连不显示 banner，实际失败才显示局部重试。文件编辑保留当前编辑器，并为未保存内容建立按标签页、资源范围和路径隔离的本地恢复副本；恢复时核对后端内容，冲突保留两份内容。

导航本身不推导样例文件创建。显式 startupFileName 仍作为宿主配置生效，常规新建继续使用类型注册的模板。
