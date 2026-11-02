# @itookit/kanban

独立、平台中立的协调库。运行依赖允许 `@itookit/vfs-core`，可选 UI 入口另用零依赖的 `@itookit/ui-common`，宿主注入可信身份、授权、产物核验、提交后回调及日志。

- `src/contracts/` 是无副作用的公开 DTO；`src/index.ts` 显式导出公共 API。
- `src/module.ts` 管理准入、授权、诊断及 quiesce；reducer 不进行 I/O。
- `src/store.ts` 通过 SeqFile 事务提交状态、依赖、派发意图、事件及幂等回执；大正文先写资产并核验，再提交引用。
- 不引入 Session、Flow、Kernel、Agent SDK、全局事件或 NestOS 目录约定。核心不安装后台调度；可选执行桥仅使用关闭超时，UI 的活动轮询必须随实例停止。sessionId/messageId 保留为不透明来源引用，独立 Agent 不必创建 NestOS Session。
- `content:finished` 不能证明执行完成；宿主根据正式执行回执提交 observe-execution。unknown 不释放责任、不自动重派；sealed 计划禁止普通命令绕过派发与验收。
- 浏览器身份使用 `src/utils/random.ts`；保持原生 UUID 缺失/抛错的兼容测试。
- 契约（含 KanbanClient）由本库自包含定义；应用不得代转出库 API。无 mechanisms 入口，reducer、codec、identity 等实现不公开。版本化内容通过 storage 的 installKanbanContent 原子安装；import 必须经过 install-content 授权。
- `/storage`、`/execution`、`/discovery`、`/activity` 各自拥有持久协议和通用协调；`/ui` 只通过实例端口接入文案、图标、日志与导航，不导入应用包。
- UI 标题以名称为主，引用编号和刷新保留在更多菜单；手机新建动作进入同一菜单，筛选详情折叠但表单值仍提交。可选 mountNavigation 由宿主装配导航按钮，重绘和销毁须释放；库不解释宿主窗口或路由历史。
- 事项、记录详情与新建表单共用 panelHeader：左侧关闭/返回、单行名称、右侧引用菜单，长标题保留 title 与可访问文本，不额外插入编号工具行。返回只关闭抽屉，保留看板和筛选，已有草稿保护沿用原操作规则。
- initialResource 显式提供时只加载对应资源，根路径展示目录；未提供时保留独立 UI 的默认看板选择。可选 navigate、mountWindowList、changed 将资源导航与窗口动作交给宿主；库只提供插槽和当前页面状态，不创建窗口管理器。窗口插槽随 DOM 替换释放，销毁释放全部监听。

验证：`pnpm typecheck`、`pnpm test`、`pnpm build`。协议与装配见 [README](README.md) 及 [协调设计](../../doc/design/kanban-coordination.md)。

mountTitleBar 提供时，目录、看板、详情和新建表单使用完整宿主标题栏，不再同时挂载局部导航和窗口插槽。库交接原标题、关闭及菜单节点，宿主保留其事件与状态；库只提供 fallback 与公开语义插槽，不导入宿主 UI 包。

automation 设置只保存不透明绑定及协调/执行主体；configure-automation 不调用模型。发布计划可凭 expectedRevision 原子接纳尚未认领的既有事项，保留身份和人工依赖；已发布定义不能借此改写。autoDispatch 支持宿主动态谓词，暂停仍观察原派发。analysisStatus/automationCatalog 是可选 UI 端口，模型输出契约、调用 journal 与具体目标解释归宿主。

宿主拥有共享导航时可省略 sidebar，实例只监听、渲染和销毁自己的 editor；独立 mountKanban 默认仍创建侧栏。createBoard/lookupReference 提供语义命令，committed 只通知已成功提交的变更，宿主不得用模拟点击接入。父项详情按 parentId 有界分页读取子事项，新建子事项预填合法工作类型与父项，父子关系和依赖关系分别校验。
