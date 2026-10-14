# @itookit/llm-context

零运行时依赖的上下文模块：对话装配、Profile、持久请求快照、工作窗口、Notes、原始历史检索、工具输出外置和自动 GC。

消费者只使用包根接口：`IContextAssembler`、`IContextProfiles`、`IContextEngine`、`IContextService`、`IContextReader`、`IContextContentStore`。工厂接受存储、读取与摘要端口，不依赖执行内核。

`prepare()` 返回不可变内容引用与 CAS 写集。宿主负责把写集、执行状态和下一模型 Effect 原子提交。`durable-kernel` 不依赖本包。

`createContextGc(IContextGcStore, policy)` 负责可达性和保留策略；`scheduleContextGc` 管理有界维护的调度与关闭。存储适配器提供与发布/根提交串行化的事务视图。默认只回收终态、Effect 已清理任务的过期孤立内容，保留可恢复历史。

详见 [Context API](../../doc/context-api.md) 与 [设计](../../doc/design/context-module.md)。

窗口与计量策略可替换：

```ts
import { createContextEngine, createContextService } from '@itookit/llm-context';

const engine = createContextEngine({
  defaultPolicy: { maxMessages: 100, keepRecent: 20, maxInputTokens: 32_000 },
  estimateTokens: request => tokenizer.countRequest(request),
  estimated: false, // Use false only for an exact provider counter.
});
const context = createContextService({ content, records, engine, summarize });
```

计数器接收完整请求（消息、工具 schema 和请求参数），用于窗口选择、Notes 加入后的校验、摘要源预算和持久说明。也可通过 `IContextEngine.select/measure` 替换整个窗口策略；只实现旧 select 的引擎继续使用默认预算计量。默认计量是 UTF-8 字节估算。`engineOptions` 是服务自动创建默认引擎时的便捷配置；显式 engine 优先。

宿主 app-core 的 `contextEngineOptions` 接到同一个引擎，实际摘要请求也用相同计量。协议校验、工具调用组完整性和必需输入保护属于机制约束，内置策略保留这些约束。
