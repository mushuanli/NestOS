# @itookit/llm-ui

原生 DOM 聊天、历史和 Flow 展示。按需要选择公开入口：

```ts
import { createLLMFactory, type SessionViewPort } from '@itookit/llm-ui/chat';

const factory = createLLMFactory(agentService, {
  sessionManager: conversation.sessionManager,
  sessionRepository,
  commandBus: conversation.commandBus,
  kernel,
  defaultHarnessToolIds: hostToolIds,
});
```

`agentService` 接受公共 `IAgentConfigService`，无需创建 VFSAgentService；`sessionManager` 接受结构化 `SessionViewPort`（查询、事件与命令通道），可由宿主实现。提示词历史是可选的 `PromptHistoryPort`。仓储、OCR、工具授权、Skill 和特权命令由宿主接入。未传默认工具列表时，UI 不自行假定授权；真实授权由执行层校验。

聊天入口不加载设置编辑器；需要设置界面时安装可选 peer `@itookit/llm-settings-ui`，再从 `@itookit/llm-ui/settings` 导入 `createAgentEditorFactory`、`createSkillsEditorFactory` 或设置编辑器。包根现在等同于 `/chat`；已删除旧 `/legacy` 聚合入口和单例回退。`/startup` 用于启动菜单与 Flow 模板安装接口，`/style.css` 提供聊天样式。

`/chat` 创建正式会话编辑器时必须传入 `sessionManager`，或通过 `resolveSessionView` 延迟获取实例；缺少端口会明确报错。提示词历史通过实例上的可选 `promptHistory` 接入。所有入口均要求显式实例注入。当前 UI 仍消费 Session/Flow 契约和仓储能力，并非只依赖通用 UI 的展示组件包。

验证：`pnpm --filter @itookit/llm-ui typecheck`、`build`、`test`。
开发说明见 [AGENTS.md](./AGENTS.md)。

Flow 模板由宿主提供，不再从 UI 导出 `builtinFlowLibrary`。安装与恢复必须显式传入 `readonly FlowDraft[]`：

```ts
await installFlowLibrary(commands, hostTemplates);
await restoreFlowLibrary(commands, hostTemplates);
const menu = createFlowContextMenuConfig({ ...runOptions, library: hostTemplates });
```

未提供 `library` 的菜单不显示恢复入口。MindOS 使用 app-core 的 `createMindosFlowLibrary()`，其他用户可提供任意符合公共契约的模板。

Agent 设置工厂使用 `createAgentEditorFactory(service, { defaultToolIds: hostToolIds })` 显式注入宿主默认授权；不传则默认目录为空。UI 不选择 Read/Write/Bash 等工具。该默认列表仅用于展示与编辑，实际工具授权由执行层校验。

SessionViewPort 可通过可选的 getDirectAgentPolicy 返回实际 Agent 策略。聊天编辑器据此显示 maxExchanges，独立 ChatInput 可直接传 maxAgentExchanges；没有该端口时沿用 llm-tasks 的通用默认预算。

迁移：旧根入口的设置编辑器和工厂改从 `/settings` 导入；`VFSAgentService` 改从 `@itookit/llm-session` 导入；使用返回的 SessionManager 实例替换单例调用，并传给 UI。

发布依赖：driver-llm、tools、kernel-adapters、llm-tasks 只作为开发契约依赖；声明在构建时内联，少量任务契约常量进入 UI 产物。直接运行依赖从 12 个降到 8 个。Session/Flow、VFS、common/ui-common 与 Kernel 仍有功能或公开类型依赖，传递依赖仍存在；公共控制端口引用 Kernel 公开 Task/Session 类型；传入真实 Kernel 时仍然兼容。

会话创建的初始 text/agentId 通过 EditorOptions.initialInputState 显式传入，UI 不读取宿主 storage 键。导航创建由宿主将请求状态传给工作区，再传给对应编辑器实例；标题由持久 Session manifest 提供。

`kernel` 参数接受结构化 `EditorTaskControlPlane`，远程客户端也可以实现：

```ts
import type { EditorTaskControlPlane } from '@itookit/llm-ui/chat';
const control: EditorTaskControlPlane = {
  openTask: id => remote.openTask(id),
  openSession: id => remote.openSession(id),
  listSessionTasks: id => remote.listSessionTasks(id),
};
const factory = createLLMFactory(agentService, { sessionManager, sessionRepository, kernel: control });
```

`openTask` 返回支持事件订阅和任务控制的 `AttachedTask`；`openSession` 只需共享挂接身份的读写与任务状态读取。事件重放、批准响应和身份切换必须满足端口契约。编辑器初始化失败也释放已创建资源；`destroy()` 幂等并汇总清理失败，调用方应等待其完成。
