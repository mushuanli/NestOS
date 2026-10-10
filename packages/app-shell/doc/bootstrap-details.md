# app-shell 启动与装配

`initApp(options)` 是唯一顶层初始化函数，只负责 UI 装配；平台无关的 VFS / LLM / Kernel / Session 组合由 `@itookit/app-core` 的 `createApplicationRuntime()` 完成。

```text
1. options.runtime ?? await createApplicationRuntime({ ...options, backend: options.backend })
   → vfs / llmDriver / agentService / sessionRepository / flowEngine /
     sessionFiles / directoryMounts / kernel / sessionManager / commandBus
2. themeService.init(await vfs.openFileSystem('/etc'))
3. createSettingsModule(vfs, settingsSources) → settingsFactory
4. 按 WorkspaceConfig.type 建 EditorFactory 表（factories / editorFactoryMap）
5. 绑定路由（routeMap / reverseRouteMap + popstate、NAVIGATION_EVENTS.NAVIGATE）
6. loadWorkspace(wsConfig, resourceId)，managerCache 缓存 + pendingLoads 并发去重
```

`initApp` 要求 `AppOptions.backend` 或 `AppOptions.runtime` 之一；编辑器、AI 菜单和 LLM 设置编辑器经 `AppOptions.ui` 注入。

chat 工作区由 `SessionWorkbench` 承载（Session 侧栏 + 路由 + 文件上下文），其余工作区由 `Workbench` 承载，二者都用 `EditorFactory` 选择编辑器。

chat 启动分阶段：`onWorkspaceMounted` 在两列 DOM 创建后立即把宿主遮罩移到正文列，使空侧栏可见；侧栏树加载完成后 `onWorkspaceReady` 通知宿主。浏览器获得一次绘制机会后才恢复选中项、当前项目正文或 URL 深链。侧栏初始化完成后触发 `onSidebarInteractive`，桌面端此时开放侧栏点击，正文首挂载再触发 `onEditorReady`。显式深链优先，不额外打开侧栏保存的旧选中项。

移动端 `setupMobileWorkspaceView` 在工作台标签初始化时保留列表，只根据可见活动面板中的实际正文切换详情，标签栏与空面板不算编辑器。观察面板挂载和 hidden 状态变化；用户返回列表后，正文的后台 DOM 更新不会再次强制切换详情。

Web 入口的图标与各工作区 CSS 由 HTML 引用的首批样式提供；`llm-ui/startup` 只带启动所需菜单和模板，编辑器工厂首次打开正文才导入完整 UI。MDX 默认编辑器与 MentionPlugin 也按正文打开延迟加载，避免侧栏数据加载等待正文模块图。

普通 Chat 走 `ConversationRunCoordinator` 的直接任务路径（`directTaskSpec`），不包装成单节点 DAG。文件工具的 `ToolExecutionContext.vfs`（`ToolVFSContext`）由 `kernel-adapters` 注入：有该字段时走虚拟文件系统，没有时回退到 `node:fs/promises`，浏览器环境下因此不需要真实文件系统。

## Flow 定义库和右键运行

AppUI.installFlowLibrary 在工作区加载前安装 llm-ui 注册的缺失 Flow 模板；已有持久草稿不覆盖。AppUI.createFlowContextMenu 通过 Workbench.uiOptions.contextMenu 装配到 flows 工作区，菜单执行依赖命令总线，导航依赖宿主回调。Web/Tauri 均已接线。

参数确认后创建 Session 并导航到 chat；会话 manifest.flow 保存固定 revision 和参数，LLMWorkspaceEditor 首次打开空会话后自动执行。定义与 UI 边界见 [作文评审实现](../../../doc/design/essay-review-flow.md)。

内置模板安装通过 `flow.draft.install` 保存独立安装记录；删除 `.flow` 后记录仍在，重启不再恢复该模板。聊天侧栏将同一 FlowEngine 挂到 `/@flows`，支持展开、打开和右键运行/删除。新增作文文件统一名为 `essay-review-isolated.flow`。

## 编辑标签与侧栏布局

普通 Workbench、SessionWorkbench 与工具箱连接器共用 `src/workbench/tabs.ts` 的标签机制。项目和普通文件工作区由 `src/workbench/sidebar.ts` 提供一个可调侧栏，上区导航、下区已打开；主区域的目录详情在 `src/workbench/directory-list.ts`。工具箱保留其资源导航，避免宿主覆盖连接器拥有的标签 DOM；释放连接器后再释放其文件视图。

bootstrap 为普通工作区和 Session 浏览器注入 VfsUIPersistence.workbenchPort，与浏览器的 uiPersistence 分开存储。恢复的标签先展示入口，活动资源由 URL/浏览树恢复；后台标签首次选择时才装配编辑器。

项目选择器替换浏览器标题行，集合当前项目、所有项目及新建项目；目录和文件保留在同一侧栏树。目录行通过 rowCreation 提供悬停新建图标，主区域列表通过 directory-selection 管理全选和批量操作，复用 vfs-ui 菜单权限与命令。已打开区用关闭/Pin 图标并提供保留固定项的批量关闭。
