# 应用策略、机制与模块接口

## 模块归属

| 模块 | 拥有的职责 | 对外入口 |
| --- | --- | --- |
| app-core/configuration | 工具箱创建、定义交换、引用重映射、分组存储与目录；模型关联删除、Agent 工具授权 | ToolboxResources、ToolboxDrawers、ModelConfigurationCommands |
| app-core/projects | 项目目录与会话归属、组织查询和命令、项目归档 | ProjectService、ProjectSessions、ProjectTarget |
| llm-session/persistence | 关系事务、循环/项目边界检查、写租约守卫、删除意图 | ISessionRepository、SessionDeletionStore |
| app-shell/projects | 项目和同组列表、正文装配、业务目标与导航路径转换 | createProjectModule |
| app-shell/toolbox | 分类、抽屉展示、资源编辑器装配及模块生命周期 | createToolboxModule |
| app-shell/configuration | 删除影响展示与用户选择 | ConfigurationDeletionDialog |
| app-shell/browser | 文件编辑器连接、保存、媒体预览 | connectEditorLifecycle |
| vfs-ui | 列表/双列、选择、排序、异步动作执行 | BrowserSource、BrowserAction、VFSUIShell |

公共库与 immer 继续复用。按业务能力归组内部文件，不新增包或第二套资源渲染器。

## 外部业务扩展与通用机制

新增非通用业务通过独立工具包与 Flow 定义显式接入。以 [Anki 方案](anki-flow.md)为例，确定性补缺/覆盖规则、卡片模板、分组与打包代码、业务回执由 `tools/anki-cli` 业务包维护；提示词与编排只有一份应用资源声明源 `app-core/src/presets/anki-generate.json`，通过产品目录提供安装和系统恢复。资源可以由应用携带，业务执行仍经外部 Tool 接入；核心不按业务名称分支。恢复后的 Flow 属于内部资源，可以由 Agent 引用。需要运行时，宿主按配置加载 Tool 工厂；用户已有定义、发布版本和手动分组保留。平台只提供同 Flow Task 资产读取、授权二进制文件 I/O 等通用端口，不解释卡片字段。

平台提供确定性 Tool 节点、注册/发现、版本与连接绑定、Schema、权限、取消、持久执行、恢复分派及通用资产/资源导入。Tool 同时可由 Flow 和 Agent 调用，不等同于模型自主选择的调用入口。核心通过契约分派到外部实现，不按具体工具名增加业务分支；HTTP 等宿主限制由外部清单声明，平台负责通用校验。

恢复调度属于平台，副作用的业务核对由工具实现。应补充通用生命周期扩展，不能为了绕过 Tool 恢复缺口将每个业务改成内置专用 Effect。外部工具包独立发布与按配置装配，不自动进入平台默认构建；应用产品目录可显式选择声明式 Flow 作为可恢复资源，恢复定义本身不加载工具包或执行模型请求。

## 当前改动的 C4 组件边界

以下是当前源码的模块关系，不表示每个 package 都是独立进程。Web、Tauri、CLI、HTTP 的宿主装配方式不同，执行机制共用。

```mermaid
C4Component
    Container_Boundary(platform, "itookit：由宿主装配的通用运行时") {
        Component(ui, "交互与展示", "ui/*", "参数、连接选择、工具箱、目录与运行结果")
        Component(app, "应用用例与装配", "backend/app-core", "资源目录、配置操作、宿主能力注入")
        Component(session, "会话与连接准入", "backend/llm-session", "调用身份、连接绑定、能力校验与快照")
        Component(flow, "图编排", "backend/llm-flow", "解释声明图、构造任务、统一能力启动")
        Component(program, "持久程序", "backend/llm-tasks + kernel-adapters/programs", "Agent、Tool、媒体状态机")
        Component(kernel, "持久执行", "libraries/durable-kernel", "授权句柄、日志、调度、取消与恢复")
        Component(adapter, "能力适配", "backend/kernel-adapters/effects", "模型通信、工具分派、媒体回执与资产")
        Component(tools, "工具契约与注册", "backend/tools", "版本、Schema、受限上下文、invoke/reconcile")
    }
    Component_Ext(extension, "外部业务实现", "独立 Tool 包与 Flow 定义", "业务字段、提示词、模板、打包和副作用核对")
    System_Ext(provider, "模型服务", "Chat、图片、语音的已声明端点")
    Rel(ui, app, "经 app-contracts 消费应用端口")
    Rel(app, session, "装配并注入服务")
    Rel(app, tools, "宿主通过 additionalTools 注入实现")
    Rel(session, flow, "编译完整准入图，持久化后提交")
    Rel(flow, program, "构造 Task 输入")
    Rel(program, kernel, "声明 Effect 与等待")
    Rel(kernel, adapter, "执行、取消、核对")
    Rel(adapter, tools, "按版本分派工具")
    Rel(tools, extension, "调用已注册处理器")
    Rel(adapter, provider, "使用冻结的模型身份与能力要求")
```

工具实现由宿主注入；图中的处理器调用不构成核心对外部业务包的静态依赖。媒体 Effect 是通用模型通信能力，不能承载业务字段、制卡步骤或业务媒体选择策略。

### 2026-10-16 工作树审查

审查开始时已有 129 个受版本管理文件的改动，另有新增文件。文件数来自跨层契约传播和多项工作混合，不能据此认定每处修改都必要。

| 改动组 | 判断与处理 |
| --- | --- |
| Tool 节点、版本、结构化结果与 reconcile | 确定性调用的执行链；插件、Program、Effect、工具服务各有职责，保留 |
| 媒体节点、连接槽、快照与资产回执 | 通用模型能力；Agent 节点要求及同槽多节点要求也必须参加准入，已修正遗漏 |
| 内置业务入口移除 | 提示词、模板、工作区、宿主初始化和演示要同步移除，避免只隐藏 UI；现有用户文件保留 |
| Skill 投影迁至后端、工具箱导航读模型 | 修复前端拥有服务订阅/后端回读前端文件系统的边界问题，可独立交付；YAML 是显式允许的无平台 I/O 编解码依赖 |
| 目录快照、面包屑、独立库版本更新 | 导航优化，可与执行机制分开提交；不属于外部 Tool 接入的必要前置 |

本次只集中修补准入遗漏、架构检查和重复流程：能力启动判定统一放在 `llm-flow/flow/task-capabilities.ts`；纯计算/媒体节点不再无条件查询工具目录；历史测试改用中性的外部文件类型。没有新增扩展市场、业务队列或第二套 Runtime。

外部包安装/完整性锁定、宿主要求匹配、业务产物导出并未形成完整交付；`additionalTools` 是注入端口，不能宣称已经实现这些安装与部署能力。现有流程仍有兼容路径，本轮不以大规模重写掩盖这些缺口。

### 2026-10-22 Flow 产品资源与业务执行解耦

`app-core/presets/flow-library.ts` 返回新版作文 `essay-review` 与合并后的 `anki-generate`，启动播种和系统恢复共用该目录。作文源码和恢复文件名统一为 `essay-review`，保留新版隔离评审逻辑，不再安装 `essay-review-isolated`；存量文件及其发布版本保留，同名旧版文件不会被覆盖。Anki 的主流程与三个内联函数只维护在应用 JSON 中，工具包集成验收读取此唯一源。默认 Flow 抽屉为空；`ToolboxResources` 仍接受宿主注入的通用分组，也支持用户手动分组及归档往返。`FlowLibraryCommand.Restore` 接受显式传入的定义，按顺序发布新恢复的可调用版本；主定义通过通用 `functions` 数组携带内联函数，只安装主资源，不把局部函数独立安装到全局库。跨文件定义仍可按被调用方在前的顺序显式恢复。已有用户草稿与发布版本不被重复恢复覆盖。

通用恢复、依赖锁定和分组测试使用中性 Flow 夹具；产品目录测试另验证 Anki 在真实系统恢复页面可见、只恢复一个主文件及保留用户修改。普通 app-core 与 app-shell 测试不读取 Anki 子模块源码或加载 Rust 工具，业务执行集成验收由外部包显式运行。

### Agent 的 Flow 执行绑定

Agent 的 `execution.kind: flow` 引用内部注册 Flow 的 ID 和可选修订号，不依赖源码目录，也不要求 Flow 反向定义 Agent。宿主注入实际插件目录和资源观察端口，派生 `availability`；删除文件后禁用新调用，恢复并发布后重新核对，状态不写回 Agent 源文件。默认跟随最新发布，未发布编辑不影响已发布调用；参数表单每次读取所选修订的签名。Agent 归档携带所引用的发布 Flow 和跨文件依赖，内部局部函数身份保留。执行、队列冻结、提示词与恢复均复用通用 Flow/Kernel，详见[调用契约](flow-invocation-composition.md#agent-引用内部-flow)。

## 配置写操作

运行时创建唯一 `runtime.configuration`，设置页面与工具箱共用它。

Provider 删除先调用 `inspectProviderDeletion(ids)` 得到受影响 Provider、Connection 和预览标识，再由原确认弹窗调用 `deleteProviders({ revision })`。当前用例不提供 Agent 保留、删除或替换选择；应用服务在写入前重读 Provider/Connection 依赖并验证预览，同一运行时的删除命令串行执行。

执行顺序为删除连接、删除服务商。底层配置存储不构成跨实体原子事务；部分失败抛出 `ConfigurationMutationError`，带有已完成步骤与原始错误。可以重新打开预览，根据当前数据继续操作。此实现不是持久化删除任务，也不宣称阻止绕过该入口的其他宿主并发写入。

UI 通过 `EditorHostContext.requestDelete(targets)` 请求确认和执行。列表直接调用相同确认界面，不打开或等待编辑器。IEditor 不包含删除能力。Modal 等待异步确认、防止重复确认并显示失败；失败时保持弹窗可见。

工具授权由 app-core 的 `saveToolGrant` 解释默认值并更新 Agent capabilityPolicy；UI 仅读取现状、选择 Agent 与提交启用状态。运行时访问检查仍由既有授权系统执行。

## 分组与展示

ToolboxDrawers 私有保存持久状态和资源目录。`setCatalog` 更新已发现的资源及默认分组；`snapshot/list/get/forPath` 生成可供调用方独立使用的查询结果。自定义归属、默认分组与未分组规则统一在服务中计算。

资源扫描在模块加载/刷新时完成，不依赖渲染。`resourceDrawers` 仅将查询快照与显示节点合并；切换筛选、搜索或重绘不会写入分组状态。重命名的同名校验与保存处于同一串行修改队列。源资源重命名仍通过事件更新归属。

模型按服务商关联分组、工具按用途/来源分组、自定义抽屉按用户归属分组；这些规则不合成一个通用目录 CRUD 接口。现有只读 VFS 投影保留，以兼容文件编辑器、归档和工作台适配；其创建与释放由工具箱模块负责，不由 bootstrap 分散管理。

## 项目与会话

ProjectService 不公开 repository 或目录挂载服务；通过 projects.sessions 提供 navigation、family、moveCandidates、rename、reparent、create、createChild、get。项目导航与同组菜单共用这些查询，不各自维护权威父子状态。查询用于界面，写入仍在 SessionRelations 事务内重验循环、项目归属、待删除状态与关系修订。

SessionDeletionStore 是必选契约，不能通过缺少 prepareSessionDeletion 或写守卫静默跳过删除恢复步骤。运行时恢复和 UI 删除仍调用同一 SessionLifecycleService。

项目归档输入输出使用 ProjectTarget：projectId、sessionId、项目内文件路径或组织分组路径。`folder:`、`@files` 与 URL 编码只在导航/VFS 适配边界解释；归档业务用例不接受这些显示路径。导入继续验证完整归档并补偿本次创建的资源，不改变会话物理存储布局。

## 装配与能力

WorkspaceController 只要求启动、打开、当前目标和销毁；创建由 WorkspaceCreation 单独声明。等待输入通过会话事件回调连接，不要求工具箱提供空实现。

createSettingsFactory 使用具名 SettingsFactoryOptions 注入服务、编辑器、文件连接器、删除交互与恢复操作。createToolboxModule 聚合工具箱目录、资源服务、编辑器工厂及释放顺序。Web/Tauri 使用相同模块；CLI 可直接调用无 DOM 的应用服务。

createProjectModule 聚合项目工作台、记忆管理交互与等待输入事件订阅。SessionWorkbench 使用具名 SessionWorkbenchOptions；有项目和兼容无项目模式都通过 ProjectSessions 创建会话，不在 UI 中直接调用 repository.createSession。

项目与工具箱返回相同 WorkspaceModule。它只暴露 WorkspaceHandle 与 dispose，不暴露具体工作台类。路由通过可选 restoreResource 能力恢复失效书签，普通 openResource 保留错误语义；bootstrap 不识别具体工作台类型。模块把事件订阅、目录投影和编辑器的生命周期放在一起，工作区动态移除与应用退出共享同一个释放 Promise，失败仍向调用方传播。

## 可执行的边界

`pnpm architecture:check` 检查 ui/backend/shared/libraries/apps 的生产源码静态依赖与 dependencies/peerDependencies，并运行检查器的边界用例；`pnpm test` 与 `pnpm test:matrix` 将它作为前置检查。

- app-core 只依赖明确列出的平台无关能力，不直接引入 Node 内建模块、DOM 或浏览器存储。
- 能力包不能反向依赖 app-core、app-shell 或 app-settings，包不能依赖 app 宿主。
- 跨包引用使用 package.json 声明的公开出口，禁止跨包相对路径与未公开子路径；类型引用、动态 import 和 re-export 同样检查。
- app-core 的公共出口使用具名导出，辅助算法与工具授权写入实现保留在模块内部。

app-settings 仍属于应用功能包；apps/demo 是使用部分历史 API 的 Vite 演示宿主，按宿主检查，其他包不能依赖它。测试夹具不受生产源码检查约束。检查器是静态边界守卫，不能代替业务职责审查，也不分析运行时拼接的模块名或任意反射访问。

## 原生用量与费用

原生适配器拥有计量协议的解释、恢复与去重；价格和供应商默认价不进入 nestos-node 或 nestos-node-driver。定价解析和算术位于 kernel-adapters 的纯 contracts 入口，模型目录与默认金额只通过产品 presets 或用户配置提供。app-core 在装配时注入估算器，按会话 revision 缓存估算并随定价快照失效；没有估算器时仍可浏览和操作会话。

远程原生历史估算与本地已入账调用是不同来源：展示携带 transcript 范围和估算标识，不把含继承历史的分支估算累计进费用账本。前端不选择价格、不猜模型归属，也不依赖原生协议或日志文件。

Flow 库恢复时是否发布修订属于应用策略，由 app-core/presets/restore-flows.ts 显式协调；核心 DraftRestore 保持只恢复草稿。图片上传限制由字段声明，Agent 使用标准多模态消息内容契约，声明模板与历史快照分开处理。
