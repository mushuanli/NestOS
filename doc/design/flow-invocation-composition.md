# Flow 函数化、组合与并发调用审查

状态：已实现并发调用、slash 入口和 `builtin.flow@2` 函数式组合。旧版 `builtin.flow@1` 及既有 Flow Session 保持兼容。

## 当前使用方式

- 聊天输入 `/flow` 选择流程，或 `/flow <id> {"参数名":"值"}` 预填参数表单。提交后仍停留在当前聊天，可以继续调用其他 Flow、重复调用同一 Flow 或发送普通聊天。
- 每次调用有独立卡片，显示参数、运行状态、结果和待处理交互；支持查看完整运行详情、取消、恢复、再次调用、将结果放入聊天草稿。关闭卡片所在编辑器只停止订阅，不取消运行。
- 文件右键和设计器运行按钮通过同一个调用服务在新会话启动；执行发生在导航之前，打开视图不会再自动重复启动。
- 多个后台调用存在时，普通 `/cancel`、`/approve`、`/resume` 会提示使用对应卡片，避免选错目标。复杂输入仍使用参数表单；审批和简单回复在各自卡片中完成，草稿彼此独立。
- 设计器新增 Call Flow（v2）节点，选择已发布的 Flow、填写参数绑定。流程设置中的“返回值声明（JSON）”保存 outputs；命名返回端口在图和连线编辑器显示。

参数在模态表单中填写，不嵌在 ChatInput 中；命令 JSON 优先预填，其余字段采用参数默认值。不会自动从聊天、附件或文件提取值。有参数时即使预填完整也需提交表单；无参数时直接启动。文件路径作为普通字符串传递，需要读取正文时由 Flow 节点显式调用文件工具。可运行的工具、Skill、MCP 例子见 [Harness 验证例子](../../apps/cli/examples/harness-validation/README.md)。

被调用 Flow 必须声明参数及返回值。例如返回声明：

```json
{
  "result": {"value": "${nodes.report.outputs.result}", "schema": {"type": "object"}},
  "score": {"value": "${nodes.score.outputs.result}", "schema": {"type": "number"}}
}
```

父流程调用节点示例：

```json
{
  "id": "review",
  "name": "Review",
  "plugin": "builtin.flow",
  "pluginVersion": "2.0.0",
  "inputs": {},
  "config": {
    "flowId": "essay-review",
    "revision": 3,
    "parameters": {"essay": "${nodes.extract.outputs.result.text}"}
  }
}
```

后续节点可引用 `${nodes.review.outputs.result}`、`${nodes.review.outputs.score}`。独立调用节点自动并行，显式引用建立串联/汇合依赖。

## 已实现的边界

- v2 调用先通过持久入口节点解析父参数、上游结果或变量，再按子参数 schema 验证；只传显式实参与默认值，不隐式继承全部父参数。入口输出作为子作用域的参数来源，恢复使用同一持久 Task 输出，数据不二次插值。
- 子流程变量仍按调用路径隔离；调用会通知宿主 binder 使用隔离上下文。返回节点等待作用域内包括循环后续轮次的工作完成，再按 outputs 声明组装并验证结果；显式 detached 的后台成员沿用既有生命周期，不阻塞返回。`__flow_return` 为编译器保留节点名。组合时同时重映射 taskGroup/loop 成员与路由边，保留 join 对外结果键名。
- 发布新 revision 时保存递归 dependencyLocks（子 id/revision/digest/子锁），计入父 digest。原有已发布版本不会被改写；新版本拒绝循环、过深和过大依赖。重复运行使用原 revision 的锁定依赖。
- `FlowInvocationService` 在 Session shared 的 `flow.invocation.<requestId>` 保存独立调用记录和提交意图，不向普通聊天分支追加未完成 user Round。来源 branch/head 在宿主装配时冻结；Task/Run 是运行状态权威。
- 根 Task 原子提交携带 requestId 及 invocation 元数据。重复请求或丢失记录回执通过根 Task 核对，避免再次启动；同 requestId 不允许更改参数。宿主启动核对已有根并恢复调度，补交尚无根且未记录启动错误的意图。
- 卡片通过 `RunGet` 的任务成员表恢复所有 pending interaction，并以根 taskId、具体 taskId、interactionId 提交。提交前重读待处理状态；停止订阅后拒绝旧回复。
- 原聊天 Session 的单前台运行限制保留；独立 Flow 调用不占用该槽位。Flow 调用卡片的输出仅在用户“用于对话”后进入草稿，不自动注入模型 history。

当前显式限制：v2 不支持子 Flow 自带 runPolicy，运行限额/工作区应配置在父 Flow；调用节点的 retry、compensate、assign、budget、capabilities 也不能隐式传递，非空配置会被拒绝，应配置在子流程执行节点上。尚未实现跨子作用域的独立限额和整个子调用的自动重试。共享目录仍共享文件副作用，可使用既有父 Run worktree 策略。设计器签名按所选发布版本读取；参数表单以定义库字段为引导，最终运行验证仍以发布版本为准。

子 Flow 内部可以使用 taskGroup；函数调用节点不能直接作为父 taskGroup 的 worker，因为其成员并发额度尚不支持整个子调用的生命周期，此组合会明确拒绝。多个普通函数节点仍可并行，受父 Run 并发上限约束。

恢复不会抢占仍有效的 Session/调度租约。宿主启动恢复失败会保留持久运行，用户可在卡片“恢复此调用”重试。此次新增恢复测试覆盖 Kernel 重建与持久提交意图，并非多个 Flow 调用的真实桌面强杀验收。

## 实现与验证

调用面板首次挂载立即加载；存在非终态调用或读取失败时每秒刷新，空列表或全部终态时改为 30 秒同步，保留其他宿主变更的可见性。窗口获得焦点、页面恢复可见和当前界面发起调用时立即刷新；销毁后解绑监听器、停止轮询并忽略迟到结果。计时与销毁回归见 [调用轮询](../../ui/app-shell/tests/flow-invocation-polling.test.ts)。

- 编译与契约：[function-call](../../backend/llm-flow/src/flow/function-call.ts)、[function-outputs](../../backend/llm-flow/src/flow/function-outputs.ts)、[dependency-locks](../../backend/llm-flow/src/flow/dependency-locks.ts)。
- 会话调用：[FlowInvocationService](../../backend/llm-session/src/session/flow-invocations.ts)。
- UI：[InvocationPanel](../../ui/llm-ui/src/flows/InvocationPanel.ts)、[invoke-flow](../../ui/llm-ui/src/flows/invoke-flow.ts)。
- 新增回归：[函数组合](../../backend/llm-flow/__tests__/function-calls.test.ts)、[并发/提交恢复](../../backend/llm-session/__tests__/flow-invocations.test.ts)、[真实 Kernel + DOM](../../ui/app-shell/tests/flow-invocations.test.ts)。
- 已通过 llm-flow、llm-session、llm-ui 整包测试，以及应用层相关回归、全仓类型检查、样式检查。应用层整包中遇到沙箱 Git 子进程拒绝和本地 HTTP 测试超时；对应 workspace-crash 与 host-restart-inflight 在沙箱外单独重跑通过。未进行真实模型或人工 GUI 验收。

## 初始审查与设计记录

以下保留实施前的审查依据及完整设计方向；当前能力和未支持范围以上文为准。

## 结论与目标

建议将 Flow 定位为有输入、返回值和固定版本的可调用定义，将每次调用建模为独立 Invocation。Session 是调用与对话的容器，不应只能绑定一个 Flow。`llm-ui` 负责选择、参数填写和调用卡片；组合语义归 `llm-flow`，调用与会话历史归 `llm-session`，宿主能力继续由 `app-core` 装配。

“同时使用”需要同时满足三个目标：

1. 同一个聊天界面可以启动 A、B，甚至用不同参数重复启动 A；各自运行、审批、取消、查看结果，输入区仍可使用。
2. Flow 可以作为另一个 Flow 的节点；支持串联、并行、汇合，并通过声明的参数和返回值传递数据。
3. 输入 `/flow` 可以发现、选取并调用 Flow；这次调用不会把当前 Session 后续所有消息切换为该 Flow。

跨 Session 分别启动、顺序排队或只增加 slash 按钮，都不能单独满足上述目标。

## 现状与证据

| 层次 | 当前实现 | 对目标的影响 |
| --- | --- | --- |
| UI 启动 | [FlowLauncher](../../ui/llm-ui/src/flows/run-flow.ts) 收集参数、发布 revision、CreateFromFlow、导航 | 一次运行进入一个新 Flow Session；`pending` 只覆盖启动流程，并非执行期间的全局锁 |
| Session 模式 | [LLMWorkspaceEditor](../../ui/llm-ui/src/shell/LLMWorkspaceEditor.ts) 读取 manifest.flow，selectFlow；空 Session 打开时自动发送 | 启动执行依赖打开编辑器，Flow 与 Session 模式绑定 |
| 发送准入 | [SessionRunCoordinator.submit](../../backend/llm-session/src/session/session-run-coordinator.ts) 按 sessionId 保存一个 active，重复提交报 SESSION_BUSY | 硬限制是每个 Session 一个活动 Run；代码未在这里施加应用级单 Run 限制 |
| 会话语义 | [RoundOperations.sendMessage](../../backend/llm-session/src/session/round-operations.ts) 拒绝连续 user；[ConversationRunCoordinator](../../backend/llm-session/src/session/conversation-run-coordinator.ts) 按 sessionId 保存一个执行，并通过 appendExpected 写入分支 | 删除 SESSION_BUSY 检查会留下状态覆盖、控制目标不明确和 branch head 冲突 |
| 输入区 | [ChatInputView](../../ui/llm-ui/src/components/input/ChatInputView.ts) 的 setLoading 禁用 textarea；triggerSend 在插件钩子前检查 loading | 运行时无法输入第二次 Flow 调用，新增 slash 解析仍会被前置条件挡住 |
| 控制与恢复 | [RunAttachmentController](../../ui/llm-ui/src/shell/RunAttachmentController.ts) 持有一个 handle；[pending-interaction](../../ui/llm-ui/src/shell/pending-interaction.ts) 只恢复最新一个待交互任务 | 一个焦点 attachment 可以保留，但不能作为全部活动调用和审批的唯一来源 |
| Slash | [SlashCommandPlugin](../../ui/llm-ui/src/components/input/plugins/SlashCommandPlugin.ts) 支持静态命令和动态 sk 命令；[Router](../../ui/llm-ui/src/shell/SlashCommandRouter.ts) 装配回调 | 可复用候选、解析和宿主回调模式，目前没有 Flow 调用入口 |
| 底层运行 | [DagCommandService](../../backend/llm-flow/src/flow/commands.ts) 已有 RunStart/List/Get/Cancel/Respond，handles 按根 taskId 保存 | 已有多 Run 控制基础；直接从 slash 调用 RunStart 仍缺会话调用记录、历史归属及恢复协调 |
| Flow 组合 | [builtin-plugins](../../backend/llm-flow/src/flow/builtin-plugins.ts) 注册 builtin.flow；[flowToDag](../../backend/llm-flow/src/flow/to-dag.ts) 递归展开并加节点前缀 | 已能组合成 DAG，不需要另造调度器；已有参数作用域、变量隔离与递归引用检测 |

现有输出窗口也已有按 branch/Run 选择的能力，见 [session-output](../../ui/llm-ui/src/flows/session-output.ts)。这可复用，但它目前只展示已归属于分支的执行，不能代替新的调用准入和历史记录。

## 现有组合为什么还不等于函数调用

以下前四项通过独立最小探针调用实际 `flowToDag`、`scopedParameters` 验证，非仅根据类型推测。

1. **上游结果不能完整地作为子 Flow 实参。** `config.parameters.text = '${nodes.source.outputs.result}'` 会编译出 source 到子图入口的依赖，但 `scopedParameters` 渲染绑定时只传 `{ param: parent }`，没有 nodes/vars 上下文，实际报 Missing Flow reference。`review(extract(document))` 这样的自然用法尚不完整。
2. **缺少稳定的返回接口。** 当前把父节点的出边接到子图所有叶节点，仅在恰好一个出口时重映射 `${nodes.call.outputs.result}`。双出口时 call 节点已被移除，该引用仍指向 call；编译不会替使用者定义统一返回值。`FlowDraft/FlowRevision` 没有 Flow 级 outputs 声明。
3. **缺少完整调用边界。** 子图 runPolicy 中的 maxConcurrency/maxTokens 没有合入父图作用域；调用节点自己的 retry 也未传递到展开节点。子参数还会混入全部父参数，虽然变量已有隔离，但这不是严格的显式参数契约。不能据此宣称子 Flow 的独立运行策略在组合后仍然生效。
4. **父 revision 不锁定全部子依赖。** 子节点 revision 可省略，解析器加载 latest；同一父定义在子 revision 更新后会编译为不同的图。已开始 Run 的展开图有 checkpoint，问题在新调用及重跑的版本可重现性，不等于恢复一定会切换版本。
5. **UI 仍以通用节点字段呈现组合。** Flow 插件提供 flowId/revision/parameters 通用 schema，缺少 Flow 库选择、根据被调用定义生成参数绑定表单、返回端口和嵌套调用身份展示。

因此，优先补齐输入绑定、返回值与调用边界，再让 UI 广泛暴露组合能力。只增加一个 Flow 选择下拉框，会让简单样例可用，却在真实流水线里遇到上述缺口。

## 建议的定义与编译模型

保留现有 `.flow`、parameters、variables、builtin.flow；新增 Flow 级返回声明和依赖锁定信息，不创建第二套 Flow 语言。下面是**提议语法，当前不可直接执行**：

```yaml
# Child definition: review
parameters:
  - name: essay
    type: string
    required: true
outputs:
  result:
    schema: { type: object }
    value: ${nodes.report.outputs.result}
```

```yaml
# Parent definition, nodes fragment
- id: review
  name: Review
  plugin: builtin.flow
  pluginVersion: 2.0.0
  config:
    flowId: essay-review
    revision: 3
    parameters:
      essay: ${nodes.extract.outputs.result.text}
```

父节点消费 `${nodes.review.outputs.result}`，不依赖子图内部路径。多个返回值使用命名端口，禁止以“最后完成的节点”决定返回值。新语义使用新插件版本；旧 builtin.flow@1 的行为保留或经显式迁移，不能无声改变已发布 revision 的含义。

继续使用现有 DAG 执行器，编译时为每个调用生成持久的入口、子图 scope 和返回节点：

```text
extract ──→ review(input → child nodes → return) ──┐
        └─→ summarize(input → child nodes → return) ─→ report
```

- 入口等待实参依赖，在父调用上下文中解析一次 param/nodes/vars，校验并冻结子参数；数据内的 `${...}` 不再次解释。只传显式参数和子定义默认值；历史、Memory、工作目录继承另设明确策略。
- 每次调用有独立 callPath、参数和变量作用域；同一 Flow 调用两次也不共享变量。保留 callPath 到内部 Task 的映射，UI 能折叠显示子调用。
- 返回节点等待该调用声明的必需工作完成，按 outputs 组装并校验返回值，再解除下游依赖。后台成员是否纳入完成条件必须显式声明，不能仅凭根结果推断所有副作用已结束。
- 发布父 revision 时解析并固定整棵子依赖的 revision/digest，计入父 digest；检测引用环、最大嵌套深度及展开规模。运行时保存展开后的 spec；默认重跑使用相同锁定依赖，升级版本作为另一个显式操作。
- 父预算是总上限；子预算和并发上限作为 scope 限制执行，不能由展开静默丢弃。初版若不支持某种子 workspace/retry/compensation 组合，应在校验时拒绝并说明，不能接受后忽略。
- 整个子调用的重试与内部节点重试分开定义。已有文件修改或工具副作用时，重新运行整个子调用可能重复副作用；幂等键、失败传播及补偿必须归属于调用作用域。

编译展开适合当前静态复用场景，不必先实现每个子调用独立创建 Session、独立调度器。未来若需要运行时选择子 Flow、独立部署或脱离父生命周期，再评估真正的子 Run 调用。

## 建议的调用与会话模型

新增会话层 Flow 调用服务，示意接口为 `invokeFlow({ sessionId, requestId, flowId, revision, parameters, contextPolicy })`。本文中的新服务和字段名称均是建议，不是已有 API。

每次返回 invocationId/rootTaskId，而不是更改 Session 的默认 Flow。持久调用记录至少包含：所属 sessionId、源 branch/head、flowId/revision/digest、锁定依赖、参数快照、rootTaskId、提交幂等 requestId、创建时间及上下文策略。Task/Run 仍是执行状态的权威来源；调用记录保存关系，不能另造一份独立的任务状态机。

推荐把调用卡片锚定在独立调用记录上，与聊天 Round 关联，但不要让并发调用争抢普通对话的最后一轮：

1. 会话层短事务串行登记调用身份、来源和幂等请求；登记后运行可以并发。相同 requestId 重试返回同一次调用，不同 requestId 可以重复运行同一个 Flow。
2. 提交 Task 与写入调用关系之间需要持久提交意图及恢复核对，防止响应丢失产生孤儿 Run 或重复启动。不能靠 UI `pending` 标志保证跨重启幂等。
3. 每次调用冻结提交时的上下文。后台输出写回各自调用卡片，完成顺序不移动当前聊天分支、不自动发送第二条聊天请求。
4. 返回值默认留在卡片，可由用户“用于对话”明确加入后续上下文；Flow 内部节点日志不自动全部进入模型 history。可显式选择继承调用时聊天上下文，函数式子 Flow 默认使用参数输入。
5. 切换聊天、关闭编辑器只解除 UI 订阅，不取消 Run；执行由宿主维持。重新打开从持久调用记录和 Kernel Run 恢复列表与所有 pending interaction。

实现上可复用 DagCommandService 的运行能力和现有 FlowRunProjection/FlowHistory，但需把会话记录、能力绑定、控制和恢复接入同一服务。按钮、文件右键、slash 都调用它；不应各自保留一套启动协议。原 CreateFromFlow 可继续作为“在专用会话打开”的入口，不能继续要求打开视图才启动后台调用。

普通聊天仍可保留一个前台模型生成；它与多个 Flow 调用独立计数。若未来允许普通聊天也并发，则需要另行定义用户轮次和分支语义，不能由本次 Flow 改造顺带隐式放开。

## llm-ui 的具体交互

建议先提供 `/flow` 选择器和明确的 `/flow <id> [参数]`；候选显示名称、说明、输入字段和版本。稳定后可加入 `/fl-<id>` 快捷别名，与现有 `/sk-<id>` 区分。

- 参数解析支持有类型的字段/JSON；缺项复用 FlowParameterForm，多个必填字段不能靠模型猜测。自由文本简写只对声明了默认文本入参的 Flow 开启；附件和 @ 文件需显式绑定字段。
- 动态列表复用 Skill 的 snapshot/refresh 模式，通过命令总线读取 Flow 库；提交时重新核验定义。草稿要先按 draftVersion 发布并显示将执行的版本，参数对话框取消不创建运行。
- 成功提交后，当前聊天里出现独立调用卡片，展示名称、参数摘要、状态、子调用进度、最终返回与展开日志。可连续提交不同 Flow 和同一个 Flow 的多个实例。
- 把全局 loading 拆为聊天生成状态、命令提交状态和调用状态；Flow 在运行不禁用输入框。命令解析先于普通聊天忙碌检查；普通消息是否排队要明确提示。
- 活动调用列表显示运行中、待输入、待审批和终态。已有“流程输出”窗口作为单次调用详情复用，卡片必须准确指定 rootTaskId。
- 所有控制携带 sessionId、rootTaskId；审批/输入再携带具体 taskId、interactionId。保留 attachment revision/pending/终态复验。
- `/cancel`、`/approve` 等只有唯一或明确选中的目标时才直接执行；多个候选时显示选择器。不能按“最近一个任务”静默取消或批准。
- 等待审批的是节点 Task，可能一轮同时有多个；交互列表按完整任务身份管理，恢复不能只选择最新一项。焦点 attachment 切换不丢弃其他待处理项。
- 同 Session 并发沿用既有目录授权。worktree 模式可隔离文件修改；共享目录中的并发写入不会被变量作用域隔离，需要按运行策略串行化冲突写入或明确选择工作副本。

Skill 继续表示指令与能力配置；Flow 表示有类型的执行图。slash 只是它们共享的发现与调用入口，不把 Flow 转成 Skill prompt 发送给模型。

## 实施顺序与完成条件

| 步骤 | 主要范围 | 完成条件 |
| --- | --- | --- |
| 1. 完整组合契约 | llm-flow/contracts、llm-flow | 上游结果/父变量能绑定子参数；多出口有声明返回；两次调用隔离；依赖锁定；不支持的策略显式拒绝 |
| 2. 多调用服务 | llm-session、app-core | 同 Session A/B/A 三次调用可同时存在；记录与提交幂等；关闭 UI 不停止执行；历史及结果不串写 |
| 3. UI 与 slash | llm-ui、app-shell DOM 回归 | /flow 发现与参数校验；持续可用输入；逐调用卡片与控制；多审批正确定位；失败保留用户输入 |
| 4. 持久恢复与资源约束 | flow/session/core/宿主集成 | 多运行崩溃恢复、依赖版本不漂移、预算限额、取消隔离、目录策略均有证据 |

应至少覆盖：`extract → review → report`、并行调用后汇合、同 Flow 不同参数并发、双返回端口、缺参/错类型、调用循环、子失败/重试/取消、两个节点使用相同 interactionId、失焦后旧审批返回、提交响应丢失、重启恢复全部等待项，以及子 Flow 升级后原父 revision 的重跑结果不变。

## 本次验证范围

执行：

```bash
pnpm --filter @itookit/llm-flow test __tests__/connections.test.ts __tests__/flow-contracts.test.ts __tests__/variables.test.ts __tests__/structured-flow.test.ts
```

结果：4 个文件、63 项测试通过，涵盖已有子图展开、单出口引用、参数单次插值和变量隔离。这些测试证明可复用基础，**不证明**本文建议的函数返回、多运行 UI 或 slash Flow 已实现。

另以最小编译探针复现：上游结果参数解析失败、父参数隐式可见、子 runPolicy/调用 retry 丢失、多出口引用保留已删除节点名，以及未锁定子版本使相同父定义编译结果变化。没有调用真实模型，也没有进行 GUI 并发验收。
