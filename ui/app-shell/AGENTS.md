# @itookit/app-shell

应用启动引导 + UI 路由 + UI 装配。`initApp()` 是唯一顶层初始化函数。
平台无关的 Session/Kernel 组合位于 backend/app-core；app-shell 只通过 shared/app-contracts 接收服务，不导入 app-core。UI 仅消费 ApplicationServices/ApplicationBackend；应用操作异步，宿主内部构造契约不进入 UI。本地与 HTTP 宿主共用 initApp。

peerDependencies: `@itookit/{app-settings,common,driver-llm,llm-session,durable-kernel,kernel-adapters,mdxeditor,vfs-ui,vfs-core,ui-common}`

## Architecture

```
src/
├── index.ts              ← 导出 initApp() + AppOptions/AppHandle 等类型
├── bootstrap.ts          ← initApp() 主函数 + 编辑器工厂表 (factories / editorFactoryMap)
├── ThemeService.ts       ← 主题管理 (data-theme attribute + system/os 检测)
├── types.ts              ← AppOptions, AppHandle, WorkspaceConfig, AppUI
├── workspaces/
│   ├── index.ts          ← 预定义 WorkspaceConfig 常量 (WS_SETTINGS/WS_CHAT/WS_AGENTS/WS_SKILLS/WS_FLOWS…)
│   ├── module.ts         ← 工作区能力、路由恢复、模块资源统一释放
│   └── hitl-bridge.ts    ← Session 等待输入状态适配
├── browser/             ← 文件浏览器与编辑器装配、媒体预览、mention/元数据策略
├── core/
│   └── Workbench.ts          ← 通用工作区控制器
├── lifecycle/            ← 可替换视图读取与订阅释放机制（不含业务策略）
├── projects/             ← createProjectModule、SessionWorkbench、project-favorites（收藏端口适配）、
│                            单侧栏项目导航与归档目标适配
├── toolbox/              ← 工具箱模块入口、分类/分组显示、编辑器装配
├── configuration/        ← 删除影响确认（调用 app-core 的共享命令）
├── navigation/           ← URL 适配与移动端切换
├── files/                ← 本包 UI 实现（兼容 re-export shim 已于 2026-09-11 全部删除）
│   ├── mount-dialog.ts       宿主目录挂载对话框
│   └── localize-mount-error.ts 把 app-core 结构化错误映射为 i18n 文案
├── config/               ← file-registry.ts (FILE_REGISTRY) + templates.ts
├── persistence/
│   ├── vfs-json-store.ts     ← 串行化的 etc:/ui JSON 文档存储
│   └── vfs-ui-state-store.ts ← VfsUIPersistence：浏览器 UI 快照落到 etc:/ui/<scope>.ui.json
└── styles/workspace.css
```

## 工作区策略

不再有 `WorkspaceStrategy` 类；`bootstrap.ts` 用 `EditorFactory` 表按 `WorkspaceConfig.type` 选择编辑器：

```typescript
// bootstrap.ts
const factories: Record<string, EditorFactory> = {
    standard: defaultEditorFactory, agent: defaultEditorFactory,
    settings: settingsFactory, chat: llmFactory, skills: skillsFactory, flows: flowsFactory,
};
const strategyType = wsConfig.type ?? 'standard';
const factory = factories[strategyType] ?? defaultEditorFactory;
```

`editorFactoryMap` 另行把 `FILE_REGISTRY` 的 `editorType`（`'agent'` / `'flow'`）映射到对应编辑器工厂。

## WorkspaceConfig 速查

| 关键字段 | 说明 |
|---|---|
| `type` | `'standard'` / `'settings'` / `'chat'` / `'agent'` / `'skills'` / `'flows'` |
| `fileCreation` | 即时创建文件配置 (label/title/content/startupFileName) |
| `aiEnabled` | chat workspace 是否启用 AI 右键菜单 |
| `showFileExtensions` | 外部文件系统挂载设为 true |

详情: [启动流程 + 配置](./doc/bootstrap-details.md)

## Conventions

- `initApp()` 是唯一 UI 装配点 — VFS/LLM/Kernel 由宿主调用 `app-core` 的 `createApplicationRuntime()` 装配，UI 只接收 `services` 和 `backend`，编辑器/AI 菜单/LLM 设置编辑器经 `AppOptions.ui` 注入
- 项目收藏只做端口适配：`project-favorites.ts` 把 `resolveBrowserTarget` 路由翻译成 `ProjectFavorites` 命令。远程命令由 pi-agent 能力声明控制，工作台不提供启用/禁用开关。
- 项目范围选择复用 vfs-ui 的 ScopeSelector；导入导出通过 toolbarOptions.definitions 统一按钮、菜单、图标与异步执行，工作台只注入业务命令和目标策略。
- 通用 Workbench 保留 vfs-ui 默认的创建文件、创建目录按钮，并透传宿主 toolbarOptions；项目侧栏的精简操作只由 ProjectNavigation 配置，不影响其他模块。
- vfs-ui 内部 DOM/CSS 由库维护；宿主只使用 appearance、NodePresentation、toolbarOptions.variant 和公开 CSS 变量。移动端正文切换订阅 VFS_DOM_EVENTS.resourceActivated，不能依赖内部类名或模拟点击。
- 项目进入文件复用单侧栏；`ProjectNavigation` 投影当前项目目录、收藏与会话，目录详情和编辑标签位于 `workbench/`。`ProjectFileView` 只保留收藏导航的选择兼容提示；收藏解析在 `openFavorite` 完成。
- `WorkbenchTabs` 保留每个标签的编辑器 DOM；修改将预览转为保持打开，固定标签受批量关闭保护。`WorkbenchSidebar` 管理上下分区与可访问分隔线，布局/非预览标签通过宿主 workbenchPort 存到 etc:/ui。关闭先完成保存，失败保留编辑器及文件租约。
- 项目与工具箱分别通过 `createProjectModule` / `createToolboxModule` 装配，返回统一 WorkspaceModule；bootstrap 只消费工作区能力，不用具体工作台类做 instanceof 判断。模块销毁同时释放目录投影和事件订阅，动态移除与应用退出共用一次释放。
- `loadWorkspace()` 包含去重 — 并发加载同一工作区共享同一个 Promise (`pendingLoads`)
- 正常 Web/HTTP/Tauri 入口启用 startPage，默认 #/start；显式深链和旧别名保留。onShellReady 在路由绑定后关闭全局提示，不等待工作区加载。工作区和资源加载分开，最新导航代次决定正文打开，隐藏模块不能改写 URL；失败局部重试，部分初始化资源由独立 cleanupGroup 释放。
- 首次进入模块不以保存的 activeId/selectedItemIds 导航，不打开旧会话、当前项目目录、文件或根目录正文；只保留侧栏展示偏好、布局及历史标签入口。当前页面内返回已缓存模块保留当前编辑器；显式 URL 或用户操作打开正文。onWorkspaceMounted/onWorkspaceReady/onSidebarInteractive 报告局部阶段，onEditorReady 根据模块打开操作的 Promise 报告，不参与全局提示或使用 DOM 挂载超时判断。
- MDX 默认编辑器经 `browser/lazy-mdx.ts` 延迟导入；标准工作区的 MentionPlugin 也只在打开正文时加载。侧栏数据与正文编辑器不能共用启动时的静态模块图。
- 普通文档启动只等待主题和当前工作区。configuration/settings-access 在首次打开设置编辑器时获取已就绪后端端口，导航目录纯本地；OCR、恢复能力、聊天控制随工作台装配，Flow 模板由后端按回执安装。lifecycle/lazy-resource 负责共享创建、失败重试和关闭时等待释放，不承载业务策略；空输入框订阅不能触发 OCR 加载。
- 路由基于 hash URL (`#/<slug>/<resourceId>`)，由 `history.pushState/replaceState` 写入，监听 `popstate` + `NAVIGATION_EVENTS.NAVIGATE`
- `ThemeService` 管理 `<html>` 的 `data-theme` attribute，监听 `app:theme-change` 事件，偏好持久化到 `etc:/ui/theme.json`；`AppHandle.setTheme(mode)` 切换主题

运行: `pnpm --filter @itookit/app-shell test`（vitest，另有 `test:watch`）

Files 页 Memory 管理使用固定 Session controls；冲突保留草稿并支持比较最新版本后显式重提。memory-sharing-dialog 经宿主 controls 管理资源、授权与审计，不从 UI 直接修改 SeqFile。

- 项目导航的纯列表展示策略位于 `projects/navigation-policy.ts`。异步收藏解析/远程探测属于导航请求，过期结果不得覆盖新的页面。

- `projects/sync` 提供项目同步菜单、预览与状态 UI；命令交给 ProjectSyncService，首次绑定经 AppOptions.projectSyncSetup 注入。面板不直接访问 HTTP 或 SeqFile，不把无在途操作显示为已同步；冲突选侧先生成新预览再确认执行。
- `showProjectSyncSetup` 通过注入端口列出服务器的同步项目目录或新建目录；切换服务器使原列表失效。目录探测可关闭面板，绑定提交仍保存恢复依据；同步目录不是 export 路径。

- `digital-twin/` 提供 WS_TWIN 的五页工作台；`navigation.ts` 将页面投影为只读 BrowserSource，使用与设置相同的 VFSUIShell/NodeList 和 vfs-ui 样式；正文使用原生 DOM。消费 runtime.digitalTwin，不访问 SeqFile。会话 Files 页可进入知识总览；异步页面代次、AbortController 和服务订阅共同管理生命周期，失败保留表单草稿。
- 自动更新使用扫描规则/扫描目标/运行记录三个独立页签，通用设置位于页签上方，模型连接未配置或不可用时默认展开，有效配置后默认折叠，扫描计划引用工具箱模型连接。表单范围与类型为多选，冲突刷新保留选择；页面销毁只释放 UI 订阅，调度随 ApplicationRuntime 生命周期运行，不能因离开页面取消已授权后台扫描。

- “数字分身”的自动更新页直接显示规则，表单包含范围、关注点、忽略模式、频率和启停；规则提取类型和预算收进高级选项；通用模型、姓名/别名默认可见，实际提示词折叠查看，全局忽略在通用设置。匹配预览仅列资源；来源明细只读，不逐项要求授权，规则启用不重复确认。

- `graph-view.ts` 展示有效知识的对象详情、局部 SVG 图与证据；点击节点切换中心，同名人物由用户确认合并。后台更新通过保留草稿的刷新路径进入 UI，不能擦除正在编辑的规则。

- 单用户知识默认供所有已接入会话/Agent 使用；总览不提供逐会话授权。全局与规则忽略支持本地/远程目录和会话名称，消费模型不绑定扫描模型。

- `digital-twin/source-menu.ts` 将本地/远程浏览器路由转换为来源身份；`source-dialog.ts` 展示分析进度、证据与类型选择，调用 service 的首次扫描和移除用例，销毁时释放订阅。标准工作区与项目侧栏复用同一入口。

- 数字分析对话框使用独立 twin-source-dialog 样式，提供状态、提取类型、结果卡片与原文证据；扫描记录默认折叠，刷新保留展开状态。正文独立滚动，关闭与底部操作在窄屏仍可访问，颜色复用主题变量。

- 数字分析结果可原位编辑，复用 memoryFields/memoryInput 与 review CAS；编辑中只更新进度，保留表单与原始 revision，保存失败保留草稿。来源进度基于当前规则版本的扫描运行显示等待、运行、暂停、失败和无结果完成。

- 数字分析将当前更新状态与历史任务分开展示：当前扫描时间、耗时、完成来源数、新增结果数、模型响应边界及下次调度可见；历史记录默认显示最近 20 条并可展开全部，不以展示窗口删除记录。计时器只更新状态，关闭对话框时释放。

- 通用数字分身设置由 `settings-autosave.ts` 按字段串行自动保存，文本防抖、模型与开关立即提交；保存失败保留草稿并提供重试，导航和销毁前完成保存。编辑期间后台通知不得替换输入 DOM 或焦点。扫描规则保留显式保存。设置使用主题变量、桌面双列与移动端单列卡片，模型连接、累计用量与不限制预算开关统一展示；提示词与结算说明折叠展示。

- 数字分身侧栏仅使用 vfs-ui 的公开配置和语义 API，隐藏文件操作工具栏与菜单，页面按固定顺序排列。深链接同步顶层页面选中态；导航前等待设置自动保存，失败回退侧栏选中态并保留正文草稿。销毁释放列表、事件和服务订阅，移动端继续消费 VFS_DOM_EVENTS.resourceActivated。

- `digital-twin/scan-list.ts` 管理规则与目标列表的搜索、筛选和每页 10 条分页，保留筛选状态和表单 DOM；规则按启用状态筛选，目标按启用状态、来源类型和可读取状态筛选。扫描目标是已接入来源，未接入匹配通过规则预览核对；不按旧 200 条截断目标。页签切换更新路由而不重建正文，保留规则草稿并支持方向键、Home/End。

- 前端禁止引用 app-core，包括类型导入；应用服务接口从 shared/app-contracts 的 services 子入口通过 import type 引用。`pnpm modules:check` 与 `pnpm modules:buildcheck` 验证完整源码和构建图，见 [前后端模块边界](../../doc/design/frontend-backend-modules.md)。

- 工作台初始聊天控制与导航由 backend.workbenchView 返回；会话先 openSessionView 准备，旧编辑器保存后 activate 返回初始快照。缓存编辑器重新激活绑定，文件租约随标签释放。连接观察只提交兴趣集合，不拥有轮询或后台任务。UI 文档写入合并、去重，后端完成 upsert，flush 失败保留待写内容。

- 普通模块通过 backend.navigationView 聚合首层与不透明 UI 文档；外部注入来源、设置/Flow/Skill 保持各自端口，独立读取并行。browser/initial-directory 只消费一次元数据，已有事件订阅使快照失效，不干预写操作与版本回调。普通侧栏 deferExpansion，首次只展示首层；切回在事件标脏、挂载身份变化或 15 秒到期后刷新。工作台保留隐藏期间的 refreshSources 并合并刷新。
- navigation/navigation-warmup 在初始路由完成后依次提前装配工具箱和工作台导航，复用 loadWorkspace 的在途 Promise 与模块缓存；不改变路由，不打开旧资源、编辑器或会话租约。任务间让出前台加载，页面隐藏时暂停，返回时继续，销毁取消剩余任务。随后最多预热两个未加载普通根的后端快照，不构造普通工作区。工具箱隐藏时暂停目录读取并合并变化；导航没有显式 startupFileName 时，不从文件类型默认值推导自动创建。
