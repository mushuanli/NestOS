# llm-flow 开发说明

本包是 DAG 编排层：把 `llm-tasks` 的 LLM 任务单元连成动态图（route/loop/spawn/compensate/on_failure/budget），并持久化 Flow 定义。详见 [llm-flow API](../../doc/llm-flow-api.md)。

Flow / Node 类型、当前编排能力与 Harness 要求的覆盖及限制，见 [Harness Flow 分析](../../doc/design/harness-flow.md)。

MCP/tools/Skill 的宿主装配、隔离上下文、批准恢复与 UI 输出见 [Flow 能力与输出](../../doc/design/flow-capabilities-and-output.md)。

真实模型 CLI 运行与输入补全验收见 [作文 CLI 验证](../../doc/design/essay-review-cli-verification.md)。

## 目录

```text
src/
├── index.ts                  统一导出
├── flow-definition-store.ts  FlowDefinitionStore（最小 FlowStore 接口 + 版本冲突）
└── flow/
    ├── executor.ts           DurableFlowExecutor（运行装配 / 所有权边界）
    ├── scheduler.ts          并发派发、等待、结算与租约失权退出
    ├── checkpoint-decoder.ts 恢复 envelope 校验
    ├── graph-decoder.ts      图效果整批结构解码
    ├── scheduler-state.ts    checkpoint 集合恢复、序列化与 Task 重挂
    ├── graph-retry-controller.ts 图重试消费、下游失效与委派清理
    ├── run-lifecycle.ts      工作区恢复、失败清理与 detached drain
    ├── run-aggregation.ts    根 Task 聚合、运行成员及结果投影
    ├── scheduler-readiness.ts 循环、路由、join 与 return 就绪判定
    ├── graph-mutations.ts    动态图 patch、边状态及 join 取消约束
    ├── node-task-preparation.ts 上游轮次、模板、变量与连接解析
    ├── task-factory.ts       插件任务 → Kernel 请求、工具/Skill/Context 装配
    ├── builtin-plugins.ts    内置插件 transform/reduce/route/spawn/flow/human/agent
    ├── structured/           输入补全、route@2 独立 Task 派发、隔离上下文、按键汇总
    ├── programs.ts           FlowValue / FlowHuman / FlowAggregate Program
    ├── operations.ts         transform/reduce/route/spawn 纯操作
    ├── plugin-registry.ts    插件注册表 + schema 注册
    ├── to-dag.ts             FlowRevision → DagRunSpec
    ├── validation.ts         Flow 校验（环检测、预算校验）
    ├── graph.ts              泛型 findCycles
    ├── commands.ts           DagCommandService
    ├── delegation-runtime.ts 委派声明解析与图成员构造（fan-out / join / 预算）
    ├── delegation-controller.ts 委派等待、超时、失败与绑定继承
    ├── node-instance.ts      节点轮次身份编码与解析
    ├── parameters.ts         运行参数模板解析与校验
    ├── connections.ts        节点连接槽解析
    ├── run-members.ts        运行成员读取与重试准备
    └── workflow/             工作流 DSL：类型 + compile + route 表达式
```

## 公共契约

`@itookit/llm-flow/contracts` 拥有 Flow/DAG、委派、派发、Hook、控制流与模板契约及纯函数；入口不加载执行器或存储实现。实现只依赖 durable-kernel、llm-tasks 和 llm-context，不再依赖 common/llm-common。命令接入经最小 `FlowCommandRegistrar.register` 端口，宿主可直接传入现有 CommandBus。

## 约束

- 只编排 DAG，不持有会话语义（Round/Branch/SessionRepository 属于 llm-session）。
- 不依赖 llm-session、UI、DOM 或具体设备；能力通过 kernel Effect 使用。
- FlowDefinitionStore 只依赖最小 `FlowStore` 接口（listFiles/findFile/createFile/readFile/writeFile/renameFile/deleteFile/createAsset/readAsset/listAssets），由会话层的 `FlowEngine`（`llm-session/src/persistence/flow-engine.ts`，`flows` VFS 模块）适配。

运行：

```bash
pnpm --filter @itookit/llm-flow typecheck
pnpm --filter @itookit/llm-flow test
```

结构化派发配置与边界见 [作文评审实现](../../doc/design/essay-review-flow.md)，可运行定义见 [essay-review-isolated.flow](../app-core/src/presets/essay-review-isolated.json)。紧凑派发使用 route@2；可视分节点使用 route@3 → check@1 → aggregate@2 → judge@1，`structured/graph.ts` 编译为持久作用域，`expand.ts` 展开旧草稿；业务轮数在判断节点配置 `maxRounds`。

统一契约：`structured/references.ts` 编译引用依赖并在节点提交前解析；`condition.ts` 将可视条件编译为表达式；`join.ts` 注册版本化纯 reducer。公共 prompt 在每次 spawn 时渲染一次，不能重解释插入数据。修改 schema 支持范围时同步 schema-registry、schema-compat 和结构化输出校验。

变量声明、assign 写回、并发依赖、恢复与组合 Flow 隔离见 [Flow 内部变量](../../doc/design/flow-variables.md)。新变量能力统一经 `flow/variables.ts` 校验与提交，不允许节点直接改写 Session 参数。

Scheduler 就绪判定在 flow/scheduler-readiness.ts，以显式运行状态消费循环、路由、join 与 return 范围；跳过状态仍由调度器持有，不改变 checkpoint 或租约边界。

GraphMutationRuntime 只持有单次运行的显式图状态；宿主通过 bindNode 解析动态节点身份。整批绑定和校验完成后才发布节点、边与幂等记录，checkpoint 和租约仍由 executor 管理，不在此模块新增持久化或产品策略。

DelegationController 消费单次运行的显式状态，执行已声明的 wait/failure 策略；agent.spawned 通过宿主回调发出。它不提交任务、不写 checkpoint、不取得租约。detached 工作的持久恢复、所有权保持与工作区收尾继续由 executor 协调。

prepareNodeTask 只准备节点输入与变量快照；FlowTaskFactory 只构造 Kernel TaskSpec，保留嵌套 dispatch 的宿主绑定与 Context Program 版本。executor 按原顺序执行 task.started、submit、运行成员更新、能力绑定与 checkpoint。上述组件保持包内，不增加 npm 包或根导出。

GraphRetryController 在同次消费中对每个 requestId 只执行一次内存图修改，CAS 冲突重读队列时合并新意图；图修改与 appliedGraphRetries 回执先提交同一 checkpoint，再 CAS 确认队列；恢复按回执跳过已应用请求，确认写入仍是独立事务。Scheduler collections 保持 version-1 存储格式。FlowRunAggregation 使用当前 fenced Session；根创建发生在调度租约建立前，最终投影写入发生在租约建立后，不能缓存初始未 fencing 的 Session。

FlowRunLifecycle 接收宿主工作区 manager、已 fencing 的 Session 和租约；清理先确认任务停止及能力释放，detached drain 保持调度所有权。公共 workspace 类型与 workspaceLeaseKey 定义移入 run-lifecycle，其中 workspace 类型继续从原 executor/root 入口导出，lease key 继续仅从源码 executor 入口转发，内部组件不新增根 API。

FlowScheduler 消费显式运行状态与提交、预算、Hook、checkpoint 端口；保留控制组并发、交互等待、生产者校验和补偿顺序。lease 失权或宿主关闭仅解除本地调度，不将 Run 标成失败。外部图效果整批解码后才修改图；重试队列和持久 checkpoint 在恢复前检查结构，未知插件配置仍归插件校验。
