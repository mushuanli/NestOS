# @itookit/llm-tasks

基于 `@itookit/durable-kernel` 的可持久、可恢复 LLM Task Program。

该包只负责一项 LLM 工作如何向前运行，提供：

- `DurableChatProgram`
- `DurableAgentProgram`
- `ContextAssembler`
- Provider 消息适配

Program 只产生 Kernel `Effect`、`Interaction` 与领域事件。LLM、Tool 等能力由
`@itookit/kernel-adapters` 注册，平台实现由 `apps/*` 注入。本包不负责 Session、DAG
调度、Conversation 状态、UI 或平台装配。

```typescript
import { DurableChatProgram } from '@itookit/llm-tasks';

kernel.registerProgram(new DurableChatProgram());
```

完整边界见 [Kernel Session / Task 最终设计](../../doc/feat/harness-session-task-final-design.md)。

公共契约入口 `@itookit/llm-tasks/contracts` 提供执行事件、节点配置与执行默认值，不会初始化运行时。新代码从所属模块导入；原 llm-common 和 common 的 LLM 兼容入口均已删除。本包实现已移除 common/llm-common 依赖。

迁移：ContextAssembler、ProviderMessageAdapter 和相关类型直接从 @itookit/llm-context 导入；本包已删除它们的根转发及内部兼容文件。
