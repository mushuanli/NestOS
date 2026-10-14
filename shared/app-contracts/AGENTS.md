# @itookit/app-contracts

共享应用契约与纯变换。前后端均可使用，不依赖 UI 或后端执行实现。

- `application/`：具名查询、命令、事件、回执与配置能力。
- `services.ts` / `ports/`：独立的本地应用服务、后端工厂与能力接口；按 files/projects/session/configuration/sync/digital-twin/local 拆分，不从 Runtime 或服务类派生。
- `settings.ts`：设置、工作区来源、存储估计与快照端口。
- `session/`、`vfs/`、`configuration/`、`projects/`、`digital-twin/`：身份、结构化错误、DTO、纯路由和校验。
- `presets/`：共享产品常量；无网络、初始化或服务实例。

运行时只依赖 common 与 vfs-core。领域类型通过公开入口引用，开发依赖不授予运行时实现导入权限。不得在契约里重新导出 Runtime、执行服务或 DOM 组件的值。`pnpm modules:check` 校验传递加载，`pnpm modules:buildcheck` 校验完整前端公开入口。
