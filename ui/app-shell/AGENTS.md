# @itookit/app-shell

应用启动引导 + UI 路由 + UI 装配。`initApp()` 是唯一顶层初始化函数。

本地会话通过 `EditorOptions.mountMoreMenu` 将会话信息与归属动作挂入聊天标题栏共用的更多菜单；不再增加正文上方的会话工具栏。关联会话不继承聊天历史，创建动作只在菜单中显示。项目侧栏直接合并各来源最近 15 条会话及父关系，超过后由“更多会话”打开右侧每页 50 条的列表；不在侧栏展开更多，不保留 harness 分组层级。后端负责有界合并、分页及能力声明，UI 使用来源图标、标题栏来源标识和规范资源跳转；容器行别名不得改变 Session/native 会话身份。

桌面项目归属作为 WorkbenchTabs 的只读 context 与资源名同行显示，不拼入 title、重命名输入或持久文件名，不另占正文一行。小屏聊天通过 `mountCompactNavigation` 合并返回、项目名、标题与已打开入口；编辑器以公开 `data-editor-mobile-navigation="embedded"` 标记接管导航，mobile-workspace-view 只检查当前标签，隐藏宿主重复返回栏、标签行及项目说明。文件与目录页使用同一 compactNavigation 的宿主导航，小屏隐藏独立返回栏和桌面标签行；侧栏面板图标、标题和叠放窗口入口同一行，Web/httpd 不分叉。移动正文切换消费标签显式的 opening/active/empty 与激活代次；打开资源后不会因等待保存、空标签或正文挂载而退回列表，深链从装配时就进入正文，用户返回列表后的普通内容更新不会抢回正文。已打开面板从顶部展开，借用原列表，关闭后归还侧栏，不克隆编辑器或丢弃草稿。窗口列表用标题和项目/目录两层信息区分同名项，支持名称、项目和路径筛选；位置作为展示元数据保存，不拼入资源名或资源 ID，移动/重命名文件后更新；旧版窗口记录只在打开列表时经 describe 补齐位置，不打开后台编辑器，路由或位置元数据版本变化后丢弃迟到结果。返回按钮在小屏切回列表，桌面仍切换侧栏。mobile-viewport 随可视视口更新应用高度并在销毁时解绑；mobile-shell-state 将当前活动布局的 detail/embedded 与输入焦点投影到 body[data-mobile-navigation]，不依赖 CSS :has()；小屏聊天正文据此收起全局底部导航，返回列表恢复，保留底部安全区；列表导航高 56px，按钮点按高度 48px。其他编辑器输入焦点通过公开 data-editor-composing 标记收起导航，不读取隐藏工作区状态。

工具箱模型抽屉优先展示默认连接所在 Provider，并显示默认标识及实际就绪状态；其余抽屉/连接按就绪、待配置、停用排序，Provider 设置行保持首位。搜索匹配显示名称与可搜索文本，匹配子项时展开所属抽屉，资源 ID 不随排序改变。智能体与抽屉按最近成功提交排序，时间通过宿主 `ExecutorUsage` 保存到 UI 文档 `mindos_executor_usage_v1`，不改写 Agent 配置时间；聊天与工具箱延迟读取并共享该端口。
项目会话通过 `onStartConversationDraft` 请求切换执行方式；宿主定位同一项目的草稿，将输入和附件交给 appendDraft。已有草稿追加内容，接收编辑器身份变化后不再写入；不迁移原生历史、不发送输入、不取消原任务。模型和助手的下一轮选择仍由原会话编辑器管理。
平台无关的 Session/Kernel 组合位于 backend/app-core；app-shell 只通过 shared/app-contracts 接收服务，不导入 app-core。UI 仅消费 ApplicationServices/ApplicationBackend；应用操作异步，宿主内部构造契约不进入 UI。本地与 HTTP 宿主共用 initApp。

peerDependencies: `@itookit/{app-settings,common,driver-llm,llm-session,durable-kernel,kernel-adapters,mdxeditor,vfs-ui,vfs-core,ui-common}`

项目目录页搜索默认文件名、会话页默认会话名，复用 ProjectSearchPanel 的异步查询与生命周期；内容和仅用户提问显式切换。目录分页游标不能限制搜索，通用 DirectoryList 通过插槽接入，不包含后端或 harness 分支。

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
- 首次进入模块不以保存的 activeId/selectedItemIds 导航，不打开旧会话、当前项目目录、文件或根目录正文；只保留侧栏展示偏好、布局及历史标签入口。顶层导航或开始页进入工作台时显示所有项目，不恢复缓存项目/会话；其他已缓存模块保留当前编辑器。项目行单击只选择，双击、Enter、菜单“进入项目”、项目切换器或显式 URL 才进入项目。创建项目、导入完成只刷新列表，不自动打开结果。所有项目只显示新建项目，项目内只显示新建会话，不提供项目嵌套入口。onWorkspaceMounted/onWorkspaceReady/onSidebarInteractive 报告局部阶段，onEditorReady 根据模块打开操作的 Promise 报告，不参与全局提示或使用 DOM 挂载超时判断。
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

- 工作台初始聊天控制与导航由 backend.workbenchView 返回；冷启动传 initialSessionId 并消费一次 initialSession，其他切换经 openSessionView 准备，旧编辑器保存后 activate 返回初始快照。缓存编辑器重新激活绑定，文件租约随标签释放。连接观察只提交兴趣集合，不拥有轮询或后台任务。聊天深链的主题、侧栏、标签和执行器记录在首次读取前合并预取，新写入优先；UI 文档写入合并、去重，后端完成 upsert，flush 失败保留待写内容。

- 普通模块通过 backend.navigationView 聚合首层与不透明 UI 文档；外部注入来源、设置/Flow/Skill 保持各自端口，独立读取并行。browser/initial-directory 只消费一次元数据，已有事件订阅使快照失效，不干预写操作与版本回调。普通侧栏 deferExpansion，首次只展示首层；切回在事件标脏、挂载身份变化或 15 秒到期后刷新。工作台保留隐藏期间的 refreshSources 并合并刷新。
- 不预热或恢复未打开工作区。显式文件/会话深链只准备当前正文能力；WorkspaceController.setNavigationVisible 由实际活动工作区、手机列表/正文模式与侧栏折叠状态驱动。隐藏目录不读取、不刷新状态；可见目录独立失败与重试，不阻塞或替换正文。

- 工具箱启动消费 backend.toolboxView 的 initial 导航快照，刷新只调用 resources.navigation；技能文件系统、默认工具分类与分组扫描归后端 configuration。browser/directory-snapshot 是通用一次性读取适配，事件或版本变化后回到实时端口。目录面包屑由前端生成路由标签并复用 openResource 同步侧栏，缓存目录重新激活也须同步选择。
- 技能文件系统端口通过 lazyResource 共享请求并允许失败重试，后端拥有其释放职责。宿主文件类型的 contentFormat 独立于 editorType，未声明时按扩展名回退；项目目录标签和目标只由 directoryBreadcrumbs 解析。

- 普通文件按路径直接打开，不经过目录 selectPath；恢复标签仅保留入口，后台补载目录不重新创建编辑器。隐藏本地/原生会话暂停视图订阅、任务附着和 Flow 面板轮询，重新激活读取当前快照；只分离观察，不取消后端任务。
- 手机恢复当前 URL 时以导航目标维持正文，`data-workspace-opening` 覆盖编辑器尚未挂载的阶段；内嵌导航未就绪时使用 pending 呈现，隐藏中间窗口栏。共享 HTML 的 `data-app-starting` 在首个有效导航完成或失败后释放，避免冷重载先显示全局导航；普通 SSE 重连复用当前 DOM，不改变路由。
- browser/file-recovery 为普通、项目与 Session 文件保存独立于 HTTP 的恢复副本：小文本用 sessionStorage，大文本用 IndexedDB，按标签页与稳定资源身份隔离。只在后端确认保存后清除；重载时按原文摘要核对，冲突或权限变化保留副本并暂时只读，不自动覆盖；存储失败保留编辑器并阻止无保护退出。该副本不是 UI 偏好或后端数据真相，不扫描其他文件。

- 项目侧栏消费 ProjectService.navigation 的聚合结果，按后端提供的不透明 loadPaths 调用 vfs-ui.loadDirectory，按 navigationTransparent 元数据展开分组内容，不解释存储目录名。手动刷新等待异步 invalidateNavigation 确认后再刷新列表；正文编辑器与草稿不随刷新重建。草稿提升通知只刷新当前可见且无未保存输入的草稿，隐藏草稿在重新激活时检查持久提升回执并换用新控制端口。
- lifecycle/view-refresh 拥有刷新合并、顺序、隐藏标脏与失败重试状态；SessionTaskView 拥有任务详情与分页展示，消费后端 sessionTasks/taskDetails/taskEvents，不枚举内核会话。从文件发起聊天只准备引用文本并调用 backend.createSessionDraft，成功后导航，不在前端组合创建与持久草稿写入。

- 组合根将 backend.taskAttachment 注入聊天工厂的可选 readTaskAttachment 回调；OCR 的多个 UI 消费者共享一个 Agent 配置源订阅。

- 会话“更多”菜单打开时只展示已有会话信息；展开“会话信息”才读取最新元数据，同一面板的在途读取去重。读取失败保留时间和菜单动作，在该面板内提示并允许重新展开重试，不向 ChatInput 下方追加工作台错误；关闭编辑器后丢弃迟到结果。回归见 session-toolbar。

- 聊天冷启动通过 backend.openView 打开当前目标；lifecycle/opened-view 将一个远程观察投影为组件的本地订阅，并一次消费恢复/Flow/Skill 初始值。装配期间以已安装快照水位过滤重复流式增量；切换已有编辑器仍保存后激活。普通模块不预开聊天资源。

- 宿主可以通过 AppOptions.initialView 传入已打开且已观察的视图；HTTP 的初始观察为本地适配。装配期间读取成对的 Session 快照/游标，不能拿更晚的事件游标过滤较早快照。startup 子入口只提供纯路由与初始文档策略，不加载 DOM Shell；首屏骨架随当前导航完成/失败释放。
- 初始连接兴趣按 revision 合并，过期响应不能更新去重状态；在途或失败更新的集合尚未确认，相同集合也不能提前省略。启动文档列表统一来自 persistence/documents。

项目、全部会话及文件页提供纯图标创建按钮，保留 title/aria-label；文件根目录按后端投影的目录写权限判断创建能力，不以侧栏分组 kind 再次拒绝。新建会话始终打开统一草稿与智能体选择器，远程 harness 作为远程智能体候选。页面搜索框、范围和清除按钮同组；手机端进入搜索时隐藏其他工具栏动作，清除/退出后恢复，点击区域至少 44px。菜单与页面按钮复用相同命令及权限判断。

页面面包屑包含当前目录时不重复显示同名标题，搜索范围由面包屑表达；无查询时隐藏结果区，保留工具栏中的搜索控件。

手机目录页在紧凑导航的侧栏图标与窗口入口之间直接呈现可点击路径，页面正文不重复路径或目录标题；路径只作显示，不改写标签标题或持久文件名。页面与侧栏图标统一 18px，手机按钮保留至少 44px 点击区域，禁止让 SVG 随按钮拉伸。
