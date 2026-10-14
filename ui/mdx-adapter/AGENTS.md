# @itookit/mdx-adapter

MindOS 对独立 `@itookit/mdxeditor` 的适配层。使用 tsup 构建 ESM、CJS 和类型声明。

## Responsibilities

- `src/factory.ts`：接收 `ui-common` 的 `EditorOptions`，先校验 namespace/Session，再构造核心公共接口；文件后缀推断和文件聊天按钮位于这里。
- `src/assets.ts`：将授权 `IFileSystem` 转成 `AssetProvider`，拒绝附件路径穿越。
- `src/document-host.ts`：文档打开、重命名和通知适配。
- `src/metadata-store.ts`：插件元数据持久化，文档路径随重命名/移动更新。
- `src/asset-manager.plugin.ts` / `src/asset-manager.ui.ts`：附件管理 UI、删除确认与生命周期。
- `src/print.ts` / `src/conversation-print.ts`：VFS 打印适配与会话格式处理。

核心只能使用自己的公共接口，不得反向依赖适配包或其他内部包。新增宿主业务逻辑放在这里。消息 ID、Session 和权限上下文不得进入核心契约。

运行：`pnpm --filter @itookit/mdx-adapter typecheck` / `test` / `build`。
