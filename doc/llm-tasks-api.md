# @itookit/llm-tasks — API 参考

> 平台无关的 LLM Durable Program 层：把"一项 LLM 工作如何向前运行"表达为 Kernel `DurableTaskProgram`（init/reduce 状态机）。提供 `llm.chat` / `llm.agent` / `llm.plan` 三个程序、上下文组装与 Provider 消息适配。所有 API 从 `@itookit/llm-tasks` 根导出。

**依赖方向**：包依赖为 `@itookit/durable-kernel`、`@itookit/llm-context`、`@itookit/driver-llm` 和 `@itookit/tools`；消息与上下文类型直接来自 llm-context，通信类型直接来自 driver-llm/contracts，Prompt/Tool 契约来自 tools/contracts。不依赖 `llm-session`、`llm-flow`、UI、DOM 或具体设备；所有外部能力（LLM/Tool）经 Kernel Effect 使用。

## 目录

- [入口：Program 清单](#入口program-清单)
- [程序输入：DurableProgramInput / DurableAgentInput](#程序输入)
- [核心类：ContextAssembler](#contextassembler)
- [核心类：ProviderMessageAdapter](#providermessageadapter)
- [程序模型：DurableChatProgram / DurableAgentProgram / DurablePlanProgram](#程序模型)
- [依赖收集：collectDependency / dependenciesReady / dependencyWait](#依赖收集)
- [辅助函数：program-helpers](#辅助函数)
- [Task 输入构建：buildLlmTaskInput](#task-输入构建)
- [源码结构：文件与路径](#源码结构文件与路径)

---

## 入口：Program 清单

三个 Durable Program 通过 `manifest = { kind, version }` 注册进 Kernel，由 `llm-flow` 的 `registerDurablePrograms()` 统一注册（`llm-session` 的 `initializeConversationSystem()` 会调用它）：

| Program | manifest | 职责 |
|---|---|---|
| `DurableChatProgram` | `llm.chat@1` | 单轮 LLM 对话（可带依赖绑定） |
| `DurableAgentProgram` | `llm.agent@1` | 多轮 Agent 循环（工具 + 预算 + 审批） |
| `DurablePlanProgram` | `llm.plan@1` | 结构化计划生成 → 审批交互 → 输出 `DurablePlanOutput` |

```ts
import { DurableChatProgram, DurableAgentProgram, DurablePlanProgram } from '@itookit/llm-tasks';
kernel.registerProgram(new DurableChatProgram());
kernel.registerProgram(new DurableAgentProgram());
kernel.registerProgram(new DurablePlanProgram());
```

---

## 程序输入

### DurableProgramInput

所有 LLM 程序的公共输入：

```ts
interface DurableProgramInput {
    sessionId: string;
    roundId: string;
    messages: ChatMessage[];
    connectionId: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    llmRetry?: { retries?: number; backoffMs?: number };
    thinking?: boolean;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    stream?: boolean;                 // stream !== false → 流式（默认）；false → 非流式回退
    webSearch?: boolean;              // 走底层内置 server-side search
    responseFormat?: ResponseFormat;
    outputValidation?: OutputValidationPolicy;
    contextCompaction?: ContextCompactionPolicy;
    dependencyBindings?: DurableDependencyBinding[];
    includeDependencyOutputs?: boolean; // false → 仍调度依赖但不把其输出拼进 messages
}
```

### DurableAgentInput extends DurableProgramInput

```ts
interface DurableAgentInput extends DurableProgramInput {
    maxExchanges?: number;            // Agent 循环最大轮次
    toolTimeoutMs?: number;           // 每个工具 Effect 的超时
    workingDirectory?: string;
    approval?: 'none' | 'external' | 'all';
    tools?: ToolDefinition[];
    allowedToolIds?: string[];        // 显式能力 ID 白名单（动态加载的 definition 必须属于该集合）
    skillContexts?: SkillContext[];   // 初始化选中的 Skill 快照；与运行时 load_skill 结果同形，逐轮重注入关键规则
    externalToolIds?: string[];
    subtaskTool?: string;             // 调用即声明子任务 payload 的工具名（该节点随即完成）
}
```

### DurablePlanInput

`DurablePlanInput extends Omit<DurableProgramInput, 'messages'>`，额外必填 `goal: string`（计划目标；messages 由程序内部按 goal 生成）。

### DurableDependencyBinding

```ts
interface DurableDependencyBinding {
    taskId: string;                   // 依赖的 Task
    input: string;                    // 依赖输出注入 messages 时使用的键名（必填）
    output?: string;                  // 从依赖输出中提取的字段路径（可选）
    edgeId?: string;                  // 上游边标识（DAG 场景）
    injectOutput?: boolean;           // false → 只登记依赖关系，不注入输出
}
```

### DurableCapabilitySignal

程序在 `capabilities` 阶段声明需要的资源句柄：

```ts
interface DurableCapabilitySignal {
    llmHandleId: string;
    toolHandleId?: string;
}
```

### 输出

- `DurableChatOutput` — `{ message: ChatMessage; usage: TokenUsage; finishReason?: string | null }`
- `DurableAgentOutput extends DurableChatOutput` — Agent 最终消息 + usage + `exchanges`
- `DurablePlanOutput` — `{ plan: string; approved: boolean }`（计划文本 + 审批结果）

---

## ContextAssembler

此入口为兼容转发，实现归 `@itookit/llm-context`。新代码消费 `IContextAssembler`/`createContextAssembler`；v2 Agent/Chat 使用 `ContextTaskProgram` 经 Effect 接入持久窗口，见 [Context API](context-api.md)。

构建 LLM 调用的上下文（system + history + 压缩摘要 + 记忆）。

```ts
class ContextAssembler {
    constructor(deps: ContextAssemblerDeps);
    assemble(
        plan: ContextPlan,
        taskRunId: string,
        agent: { id: string; version: string },
        systemPrompt?: string[],
        skillsPrompt?: string,
        options?: { persist?: boolean; projectInstructions?: string; skillInstructions?: string; skillIndex?: string },
    ): Promise<AssemblyResult>;
}
```

**`ContextAssemblerDeps`**：`log`（兼容参数，装配不依赖其实现）、`profileStore.getProfile(profileId, revision?)`、`snapshotStore?`（`save(snapshot)`）、`readRound(roundId)`（返回 `{ input, output, historyParentIds, defaultContextMode?, _deleted? } | null`）、`loadArtifact?(artifactId)`、`retrieveMemory?(plan, agent)`、`providerAdapter?`、`provider?`（`ProviderKind`）。

**`AssemblyResult`**：`{ snapshot: ContextSnapshot; messages: ChatMessage[] }` —— 持久化的上下文快照 + 归一化后的消息序列。

**`RetrievedMemoryEntry`**：`{ entryId: string; namespaceId: string; content: string; contentHash: string }` —— 单条记忆片段（LLM 上下文注入用）。

**关键语义（ContextPlan → ContextSnapshot）**：

- **本次用户输入必留**：`plan.pendingUserMessage` 由调用方恒提供，作为最后一个 ContextBlock 追加且不参与预算裁剪——预算再紧也不会丢掉正在问的问题。
- **去重在裁剪之后**：`pendingRoundId` 指向该提示所属 Round；只有当该 Round 经上下文规则（include/exclude/summary）与预算裁剪后**仍在上下文中**且已携带同内容 user 消息时，才丢弃追加的副本。被排除、被摘要或被裁掉的 Round 一律保留副本。
- **裁剪顺序**：先丢 `skill-index` 发现元数据，再按顺序丢非 system 块；system 策略块与 pending 块不丢。
- 每轮排除/摘要由 branch profile 的 `rules` 与 Round 自身 `defaultContextMode` 决定。

---

## ProviderMessageAdapter

Provider 无关的消息归一化（发往 LLM 前按 provider 规则校验/清理消息）。

```ts
class ProviderMessageAdapter {
    validate(messages: ChatMessage[], options?: AdapterOptions): ChatMessage[];
}
```

- `ProviderKind = 'anthropic' | 'openai' | 'generic'`（无 Gemini 分支）
- `AdapterOptions`：`{ provider?: ProviderKind }`（默认 `'generic'`）
- 校验规则：删除空 assistant 消息、校验 tool_call 分组配对；`anthropic` 追加"末条必须是 user/tool"与"禁止连续 user"两条硬规则，`openai` 仅通用校验
- `ProviderMessageError`：格式校验失败抛错（`code` 标识具体规则）

---

## 程序模型

三个类均实现 Kernel `DurableTaskProgram<S, I, O>` 契约（`init` / `reduce` 返回 `Decision`）。

### DurableChatProgram（`llm.chat@1`）

状态机：`collecting`（等依赖）→ `llm`（调 LLM）→ complete。

```ts
class DurableChatProgram implements DurableTaskProgram<ChatState, DurableProgramInput, DurableChatOutput> {
    readonly manifest = { kind: 'llm.chat', version: '1' };
    init(input: DurableProgramInput): Decision<ChatState, DurableChatOutput>;
    reduce(state, event): Decision<ChatState, DurableChatOutput>;
}
```

`ChatState`：`{ input, phase: 'collecting'|'llm', dependencyOutputs, resolvedDependencyIds, capabilities? }`

### DurableAgentProgram（`llm.agent@1`）

多轮 Agent 循环：每轮 LLM → 解析 tool_calls → 授权执行 → 回馈，直到无工具调用或 `maxExchanges` 耗尽。

### DurablePlanProgram（`llm.plan@1`）

状态机：`capability`（等 `capabilities` 信号）→ `llm`（按 `goal` 生成计划）→ `approval`（`approve:plan` 审批交互）→ complete，输出 `DurablePlanOutput`（`{ plan, approved }`）。

---

## 依赖收集

支持 DAG 依赖的 chat/agent 程序前置阶段：

```ts
// 把一个 task-exited 事件原地收集进 outputs / resolvedIds
collectDependency(
    bindings: DurableDependencyBinding[],
    outputs: Record<string, JsonValue>,
    resolvedIds: string[],
    event: TaskInputEvent,
    defaultOutput?: string,
): void;

// 所有 binding 的 taskId 都已收集即就绪
dependenciesReady(bindings: Array<{ taskId: string }>, resolvedIds: string[]): boolean;

// 构建「等待所有依赖 task-exited」的 Decision.next
dependencyWait(bindings: Array<{ taskId: string }>): {
    type: 'wait';
    on: { type: 'all'; waits: Array<{ type: 'task'; id: string }> };
};
```

---

## 辅助函数

`program-helpers.ts` 提供的纯函数（供程序内部使用，部分对外导出）：

| 函数 | 用途 |
|---|---|
| `dependencyOutput(event, bindings?, defaultOutput?)` | 由 `task-exited` 事件解析 `{ taskId, key, value }` |
| `extractNodeOutput(value, output?)` | 从依赖 Task 输出提取字段（`output` 为路径；唯一从根导出的 helper） |
| `mergeDependencyOutput(outputs, key, value)` | 合并多个依赖输出（同键转数组） |
| `llmEffect(input, messages, handleId, tools?, effectId?)` / `toolEffect(roundId, exchange, call, handleId, cwd?)` | 构造 LLM / Tool EffectRequest |
| `toolEffectId(exchange, call)` | 构造 Tool Effect 的稳定 ID |
| `capabilitySignal(event)` | 从输入事件解析 `DurableCapabilitySignal` |
| `response(event)` | 从 LLM Effect 完成事件取 `ChatCompletionResponse` |
| `responseEvents(input, round?)` | 构造流式响应后的 KernelAction 序列（只含 `round:end`） |
| `emit(event)` | 构造 `agent.event` KernelAction |
| `assistantMessage(value)` / `toolCalls(value)` / `toolName(call)` / `toolArguments(call)` | 响应解析助手 |
| `roundEvent(type, input, round?)` | Round 业务事件构造 |
| `addUsage(left, right?)` | TokenUsage 累加 |
| `applyDependencyMessages(input, outputs)` | 把依赖输出拼成追加的 user 消息（`includeDependencyOutputs === false` 时跳过） |

**常量**：`CAPABILITY_SIGNAL = 'capabilities'`。

---

## Task 输入构建

```ts
buildLlmTaskInput(options: LlmTaskInputOptions): DurableAgentInput;
```

**`LlmTaskInputOptions`**：`{ sessionId, roundId, messages, connectionId?（默认 'default'）, model?, temperature?, maxTokens?, timeoutMs?, llmRetry?, toolTimeoutMs?, thinking?, reasoningEffort?, webSearch?, stream?, responseFormat?, outputValidation?, contextCompaction?, maxExchanges?, workingDirectory?, approval?（默认 'external'）, tools?, allowedToolIds?, externalToolIds?, skillContexts?, subtaskTool?, dependencyBindings?, includeDependencyOutputs? }` —— 将上层会话数据组装为 `DurableAgentInput`。

---

## 源码结构：文件与路径

`@itookit/llm-tasks` 的公共 API 全部从 `backend/llm-tasks/src/index.ts` 根导出。包内按 **core / durable** 两层组织：

```
backend/llm-tasks/src/
├── index.ts                      根导出（唯一公共入口）
├── core/                         上下文组装 + Provider 适配（无状态）
│   ├── context-assembler.ts      ContextAssembler + ContextAssemblerDeps/AssemblyResult/RetrievedMemoryEntry
│   └── provider-message-adapter.ts  ProviderMessageAdapter + ProviderKind/AdapterOptions/ProviderMessageError
└── durable/                      Durable Program 实现（状态机）
    ├── types.ts                  DurableProgramInput/DurableAgentInput/DurableCapabilitySignal/
    │                             DurableChatOutput/DurableAgentOutput/DurableAgentState/DurableDependencyBinding
    ├── chat-program.ts           DurableChatProgram（llm.chat@1）
    ├── agent-program.ts          DurableAgentProgram（llm.agent@1）
    ├── plan-program.ts           DurablePlanProgram + DurablePlanInput/DurablePlanOutput（llm.plan@1）
    ├── program-helpers.ts        dependencyOutput/extractNodeOutput/llmEffect/toolEffect/response/emit 等纯函数
    ├── context-compaction.ts     validateContextCompaction()/compactMessages()（内部使用，未从根导出）
    ├── task-spec.ts              buildLlmTaskInput + LlmTaskInputOptions
    ├── dependency-collector.ts   collectDependency/dependenciesReady/dependencyWait
    └── *.test.ts                 单测（不导出）
```

**注册位置**：`llm.chat@1` / `llm.agent@1` / `llm.plan@1` 由 `llm-flow` 的 `registerDurablePrograms()` 与 Flow 系程序一起注册（`backend/llm-flow/src/flow/register-programs.ts`），本包自身不做注册。

**约定**：本包不持有 Session/Flow/Scheduler/CommandBus/通用 Middleware；新运行模式实现 `DurableTaskProgram` 并放入 `durable/`；所有等待必须返回 Kernel `WaitSpec`，State 必须可持久化（JSON 可序列化）。

任务记忆授权快照：`DurableAgentInput.memoryPolicy` 保存宿主在提交时解析的策略。`buildLlmTaskInput` 深复制策略及嵌套 scope/retention；未提供时不生成该字段。直接会话已将解析后的 Agent memoryPolicy 写入 Task input。共享 app-core 已装配 memory_list/write/remove，TaskMemoryService 在 tool.call 执行时以 Kernel 身份读取该持久策略并检查工具白名单；普通 ToolService 直接调用拒绝。Flow builtin.agent 已接线；会话 binder 仅使用节点引用 Agent 的策略，不继承父会话权限。输入构造器校验 namespace、scope 数组及条数/时间限制，非法策略在提交前拒绝。底层 Flow 配置属于可信宿主输入，类型校验不替代来源授权。

### 初始 Skill 激活

buildSkillContexts(skills, catalog, allowedToolIds, selectedIds) 返回 SkillContext[]。buildLlmTaskInput 接受 skillContexts；DurableAgentProgram 初始化时复制到持久状态，逐轮关键规则与工具合并沿用动态 load_skill 路径。有效工具仍受 allowedToolIds 限制，external 标记来自宿主目录；原节点工具定义优先，初始快照不扩展工具授权。


LLM 请求失败策略：`DurableProgramInput.llmRetry?: { retries?: number; backoffMs?: number }`，
默认 retries=3、backoffMs=1000，retries 范围 0..3（额外重试，不含首次）。共享 llmEffect
生成持久 Effect retry，Agent / Chat / Plan 使用同一策略；可重试错误由适配器分类，总等待受 timeoutMs 限制。

结构化输出的 `outputValidation.onInvalid: repair` 默认额外修复 3 次，显式 retries 优先；
修复计入 maxExchanges。无效响应生成 `llm.output.invalid` 持久事件，包含解析错误、finishReason、
响应长度与首尾片段、实际修复策略和预算，详见 [Flow 能力与输出](./design/flow-capabilities-and-output.md)。

llmRetry.retries 表示附加尝试次数，默认 3，backoffMs 默认 1000；宿主可覆盖，机制只校验数值边界，禁止溢出总尝试次数。toolTimeoutMs 是正的安全整数，默认 300000。buildLlmTaskInput 验证并复制策略，工具 Effect 从持久 Agent 输入读取，恢复后不会重新读取宿主当前配置。
