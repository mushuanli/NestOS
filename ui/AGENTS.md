# ui/ 前端模块

所有业务 UI 均在本目录：app-shell、app-settings、llm-ui-adapter、llm-settings-ui、mdx-adapter、ui-common。各包自身的 AGENTS.md 补充本约定。

- 负责 DOM、CSS、交互、导航投影、编辑草稿和视图缓存。
- 应用服务接口从 `@itookit/app-contracts/services` 导入；领域接口从公开 contracts 入口导入。禁止从 app-core 导入实现或实现类型。
- Runtime、持久化、执行和后端工厂由 apps 宿主装配并注入；UI 不拥有 Runtime 的 dispose 或恢复。
- vfs-ui、mdxeditor 是独立 UI 库，源码仍在 libraries/，业务 UI 通过公开入口消费。
- `pnpm modules:check` 检查目录归属、应用契约与运行时依赖；`pnpm modules:buildcheck` 构建全部八个前端根入口。

详见 [模块边界](../doc/design/frontend-backend-modules.md)、[包结构](../doc/pkgstructure.md)。

libraries/llm-ui 同时提供 Chat 与可选 Flow，唯一直接运行时依赖是 mdxeditor；NestOS 业务接线与完整产品编辑器兼容入口位于 llm-ui-adapter。
