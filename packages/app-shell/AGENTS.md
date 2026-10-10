# @itookit/app-shell

应用启动引导 + UI 路由 + UI 装配。`initApp()` 是唯一顶层初始化函数。
平台无关的 Session/Kernel 组合位于 `@itookit/app-core`（直接依赖）；app-shell 依赖它并只保留 UI/路由/编辑器装配。

peerDependencies: `@itookit/{app-settings,common,driver-llm,llm-session,durable-kernel,kernel-adapters,mdxeditor,vfs-ui,vfs-core,ui-common}`

## Architecture

```
src/
├── index.ts              ← 导出 initApp() + AppOptions/AppHandle 等类型
├── bootstrap.ts          ← initApp() 主函数 + 编辑器工厂表 (factories / editorFactoryMap)
├── ThemeService.ts       ← 主题管理 (data-theme attribute + system/os 检测)
├── types.ts              ← AppOptions, AppHandle, WorkspaceConfig, AppKernelPlatform, AppUI
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

- `initApp()` 是唯一 UI 装配点 — VFS/LLM/Kernel 由 `app-core` 的 `createApplicationRuntime()` 装配，编辑器/AI 菜单/LLM 设置编辑器经 `AppOptions.ui` 注入
- 项目收藏只做端口适配：`project-favorites.ts` 把 `resolveBrowserTarget` 路由翻译成 `ProjectFavorites` 命令。远程命令由 pi-agent 能力声明控制，工作台不提供启用/禁用开关。
- 项目范围选择复用 vfs-ui 的 ScopeSelector；导入导出通过 toolbarOptions.definitions 统一按钮、菜单、图标与异步执行，工作台只注入业务命令和目标策略。
- 通用 Workbench 保留 vfs-ui 默认的创建文件、创建目录按钮，并透传宿主 toolbarOptions；项目侧栏的精简操作只由 ProjectNavigation 配置，不影响其他模块。
- vfs-ui 内部 DOM/CSS 由库维护；宿主只使用 appearance、NodePresentation、toolbarOptions.variant 和公开 CSS 变量。移动端正文切换订阅 VFS_DOM_EVENTS.resourceActivated，不能依赖内部类名或模拟点击。
- 项目进入文件复用单侧栏；`ProjectNavigation` 投影当前项目目录、收藏与会话，目录详情和编辑标签位于 `workbench/`。`ProjectFileView` 只保留收藏导航的选择兼容提示；收藏解析在 `openFavorite` 完成。
- `WorkbenchTabs` 保留每个标签的编辑器 DOM；修改将预览转为保持打开，固定标签受批量关闭保护。`WorkbenchSidebar` 管理上下分区与可访问分隔线，布局/非预览标签通过宿主 workbenchPort 存到 etc:/ui。关闭先完成保存，失败保留编辑器及文件租约。
- 项目与工具箱分别通过 `createProjectModule` / `createToolboxModule` 装配，返回统一 WorkspaceModule；bootstrap 只消费工作区能力，不用具体工作台类做 instanceof 判断。模块销毁同时释放目录投影和事件订阅，动态移除与应用退出共用一次释放。
- `loadWorkspace()` 包含去重 — 并发加载同一工作区共享同一个 Promise (`pendingLoads`)
- chat 工作区在 `SessionWorkbench` 完成侧栏树加载后立即触发 `onSidebarReady`，宿主的 `onWorkspaceReady` 因此先把加载遮罩限制在正文列；让出一帧后再恢复选中项、项目正文和深链编辑器。侧栏初始化完成后 `onSidebarInteractive` 允许桌面端提前开放点击；显式深链不额外打开旧的侧栏选中项。`onEditorReady` 仍在正文首挂载后触发。
- 两列 DOM 创建后 `onWorkspaceMounted` 立即让桌面端把加载遮罩移到正文列，VFS 侧栏骨架在数据读取期间可见；`onWorkspaceReady` 表示侧栏数据已完成。
- MDX 默认编辑器经 `browser/lazy-mdx.ts` 延迟导入；标准工作区的 MentionPlugin 也只在打开正文时加载。侧栏数据与正文编辑器不能共用启动时的静态模块图。
- 路由基于 hash URL (`#/<slug>/<resourceId>`)，由 `history.pushState/replaceState` 写入，监听 `popstate` + `NAVIGATION_EVENTS.NAVIGATE`
- `ThemeService` 管理 `<html>` 的 `data-theme` attribute，监听 `app:theme-change` 事件，偏好持久化到 `etc:/ui/theme.json`；`AppHandle.setTheme(mode)` 切换主题

运行: `pnpm --filter @itookit/app-shell test`（vitest，另有 `test:watch`）

Files 页 Memory 管理使用固定 Session controls；冲突保留草稿并支持比较最新版本后显式重提。memory-sharing-dialog 经宿主 controls 管理资源、授权与审计，不从 UI 直接修改 SeqFile。

- 项目导航的纯列表展示策略位于 `projects/navigation-policy.ts`。异步收藏解析/远程探测属于导航请求，过期结果不得覆盖新的页面。

- `projects/sync` 提供项目同步菜单、预览与状态 UI；命令交给 ProjectSyncService，首次绑定经 AppOptions.projectSyncSetup 注入。面板不直接访问 HTTP 或 SeqFile，不把无在途操作显示为已同步；冲突选侧先生成新预览再确认执行。
- `showProjectSyncSetup` 通过注入端口列出服务器的同步项目目录或新建目录；切换服务器使原列表失效。目录探测可关闭面板，绑定提交仍保存恢复依据；同步目录不是 export 路径。

- `digital-twin/` 提供 WS_TWIN 的五页原生 DOM 工作台；消费 runtime.digitalTwin，不访问 SeqFile。会话 Files 页可进入带会话选择的授权页；异步页面代次、AbortController 和服务订阅共同管理生命周期，失败保留表单草稿。
- 来源与扫描内含来源清单/扫描计划/运行记录三页签，扫描计划引用工具箱模型连接。表单范围与类型为多选，冲突刷新保留选择；页面销毁只释放 UI 订阅，调度随 ApplicationRuntime 生命周期运行，不能因离开页面取消已授权后台扫描。

- 数字分身的来源页默认显示扫描规则，表单仅范围、周期、类型；模型、预算、全局排除在总览。匹配预览仅列资源；来源明细只读，不逐项要求授权，规则启用不重复确认。
