# @itookit/llm-context

独立的上下文领域包。类型、Profile、历史选择、窗口预算、Notes、压缩和检索的实现归本包，外部只引用根入口接口与工厂。

- 不依赖任何其他 workspace 包、VFS、Kernel、Provider SDK 或 UI；I/O 通过端口注入。
- `IContextService.prepare` 先发布不可变内容，返回待提交 writes；不能自行推进共享 head。
- 宿主把 writes、Task 状态和下一 Effect 放在同一事务。Notes 不能表达授权、执行完成或 Kernel checkpoint。
- 原文先保存后截断；摘要与检索材料不能提升为 system policy；工具调用组不能被拆开。
- 保留旧类型与工厂兼容入口；具体部署适配器放在 kernel-adapters，装配在 app-core。
- 自动 GC 通过 `IContextGcStore` 执行：完整标记后才删除；与发布/根提交共享事务边界；运行中、未确认清理和扫描不完整时禁止删除。已保留的历史引用不能按年龄淘汰。
- 默认只回收终态 Task 的过期孤立内容；旧文件不自动迁移/删除。估算预算不能宣称是 provider 精确 tokenizer。

验证：`pnpm --filter @itookit/llm-context test`、`pnpm --filter @itookit/llm-context typecheck`、`pnpm --filter @itookit/llm-context build`。

接口与存储说明见 [Context API](../../doc/context-api.md)，设计依据见 [模块设计](../../doc/design/context-module.md)。

- `ContextEngineOptions` 注入窗口默认值与完整请求计量；服务后续预算校验经 `IContextEngine.measure`，不得绕回固定估算器。摘要请求在宿主使用同一计量。
