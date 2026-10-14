# backend/ 后端模块

本目录包含 app-core、llm-context、llm-session、llm-flow、llm-tasks、durable-kernel、kernel-adapters、tools、device-tty、sanbox、sync-adapters。各包自身的 AGENTS.md 补充本约定。

- 负责应用用例、持久化、授权、执行、调度与恢复，不导入 UI（包含类型引用）。
- app-core 装配平台无关能力；平台、进程和存储实现由 apps 宿主注入。
- 公开 contracts 入口只提供领域数据、接口和纯规则，不转发执行实现值。
- 应用服务契约由 shared/app-contracts 拥有；实现与宿主绑定返回这些独立接口，编译时验证匹配。
- `pnpm architecture:check` 验证分层、目录和加载边界。

详见 [模块边界](../doc/design/frontend-backend-modules.md)、[运行时架构](../doc/runtime-architecture.md)。
