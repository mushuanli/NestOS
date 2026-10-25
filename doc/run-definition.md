# RunDefinition

`RunDefinition` 是 YAML 与 `.flow` 两种输入格式的 canonical 运行时定义。

## 数据流

```text
mindos.yml ──┐
             ├→ RunDefinition → DagRunSpec
*.flow ──────┘
```

- `RunDefinition`：统一身份、图、参数、环境和策略。
- `DagRunSpec`：`DurableFlowExecutor` 的执行输入。
- `RunRecord`：运行状态投影；权威 Task/Effect 状态仍在 durable-kernel。

当前实现：

- CLI YAML 已通过 `apps/cli/src/run-definition.ts` 编译为 `RunDefinition`；
- `.flow` 已通过 `backend/app-core/src/run/run-definition.ts` 的 `createRunDefinitionFromFlow()` 转为 `RunDefinition`；
- `RunDefinition → DagRunSpec` 已通过 `toDagRunSpec()` 实现，CLI `run` 已走该路径；
- CLI `run -f xxx.flow` 已支持 inline `.flow` 节点和 desktop profile LLM 配置；
  可用 `--params input.json` 传入运行参数；编译参数作用域与模板标记完整传到 DAG，运行快照支持补填、恢复和重跑。定义声明 `outputs` 时，CLI 从生成的返回节点提取所有具名输出保存为 `result.json`；未声明时继续选择最后一个作者节点的 result。真实模型验证与命令见 [作文 CLI 验证](./design/essay-review-cli-verification.md)。
- `RunCatalog` 只读投影已提供；
- `.flow` 的 `agentId` / `systemPromptId` / `skillIds` 引用解析已由 `backend/llm-session/src/session/flow-node-binder.ts`（`bindFlowNode` / `bindStandaloneFlowNode`）实现，并被 `backend/llm-session/src/session/session-run-coordinator.ts` 与 `DagCommandService` 使用；CLI `.flow` 入口已传入 `runtime.flowCapabilities.bindNode()`，使用 profile 时复用已登记 Agent、系统提示词和 Skill；裸 YAML 工作流不隐式读取 profile Agent 资源。远程执行绑定同样由此入口冻结，见[远程 Harness 执行连接](design/remote-harness-connections.md)。Tauri Runs 视图仍须按其宿主入口单独核对。

## 会话与命令的统一提交

`@itookit/llm-flow` 的 `CompiledRunDefinition` 是已解析配置的提交协议：

| kind | 内容 | 使用入口 |
|---|---|---|
| `task` | Session id、TaskSpec、宿主解析的 CapabilityBinding[] | 普通 Chat、Agent、`/plan`、`/exec` |
| `graph` | Session id、DagRunSpec、运行参数 | 会话内 Flow、Flow 编辑器 |

上述入口都调用 `submitRun()`，返回 `RunExecution`（根 Task 和实时 `tasks()` 成员读取）。图运行额外返回原有 `FlowExecutionHandle`，保留循环实例、动态扩图、工作区收尾和图级重试信息。根 Task 控制与 Interaction 响应仍使用 Kernel 公共接口。

单任务提交先持久化 `deferStart: true` 的 Task，再绑定能力并通过 `start({ signal })` 一并启动；`/plan`、`/exec` 的能力绑定也使用此协议。能力由可信宿主构造，不能把外部输入的能力声明直接当成授权。

普通 Chat 每次发送产生一个独立 Task；会话空闲不创建人工等待。Agent 的工具循环和 Plan 的批准仍在各自 Program 内执行。工作流允许有界回边，所以定义层的“DAG”表示可循环工作流图。Session 历史、分支、留存策略继续由会话层管理。

源码：[run-submission.ts](../backend/llm-flow/src/run-submission.ts)。`RunDefinition` 仍负责 YAML/`.flow` 的来源、环境和策略；`CompiledRunDefinition` 位于配置解析之后，不重复存储这些来源信息。CLI 的已有 `RunDefinition → DagRunSpec → DurableFlowExecutor` 路径继续使用原执行器。

## 字段

```ts
interface RunDefinition {
  id: string;
  name: string;
  revision: number;
  digest: string;
  source: 'yaml' | 'flow';
  graph: {
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
    nodeDefaults?: Record<string, Record<string, JsonValue>>;
    nodeConnections?: Record<string, Record<string, JsonValue>>;
    variables?: DagRunSpec['variables'];
    variableScopes?: DagRunSpec['variableScopes'];
    parameterScopes?: DagRunSpec['parameterScopes'];
    functionCalls?: DagRunSpec['functionCalls'];
    input?: DagRunSpec['input'];
    maxNodes?: number;
  };
  parameters?: FlowParameter[];
  environment: {
    providers?: RunProviderConfig[];
    connections?: RunConnectionConfig[];
    agents?: RunAgentConfig[];
    sandbox?: RunSandboxConfig;
  };
  policy: {
    runPolicy?: FlowRunPolicy;
    result?: { task: string; output: string };
    workspaceRoot?: string;
    additionalDirectories?: Array<{ path: string; access: 'ro' | 'rw'; at?: string }>;
  };
  metadata?: Record<string, JsonValue>;
  createdAt: number;
}
```

`apiKeyEnv` 只记录环境变量名，密钥由 host 的 `CredentialResolver` 解析，不进入 RunDefinition 快照。

## CLI 参数映射

| CLI | RunDefinition |
|---|---|
| `--profile <name>` | 选择数据根，不属于 RunDefinition |
| `--set-home <dir>` | `policy.workspaceRoot`，并生成 `/workspace` Session mount |
| `--add-dir <dir>[:ro\|rw]` | 尚未映射：CLI 只把目录作为宿主挂载交给 `CliRuntimeOptions.addDir` → `DirectoryMountService`，从不写入 `policy.additionalDirectories` |
| `-f mindos.yml` | `source: 'yaml'`，编译 YAML 后填充 graph/environment |
| `.flow` 输入 | `source: 'flow'`，从 `FlowRevision` 编译 |

CLI 的 `flow-config` 只读取文件并调用 llm-flow 公开的 `createFlowRevision`，不另行维护草稿字段清单。
首次运行在同一次编译中完成宿主绑定与最终连接准入，`variables` 与组合流程的 `variableScopes` 随执行定义保存，提交前不再二次绑定。
多组参数的函数调用模板保存在 `graph.functionCalls`，包含冻结的子图和整次调用并发上限；`createRunDefinitionFromFlow` 与 `toDagRunSpec` 双向保留该字段。恢复不能只保存入口和空汇合节点，否则会误报成功但没有实际执行参数组。CLI 的 [多组调用回归](../apps/cli/tests/flow-parameter-calls.test.ts) 覆盖完整结果和跨运行时恢复。

`graph.input` 同样双向保留只读运行输入 `{prompt: string}`。Agent 绑定内部 Flow 时，提示词通过该快照提供给 `${input.prompt}`，其他参数仍使用声明的参数 schema；它属于运行实例，不改变定义的业务参数、版本或 digest。
`rerun` 创建新 Run 并复用原执行定义，不从源码重新选择当前 tier 的模型；模型仍需可用，媒体端点变化仍在执行前拒绝。
运行时连接绑定通过 `--connection-bindings file.json` 独立传入，不改写源 Flow 及其 digest。
Agent Task 的 Session 身份取自当前运行上下文，重跑不会沿用旧定义中的 Session ID。

## 状态与投影

`RunRecord` 只保存跨入口恢复和控制所需的最小状态：

```ts
interface RunRecord {
  id: string;
  sessionId: string;
  definitionId: string;
  definitionRevision: number;
  definitionDigest: string;
  status: RunStatus;
  rootTaskId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  resultPath?: string;
}
```

`events.jsonl`、`result.json` 和 CLI stdout/JSONL 是投影，不是权威状态。

CLI Agent memory_policy 经 memoryPolicyForAgent 转换为 RunAgentConfig.memoryPolicy 与节点 config.memoryPolicy，嵌套 scope/retention 深复制；RunDefinition 保留该策略快照。记忆工具权限仍要求节点 capabilities 中显式列出 memory_list/write/remove，namespace 不赋予跨 Session 共享。

## 通用插件节点 DSL

WorkflowTaskSpec 支持 `kind: node`，通过 node 定义版本化插件；depends_on、inputs、budget、retry 等仍由工作流编译器处理。例如：

```yaml
tasks:
  - id: collect
    kind: node
    node:
      plugin: builtin.input
      pluginVersion: 1.0.0
      config:
        fields:
          essay:
            type: string
            nonBlank: true
```

同样可接入 builtin.route@2.0.0 的结构化派发循环和 builtin.aggregate@1.0.0。详细配置与 .flow 示例见 [作文评审实现](design/essay-review-flow.md)。

CLI 运行组合 `.flow` 时，从入口文件所在目录加载 `<flowId>.flow`；ID 必须是安全文件名且与定义身份一致，显式 revision 必须匹配。展开后的图、连接快照和参数作用域保存进 RunDefinition，resume 使用已有快照，不重新读取最新子定义。


## Flow 公开范围

`.flow` 根运行要求 `exposure: global`；未声明 exposure 的旧定义沿用 global。`local` 仅可由 Flow 内部调用。CLI 在读取调用参数、创建 RunStore 或启动运行时前检查根范围；app-core 的 `createRunDefinitionFromFlow` 再验证这一应用入口契约，非 CLI 消费者不能绕过。

`loadFlowDefinition` 和 `flowToDag` 保持通用加载/编译机制，不把 local 定义一律拒绝。公开父 Flow 仍可经 siblingFlowResolver 加载 local 子定义，并将编译结果冻结到 RunDefinition。此规则不是文件访问授权，也不改变旧运行快照的恢复语义。回归见 `apps/cli/tests/flow-exposure.test.ts` 与 `backend/app-core/tests/shared-core.test.ts`。
