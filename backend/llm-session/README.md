# @itookit/llm-session

会话机制：Session、Round、分支、上下文提交、运行协调和历史投影。普通 Chat 提交 Direct Run，显式 Flow 才提交 DAG Run。

```ts
import { initializeConversationSystem } from '@itookit/llm-session';

const conversation = await initializeConversationSystem({
  agentService, sessionEngine, promptHistoryFiles,
  kernel, dagPlugins, flowStore,
  hostPorts: {
    translate: key => myTranslations[key],
    logger: myLogger,
  },
  agentResolution: { missingAgent: 'reject' },
  directAgentPolicy: { systemPrompt: ['Your host execution guidance'], maxExchanges: 7 },
});

// Pass this instance to the editor instead of reading a process singleton.
const sessionManager = conversation.sessionManager;
await conversation.dispose();
```

宿主提供模型管理、会话仓储、提示词历史文件能力、Kernel 和 Flow 存储。翻译、日志、启动追踪均为可选的实例端口；默认英文提示、空日志和直接执行操作。多个运行时的展示配置和提示词历史互不覆盖；关闭时只释放自己的资源。

`agentResolution.missingAgent` 可以为 `'reject'`，也可以为返回 `ExecutorConfig` 的同步/异步函数，接收 Agent ID 与失败原因；省略时保留旧回退。`resolveExact` 始终严格校验 Agent 身份。授权、单写者和已锁定执行模式的约束不因回退策略改变。

`@itookit/llm-session/contracts` 提供会话、事件、命令/扩展契约，兼容转发配置管理契约，不初始化 VFS、YAML 或运行时。配置声明和纯函数从 kernel-adapters/contracts 内联到发布产物，适配器仅作为开发依赖。

Session manifest 只接受规范 `schemaVersion: 3` 数据。作文预设和播种属于 app-core 的产品装配，不再由本包导出。

迁移：删除 `configureSessionHostPorts`，改为 `initializeConversationSystem({ hostPorts, ... })`。该工厂不再设置全局 SessionManager 或 PromptHistory；使用返回的实例。已删除 `createSessionManager/getSessionManager/resetSessionManager` 和提示词历史单例 API。低层装配使用 `new SessionManager(...)`，历史使用 `new PromptHistoryService(files)` 并显式初始化和销毁。UI 使用 `createLLMFactory(agentService, { sessionManager, sessionRepository, ... })`。

`directAgentPolicy` 只作用于显式 Agent 模式：提示词在 Context 装配阶段加入并参与 token 预算，maxExchanges 固定到持久 Task。实例构造时复制并冻结策略；maxExchanges 必须为正的安全整数。未传提示词时不追加产品执行指令；未传预算时沿用 llm-tasks 的通用默认值。普通 Chat、Flow 和无显式模式的旧调用不追加这些提示词。

`SessionManager.getDirectAgentPolicy()` 提供只读视图，宿主 UI 可据此显示实际预算。MindOS 的默认执行指导由 app-core 注入；其他宿主可传自己的策略或空对象。

DirectAgentPolicy 还可指定 llmRetry（retries/backoffMs）与 toolTimeoutMs；仅用于显式 Agent，构造时验证、快照并冻结，最终写入持久 Task input。Flow 使用节点配置或 Flow defaults 的同名字段，不读取直接 Agent 策略。
