# llm-tasks 开发说明

本包是平台无关的 LLM Durable Program 层，不是系统总控。详见 [llm-tasks API](../../doc/llm-tasks-api.md)。

## 目录

```text
src/
├── index.ts                        统一导出
└── durable/
    ├── types.ts                    Program 状态 / 输入 / 输出类型
    ├── task-spec.ts                llm.agent / llm.chat 的 TaskInput 装配
    ├── program-helpers.ts          Program 共享辅助（事件、用量、失败处理）
    ├── dependency-collector.ts     依赖收集状态机（等待 task-exited → 就绪）
    ├── chat-program.ts             DurableChatProgram
    ├── agent-program.ts            DurableAgentProgram（工具调用 / 审批）
    └── plan-program.ts             DurablePlanProgram
```

## 公共契约

`@itookit/llm-tasks/contracts` 拥有执行事件、节点配置、输出校验/Memory 策略类型及执行默认值。入口不加载 Program 实现。机制直接依赖 driver-llm、llm-context、tools 的公开接口与 durable-kernel，不再依赖 common/llm-common。宿主负责解析配置引用、授权和选择策略。

## 约束

- 新运行模式实现 `DurableTaskProgram`。
- 所有等待必须返回 Kernel `WaitSpec`，State 必须可持久化。
- 所有外部能力通过 Kernel `Effect` 使用。
- 不得依赖 `llm-session`、`llm-flow`、UI、DOM 或具体设备。
- 不在本包新增 Session、Flow、Scheduler、CommandBus 或通用 Middleware。

运行：

```bash
pnpm --filter @itookit/llm-tasks typecheck
pnpm --filter @itookit/llm-tasks test        # vitest run（等价于 test:run）
pnpm --filter @itookit/llm-tasks test:watch  # 监听模式
```

ContextTaskProgram 为 Agent/Chat v2 bridge，负责把 context 写集转换为 Kernel actions；预算、Notes 与检索策略全部归独立 context 包。

执行策略：llmRetry.retries 是附加尝试次数（默认 3），没有固定业务上限，只校验可安全表示的总尝试次数。toolTimeoutMs 默认 300000，可由宿主覆盖；buildLlmTaskInput 验证并快照策略，Agent 每轮工具 Effect 使用持久输入中的值。

Context 装配、消息适配和压缩的兼容转发已删除。消费者直接使用 llm-context，装配及协议组测试归实现所属包。
