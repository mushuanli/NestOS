# @itookit/app-settings

设置 UI 模块 — 全局配置、日志、存储、标签、联系人、数据恢复、外观和系统 VFS 浏览。

依赖（peer）：`@itookit/common`、`@itookit/driver-llm`、`@itookit/vfs-core`、`@itookit/ui-common`、`@itookit/vfs-ui`、`@itookit/mdxeditor`。LLM 设置编辑器来自 `@itookit/llm-settings-ui`，经 `LLMUIEditors` 接口注入（避免上行依赖）。

## Architecture

```
src/
├── index.ts           ← createSettingsNavigation() + 导出
├── editors/           ← 8 个设置编辑器（本包自有）+ system-fs/ storage/ log/ 子模块
│   ├── SystemFSExploreEditor.ts  ← 跨模块只读 VFS 浏览（调试页，经 system-fs/ 组装视图）
│   ├── Storage/Tag/Contact / Recovery/Log/About
│   └── Appearance     ← 浅色/深色/跟随系统 主题切换，写入 /ui/theme.json
├── engine/            ← SettingsEngine（只读导航投影）
├── factories/         ← createSettingsFactory (nodeId → editor 路由)
└── styles/            ← settings CSS (_appearance.css, _cost.css 等)
```

## 关键点

- `createSettingsFactory()` 先经 `resolveSettingsSlug()` 把 nodeId（VFS path 或 slug）归一为分类 slug，再按 slug 路由到对应 editor，未匹配时返回 placeholder
- `SettingsEngine` 把 `SETTINGS_PAGES` 映射为只读虚拟文件节点；技能文件系统归 [后端技能文件系统](../../backend/app-core/src/configuration/skills-files.ts)，UI 通过后端端口使用
- `SystemFSExploreEditor` 经 `createSystemFileInspector()` 组装只读视图：`/dev` 挂载设备描述，`/workspaces/<name>` 挂载各工作区文件系统
- `SystemFSExploreEditor` 的 MDX 文件编辑器按需导入；设置模块初始化与 VFS 列表显示不加载正文编辑器代码。
- `LLMUIEditors` 注入 5 个编辑器（来自 `@itookit/llm-settings-ui`）：Provider / Connection / MCP / Cost / SystemPrompt；Skill / Agent 编辑器由 llm-ui 的 skills/agent 工作区直接使用，不经过本包
- `AppearanceSettingsEditor` 写入 `/ui/theme.json`，通过 `app:theme-change` 事件广播

运行: `pnpm --filter @itookit/app-settings build`（`dev` 为 watch 模式）

[架构设计](./Architecture.md)

文件系统与系统恢复页通过 createSettingsFactory 的可选 InitialFilesPort 提供初始文件清单与勾选恢复。initial-files.ts 负责折叠分组、默认全选、存在状态与逐文件结果；系统恢复页由顶部统一提供选中项恢复和全局状态刷新，不重复展示文件级操作按钮，刷新保留勾选与展开状态；每个笔记/Flow/Provider/Connection/Agent 折叠组标题旁的全选仅影响本组；app-shell 注入 app-core 的 MindosInitialFiles，写入当前笔记文件系统并经原 Flow 命令恢复工作流。设置包不依赖 app-core 或 Flow 运行器。旧 restoreFlows 回调保留兼容；初始文件恢复与 Provider/Connection/Agent 强制重置分开。

mindos-node 连接统一由工具箱 MCP 管理，StorageSettingsEditor 只负责存储维护。MCP 编辑器通过中立 ConfigurationFormControls 接收宿主字段与操作，不使设置包依赖 app-core。

- createSettingsNavigation 只生成本地设置目录；编辑器消费已就绪的 SettingsPort，不调用服务 init。backend.settings 在后端完成联系人和标签定义加载；工作区来源仅传身份或已有文件视图，需要导出、标签统计或系统浏览时才打开。持久化与标签存储归 app-core/settings，数据库快照与存储估计归宿主适配。禁止将 IndexedDB、存储复制或 Runtime 创建重新放入 UI。
