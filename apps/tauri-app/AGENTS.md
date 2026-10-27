# NestOS Tauri 宿主

桌面入口位于 `src/main.ts`，原生实现位于 `src-tauri/`。宿主装配 LocalFS/SQLite、原生文件与进程端口、ApplicationRuntime 和共享 app-shell。

- 业务策略归 app-core 及对应业务包；原生差异通过宿主端口注入，公共工作台 UI 复用 app-shell。
- 文件授权、隔离执行、进程停止与工作区清理由对应平台适配器完成；取消确认遵守现有进程树退出与资源释放契约。
- 文件选择、窗口关闭、日志及原生命令保留在宿主层，不把 Tauri invoke 引入独立库或共享业务契约。
- 新增流程沿用现有安全诊断通道，不记录用户正文、完整参数或凭据；浏览器可达代码使用兼容 UUID 工具。

验证：`pnpm --filter tauri-app typecheck`、`pnpm --filter tauri-app build`；修改 Rust 边界时运行 `pnpm --filter tauri-app test:rust`。窗口行为与安装包支持范围按实际验收记录说明。
