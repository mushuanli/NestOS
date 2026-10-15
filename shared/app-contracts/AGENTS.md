# @itookit/app-contracts

共享应用契约与纯变换。前后端均可使用，不依赖 UI 或后端执行实现。

- `services.ts` / `ports/`：application-client 是显式前端契约；local 描述宿主服务与平台选项，不再保留 LocalBackendPort 工厂表，UI 禁止引用。其余能力接口按 files/projects/session/configuration/sync/digital-twin/local 拆分，不从 Runtime 或服务类派生。
- `settings.ts`：设置、工作区来源、存储估计与快照端口。SettingsPort 返回即就绪，不含 init；工作区描述与 openWorkspace 分开。OCR 通过异步 readSettings 读取，通过显式 prepareConfiguration 准备配置，不暴露同步未加载快照。
- `session/`、`vfs/`、`configuration/`、`projects/`、`digital-twin/`：身份、结构化错误、DTO、纯路由和校验。
- `presets/`：共享产品常量与持久工作区身份；无网络、初始化或服务实例。

运行时只依赖 common 与 vfs-core。领域类型通过公开入口引用，开发依赖不授予运行时实现导入权限。不得在契约里重新导出 Runtime、执行服务或 DOM 组件的值。`pnpm modules:check` 校验传递加载，`pnpm modules:buildcheck` 校验完整前端公开入口。

- WorkbenchView/SessionOpenView 是应用聚合契约：后端准备只读模型、能力与资源所有权，前端决定编辑器保存/切换时机。UI 文档保持不透明，连接兴趣按 revision 更新，不能传递实现类或前端类型。
