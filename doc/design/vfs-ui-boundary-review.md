# VFS UI 机制与策略边界审查

日期：2026-09-26；独立包调整：2026-10-02。状态：职责隔离完成，当前 vfs-ui 仅依赖 vfs-core。

## 实施决定

2026-10-02 按独立发布要求进一步收敛：vfs-ui 仅依赖 vfs-core，移除 common、ui-common 和 immer。公开消费方契约归本包所有，与既有宿主接口结构兼容；基础展示有包内默认实现，宿主通过 presentation 注入翻译、图标和跟踪。MindOS 适配放在 app-shell；包内构建配置可脱离仓库脚本。状态更新显式复制受影响路径，保留历史快照和未变分支，动作通知顺序不变。

已实施：编辑器装配移到 app-shell，设置文件浏览器通过注入接入；移除重复 Options、文件类型接口及旧 Coordinator；宿主用语义方法替代 store.dispatch；新增 BrowserSource/BrowserNode/BrowserAction 与简明入口；源 ID 和 ResourceRef 分离，抽屉显式标识 group；统一动作执行边界并堵住底栏、行内删除和拖拽绕过菜单策略的路径；保留异步 Promise；版本化持久化和快照去重；作用域内 CSS reset；业务状态转为通用 presentation。

持久化边界（2026-10-01 落地）：`VFSUIOptions.persistence` 接受 `boolean | UIPersistencePort`。默认不写任何存储；`true` 显式选用包内 localStorage adapter（`createLocalStorageUIPersistence`），对象则由宿主提供 VFS / Tauri store 等实现。快照只含 `activeId` / `expandedFolderIds` / `selectedItemIds` / `uiSettings` / `isSidebarCollapsed` 并带 `version`，`readUISnapshot` 丢弃版本不符或字段损坏的记录。

宿主侧统一经 app-shell 的 `VfsJsonStore` 落到 `etc:/ui/`，与 `/ui/theme.json`、`/ui/toolbox-drawers.json` 同一处，可查看、可备份、可手工修复：浏览器快照 `/ui/<scope>.ui.json`（Session 侧栏、标准工作区、工具箱），工具箱过滤器与查询记忆 `/ui/mindos_toolbox_v1.preferences.json`，日志级别覆盖 `/ui/log-levels.json`。写入按文档串行排队；读取时逐字段校验，未知版本、损坏 JSON 与非法条目一律丢弃（日志级别只接受已知模块名与 `LogLevel`）。

原有项目/工具箱的高级配置保留，使用同一底层列表和状态。简明 source 入口适合新资源浏览；没有另起一套渲染器，也没有移除既有文件操作。当前具体 API 见 [组件接口](https://github.com/mushuanli/vfs-ui/blob/main/doc/components.md)。

以下保留原审查依据与后续演进取舍；“唯一直接依赖”和“移除 immer”现已实施，“所有高级调用改为 panes”仍非当前实现。

## 一、现状与问题

| 优先级 | 证据 | 问题与影响 |
| --- | --- | --- |
| 高 | [NodeList](https://github.com/mushuanli/vfs-ui/blob/main/src/ui/components/NodeList/NodeList.ts)、[ContextMenuHandler](https://github.com/mushuanli/vfs-ui/blob/main/src/ui/components/NodeList/handlers/ContextMenuHandler.ts)、[ItemActionHandler](https://github.com/mushuanli/vfs-ui/blob/main/src/ui/components/NodeList/handlers/ItemActionHandler.ts)、[DragDropHandler](https://github.com/mushuanli/vfs-ui/blob/main/src/ui/components/NodeList/handlers/DragDropHandler.ts) | 工具栏覆盖、菜单回调、行内删除、底部批量删除和拖拽分别分派；覆盖菜单不等于覆盖操作。底部批量删除直接执行 `bulk:delete`。业务授权、确认和删除语义容易不一致；底层只读检查仍然存在，不能仅凭静态分析断言已发生误删。 |
| 高 | [types](https://github.com/mushuanli/vfs-ui/blob/main/src/contracts/types.ts)、[ColumnState](https://github.com/mushuanli/vfs-ui/blob/main/src/shell/ColumnState.ts)、宿主 ToolboxWorkbench | `id` 同时是显示身份和文件路径；抽屉通过伪目录参与渲染，上层再展开成真实资源。ColumnState 与 Shell 根据 `/` 推导祖先。合成分组和真实目录尚未形成明确类型边界。 |
| 高 | [入口](https://github.com/mushuanli/vfs-ui/blob/main/src/index.ts)、[VFSUIShell](https://github.com/mushuanli/vfs-ui/blob/main/src/shell/VFSUIShell.ts)、[editor-connector](../../ui/app-shell/src/browser/editor-connector.ts) | 公共 API 继承 `ISessionUI`，包含会话命名、编辑器工厂、内容写入、任务统计及等待输入状态。树组件与编辑器装配边界混合。 |
| 中 | [CommandBus](https://github.com/mushuanli/vfs-ui/blob/main/src/interaction/CommandBus.ts)、[ports](https://github.com/mushuanli/vfs-ui/blob/main/src/contracts/ports.ts) | execute 返回 void，异步 handler 的 Promise 没有被等待；同步 try/catch 无法统一接住异步拒绝。难以集中处理 pending、错误、重复点击和操作完成。部分 handler 自行 catch，不能消除结构问题。 |
| 中 | [入口](https://github.com/mushuanli/vfs-ui/blob/main/src/index.ts)、[shell 入口](https://github.com/mushuanli/vfs-ui/blob/main/src/shell/index.ts)、[Shell](https://github.com/mushuanli/vfs-ui/blob/main/src/shell/VFSUIShell.ts) | Options 三处声明且字段不同；还有两套 FileTypeDefinition/ParseResult。上层直接访问 store.dispatch，内部 action 字符串成为事实上的 API。 |
| 中 | [ColumnLayout](https://github.com/mushuanli/vfs-ui/blob/main/src/shell/ColumnLayout.ts)、[templates](https://github.com/mushuanli/vfs-ui/blob/main/src/ui/components/NodeList/items/itemTemplates.ts)、[helpers](https://github.com/mushuanli/vfs-ui/blob/main/src/utils/helpers.ts) | 返回按钮使用“项目”，菜单使用 toolbox 翻译 key；隐藏所有单下划线前缀路径等规则内置在映射器中。业务词汇、资产目录约定与展示机制耦合。 |
| 中 | [main.css](https://github.com/mushuanli/vfs-ui/blob/main/src/styles/main.css) | 设置全局 `:root` 变量及 body/button/ul 等样式，会影响宿主；部分菜单依赖 Font Awesome 类名。仅拆 TS 依赖不足以成为独立控件。 |
| 中 | [persistence](https://github.com/mushuanli/vfs-ui/blob/main/src/contracts/persistence.ts)、[Assembler](https://github.com/mushuanli/vfs-ui/blob/main/src/shell/Assembler.ts) | 默认读写 localStorage，存内部状态结构，每次 store 更新都保存；持久化规则和状态版本应有明确边界。**已修正**：`persistence` 改为可注入端口，默认不写任何存储，宿主经 `etc:/ui/<scope>.ui.json` 持久化版本化快照。 |

已有的好基础：VFS 事件适配、懒加载目录、独立列选择、自然排序、批量选择、宿主投影和菜单注入都可复用。项目和工具箱的主要业务逻辑已在 app-shell 中，迁移应修正边界，而非推倒重写。

## 二、职责划分

| 留在 vfs-ui 的机制 | 上移的策略／装配 |
| --- | --- |
| DOM 渲染、树展开、抽屉外观、键盘与焦点、响应式单双列 | 哪些条目组成项目、服务商、MCP 或工具分类抽屉 |
| 懒加载、缓存、订阅与失效、选择状态、查询、稳定排序 | 文件入口排首项、禁用服务商靠后、会话家族关系 |
| 菜单、工具栏、多选栏、拖拽意图及统一动作执行 | 删除抽屉保留条目；删除提供商同时处理连接和 Agent |
| 普通 VFS 文件 CRUD 适配器、普通文件导入导出预设 | 工具箱 JSON、项目/session 归档、引用重映射及导入副本 |
| 显示摘要、徽标、标签和大纲的通用数据结构 | Markdown 解析、任务统计、HITL、模型状态含义 |
| 通用标签交互（以数据源能力为前提） | 特定资源允许哪些标签和操作 |
| 显式 UI 状态快照及可选存储接口 | 保存位置、命名空间、应用迁移和恢复策略 |

编辑器连接与媒体编辑器移至现有上层装配位置；若 app-shell 与 app-settings 均需复用，可在 ui-common 放只依赖结构接口的编辑器连接器，由调用方同时持有浏览器和编辑器。不得使 app-settings 反向依赖 app-shell，也不得形成 ui-common ↔ vfs-ui 循环。

## 三、关键抽象

### 1. 显示身份与资源引用分离

建议使用以下概念模型（提案，不是当前 API）：

```ts
type NodeId = string;
interface ResourceRef { viewId: string; path: string }
interface BrowserNode {
  id: NodeId;
  parentId: NodeId | null;
  kind: 'file' | 'directory' | 'group';
  label: string;
  resource?: ResourceRef;
  expandable: boolean;
  presentation?: {
    layout?: 'row' | 'drawer';
    description?: string;
    icon?: string;
    badges?: readonly { label: string; tone?: 'muted' | 'info' | 'warning' }[];
  };
}
```

- `id` 是稳定、不可解释的显示标识；只有 VFS adapter 能把自己的 ID 映射为文件路径。
- 普通文件／目录有 resource；纯分组可没有。虚拟分组绝不能自动进入文件删除／移动操作。
- resource 包含 viewId，防止不同挂载中的同路径混淆。实际执行仍使用已授权 IFileSystem，不通过引用扩大访问范围。
- 同一资源可以有多个显示节点；展开和选择按节点 ID，写操作由策略按资源去重。
- 使用 parentId/source 定位祖先，不对通用 ID 做 split('/')。
- 展开状态、子节点加载状态分别保存；空 children 不代表未加载。
- generic presentation 替代 `metadata.custom.navigationMenu`、`hasWaitingInput` 等隐式约定；业务对象由宿主持有，不要求 UI 理解。

### 2. 数据源只有一套读取协议

最小 BrowserSource 提供：`get(id)`、`children(parentId)`、`subscribe(invalidation)`；读取支持 AbortSignal。父链由 parentId 获得，reveal 遇到找不到的节点应明确返回失败。

包内 `fromVFS(fs, options)` 实现协议：FSNode 映射、根范围、懒加载、事件转换。项目/工具箱提供同协议的投影，不再迫使 renderer 接受整树变换后仍把 ID 当路径。缓存与共享事件订阅放在浏览器内部的数据层，各列引用同一数据源，但不共享查询、选择和展开状态。

搜索须明确：默认只搜索已加载节点；全量/远端搜索为可选 source.search 能力。不能靠隐式全树预加载伪装成全量搜索。

### 3. 一套动作服务所有入口

```ts
interface ActionContext {
  paneId: string;
  selection: readonly BrowserNode[];
  target: BrowserNode | null;
  parent: BrowserNode | null;
}
interface BrowserAction {
  id: string;
  label: string;
  placements: readonly ('toolbar' | 'menu' | 'selection')[];
  state(context: ActionContext): { visible: boolean; enabled: boolean; reason?: string };
  run(context: ActionContext, signal: AbortSignal): Promise<void>;
}
```

动作状态控制所有按钮、快捷键和拖拽映射。UI 在执行前重新校验，统一管理 pending、错误、完成和焦点；浏览器事件回调仍然可以是通知式，但有副作用的 action 必须可 await。确认可以由动作打开业务 modal；机制不再在第二处自行 confirm。

文件预设负责普通文件的 create/rename/delete/move/import/export；业务动作拥有完整语义。例如 delete-drawer 和 delete-provider 是不同动作，二者均可展示成删除入口。分组没有普通文件的默认动作。只读不等于不可导出，也不能替代逐动作能力判断。最终写权限仍由 vfs-core / 领域服务校验。

提供商删除应提取为上层动作，由抽屉菜单与编辑器共同调用。当前 `requestDelete` 通过打开编辑器触发确认可作迁移桥梁；长久保留会让导航依赖编辑器是否加载，不能成为新的核心契约。

拖拽只产生明确的 move/reorder 意图，交给同一动作策略。按字母排序的视图不默认允许手工重排。

### 4. 列只负责呈现独立视图

同一个 PaneOptions 同时适用于单列和双列；使用具名 panes 而非继续增长 navigationX/contentX 成对参数。共享资源缓存，每列独立维护 root/query/selection/expanded/sort。

上层监听 activate 决定打开编辑器、切换另一列 root 或执行其他业务行为。选中、展开、激活三者不能合并为 sessionSelected。仅支持当前确有需求的一列／两列，不扩张成任意工作区布局平台。

排序只有一个配置来源：`{ by, direction, foldersFirst, compare?, userChangeable }`。比较函数必须形成稳定顺序，最终用稳定 ID 兜底；active、最近点击时间不能隐式改变固定字母排序。

## 四、公共 API 与依赖目标

典型接入应保持简短，下面展示目标用法：

```ts
const source = fromVFS(fs, { root: '/' });
const browser = createVFSBrowser({
  container,
  source,
  actions: applicationFileActions,
  onActivate: node => { if (node.resource) openEditor(node.resource); },
});
await browser.start();
```

默认单列；`panes` 仅在双列时传入。普通文件操作预设提供可用的默认确认／输入流程，可注入宿主 dialogs；自定义业务完全替换 actions，不需要删除默认菜单中的字符串 ID。

公共导出限制为：构造函数、VFS adapter、文件动作预设及其契约类型。内部 Store、Service、CommandBus、Renderer 不再作为常规扩展接口。

Handle 提供生命周期、刷新、激活事件及按 pane 设置 query/selection/expanded/root 的语义方法；只读 snapshot 用于上层联动，不暴露 dispatch 和可变 Set/Map。`reveal` 明确是否激活，程序恢复与用户动作通过事件 reason 区分。

依赖迁移：

1. ui-common：移出编辑器/媒体/mention 宿主协议；浏览器拥有自身通用契约，不继承 ISessionUI。
2. common：应用传入本地化文案、图标及资源展示信息；保留独立可用的通用默认文案与图标。escape、debounce 等小型 DOM 工具本地维护，复杂 Markdown 解析不上移到 vfs-core。
3. immer：过渡期可保留；若严格要求唯一直接依赖，在状态拆小后改为明确的不可变 reducer。无需自行实现通用 produce。
4. 样式：根节点作用域内的 `--vfs-*` 默认变量，禁止全局 reset；宿主负责主题映射，不要求 Font Awesome 或 llm-ui CSS。
5. 持久化：默认不写本地存储，可选择包内 localStorage adapter 或宿主 VFS storage；只保存版本化 UI 快照，不序列化内部数据缓存。
6. 发布：核验 package exports、构建 external、生成 d.ts 的依赖图；不能只删除 package.json 依赖。CSS 以显式子入口引入。

## 五、渐进迁移顺序

1. 统一动作分派：先覆盖菜单、工具栏、底栏、行内按钮、快捷键和拖拽，保留旧 facade 适配。优先消除功能入口不一致。
2. 建立 BrowserNode/BrowserSource：普通文件 adapter 先接通；再迁移工具箱分组及项目投影，取消伪目录作为文件路径的假设。
3. 统一 Options 和 pane 状态：移除三套声明、store.dispatch 外泄以及成对列参数。保持现有交互验收。
4. 移出编辑器与业务装配，替换 common/ui-common 依赖；落实样式及持久化边界。
5. 迁移 Workbench、SystemFSExploreEditor、SessionWorkbench、ToolboxWorkbench；清理兼容层、旧 Coordinator、重复类型及多余 exports。最后移除 immer。

兼容层放在应用侧，不在最终独立包中保留依赖 common/ui-common 的 legacy 子入口。每一步都可运行现有应用；不同时重写项目、会话和文件存储格式。

## 六、验收标准

- 仓库外最小页面：只安装 vfs-ui 与 vfs-core，引入 CSS，即可浏览文件；构建和类型声明不引用其他 itookit 包。
- 两实例、双列独立选择/搜索/展开，切换不乱序，销毁后无事件/异步结果回写；懒加载和快速切换无旧结果覆盖。
- 每个操作入口走同一动作；隐藏/禁用/确认/pending/错误一致。失败可观察，不因 handler Promise 遗失而静默。
- 合成分组不触发 fs.delete；只读节点允许读和导出；前端能力不会绕过后端权限。
- 提供商删除及三种 Agent 处理、普通抽屉删除保留条目、归档导入导出，继续由上层测试验证。
- 项目文件入口固定首项、父子会话、工具箱固定排序、移动端触屏菜单与键盘操作无回归。
- CSS 不改变宿主按钮、列表和 body；持久化有 scope/version，损坏或过期 ID 可恢复。

本轮已实施上述“实施决定”中的边界收敛；原审查表记录的是改动前状态。独立接入允许稳定公共库依赖，不能再用“只有 vfs-core”判断是否通过。
