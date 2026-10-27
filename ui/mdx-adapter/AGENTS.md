# @itookit/mdx-adapter

NestOS 对独立 `@itookit/mdxeditor` 的适配层。使用 tsup 构建 ESM、CJS 和类型声明。

## Responsibilities

- `src/factory.ts`：接收 `ui-common` 的 `EditorOptions`，先校验 namespace/Session，再构造核心公共接口；文件后缀推断和文件聊天按钮位于这里。
- 公共 `htmlPolicy` / `scrollMode` 原样转发到 mdxeditor，不在适配层设置对话角色或显示策略。
- `src/assets.ts`：将授权 `IFileSystem` 转成 `AssetProvider`，拒绝附件路径穿越。
- `src/document-host.ts`：文档打开、重命名和通知适配。
- `src/metadata-store.ts`：插件元数据持久化，文档路径随重命名/移动更新。
- `src/asset-manager.plugin.ts` / `src/asset-manager.ui.ts`：附件管理 UI、删除确认与生命周期。
- `src/print.ts` / `src/conversation-print.ts`：VFS 打印适配与会话格式处理。

核心只能使用自己的公共接口，不得反向依赖适配包或其他内部包。新增宿主业务逻辑放在这里。消息 ID、Session 和权限上下文不得进入核心契约。

运行：`pnpm --filter @itookit/mdx-adapter typecheck` / `test` / `build`。

文件窗口入口经 EditorOptions.mountWindowList → core:titlebar.mountActions 加入编辑器已有标题栏；插槽通过公开 data-editor-mobile-navigation 标记接管手机导航并在销毁时释放。适配层启用 overflowActions，把次要按钮收进原标题栏更多菜单；不再在编辑器之外加同名标题栏。

标题栏 presentButton 通过公开按钮挂载钩子接入响应式显示：手机返回图标、桌面侧栏图标；点击仍经过编辑器原有重命名/保存屏障，再委托宿主导航。

Markdown 文件默认通过 defaultEditorFactory 以 render 模式打开，大文件语法预算不能强制改成 edit；显式 initialMode 仍保留。纯文本继续源码显示，不启用 Markdown 解析。
