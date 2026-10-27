# @itookit/ui-common

OcrSettingsForm 已挂载的字段在后台读取失败时保留 DOM 和程序赋值，仅更新错误状态与重试入口；不能以网络错误清空草稿或改变恢复表单结构。form-recovery 只记录字段数量和结构差异位置，不记录字段值或设置密钥。

OcrSettingsForm 可通过可选 selectionChanged 回调向宿主提供当前连接 ID 和选择控件所在容器，供宿主挂载相邻操作；syncSelection 在恢复表单值后同步这些操作，不触发保存。共享组件不持有工具箱路由。

共享 **UI 契约与基础组件**：编辑器接口（`IEditor`/`IEditorFactory`）、Session 视图接口（`ISessionUI`）、可复用的原生 DOM 组件（`Modal`/`Toast`/确认框）、设置编辑器基类与剪贴板工具。供 `app-settings`、`app-shell` 等 UI 装配层复用。技术栈为原生 DOM + TypeScript，无前端框架。

## 定位与铁律

- **不依赖具体实现**：只依赖 `common` 与 `vfs-core`；不得依赖 `app-shell`、`vfs-ui`、`mdx`、`llm-ui`、`app-settings` 或任何 app。
- **接口优先**：跨层能力以接口声明（`IEditor`、`IEditorFactory`、`ISessionUI`），实现由宿主注入；组件只做 DOM 与事件，不直接访问 VFS。
- **无用户文案硬编码**：可见文案用 `t('domain.section.item')`（key 在 `@itookit/common` 的 `i18n/zh-CN.ts` → `en.ts` 同步）。
- **样式遵循 BEM**：类名与 `ui/*/src/styles` 保持一致，新增类需通过 `pnpm styles:check`。
- 无框架、无构建期 CSS 处理：`build` 由 tsup 产出类型与 ESM/CJS，宿主负责样式打包。

## 结构

```
src/
├── index.ts                     根导出（接口 + 组件 + 工具）
├── interfaces/
│   ├── IEditor.ts               编辑器契约：EditorOptions/EditorTarget/EditorEventMap/
│   │                            normalizeEditorOptions/editorFilePath/editorResourceId
│   ├── IEditorFactory.ts        按目标类型创建编辑器的工厂
│   └── ISessionUI.ts            Session 视图契约：菜单/上下文菜单/标签编辑器/事件
├── components/
│   ├── BaseSettingsEditor.ts    设置编辑器抽象基类（统一渲染/生命周期/host context）
│   ├── UIComponents.ts          Modal / Toast / showConfirmDialog
│   └── responsive-actions.ts   按容器宽度在工具栏与菜单间移动原按钮，返回释放函数
└── utils/
    └── clipboard.ts             copyText()（带回退的剪贴板写入）
```

## 入口

```ts
import { Modal, Toast, showConfirmDialog, ISessionUI, IEditor } from '@itookit/ui-common';
```

`BaseSettingsEditor<TService>` 是设置类编辑器的推荐基类：子类实现渲染与保存，基类负责 DOM 挂载/卸载与 host context 传递。

## 约束

- 组件不得假设宿主环境（浏览器/WebView/jsdom 均可运行）；不得使用 `node:*`。
- 事件与回调类型从接口导出，宿主与实现共享同一份类型，避免各自声明漂移。
- `EditorOptions.mountMoreMenu` 是宿主更多菜单挂载端口，返回清理函数；编辑器控制菜单布局和关闭行为，宿主控制资源业务与元数据。
- `EditorOptions.mountCompactNavigation` 挂载小屏宿主导航，返回清理函数。支持嵌入导航的编辑器公开 data-editor-mobile-navigation="embedded"；输入容器用 data-editor-composing 标识编辑状态。宿主只消费这些语义标记，不访问业务编辑器内部 DOM。
- `EditorOptions.onStartConversation` 打开当前资源对应的宿主聊天工作区，不提交消息；编辑器先保存当前草稿，宿主拥有目标项目、执行者及草稿复用策略。该可选端口不引入聊天领域或后端依赖。
- `EditorOptions.executorUsage` 是可选的最近使用展示端口；宿主拥有保存和订阅，编辑器只在提交获接受后记录，不在本包实现存储或改变 Agent 定义。
- 新增组件时同步补样式类；`pnpm styles:check` 会把无规则类名列为失败或计入允许清单。
- `setTimePresentation` 统一原生 time 元素的本地化显示、datetime 与 title；缺失、非正数和无效时间清理旧属性并使用调用方的缺失提示。本地与远程会话的创建时间、最后活动共用该工具，不使用页面读取时间填补。

## 运行

```bash
pnpm --filter @itookit/ui-common typecheck
pnpm --filter @itookit/ui-common build        # tsup
```

本包**没有独立测试套件**；使用方（`app-settings`、`app-shell`）在 jsdom 下覆盖组件行为。新增有分支逻辑的组件时，应在使用方补一条 jsdom 回归。

## 相关文档

| 文档 | 内容 |
|---|---|
| [接口契约](../../doc/interface-contracts.md) | UI 体系接口与实现/消费关系 |
| [架构设计](../../doc/architecture.md) | UI 层在整体分层中的位置 |
| [开发模式](../../doc/dev-patterns.md) | i18n 与新增 UI 的流程 |

`EditorOptions<TSubmission>` 与 `SessionDraftControls<TSubmission>` 通过泛型传递宿主提交数据，默认 unknown。本包不依赖 Flow 或 Session；LLM 编辑器适配层负责指定 SessionSubmission。

发布出口使用 dist/index.js（ESM）、dist/index.cjs（CJS）及相应声明；publishConfig.exports 必须覆盖工作区的 src 出口。

EditorOptions 的第二个泛型参数描述编辑器专属 initialData，本包不解释领域结构；IEditor.activate 供宿主恢复缓存视图的绑定。业务读模型与执行策略不进入 ui-common。

- SessionDraftControls.refresh 是可选宿主端口：确认旧草稿提交后返回新的草稿控制对象，不让编辑器自行跟随或覆盖共享存储。

- ConversationMessage.commandOutput 只表达原生命令的预览、不可变内容引用及独立可用性错误；不等于 Task Artifact 或新的执行事实。readCommandOutput/loadCommandOutput 是可选只读端口，纯 DTO 不导入 driver 实现；resultError 表示已持久提交但结果身份待核对，不能降为可重发的拒绝。

- OcrSettingsForm 对相同配置保留输入 DOM 和保存反馈；失败替换内容后清除渲染缓存，下一次读取成功必须能恢复表单。

- EditorOptions.mountWindowList 向已有编辑器标题栏挂载宿主窗口切换按钮并返回释放函数；它与用于聊天完整导航的 mountCompactNavigation 分开使用，避免重复标题和侧栏按钮。

- installNavigationButtonPresentation 只管理标题栏按钮的响应式图标及 title/aria-label：手机返回上一页、桌面侧栏切换；不持有浏览器历史、不替换原点击处理器。宿主拥有返回行为，销毁时释放媒体查询监听。

EditorOptions.mountSettings 让宿主挂载业务偏好，返回 isDirty/flush/destroy；配置编辑器在导航、重绘和销毁前保存，失败保留输入。SessionDraftControls.scope 仅表达项目展示候选及选择回调，executorScope 区分本地/远程候选，持久归属与选择策略由宿主提供。

- SessionDraftControls.scope.select 可携带 SessionDraftPreferences；settings 对通用导航保持不透明，由目标输入编辑器验证和应用，不引入 LLM 领域依赖。

- SessionDraftMaterialization.createEditor 是 UI 内部的显式控制器工厂；宿主准备 EditorOptions 后调用它，保持视图所有权，不经应用 RPC 传输 DOM 或工厂。

IEditor 的 captureRecovery/restoreRecovery/suspendForRecovery 为显式本地视图恢复契约，不能提交操作。BaseSettingsEditor 的表单恢复需子类显式开启并交接额外模型状态；表单值（包括密钥）仅在内存中交接，不写浏览器存储、不记录日志，恢复不派发 input/change 事件或自动保存。不支持的可编辑表单保留旧页并说明原因。

ConversationControls 仅描述宿主能力与投影，不拥有原生 SDK。查询目录、独立控制回执和输出引用分别表达；结果可读性、控制已接纳和实际停止不可互相替代。
