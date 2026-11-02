# @itookit/mdx-adapter

NestOS 对独立 `@itookit/mdxeditor` 的适配层。使用 tsup 构建 ESM、CJS 和类型声明。

## Responsibilities

- `src/factory.ts`：接收 `ui-common` 的 `EditorOptions`，先校验 namespace/Session，再构造核心公共接口；文件后缀推断和文件聊天按钮位于这里。
- 公共 `htmlPolicy` / `scrollMode` 原样转发到 mdxeditor，不在适配层设置对话角色或显示策略。
- `src/assets.ts`：将授权 `IFileSystem` 转成 `AssetProvider`，拒绝附件路径穿越。
- `src/document-host.ts`：文档打开、重命名和通知适配。
- `src/metadata-store.ts`：插件元数据持久化，文档路径随重命名/移动更新；`entries(prefix)` 支持按 key 读取。
- `src/srs-store.ts`：`cloze:memory` 使用笔记 nav 内统一的 `/.nestos/cloze-srs.seq`，key 为编码后的文档相对路径 + `#` + 插件 key。首次实际渲染 cloze 时登记 `$document` 计数及摘要，不生成评分状态；首次评分才逐卡写入。后端 `app-core/vfs/cloze-lifecycle` 监听笔记 nav 文件视图，事务更新重命名/移动的路径 key，删除文件/目录时清理对应条目；不支持跨 nav 迁移。旧元数据只读兼容，实际评分时由核心迁移被修改的卡片；后端无 seqFiles 时回退节点元数据。
- `src/asset-manager.plugin.ts` / `src/asset-manager.ui.ts`：附件管理 UI、删除确认与生命周期。
- `src/print.ts` / `src/conversation-print.ts`：VFS 打印适配与会话格式处理。

核心只能使用自己的公共接口，不得反向依赖适配包或其他内部包。新增宿主业务逻辑放在这里。消息 ID、Session 和权限上下文不得进入核心契约。

运行：`pnpm --filter @itookit/mdx-adapter typecheck` / `test` / `build`。

文件窗口入口经 EditorOptions.mountWindowList → core:titlebar.mountActions 加入编辑器已有标题栏；插槽通过公开 data-editor-mobile-navigation 标记接管手机导航并在销毁时释放。适配层启用 overflowActions，把次要按钮收进原标题栏更多菜单；不再在编辑器之外加同名标题栏。

标题栏 presentButton 通过公开按钮挂载钩子接入响应式显示：手机返回图标、桌面侧栏图标；点击仍经过编辑器原有重命名/保存屏障，再委托宿主导航。

更多菜单顺序通过公开 `actionOrder` 声明（`data-button-id`），适配层不再移动标题栏内部节点；`core:titlebar.enableAssetManager` 是宿主私有开关，仅在 `defaultPluginOptions` 中透传。

Markdown 文件默认通过 defaultEditorFactory 以 render 模式打开，大文件语法预算不能强制改成 edit；显式 initialMode 仍保留。纯文本继续源码显示，不启用 Markdown 解析。

`src/study.ts` 提供 StudyHost 的 VFS/seqfile 适配和工作区 IEditor 包装；文档来源只来自 seqfile 中已跟踪的 Markdown/笔记，不遍历未跟踪目录；隐藏目录排除。管理视图与正文共用 `createAdapterStore`，首次评分才写入复习状态。

复习历史是核心卡片 payload 中的 history 字段，适配层按原值存取；评分与历史共用一次 seqfile 写入，不新增宿主数据库协议。目录迁移和文件删除沿用整条记录的生命周期，读取学习曲线不创建记录。

`src/study-index.ts` 在首次 cloze 激活后持久登记文档计数、摘要和更新时间；旧逐卡状态也视为已跟踪。当前可见编辑器按文件增量更新，其他已跟踪文件每五分钟检查版本；正文只在版本变化后读取。管理器初次加载仍读取已跟踪正文以构建卡片，后续复用内存缓存。评分成功后定向刷新内存状态，跨客户端状态五分钟核对一次。所有订阅和计时器随编辑器/管理器租约释放。StudyEditor.activate 调用通用视图 refresh，mdxeditor 不依赖宿主事件类型。

createStudyHost/createStudyEditor 的可选 capabilities.creation 透传宿主新建/生成能力；创建弹窗及草稿交互属于 mdxeditor。适配包不内置 AI 提示或创建文件的业务模板。

提供 creation 时默认注入 src/study-prompt.ts 的 prompts.store（调用者可覆盖），以笔记 nav 的 /.nestos/cloze/prompt.md 保存提示词；缺文件只读返回空，用户显式保存时才创建。此配置不写复习 seqfile，隐藏路径事件不触发学习来源扫描；mdxeditor 只认识 load/save 接口。

命名提示词列表通过 prompts.store.list/saveList 存在 /.nestos/cloze/prompts.yaml；不读取旧 JSON。列表内容校验失败明确报错，禁止静默覆盖损坏配置。预设由 app-core/presets 初始化；显式系统恢复完整覆盖模板 YAML，正常启动保留已有内容。适配层不附带业务模板。

创建能力采用 documents/generation/prompts/recovery 分组；适配层只补齐 documents.directories 与 prompts.store，不解释生成错误码或取消策略。

完整 mountTitleBar 端口优先透传到 core:titlebar，复用原标题输入、经过重命名屏障的返回按钮及更多菜单；提供完整布局时不再重复 mountWindowList。mdxeditor 只声明通用节点插槽，公共 UI 与路由实现仍由宿主注入，不引入 ui-common 依赖。
