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

当前 taskGroup 是静态图分组：直接成员必须为普通节点，并连接同一个 join。它不提供独立的组级 Kernel 生命周期、动态 map、嵌套 taskGroup、重叠 loop 或独立 subRun；这些仍是扩展边界，不能据此认为 Harness 的所有资源与生命周期能力均已覆盖。loop 编译使用整个强连通分量，包含并行路径；各轮等待前轮成员结束，并使用同轮数据绑定。

[作文评审模板](../../backend/app-core/src/presets/essay-review-isolated.json) 已迁移为 loop → taskGroup → 四个普通 Agent → join → aggregate → route，改写也使用普通 Agent。Agent 的隔离调用保留 system 指令并排除会话历史。评审与改写使用 JSON Schema 和三次输出修复；达到评分条件或轮数上限后转入报告。

实现：[控制图编译](../../backend/llm-flow/src/flow/control/graph.ts)、[插件](../../backend/llm-flow/src/flow/control/plugins.ts)、[join Program](../../backend/llm-flow/src/flow/control/join-program.ts)、[并发调度](../../backend/llm-flow/src/flow/control/scheduling.ts)。

验证：[原生控制节点测试](../../backend/llm-flow/__tests__/control-flow.test.ts) 覆盖实际并发、提前汇合、剩余任务策略、失败与 quorum、结果丢弃、并行循环及模板多轮执行。旧图兼容测试使用冻结的旧模板。
