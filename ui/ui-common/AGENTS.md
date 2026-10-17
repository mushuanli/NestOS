# @itookit/ui-common

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
- `EditorOptions.executorUsage` 是可选的最近使用展示端口；宿主拥有保存和订阅，编辑器只在提交获接受后记录，不在本包实现存储或改变 Agent 定义。
- 新增组件时同步补样式类；`pnpm styles:check` 会把无规则类名列为失败或计入允许清单。

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

- OcrSettingsForm 对相同配置保留输入 DOM 和保存反馈；失败替换内容后清除渲染缓存，下一次读取成功必须能恢复表单。
