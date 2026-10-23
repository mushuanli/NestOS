# Flow 内部变量

## 语义与配置

新流程用 `param` 表示声明的运行参数，用 `input.prompt` 表示只读提示词，用 `vars` 表示可修改的运行状态。补全输入节点先收集必需字段；变量消费者等待其完成，再用补全后的输入初始化变量。声明保存在 `.flow` 草稿中，发布时进入 revision 和 digest。

```yaml
variables:
  essay:
    type: string
    initial: ${param.essay}
```

变量类型为 string、number、boolean、json；必须声明 initial。初值允许引用 param 与只读 input，不能依赖其他变量或节点，避免初始化顺序歧义。变量名称必须是合法标识符，禁止原型相关名称。

Agent 执行绑定为 Flow 时，发送正文作为 `${input.prompt}`，其他运行参数按 Flow 签名分别填写。可声明 `variables.prompt: {type: string, initial: '${input.prompt}'}`，再通过 `${vars.prompt}` 读取和修改当前稿件；内置输入不需要声明，不能通过 assign 修改。未提供输入的调用默认提示词为空串。`DagRunSpec.input` 随检查点冻结，函数、批次、动态节点和结构化派发共享同一份只读输入；用户正文不再次作为模板解释。历史对象条件路径 `['input', x]` 仍表示原数据端口，新内置输入使用字符串 `${input.prompt}`。

可执行节点在顶层声明赋值映射：

```yaml
assign:
  essay: ${output.essay}
```

`output` 是节点 result 的业务值。普通 Agent 的 JSON 文本会在读取字段时解析；纯文本可用 `${output}` 整体赋值。赋值也可以引用启动快照中的 `${vars.field}`、`${param.field}` 和显式依赖的 `${nodes.id.outputs.result}`。模板只解释一次，用户内容里的 `${...}` 保持普通文本。

Prompt 使用 `${vars.essay}` 读取当前稿件；`${param.essay}` 保留最初输入。普通节点输出不隐式覆盖同名变量，必须使用 assign。执行节点可以读写变量；分节点图中的 aggregate/judge 是编译运算符，不能设置 assign，写回放在 check/revise 或独立执行节点上。

## 一致性与持久化

- 节点提交时冻结输入与变量快照。输出成功并通过节点契约校验后，计算整组 assign，检查全部变量类型，再一次性提交。失败、取消和赋值校验失败不提交该节点更新。
- 普通 DAG 中，同一变量的读写或双写必须通过图上的依赖确定先后顺序；不依赖实际完成速度。不同变量允许并行写入。当前没有隐式合并策略；需要合并时先将分支输出交给汇总节点，由一个节点写回。
- 路由一次派发的所有子节点读取同一批快照，汇合时按配置顺序原子提交成功结果的赋值；同批双写同一变量在编译时拒绝。partial 策略只接受成功子节点的更新。
- 评审 scope 内部被检查 prompt/输入引用的变量更新会推进 inputRevision，旧输入对应的评分标记为非当前，重新评审后才能用于达标判断。
- 每个 Run 独立存储变量。组合 Flow 有独立的词法作用域；子流程不会写到父流程或兄弟流程的同名变量。
- Scheduler checkpoint 保存 initial、按 Task 身份去重的 commits、启动 snapshots。snapshots 只保留 assign 实际引用的非 output 路径；没有 assign 或仅引用 output 时不复制上下文。成功提交后的必要快照继续用于重试，仅清除已被替代 Task 的快照；旧完整上下文仍可读取。恢复重放不会重复应用已提交写入；图级重试移除已被替代 Task 的写入后重算。路由子节点的变量、写入来源和轮次还保存在 flow.dispatch Task 的持久状态中。
- 作用域成功结束后把其写过的变量提交给外层 DAG。作用域运行中可观察内部状态，外部消费者通过作用域依赖等待提交。
- 最终根输出包含 `variables.initial/current/changes`（按作用域分组，空字符串表示根作用域）；不包含完整 prompt 快照。Session History 和 CLI 结果使用该输出。RunGet 另提供持久检查点；llm-ui 展示初值、当前值和来源 Task。

## 作文模板

`essay-review.flow` 声明 `vars.essay`，初值来自 `param.essay`。评审与修改的 prompt 都读取 vars.essay；修改节点返回完整 essay，通过 assign 写回。四维评审 → 汇总 → 判断 → 修改 → 重新评审，全部达标或到达 maxRounds 后退出，最后一轮不再生成未经评审的稿件。

旧版本没有 variables/assign 的结构化流程仍保留原有 revision.fields 更新输入的语义。已有用户文件不自动改写；要迁移需添加 variables 和 assign，并将读取当前稿件的 prompt 改为 vars.essay。保存后重新运行会创建新发布版本和新分支，旧运行继续使用原版本。

## 设计器入口

- Flow settings：流程变量 JSON 声明。
- 节点高级设置：成功后写回变量的 assign JSON 映射。
- Prompt 引用选择：包含声明的 vars 字段。
- 流程输出：变量初始值、当前值、修改来源；与当前所选 Run/branch 对应。

## 实现与验证

- [公共变量语义与调度检查点](../../backend/llm-flow/src/flow/variables.ts)
- [普通 DAG 调度器](../../backend/llm-flow/src/flow/executor.ts)
- [结构化路由提交](../../backend/llm-flow/src/flow/structured/dispatch.ts)
- [模板引用](../../backend/llm-flow/src/contracts/flow-templates.ts)
- [变量运行验证](../../backend/llm-flow/__tests__/variables.test.ts)：普通节点、原参数保留、运行隔离、补全后初始化、重启恢复、原子校验、重试清理、组合流程隔离、纯文本/JSON 输出。
- [作文与子节点验证](../../backend/llm-flow/__tests__/structured-flow.test.ts)：修改后评审读取新稿，外层节点读取新变量，普通 check 写回与重启恢复。

启动安装、恢复、草稿校验和发布共用 `createFlowRevision` 转换，保留 variables 与节点 assign，避免校验入口漏传声明。内置模板安装回归通过实际 DagCommandService 命令覆盖首次安装、保存发布、重复安装保留用户改动、删除后显式恢复，以及未声明变量的拒绝。
