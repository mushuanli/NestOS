# @itookit/kanban

独立、平台中立的协调库。运行依赖只允许 `@itookit/vfs-core`，宿主注入可信身份、授权、产物核验、提交后回调及日志。

- `src/contracts/` 是无副作用的公开 DTO；`src/index.ts` 显式导出公共 API。
- `src/module.ts` 管理准入、授权、诊断及 quiesce；reducer 不进行 I/O。
- `src/store.ts` 通过 SeqFile 事务提交状态、依赖、派发意图、事件及幂等回执；大正文先写资产并核验，再提交引用。
- 不引入 Session、Flow、Kernel、Agent SDK、全局事件或 NestOS 目录约定。核心不安装后台调度；可选执行桥仅使用关闭超时，UI 的活动轮询必须随实例停止。sessionId/messageId 保留为不透明来源引用，独立 Agent 不必创建 NestOS Session。
- `content:finished` 不能证明执行完成；宿主根据正式执行回执提交 observe-execution。unknown 不释放责任、不自动重派；sealed 计划禁止普通命令绕过派发与验收。
- 浏览器身份使用 `src/utils/random.ts`；保持原生 UUID 缺失/抛错的兼容测试。
- 契约（含 KanbanClient）由本库自包含定义；应用不得代转出库 API。无 mechanisms 入口，reducer、codec、identity 等实现不公开。版本化内容通过 storage 的 installKanbanContent 原子安装；import 必须经过 install-content 授权。
- `/storage`、`/execution`、`/discovery`、`/activity` 各自拥有持久协议和通用协调；`/ui` 只通过实例端口接入文案、图标、日志与导航，不导入应用包。

验证：`pnpm typecheck`、`pnpm test`、`pnpm build`。协议与装配见 [README](README.md) 及 [协调设计](../../doc/design/kanban-coordination.md)。
