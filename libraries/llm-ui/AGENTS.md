# llm-ui

独立的原生 DOM Chat + Flow 库，唯一直接运行时依赖是 `@itookit/mdxeditor`。

- `contracts.ts` 定义展示投影、具名操作、草稿与宿主持有的操作台账；不得导入 Session、Task、后端 Flow、VFS 或应用类型。
- `createChatView` 只拥有自己的 DOM、订阅、Markdown renderer 和局部异步读取。销毁不关闭 source、台账、共享连接或后台任务。
- 接纳确认与正式消息替换分开；只有 confirmed 用户消息提供提交接纳证据。未知操作不自动重发。
- 文字按 textRevision 清理，附件按草稿项 id 清理；上传成功必须核对原草稿项仍有效。
- 自定义 renderer 是可信宿主代码；模型 Markdown 不登记扩展。显示和打印共用内容策略。
- 业务兼容工厂在 `../../ui/llm-ui-adapter`，通用 Flow 视图通过本包 `/flow` 提供。
- 验证：`pnpm typecheck`、`pnpm test`、`pnpm build`；构建扫描源码、JS 和声明的外部依赖。

操作身份和上传项身份统一使用包内 randomUUID 兼容工具，支持原生方法缺失或抛错；不因此增加 common 依赖。根仓库 uuid:check 和 Chat/Flow 回归共同覆盖这些入口。
