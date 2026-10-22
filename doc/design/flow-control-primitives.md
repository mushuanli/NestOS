# Flow 控制节点

新图将选路、并发、等待、聚合与循环分别表达；旧 route@2/@3 及评审专用插件继续支持已有定义。

| 节点 | 职责 | Program |
|---|---|---|
| builtin.route@1.0.0 | exclusive/multicast 条件选路，result 返回 selectedEdgeIds/selectedValue | flow.value@1 |
| builtin.taskGroup@1.0.0 | 声明直接 worker 及 maxConcurrency；每个 worker 保留独立 Task | flow.value@1 |
| builtin.join@1.0.0 | 等待 worker 终态，收集结果与失败 | flow.join@1 |
| builtin.aggregate@3.0.0 | 调用版本化 reducer，合并 previous/updates；默认 latest@1 | flow.value@1 |
| builtin.loop@1.0.0 | 声明带反馈边的循环及 maxRounds，输出 round/maxRounds/lastRound | flow.value@1 |

join 的 mode 支持 all/any/first-success/quorum。any 等待首个终态；first-success/quorum 只计成功。remaining 独立选择 continue 或 cancel，默认 continue；failure 选择 fail 或 partial；result 选择 collect 或 discard。result 输出包含 results 和 failures，可用 keys 将 worker id 映射到结果名。旧 delegation.wait 未设置 remaining 时保留 cancel 行为，可显式改为 continue。

调度器先持久创建组内 worker 身份，再按全局与组内并发额度启动实际执行。join 通过 durable wait 等待已创建任务，不占 worker 执行额度，也不使用全部成功的 dependsOn 阻塞自身。仅显式 remaining=cancel 的成功 join 取消未完成成员；join 自身失败交给既有 Run 失败策略处理。取消权限限定于连接该 join 的任务。

条件表达式支持 `and`、`or`、`not`；布尔 OR 与 join 的 any/first-success 含义不同。前者选择分支，后者消费已经创建的 Task 终态。未选分支必须传播跳过状态；汇合只等待活跃路径。函数入口的控制边用于参数准入，不能重新激活函数内部被排除的分支。

2026-10-22 复验修复了两个调度缺陷：未选分支的孙节点仍执行；整段函数调用被跳过后，其内部节点永久等待不存在的实参，导致外部汇合未执行。调度器现在先将跳过状态传播到稳定状态，再派发任务，并处理被跳过的函数作用域。[分支回归](../../backend/llm-flow/__tests__/branch-readiness.test.ts) 覆盖倒序节点列表、多级分支、函数内部、整函数跳过、共同汇合及恢复不创建未选任务。

当前 taskGroup 是静态图分组：直接成员必须为普通节点，并连接同一个 join。它不提供独立的组级 Kernel 生命周期、嵌套 taskGroup、重叠 loop 或独立 subRun。对于运行时参数对象数组，使用 `builtin.flow@2` 的 `parameterSets` 调用同一个函数，`maxConcurrency` 限制完整函数调用，返回按输入序汇合；无需业务 Tool 生成调度图，详见[函数调用](flow-invocation-composition.md)。这没有引入任意集合变换或通用脚本执行器。loop 编译使用整个强连通分量，包含并行路径；各轮等待前轮成员结束，并使用同轮数据绑定。

通用分批由 `builtin.transform.operation: batch` 生成命名参数对象数组：支持任意图片/文本/对象数组、批次大小及可选原组边界，后续仍调用相同 Flow 函数。`mode: combined` 合并分批，`grouped` 保留原组边界，输入及分组的内容与顺序必须一致。局部函数可放在主定义的 `functions` 数组中，发布、恢复及归档随主文件保存，调用语法不变。

动态汇合允许新增节点回连 spawn 的直接下游，但目标必须尚未启动且未被跳过；existing → existing、无关目标及新增闭环均拒绝，整批绑定校验后才发布。组合函数返回会补齐同作用域动态成员的依赖，失败/取消不得先返回成功再由根聚合补报；显式 continue、委派容错和 detached 保留各自语义。相关恢复与失败回归见 `dynamic-return.test.ts`、`dynamic-call-failure.test.ts`。

[作文评审模板](../../backend/app-core/src/presets/essay-review.json) 已迁移为 loop → taskGroup → 四个普通 Agent → join → aggregate → route，改写也使用普通 Agent。Agent 的隔离调用保留 system 指令并排除会话历史。评审与改写使用 JSON Schema 和三次输出修复；达到评分条件或轮数上限后转入报告。

实现：[控制图编译](../../backend/llm-flow/src/flow/control/graph.ts)、[插件](../../backend/llm-flow/src/flow/control/plugins.ts)、[join Program](../../backend/llm-flow/src/flow/control/join-program.ts)、[并发调度](../../backend/llm-flow/src/flow/control/scheduling.ts)。

验证：[原生控制节点测试](../../backend/llm-flow/__tests__/control-flow.test.ts) 覆盖实际并发、提前汇合、剩余任务策略、失败与 quorum、结果丢弃、并行循环及模板多轮执行。旧图兼容测试使用冻结的旧模板。
