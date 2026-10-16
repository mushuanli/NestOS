# shared/ 共享模块

app-contracts 拥有应用 DTO、服务端口、身份与纯变换；common 拥有通用工具、导航接口、i18n、图标和日志基础设施。app-transport 提供无 DOM/Node 的应用传输机制，平台差异由宿主注入。各包自身的 AGENTS.md 补充本约定。

- 共享契约不引用 ApplicationRuntime 或从后端类推导类型。
- 不加载后端执行、存储驱动或前端 DOM 实现；领域类型通过公开 contracts 入口引用。
- 业务服务实现放 backend，展示与交互放 ui，宿主接线放 apps。
- `pnpm modules:check` 与实际构建守卫验证传递加载边界。

详见 [模块边界](../doc/design/frontend-backend-modules.md)。
