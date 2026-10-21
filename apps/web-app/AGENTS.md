# mind-os Web 宿主

浏览器入口位于 `src/main.ts`：装配 IndexedDB 后端、ApplicationRuntime、应用客户端与共享 app-shell。工作台 UI 和业务规则复用所属工作区，宿主只接入浏览器能力。

- 会话、Flow、Kernel 策略归 app-core 及对应业务包；浏览器宿主不复制执行状态机。
- 本地存储使用 IndexedDB；远程项目来源通过 mindos-node-driver 注入，不在浏览器中引入 Node 文件系统或本机 Shell。
- 文件、模型和图片工具经宿主端口接入；保持现有 Session 租约身份与资源释放顺序。
- 启动、路由和编辑器使用 app-shell 的公开入口；新增跨平台代码遵守根目录 UUID 与诊断日志约定。

验证：`pnpm --filter mind-os typecheck`、`pnpm --filter mind-os build`。打包成功不替代真实浏览器交互与存储恢复验收。
