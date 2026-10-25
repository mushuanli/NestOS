# 统一执行改动的功能合入计划

本计划针对根仓 `6d8d2171` 之后的工作树。按可独立审查、验证和回退的功能拆分；不按目录一次性提交，也不将所有 UI、CLI、RPC 接线留到最后。记录时间：2026-10-25。当前按 25 个能力组管理，F09 拆为四个交付单元，共 28 个功能切片。

## 1. 合入规则

一项功能包含自己的契约、实现、实际消费者、必要回归与文档。公共契约随首个有效消费者进入；共享文件按修改块拆分。纯算法出口等兼容性重构可先行，但不能将尚未接线的可选端口称为功能完成。

每个候选树使用独立索引组装，再在隔离源码检出中测试、检查类型；隔离树使用该提交锁定的独立库版本，不能借用完整工作树中尚未合入的依赖。提交后核对树与候选一致，保留原有用户暂存项。

“子仓已提交”只表示子仓内部有可追溯提交，根仓尚未更新 gitlink 时，不表示应用已消费。合入也不表示已部署，更不能代替原故障 Session 的验收。

## 2. 职责与依赖

```mermaid
C4Component
    title 功能切片共享机制与宿主边界
    Container_Boundary(host, "MindOS 宿主") {
        Component(entry, "UI / CLI / RPC", "入口适配", "输入编辑、台账、结果展示、能力传输")
        Component(session, "llm-session", "会话语义", "准入、队列、调用身份、历史关联")
        Component(flow, "llm-flow", "编排机制", "参数解析、节点调度、成员与控制树")
        Component(core, "app-core", "用例与装配", "授权、发布、租约、资产与 binding 端口")
        Component(effect, "kernel-adapters", "执行桥", "连接事实与 Kernel 结果转换")
        Component(port, "HarnessExecutionProvider", "注入契约", "execute / reconcile / cancel")
        Component(driver, "mindos-node-driver", "原生协议适配", "操作身份、回执、队列与查询")
    }
    Component(kernel, "durable-kernel", "持久机制", "任务事实、原子准入、控制与清理")
    Component(node, "mindos-node", "SDK 宿主", "原生会话、turn、查询与输出")
    Rel(entry, session, "结构化提交；独立回答和控制")
    Rel(session, flow, "冻结实参与执行关联")
    Rel(session, kernel, "持久准入与事实观察")
    Rel(flow, kernel, "提交与控制 Task")
    Rel(core, session, "注入授权、资产和上下文端口")
    Rel(core, driver, "装配原生连接")
    Rel(kernel, effect, "执行、核对与清理")
    Rel(core, port, "实现并装配")
    Rel(effect, port, "调用注入端口")
    Rel(driver, node, "有身份的原生操作与查询")
```

图中的连接端口由宿主注入；kernel-adapters 不反向导入 app-core。业务默认值、公开范围和授权策略归宿主与定义，原子控制、租约条件写和幂等事实归机制。UI 不参与释放资源判定，原生 driver 不决定 Session 分支或业务目标。

各功能复用现有 OperationLedger、指令队列、Kernel、journal 与 Session 存储；本次拆分不增加调度器、状态库或 package。

## 3. 已独立提交的基础切片

| 编号 | 功能 | 根仓提交 | 验证边界 |
|---|---|---|---|
| B01 | 构建源变更诊断 | `ef5ef18a` | 9 个构建工具回归；保留原源码冻结保护 |
| B02 | 无运行时依赖的摘要出口 | `9acd6504` | Context 测试、类型、构建及 ESM/CJS 出口 |
| B03 | 当前输入材料去重 | `25a088de` | 文本、附件、结构化内容身份与预算回归 |
| B04 | 已接纳初始化在关闭期间排空 | `12954a08` | 7 个启动回归及 app-core 类型 |
| B05 | 恢复先排空再停止 Kernel | `5aafb3d8` | 19 个启动/恢复回归及 app-core 类型 |
| F01 | 子 Session 执行存储准备 | `9d0eda8b` | 存储/恢复 15 项、内容转交 9 项及 Session/app-core 类型 |
| F02 | Kernel 控制 API 与 Flow/RPC 集成 | `d2ad3268` | Kernel 419 项、Flow 18 项、RPC 3 项及五个消费包类型 |
| F03 | 远程恢复记录 CAS | `3edebe15` | 隔离存储/草稿 13 项、延迟读取故障回归及 app-core 类型 |
| F04 | 原生队列宿主与 RPC | `6d1f090b` | driver 293 项、宿主 893 项、RPC 4 项及消费包类型；跳过项单独记录 |
| F25 | Flow 调度准入所有权 | `0bcfa29e` | 完整 Flow 635 项及 Flow/Session/app-core 类型 |
| F09a | 默认远程工作台队列与接纳等待 | `4df2896d` | 队列库 92 项、适配层 128 项、接纳 6 项、远程 DOM 86 项及消费包类型 |
| F09b | 独立 ChatView 原生接纳台账 | `ceb71d43` | 适配层 133 项、原生及远程 DOM 88 项及消费包类型 |
| F09c | 独立原生视图队列编辑区 | `dd4c04bd` | 适配层 133 项、队列编辑/隐藏及远程 DOM 88 项及消费包类型 |
| F05/F06/F07 | 原生查询、取消核对与结果读取 | `09c122fc` | 适配层 141 项、真实 UI/RPC 118 项、HTTP RPC 5 项及消费包类型；Node 复用同源码已审查证据 |
| F11 | 统一 Flow 实参与公开范围准入 | `fc007454` | 完整 Flow 668 项、构建及四个消费包类型；未知来源字段两项回归从失败到通过 |
| F10 | Agent 不可变发布与队列策略冻结 | `44656133` | 隔离 Session 380 项、设置 UI 162 项、宿主 33 项、认证 HTTP 2 项，类型/构建、边界及 C4 检查 |
| F08 及调用入口必要接线 | 本地队列编辑、后端/CLI 根调用、根 Invocation 与 Session 附件冻结 | `937fe32b` | Context 39 项、Flow 668 项、Session 433 项、完整宿主 933 项、CLI 28 项、队列 DOM 6 项；构建/边界通过，历史切换 8.65 秒 |
| B06 | 历史 DOM 引用与展示身份归属 | `642cb67f` | 隔离历史/原生/窗口 119 项、类型及构建；完整工作树同一 30 秒预算从超时恢复为 8.64 秒通过 |
| F13/F14 | 不可变输入资产、通用文件表单与派发就绪校验 | `a2989fc4` | 完整宿主 947 项（另 13 跳过）、Session 433 项、Flow 668 项；UI 75 项、认证 HTTP 22 项、类型/构建/边界及 C4 通过 |
| F12 及 F09d 必要接线 | 默认工作台/独立视图平级目标、冻结请求台账与恢复 | `630455b4` | 适配层 156 项、相关工作台 146 项、项目草稿 16 项、四包类型与构建/边界；历史切换原预算 8.201 秒；完整附件崩溃消费另列 |
| F09d 附件草稿恢复 | 已提交附件的草稿恢复与原接纳消费 | `45e227f2` | 冻结文件身份、逐字段修订及重开恢复验收 |
| F09d 并发台账 | OperationLedger 条件合并与 Session UI CAS | `776bc8b0` | 冻结身份冲突、终态单调性及丢回执核对 |
| F09d 分支草稿 | 编辑基线保护及显式恢复；纯 UI/宿主数据边界 | `558f8af4` | 隔离 adapter 180、工作台 97、认证 HTTP 23 项；最终恢复 9 项 |
| 结构化 Harness 消息装配 | 普通/revision worker 消息与连接配置隔离 | `5ff3054e` | 隔离 Flow 674 项、类型及 C4/链接 |
| F15 | 授权附件传输、原操作恢复与队列消费 | `5411bf71`，见第 13 节 | 原始与最终增量证据分别记录，不把默认并发超时隐藏为全套通过 |
| F19 | 原生取消/核对事实桥及失败连接释放重试 | 本批，见第 14 节 | 隔离宿主 987、adapter 362、Session 436 项；类型、构建和架构检查 |

独立仓当前锁定：Kernel `0c5e7cb`、llm-ui `595aaea6`、mindos-node-driver `6e32348`、mindos-node `edcaefb`。Kernel 已由 F02 锁定，driver 已由 F04 锁定，llm-ui 已由 F09a 接入，后续随 F09d 台账合并更新；mindos-node 已由原生查询/控制/输出批次锁定；四个 gitlink 均已接入已验证消费者。保留这些已有提交；根仓锁定版本时必须同时验证受影响消费者，不用未锁定的本地源码冒充集成完成。

## 4. 继续细分的功能单元

以下“待合入”表示当前有实现增量，仍需完成对应候选树的隔离审查。共享同一正确性约束的实现与消费者按依赖链合入，避免公共文件反复拆分；不因一个远期功能未完成而阻塞其他已经闭环的功能。

| 编号 | 独立功能及必要接线 | 主要所有者 | 前置 | 状态 / 验收重点 |
|---|---|---|---|---|
| F01 | 子 Session 执行存储准备 | app-core + Session 端口 | B05 | 已合入 `9d0eda8b`；先 metadata lease，再存储，再恢复；拒租重试保留原身份 |
| F02 | Kernel 控制版本与准入 API 集成 | Kernel + Flow fence + RPC | B05 | 已合入 `d2ad3268`；锁定子仓、撤销未确认暂停不绕过租约、错误原样传输 |
| F03 | 远程恢复记录 CAS | app-core 存储适配 | 无 | 已合入 `3edebe15`；丢写回执核对写前/写后值，真实冲突不可因 load 解除 |
| F04 | 原生可编辑队列 | driver + ConversationView + RPC | F03 | 已合入 `6d1f090b`；宿主/RPC 队列闭环，UI 台账接入仍属 F09 |
| F05 | 原生只读命令目录与查询 | node + driver + RPC + UI | 子仓版本 | 已合入 `09c122fc`；查询不经过写命令 tail，不推进原生 turn |
| F06 | 原生取消与控制回执 | driver + registry + RPC + UI | F03 | 已合入 `09c122fc`；独立 operationId，未知时继续观察原操作；Kernel 事实桥仍属 F19 |
| F07 | 原生命令结果分段读取 | node + driver + RPC + UI | F05 | 已合入 `09c122fc`；执行终态与结果可读性分离，按需读取且可停止后续分页 |
| F08 | 本地 Session 可编辑队列 | llm-session | B03 | 已合入 `937fe32b`；正文/实参 CAS 编辑、冻结定义重编译、附件核验与共享编辑器闭环 |
| F09 | 提交台账与草稿消费 | llm-ui + UI adapter | F04 / F08 | 原生 F09a/b/c 已合入；本地 F09d 台账与附件恢复、原回执消费、台账条件合并已合入；本批补全同分支基线保护及显式恢复，原生故障部署验收另列 |
| F10 | Agent 不可变发布 | Session 仓储 + app-core + 设置 UI/RPC | B02 | 已合入 `44656133`；发布回执独立读取，锁定实现依赖和入队策略，草稿不冒充发布 |
| F11 | 结构化实参、默认值与补参 | llm-flow + Session 准入 | B02 | 已合入 `fc007454`；接纳/消费两阶段校验，显式空值不被默认值覆盖 |
| F12 | Agent/Flow 平级目标入口 | app-core 目录 + Session + UI/CLI | F08 / F10 / F11 | 已合入 `937fe32b` / `630455b4`；后端、CLI、默认工作台、独立视图及本地首次草稿均使用真实平级目标；独立子 Session 路由继续按 F16/第 7 节实施 |
| F13 | 不可变输入附件与内容身份 | Session + app-core | B02 | 已合入 `937fe32b` / `a2989fc4`；Session 冻结、宿主上传核对和 UI 不可变写闭环；远程编码及长期回收另列 |
| F14 | 通用文件参数与就绪预检 | app-core + Flow + UI | F11 / F13 | 已合入 `a2989fc4`；文件表单、默认/空文件、真实上传、接纳/编辑/派发前核验；原回执查询不重读损坏输入 |
| F15 | Harness 资产编码与能力准入 | app-core + adapter + driver | F13 / F14 | 本批合入；普通 Session 与 Flow 声明附件贯通，能力/摘要错误在 create/turn 前拒绝，原操作核对不重读输入；见第 13 节 |
| F16 | Invocation、重跑及输出身份 | Session + Flow | F08 / F11 | 根身份随 `937fe32b` 合入，节点/循环/worker 身份及历史投影由 `1b9734a3` 合入；独立子 Session 路由和函数调用展示仍未完成 |
| F17 | Flow 控制树与调度屏障 | Flow + Kernel + UI/CLI | F02 / F16 | Flow 控制屏障由 `dc20beb2` 合入；UI 卡片/详情接线见第 18 节，CLI 显式入口见第 19 节；历史回执与卡片跨视图恢复见第 20—21 节；旧 DAG Goal 控制入口迁移及组合验收待完成 |
| F18 | 长活 Effect 审批准入 | Kernel + Harness adapter | F02 / F06 | 本批合入；新审批转发与暂停同事务校验，held 不转成 unknown，见第 17 节 |
| F19 | Connection 取消/核对事实桥 | kernel-adapters + 宿主 journal | F06 | 本批合入；归属证据、原操作核对、失败连接释放重试及日志隔离，见第 14 节 |
| F20 | 独立上下文 binding 与清理 | app-core + adapter | F16 / F19 | 待合入；集合 CAS，journal 与原生身份关联，旧结果不释放新所有者 |
| F21 | 已确认检查点与精确 fork | app-core + driver + node | F20 | 待合入；检查点归属与真实 head，错误边界不补发 turn |
| F22 | Context 目录与工作台选择 | app-core + Session + RPC + UI | F12 / F21 | 待合入；只读目录不取 writer，切目标/分支及迟到接纳保留当前草稿 |
| F23 | Task 产物目录与读取 | app-core + Session 端口 | F13 / F16 | 待合入；从终态输出派生，核对范围和摘要，不另建结果注册表 |
| F24 | 调用组与产物详情展示 | llm-ui + UI adapter + RPC | F07 / F16 / F23 | DOM 引用机制已由 `642cb67f` 合入并修复匹配夹具退化；完整调用组、产物 UI 及复杂输出性能仍待验收 |
| F25 | Flow 调度所有权竞态修复 | llm-flow | 无 | 已合入 `0bcfa29e`；竞争失败者不终结胜者，接纳丢回执不误清理工作区 |

F03 已独立合入原有记录的写入核对，且修复延迟 load 回退 CAS 游标；F04 再加入队列修订保护。查询结果校验仍随 F05 合入。公共能力表只随该功能加入所需方法，避免一次暴露尚未接通的全部端口。

F09 的独立交付边界如下，原生与本地使用同一台账协议，不建立第二套持久状态：

| 子项 | 边界 | 状态 |
|---|---|---|
| F09a | 默认远程工作台直接使用 native port 和共享队列组件；接纳通知结束 UI 等待 | 已合入 `4df2896d` |
| F09b | 独立 ChatView 将原生接纳投影到 OperationLedger；首轮 send 与 canQueue 分开 | 已合入 `ceb71d43` |
| F09c | 独立原生视图挂载队列编辑区，保留工具栏与隐藏/销毁生命周期 | 已合入 `dd4c04bd` |
| F09d | 本地 Session 队列及默认工作台的持久台账与草稿恢复 | 台账基础 `630455b4`、附件恢复 `45e227f2`、并发台账 `776bc8b0`；本批补全分支草稿基线、发送前核对与冲突恢复；不代表原生产 Session 已验收 |

默认远程兼容编辑器沿用既有 ConversationComposer；独立 ChatView 沿用 OperationLedger。两者消费同一后台接纳事实，前者的 awaitNativeAdmission 只是一段视图等待，不保存另一份队列或执行状态。原生首轮没有 canQueue 时仍走 send，不因端口具有 enqueue 方法而拒绝首轮。队列接纳不合成原生历史，真实 turn 到达后再关联。

```mermaid
C4Dynamic
    title 原生接纳先于 RPC 回复的两条 UI 路径
    Component(editor, "默认远程编辑器", "ConversationComposer 与输入修订")
    Component(view, "独立 ChatView", "输入与显示")
    Component(adapter, "原生 UI 适配器", "等待与事实投影")
    Component(ledger, "OperationLedger", "原有提交台账")
    Component(queue, "宿主原生队列", "mindos-node-driver")
    Component(store, "恢复记录", "app-core CAS")
    Component(native, "原生执行端", "原 session 与 turn")
    RelIndex(1, editor, adapter, "冻结输入与 operationId")
    RelIndex(2, view, adapter, "登记原台账后提交冻结输入")
    RelIndex(3, adapter, queue, "按 canQueue 选择入队；原生首轮可直接 send")
    RelIndex(4, queue, store, "持久接纳与修订 CAS")
    RelIndex(5, queue, adapter, "发布同操作接纳；可以先于 RPC 回复")
    RelIndex(6, adapter, ledger, "投影独立视图的原操作回执")
    RelIndex(7, ledger, view, "消费匹配草稿并释放下一次输入")
    RelIndex(8, adapter, editor, "结束默认视图等待，按原修订消费草稿")
    RelIndex(9, queue, native, "按队列和实际资源约束执行")
    RelIndex(10, native, queue, "核对原 turn 与真实结果")
```

原 RPC 的迟到成功/失败只结束旧调用，不重新消费草稿。以上为原生兼容入口的实际链路，接纳不等于执行完成；本地 Session/Kernel 统一执行与更完整的原生 Invocation 接线继续按其他能力组验收。F24 中原生结果与普通 Task 产物可各自形成展示闭环，但历史容器重构仍须单独通过性能回归。

## 5. 仍未完成，不能按合入拆分掩盖的范围

| 范围 | 当前限制 | 完成条件 |
|---|---|---|
| 严格原生 continue | binding CAS 和 fork 不提供远端条件写保障 | 原生条件写或独占 writer；外部推进及跨 epoch 可核对 |
| Flow Harness worker 的统一输入与上下文 | 消息装配与参数隔离切片已完成；原生 binding 与结构化材料消费仍待完成 | 本地/Harness worker 共用消息构造，普通与 revision worker 已覆盖；继续验证并行、循环、重试的 binding 与资产实例 |
| 无人值守与离线入口 | 人工补参、审批、连接失联策略尚未完全闭环 | 明确等待/超时/拒绝规则，CLI 与父 Flow 共享输入和控制协议 |
| 历史及资产长期生命周期 | 当前增量不等于永久恢复、导出和回收全部完成 | 保留引用、分页与恢复水位，删除/回收边界及持久故障验收 |
| 工作区、项目记忆与初始化 | 上下文 fork 不等于文件系统或记忆隔离 | 初始化按作用域去重，环境/记忆继承明确，报告实际恢复范围 |
| 历史展示扩展与性能覆盖 | DOM 全树扫描退化已由 `642cb67f` 修复；完整工作树同一单项 8.64 秒通过 | 完整调用组、大报告和产物按需加载仍须扩大验收；不通过提高超时掩盖退化 |
| 原生产故障验收 | 本地测试和构建不证明部署版本或原 Session 已恢复 | 核对运行版本及 node 能力，在授权边界内验证队列、查询与控制 |

原有性能对照已补受控方法剖析与同条件修复验证：新增展示扩大了逐消息全历史 DOM 查找的次数。结论限于当前夹具，不能据此证明复杂报告或完整调用树没有额外开销。已有关闭语义夹具修正也不能替代真实进程崩溃测试。

## 6. 交付顺序与结束条件

先合入基础修复、执行存储准备、Kernel/RPC 边界和调度所有权，再分别推进原生队列链、本地目标输入链、binding 链与产物链。依赖不满足时保留候选，不把缺失消费者用空实现补齐。

前期同时铺开跨层修改，后续过细拆分又造成共享文件反复审查和验证，这是积压的主要过程原因。F12 入口合入后，F15/F19 合入后仍有 8 个未完整交付单元，按以下五条依赖链收拢；同批内保留有意义的提交边界，契约与必要消费者一起交付。

| 批次 | 剩余交付单元 | 合入约束 |
|---|---|---|
| 调用身份 | F16 | 平级入口、台账/附件恢复及分支草稿冲突保护已接通；继续完成内部子调用身份及独立子 Session 路由 |
| Harness 资产传输 | F15 已合入 | 文本/图片与显式资产引用传输完成；格式转换、结构化 route 材料扩展及长期回收按第 5 节另行验收 |
| 执行控制 | F17 / F18；F19 已合入 | 控制屏障、长 Effect 审批与清理确认沿用 Kernel 事实；未知结果不释放资源 |
| 原生上下文 | F20 / F21 / F22 | binding、检查点和选择器一致；严格 continue 的原生能力缺口仍须明确保留 |
| 结果与历史 | F23 / F24 | 先贯通产物读取，再处理调用组；匹配夹具的扫描退化已修复，复杂输出仍需按需渲染回归 |

F10 一批包含 46 个文件；其中普通 Agent 入队冻结是发布语义的必要消费者，因为发布新版本不能改变已经接纳的旧请求。文件数不等于未完成功能数：共享文件中仍有其他切片的未提交修改，不能把该文件整个标为完成。

每项记录实际提交、独立验证范围和仍未覆盖的行为。最终集成再运行跨边界组合：发送回执悬挂时入队、暂停时审批到达、取消与完成竞态、分支切换后 fork、完成后历史写入失败、旧远端操作仍执行时接管。只有这些链路闭环后，才能移除被替代的兼容路径并宣告对应目标完成。

本轮补充证据：F04 的隔离 driver 套件 293 通过、2 跳过，宿主套件 893 通过、13 跳过。完整宿主测试后只修正 RPC 测试替身的 subscribe/refresh；候选差异确认生产代码一致，再通过 4 项 RPC 回归与类型检查，未将完整工作树中其他未合入测试计入这些数字。

F09 证据补充：只等待 RPC 的反向候选使两项默认工作台输入回归失败；修复后通过。独立视图真实 DOM 同时覆盖旧回复迟到成功/失败、队列正文编辑的原修订、隐藏/恢复控制与原生历史不伪造。已合入 UI 候选的历史切换单项为 8.56 秒通过，不能据此声称完整工作树的性能退化已经修复。

原生批次以一个连续契约合入 38 个文件，输入批次合入 25 个文件；两者复用既有执行路径，保留各自失败边界。通用字节拼接/摘要核验已移到 utils/verified-content，原生读取不依赖 DAG 产物模块。ProjectConversationPort 从原端口推导命令、取消及分叉参数，只扩展返回投影，降低新增参数在宿主层丢失的风险。Node 源码版本锁定及回归通过仍不代表运行中的 httpd/native 已更新。

F10 的宿主回归覆盖已有发布与首次发布两种情况下，普通 Agent 队列在重启后保持原策略；认证 HTTP 回归覆盖原发布响应悬挂时独立查询持久回执。注入日志抛错的两项回归先复现失败，再验证成功与拒绝均保留原结果。全部功能测试在隔离候选树完成；架构边界、样式与本次 C4 文档检查也在隔离树通过。全量 docs:check 在完整工作树通过，隔离树的全量文档检查因既有文档引用未准备的 CLI 产物、其他工具仓和本地配置而未通过，不将其记为候选树全量文档通过。

本地根调用批次合入 90 个文件，未增加调度器、状态库或 package。Session 保留准入、队列与历史；Context 只提供材料解析端口；CLI 和共享队列面板消费既有应用端口。Session 附件冻结是队列正确执行的必要依赖，已一并合入；宿主通用文件传输和 Harness 资产协议继续保留明确边界。Agent Flow 重跑的双重参数来源、旧编辑响应回退来源信封的两处回归均从失败验证到通过；面板不再将编译图复制给共享编辑器，重复样式已删除。

该批次的隔离完整宿主为 933 通过、13 跳过；CLI 28 项是本次受影响的四个套件，不是 CLI 全量矩阵。真实模型请求覆盖当前与历史附件、上传后变更、冻结副本损坏、缺失必选材料，以及编辑后新引用文件。其历史切换单项 8.651 秒只证明该隔离树没有退化；完整工作树的受控修复见下段，原生产故障仍未验收。API 中已补 Mermaid C4 调用流；默认工作台的目标/台账和完整子调用树仍未标为完成。

B06 的受控诊断先在完整工作树重新复现同一测试 31.08 秒超时；临时方法剖析显示两次恢复中约 25.2 秒用于按消息 ID 查找整段历史 DOM，剖析文件随后删除。修复用消息 Map 代替原 ID Set，统一维护已拥有的包装节点；Flow 窗口及原生别名从现有引用解析，删除先撤销引用再动画。两项归属/动画回归先失败再通过；完整工作树原测试以原 30 秒预算 8.637 秒通过，隔离候选同项为 8.185 秒通过。该修复不依赖未合入的产物模块，也不修改执行事实；独立模块设计中已补 C4 所有权图。F24 继续保留其他输入/展示及生命周期验收，未因性能修复整体关闭。

F13/F14 一批合入 51 个文件。上传身份与内容存储归 app-core，Session/Flow 通过宿主端口核验，UI 只管理选择、观察与上传；复用既有 inputs.seq、队列和 Kernel，不增加状态库或 package。UI 摘要复用 common，删除不必要的 llm-context 依赖。两个正确性缺口均先复现失败再修正：上传在异步持久化前复制调用方字节；队列新派发复验已选材料，损坏时不创建 Task，但原接纳回执仍可查询。API 中补充 C4 流程。

该批次后仍有 220 个待处理路径（其中 78 个未跟踪，排除用户原有的三个路径）；文件数包含共享文件的其他功能增量及设计材料，不能当成功能数。剩余交付单元为 F09d、F12、F15—F24。后台完整套件证据与最终候选的后台源码和测试逐字节一致；后续仅调整既有 UI 上传测试替身、UI 文件来源控件及文档，再通过最终消费者验证。合入不代表部署，原生产 Session 仍未验收。

## 7. 子会话与函数视图的交付安排

2026-10-25 决策：一个 Session 可以关联多个子 Session；独立任务或 Flow 函数调用默认拥有自己的子 Session，每次独立运行分配不同 Session/Invocation。同一子会话的续聊和重跑仍允许多个 Invocation。普通 DAG 节点不逐个创建 Session，组织树与执行控制树分开。完整定义与 C4 见[子会话与函数调用视图](session-invocation-ui.md)。

以下为 F12/F16/F24 内的实施与验收检查项，不增加新的能力组、调度器或存储模块；现有父子 Session 和调用接口仅算基础，不能据此勾选完整功能。

| 检查项 | 归属与前置 | 状态 | 交付及验收条件 |
| --- | --- | --- | --- |
| 会话与调用关联 | F16；Session/app-core | 已有 parentSessionId 和幂等创建基础；完整调用关联待实施 | 持久保存原调用者、执行所属 Session、Invocation 及真实根 Task；组织关系不授予控制 |
| 独立调用入口 | F16；F12 平级目标和台账基础已合入 | 子 Session 路由待统一接入；普通发送继续在当前 Session | 同 Flow 两次独立运行获得不同子 Session；同请求丢回复/重启返回同一子 Session；父子不重复入队 |
| 最小函数调用组 | F24 基础；依赖 F16/F23 | 待实施与验收，本阶段范围 | 默认输入、状态、最终 value/artifacts；原 Invocation 稳定定位；审批、补参、失败及清理状态可见 |
| 打开真实子会话 | F24 基础；依赖明确的 Session 关联 | 待接线，本阶段范围 | 打开既有 Session UI，不重跑、不复制历史；关闭观察不取消后台执行；不支持时不伪造入口 |
| 高级会话详情 | F24 增强；在基础入口后扩展 | 后续增强；不阻塞最小函数视图交付 | 内嵌会话、完整节点/循环/尝试树、搜索与大历史分页，展开才加载 renderer |
| 组合回归 | F09d/F12/F16/F17/F24 | 待完成 | 分支切换后核对原提交不消费新草稿；父取消只覆盖受管理调用；详情读取失败不改执行终态 |

本地目标/台账链已由 `630455b4` 合入 50 个文件；不增加 package 或状态库。三个回归先失败再通过：相同队列 ID 的实参冲突、旧接纳消费另一分支附件、核对期间接纳通知丢失。独立视图将原 Session/分支请求保存到同一台账，重开另一观察绑定仍查原请求；默认工作台支持首个发送回复悬挂时继续入队。参数详情及重跑复用原历史与 Flow 表单，不依赖未合入的产物或原生上下文模块。

本批次后剩余 191 个待处理路径（其中 68 个未跟踪，排除用户原有三个路径），包括其他功能的共享文件增量和设计材料。适配层 156、相关 UI 146、项目草稿 16 项在隔离源码候选通过，四包类型、构建及架构/样式通过，历史切换单项保持原 30 秒预算并以 8.201 秒通过。最终候选仅做空白格式及三份文档补充，源码忽略空白比较一致，再检查最终类型、C4、链接及 diff；完整工作树 docs:check 通过。当前的完整附件崩溃消费、独立子 Session、函数调用组和原生产故障验收仍未完成。


## 9. 已保存附件草稿的恢复增量

本次附件恢复批次沿用 F09d、F13 的已有台账和 Session assets：分支草稿保存 token、文件引用及摘要，项目/原生兼容草稿复用同一编解码；发送前先等待保存。恢复保留逻辑 File ID，Flow 查询原上传回执，原提交仅只读核对；旧接纳不消费新文字、重选参数或同名同大小新文件。设置保存时间不作为用户输入变化。已接纳但清空草稿写入失败，重开仍能匹配消费。

隔离候选已通过适配层 161 项、相关 UI 202 项（其中真实工作台故障恢复 4 项）、三个包类型、适配包构建、目录边界、UUID 和样式检查。新增回归验证坏摘要、缺失文件、空文件、保存失败不派发，以及安全诊断；项目首次草稿与原生编辑器同时回归。普通输入保留延迟保存窗口，本保证针对发送前已确认保存的草稿。

该批次留下的台账整组覆盖问题由第 10 节的条件合并处理；同分支草稿冲突继续开放，不能以单工作台重开测试证明所有跨客户端一致性。独立子 Session 路由、函数调用组、上下文与控制链、产物详情及原生产 Session 验收继续按前述安排实施；本批次不部署或操作原故障 Session。


## 10. 多视图台账合并增量

独立 llm-ui 提供纯记录合并与实际持久快照发布；宿主 UI 用 Session 原有修订条件保存，后端不解释 OperationRecord。原操作已接纳、拒绝或未知时不再派发。丢写回执通过只读核对确认，八次修订冲突后明确保留错误，不降级为无条件覆盖。原普通 UI patch 接口保留，新增条件写入通过独立方法及真实 RPC 开放，避免旧宿主忽略附加参数。

独立库 107、隔离适配层 172、完整 Session 436、相关工作台 67、认证 HTTP 23 项通过；类型、构建与边界检查覆盖锁定后的消费者。回归包含冻结输入与终态冲突、两个真实工作台的独立提交、HTTP 陈旧修订拒绝、落盘后丢回复、日志故障及正文不泄漏。该批次留下的同分支草稿并发写入与旧接纳清空冲突，由第 11 节的基线保护与显式恢复补齐。独立子 Session、函数调用视图及其余执行链仍待完成。


## 11. 展示与存储边界、草稿冲突闭环

llm-ui 只负责显示、输入编辑与控制请求；临时编辑状态和读缓存留在界面，MindOS 的持久数据经宿主端口写入既有 VFS/SessionRepository，执行事实继续归 Kernel。独立库不绑定文件系统实现。适配层负责 DTO、浏览器文件编解码与恢复交互，不建立新的执行状态库。职责及 C4 见[独立模块的数据边界](llm-ui-independent-module.md#展示输入控制与持久数据边界)。

本批补全 F09d 的同分支草稿基线、冲突提示及加载/替换动作；持久输入与基线不符时不覆盖正文、参数或附件。替换仍校验所显示的冲突快照，加载中的编辑和隐藏会阻止迟到恢复，读取失败不能当作空草稿。偏好写入在草稿条件检查后进行，发送前核对草稿；恢复动作不派发业务调用。

本次隔离源码候选的适配层 180、相关工作台 97、认证 HTTP 23 项及类型、构建/边界通过；另补隐藏时加载的组合回归。F09a—d 的已定义接线与恢复切片可按本批合入，剩余交付单元为 F15—F24 共十项；原生产故障 Session、实际部署、长期资产回收、无人值守和更复杂输入输出等跨能力验收仍按原清单推进。

## 12. 结构化 Harness 消息装配审查切片

发现 route worker 只对本地 LLM 组装消息，Harness 落入普通参数合并分支，会丢失本轮指令，并允许同名业务参数覆盖连接快照。修复集中在 llm-flow 的结构化调用构造层，以共用 Program 分类和隔离输入函数消除两处判定差异；不向 UI、宿主传输层或 Kernel 下沉 Flow 模板规则。流程及模块边界见 [Flow 能力与输出](./flow-capabilities-and-output.md#结构化-harness-worker-的输入边界)。

验收覆盖本地 Agent/Chat 兼容、Harness 连接不可被实参覆盖、声明历史、输出约束、真实 builtin.agent/TaskFactory 路径及 revision worker。该切片独立于尚未合入的子 Invocation、控制树和原生 binding；F15 的附件传输及十项剩余交付单元仍未整体完成。

隔离候选验证：llm-flow 全部 674 项测试及类型检查通过；两份文档的 4 个 Mermaid 图与 17 个本地链接通过解析/存在性检查。未运行真实远端模型，未部署或重启服务。

## 13. F15 附件传输与后续可审查候选

F15 以冻结消息/资产引用 → HarnessProgram → 授权 TaskAssetReader → 原生附件协议组成完整功能；复用现有队列、journal、存储和取消链，不需要先合入 F19 的新取消结果类型或 F20 的 binding。普通 Session、Flow 上传参数、同 Flow 的 Tool 文件转交与队列编辑都包含实际消费者测试。模块职责及 C4 见 [不可变附件的执行传输](./remote-harness-connections.md#不可变附件的执行传输)。

下表的“可继续审查”只表示实现可抽取为下一候选，不能代替隔离验证和提交。不能仅凭文件已写好就批量合入。

| 顺序 | 候选 | 当前可抽取范围 | 尚需确认的边界 |
|---|---|---|---|
| 1 | F19 | Connection 取消/核对事实到 Effect 的映射，宿主清理证据及日志 | unknown/cleaning 不得正常返回并确认释放；剥离 binding 清理增量 |
| 2 | F16 的调用身份切片 | 节点、循环、动态 worker 的持久调用关联及只读投影 | 内部重试保持身份，旧运行指纹兼容；独立子 Session 路由仍未完成 |
| 3 | F17 / F18 | 根/子调用控制屏障、暂停时审批转发准入 | 实际 Kernel 事务和动态子任务覆盖，独立控制回执与 UI 接线 |
| 4 | F20 / F21 / F22 | binding、检查点 fork、上下文目录及选择器 | 依赖身份与清理事实；严格 continue 缺少原生条件写保障，不能宣称完成 |
| 5 | F23，随后 F24 | 产物归属读取/RPC，再接按需展示 | F16 的身份归属；函数调用组和真实子 Session 导航不能用空入口替代 |

本批完成后，剩余能力组为 F16—F24 共九项。子 Session 创建/路由、结构化 worker 的多模态材料与 binding、严格 continue、无人值守及原生产 Session 部署验收仍按第 5、7 节推进。

验证记录：宿主默认并发全套有一项 IndexedDB 批量兼容测试超过原 5 秒预算；单独同预算约 1.8 秒通过，限制为两个 worker 后全套 970 项通过、13 项显式 live 跳过。它使用 fake-indexeddb 验证浏览器后端兼容性，不连接 httpd；资源竞争只是基于对照结果的推测，未做 CPU/GC 归因。Kernel adapters 330 项、Session 436 项、相关 Flow 21 项、三包类型、构建和架构检查通过。最终另补 Task 资产错误分类及包装后的权限/缺失原因回归；均保留旧错误消息，只增加安全错误码，不引入产物目录模块。

最终错误分类增量验证：Kernel adapters 335 项、宿主 Harness 27 项及两包类型、adapter 构建通过；C4/链接和 diff 检查通过。其他生产源码与上述全套通过候选保持一致。

## 14. F19 取消事实桥与本地释放故障

本批只交付 Connection 事实与既有 Effect/Kernel 的适配：归属证据不符、unknown 或仍在清理不能转成成功取消；running 不映射为再次执行。真实 Runtime 的取消同时核对持久原生终态、连接释放及 Kernel stopped/settled；取消与完成竞态保留远端真实 completed 事实。租约丢失在打开清理 Session 前拒绝，每次 journal 读写仍复验。

审查发现并复现两个释放故障：关闭失败后下一次取消没有重试原连接；持续关闭失败时却返回 cleanup confirmed。现已由宿主保存原 Effect 的失败关闭句柄，关闭成功前保持清理未确认；同时修复连接 release 永久缓存失败 Promise 的问题。此机制不接管原生执行状态，不新增 package、调度器或持久状态库。职责及 C4 见 [Connection 取消和核对事实桥](./remote-harness-connections.md#connection-取消和核对事实桥)。

下一批优先 F16 的调用身份与只读投影；其独立子 Session 路由尚未完成。随后 F17/F18 控制屏障、F20—F22 上下文、F23/F24 产物展示。当前剩余 F16—F18、F20—F24 共八个能力组；第 13 节候选顺序中的 F19 已由本节交付。

隔离候选验证：宿主全套 987 项通过、13 项显式 live 跳过（两个 worker，原超时不变）；Kernel adapters 362 项、Session 436 项通过。三包类型、adapter 构建和架构检查通过；5 个 Mermaid 图及 15 个本地链接检查通过。未部署、未重启服务，也未用本地夹具替代原生产 Session 验收。

## 15. F16 调用身份与只读投影切片

本批在 llm-flow 内补齐节点、循环实例和结构化 worker 的 Invocation 关联。子身份由父调用、节点或派发键、业务轮次确定；Kernel Task ID、内部尝试和图恢复代次不参与身份计算。用户重新运行使用新的根 Invocation；内部 Task 重试保留原调用关联。旧 Run 不补写新身份协议，恢复时检查 checkpoint 与根输入中冻结的协议版本一致，避免已接纳 Task 的请求指纹变化。

```mermaid
C4Component
  title Flow 调用身份与投影职责
  Container_Boundary(flow, "llm-flow") {
    Component(executor, "Executor / TaskFactory", "执行装配", "冻结身份协议并提交带调用关联的 Task")
    Component(identity, "Invocation identity", "纯规则", "按父调用和业务实例派生身份")
    Component(projection, "Invocation projection", "只读投影", "区分当前成员与历史尝试")
    Component(commands, "Command / Transcript", "端口", "展示历史，控制按持久成员定位")
  }
  ContainerDb(kernel, "Kernel", "既有 Task / shared 存储", "执行事实、成员及 checkpoint")
  Container(ui, "宿主 / llm-ui", "消费方", "读取投影并提交明确控制请求")
  Rel(executor, identity, "派生节点与 worker 身份")
  Rel(executor, kernel, "提交及持久恢复")
  Rel(projection, kernel, "读取事实与成员")
  Rel(commands, projection, "读取当前实例和历史")
  Rel(commands, kernel, "按当前成员提交控制")
  Rel(ui, commands, "查询、读取详情、控制")
```

身份规则属于 Flow 调用装配，不应放在暂停屏障或 UI。投影只组合既有 Task、成员和标签，不增加状态库或 Session 存储。相同轮次的替代成员以持久成员记录为准，不能被进程内旧 handle 覆盖；历史可包含已替换尝试，但显示缓存不扩大控制范围。取消、信号、回答及原有暂停/恢复路径均不得仅凭历史缓存选择目标。

这里的“当前成员”是既有持久成员及重试成员契约，不表示已完成终态重试准入、控制树或原子暂停屏障迁移。跨操作竞态和动态子调用控制仍由 F17/F18 补齐；只读快照不成为控制事务。独立子 Session 的创建/路由、函数调用视图仍未完成，因此 F16 只合入本切片，剩余能力组仍为八项。

隔离源码候选验证：Flow 682 项、Session 436 项通过；Flow、Session、app-core 类型检查通过。专项回归覆盖旧指纹恢复、冻结身份协议不匹配拒绝、同轮替代成员投影、旧成员控制拒绝及历史详情仍可读。未部署、未重启，未宣称完成原生产 Session 验收。

## 16. F17 Flow 根控制屏障切片

新 Run 冻结 `controlTreeVersion=1`，节点以根 Task 为控制父级，结构化 worker 延续既有 Kernel 父子链。暂停/恢复操作只改变根控制，成员自己的暂停和 Session 暂停仍独立有效。调度前等待用于减少无效提交；真正阻止暂停后新增子任务的是 Kernel 提交事务。Flow 不另建控制状态库，也不通过遍历 UI 缓存模拟树级暂停。

```mermaid
C4Component
  title Flow 根控制与派发屏障
  Container_Boundary(flow, "llm-flow") {
    Component(command, "Run control", "命令端口", "稳定请求身份、控制版本与回执核对")
    Component(gate, "Dispatch gate", "调度适配", "观察暂停事实，保留同一提交身份")
    Component(legacy, "Legacy recovery", "兼容边界", "仅恢复有历史证据的旧批量暂停")
  }
  Container(kernel, "Kernel", "控制及提交事务", "祖先屏障、独立暂停、子任务原子准入")
  ContainerDb(store, "既有持久存储", "Task / checkpoint / shared", "控制事实、协议标记与重试成员")
  Rel(command, kernel, "暂停、恢复、撤回待确认暂停")
  Rel(command, legacy, "识别旧 Run")
  Rel(legacy, kernel, "核对旧控制及历史")
  Rel(gate, kernel, "查询控制并提交带父级的 Task")
  Rel(kernel, store, "原子持久控制与准入")
  Rel(command, store, "控制接纳后写 goal 展示元数据")
```

控制接纳和实际暂停确认是不同事实；goal 只是兼容展示元数据，不能替代 Task 控制事实。goal 写入失败后使用原 requestId 核对；已被新控制覆盖的旧回执不能再次改写 goal。撤回尚未确认的暂停要求已观察的控制 epoch，不等于恢复被取消的调用。旧 Run 不补写新父级或改变提交指纹；拒绝新建 Run 级暂停，仅允许有前态证据的有限恢复，不能证明的成员继续保持暂停。

内部重试归属原根，已接纳的请求可核对；新重试拒绝终态根，用户重新运行须创建新 Invocation。重试模式和来源参与冲突检查。根在延迟启动前终结时取消尚未执行的尝试。join-detached 仅表示不等待结果，不自动脱离控制所有权。

审查发现待合入代码恢复了按历史缓存取消的旧路径；新增真实 Kernel 回归先复现失败，再恢复按持久成员定位。根取消仍由 Kernel 传播到已有控制子树，历史缓存不额外授权目标。派发等待的日志失败不得中断执行，诊断不记录输入正文。

本批仅交付 Flow 层及其与已锁定 Kernel 的接线。F17 的 UI 控制回执/按钮接线、F18 Harness 审批转发与暂停能力尚未交付，不能据此宣称远端原生 Agent 已暂停。F16 子 Session 路由及 F20—F24 保留原安排，剩余能力组仍为八项。

隔离验证：Flow 710 项、Session 436 项及 Flow/Session/app-core 类型检查通过；7 个 Mermaid 图、15 个本地链接通过校验。取消历史缓存回归先失败后通过；原生远端与 UI 端到端验收不包含在本批内。未部署、未重启。


## 17. F18 长活 Harness Effect 的审批转发准入

本批连接既有 Kernel `EffectSessionState.setIfRunning` 与宿主 native operation journal。审批回答保存和远端转发分开：新的 respond 操作必须在检查 Session/Task/祖先控制的同一事务中写入 pending 身份；遇到暂停只返回 held，不新增 pending，也不把等待当作结果未知。恢复或撤回待确认暂停后沿用同一操作身份。

```mermaid
C4Component
  title 长活 Effect 的审批转发与暂停
  Container_Boundary(host, "app-core Harness adapter") {
    Component(interactions, "Interaction bridge", "协议映射", "读取已保存回答并构造原生响应")
    Component(journal, "Execution journal", "持久操作适配", "新操作原子准入，原操作只核对")
  }
  Container(kernel, "Kernel", "事务与控制", "校验 Effect claim、Session 和祖先 hold")
  ContainerDb(store, "既有 Session shared", "持久记录", "回答、journal 与操作身份")
  System_Ext(native, "远端 Harness", "持有原生 Agent 循环和操作回执")
  Rel(interactions, store, "读取回答")
  Rel(interactions, journal, "申请转发")
  Rel(journal, kernel, "setIfRunning 原子准入")
  Rel(kernel, store, "通过才保存 pending")
  Rel(interactions, native, "准入后发送一次，或核对原操作")
  Rel(journal, store, "保存原操作回执")
```

原子准入是排序点，不是远程暂停确认：先准入的操作可能在随后暂停期间完成，不能声称远端已停止工具循环。已保存 pending 的操作只查询原回执，不因当前暂停重新发送；unknown 保留待核对事实。取消或失去 Effect claim 会阻止迟到的新准入。缺失原子端口时明确报 `NATIVE_CONTINUATION_GUARD_UNAVAILABLE`，不能退化为先查状态再普通写入。

模块放置：Kernel 继续拥有通用原子控制检查，宿主 adapter 负责 native requestId、journal 和协议响应；Flow、Session UI 不实现远端转发规则。本批不引入 binding/fork 修改，不新增存储。held/committed 诊断复用 Effect 事件通道并按操作去重，不能记录回答或消息正文。

F18 此项完成后，剩余 F16/F17/F20/F21/F22/F23/F24 共七个能力组；F16/F17 已交付切片与未完成部分以主表为准。原生产 Session、真实远端与 UI 端到端验收继续单列，不能以本地原生协议夹具代替。

隔离候选验证：宿主全套 999 项通过、13 项真实环境测试显式跳过（两个 worker，未放宽超时）；app-core 类型检查通过。专项覆盖缺失原子端口、暂停与回答读取竞态、祖先/Session 屏障、先准入后暂停、取消迟到回答、原操作未知结果及日志不泄漏回答。8 个 Mermaid 图、15 个本地链接与 diff 检查通过；未部署或重启。

## 18. F17 调用卡片与 DAG 控制视图切片

调用卡片按根控制、当前成员集合和 Kernel 停止事实生成按钮。`DurableFlowSnapshot.controlStats` 是后端对同批 Task 调用 `taskStat` 的只读投影，不新增执行状态；UI 不复制 Kernel 的 stopped 算法。成员或统计缺失时不能确认整个调用已暂停。暂停待确认允许撤回请求，已确认暂停才允许恢复；Session/祖先 hold 不因恢复本调用而解除。宿主调度重挂与解除暂停使用不同入口。

```mermaid
C4Component
  title 调用控制的事实与展示分层
  Container(kernel, "Kernel", "执行机制", "持久 Task、控制 epoch 和停止事实")
  Component(projection, "Flow snapshot", "llm-flow", "当前控制成员、历史及 Kernel stat 投影")
  Container_Boundary(ui, "llm-ui-adapter") {
    Component(policy, "Invocation control projection", "展示规则", "组合成员事实与当前可用按钮")
    Component(panel, "InvocationPanel / DAG details", "DOM", "显示、输入和明确目标控制")
  }
  Rel(projection, kernel, "读取执行事实并调用 taskStat")
  Rel(policy, projection, "消费只读快照")
  Rel(panel, policy, "渲染按钮与暂停状态")
  Rel(panel, projection, "刷新目标并提交命令")
  Rel(projection, kernel, "复验控制版本与权限")
```

暂停、恢复、撤回在当前视图内按目标、动作、已观察 epoch 复用 requestId；逐 token 版本变化不重建按钮，也不改变控制版本。响应丢失后以真实 Task 控制刷新展示，迟到 goal 元数据不能反转状态。每种动作独立限制重复点击，悬挂的暂停响应不能禁用取消。隐藏或销毁使原视图的待发控制失效。

审查回归先复现了两项错误：历史成员的旧审批误显示为当前等待，以及隐藏后仍发送迟到取消。修复后审批展示、状态摘要和提交前核对均使用当前控制成员；历史详情仍可读取。DAG 控制入口同样限制成员归属，终态根不提供节点重试；调用卡片重新运行保留 retryOf 关联并创建新 Invocation。

本批是 UI 展示与控制接线，不宣称跨视图重建持久控制台账已经完成。CLI 没有现成的专用 Flow 暂停/撤回入口，仍需明确命令及回执恢复契约；F17 因此仍保留未完成项。F16 子 Session 路由、F20—F24 与原生产 Session 验收继续按主表推进。

隔离候选验证：Flow 全套 710 项、相关工作台 60 项、适配层全套 180 项通过；Flow/适配层类型检查与适配层构建通过。旧审批及迟到取消两项回归先失败后通过；冻结控制身份、终态重跑、真实 Kernel 暂停中回答、宿主重启和未知回复均有覆盖。未部署或重启。

## 19. F17 CLI 显式控制入口

`flow-run` 将应用 Session/根 Task 定位与离线 run-id 分开，暂停、恢复、撤回暂停均要求调用方提供稳定 requestId 和观察到的 epoch；取消与调度重挂独立。参数校验先于命令查询，目标查询失败不提交控制。所有执行走既有 ApplicationClient/FlowCommand，本地和 HTTP 仅由宿主选择传输。

```mermaid
C4Component
  title CLI Flow 控制接线
  Component(cli, "flow-run", "CLI 表示层", "显式身份和 epoch，JSON 结果，不自动重发")
  Container(transport, "ApplicationClient", "本地或 HTTP", "共用命令端口")
  Component(flow, "Flow command service", "后端", "目标、权限、租约及控制回执")
  Container(kernel, "Kernel", "执行机制", "持久控制与原子版本核对")
  Rel(cli, transport, "先查询目标，再提交明确控制")
  Rel(transport, flow, "既有 FlowCommand")
  Rel(flow, kernel, "pause / resume / withdraw / cancel")
  Rel(cli, transport, "receipt 仅查询当前持久控制")
```

receipt 只在当前控制身份匹配时返回 observed，保留 acknowledged/stopped 事实；身份不匹配返回 unknown，不推断未执行、不查询后触发重发。调用方可保存原参数跨 CLI 进程继续核对，但完整历史回执查询和 UI 跨视图持久控制台账仍未完成，F17 不整体标为完成。命令及本地宿主生命周期说明见 [Flow 控制 CLI](../http-mode.md#flow-调用控制-cli)。

隔离验证：CLI 专项与本地应用客户端共 17 项通过，CLI 类型、构建和架构检查通过，10 个 Mermaid 图及 16 个本地链接通过。真实 Kernel 夹具覆盖原身份核对、同请求重试、陈旧 epoch 拒绝与取消；未运行生产远端控制、未部署或重启。

## 20. F17 原控制接纳记录的只读查询

复用 Kernel 已有 `control/<requestId>` 回执，不另建应用台账、不改变旧写入或去重指纹。Kernel 冷查询返回原 action、expectedEpoch、accepted 控制，以及独立 current 控制；原暂停未确认的事实不会被后来的恢复或撤回重写。查询不返回请求 fingerprint 或信号正文，不开启执行 Session、不提交控制、不唤醒调度。

```mermaid
C4Component
  title 原控制回执的权威读取链
  Component(cli, "CLI receipt", "表示层", "显式 Session、根 Task、requestId")
  Component(flow, "Flow control receipt", "应用端口", "验证根归属，只读命令策略")
  Container(kernel, "Kernel cold inspection", "机制", "同一事务读取原接纳与当前控制")
  ContainerDb(receipts, "Task 原有 control 记录", "持久回执", "原接纳快照与请求身份")
  Rel(cli, flow, "既有本地或 HTTP CommandBus")
  Rel(flow, kernel, "readTaskControlReceipt")
  Rel(kernel, receipts, "读取，不重放")
```

CLI receipt 升级为原记录查询，替代第 19 节仅核对当前身份的限制；原 Task 已终结或控制已被覆盖仍可 observed。缺失保留记录只返回 unknown，不推断从未接纳。accepted 是历史接纳证据，current 是当前观察，二者都不能单独替代当前整棵树的停止统计。

F17 的 Kernel/Flow/CLI 历史查询链在本批交付；UI 跨视图持久控制请求与核对恢复仍未完成。认证 RPC 验收同时覆盖暂停、暂停中回答、陈旧 epoch 拒绝、完成后读取旧回执、错误 Session 拒绝、查询不改 Task 版本和队列，以及审计不泄漏消息/回答。

验证：Kernel 单元 368 项，补充接口契约 22 项及类型、构建、独立 ESM/CJS/声明消费通过；隔离 Flow 710 项、CLI 13 项、认证 HTTP 24 项通过。Flow/CLI/HTTP 类型、架构和 11 个 Mermaid 图、16 个本地链接检查通过。Kernel 提交 `8bb4606`，宿主同步锁定；无部署、重启或生产控制操作。

## 21. F17 调用卡片的持久控制与跨视图核对

暂停、恢复和撤回暂停沿用 Session UI 的 OperationLedger，注册成功后才发送。冻结输入只含协议标记、根 Task、动作和观察到的 epoch；Session/Task/动作/epoch 确定稳定 operationId，同一控制在多个视图使用相同身份并由既有条件合并保存。它是用户操作意图，不是第二套执行状态；执行接纳仍以 Kernel 回执为准。

```mermaid
C4Component
  title 调用控制的持久意图与回执恢复
  Component(panel, "InvocationPanel", "UI", "明确控制动作，原回执核对按钮")
  Component(adapter, "ControlOperations", "宿主适配", "冻结身份，先登记后派发，核对原记录")
  ContainerDb(ledger, "Session UI OperationLedger", "现有持久端口", "跨视图条件合并，保存待核对操作")
  Component(commands, "FlowCommand", "应用端口", "执行控制和只读原回执查询")
  ContainerDb(kernel, "Kernel 控制记录", "权威执行事实", "原接纳与当前控制")
  Rel(panel, adapter, "控制或显式核对")
  Rel(adapter, ledger, "先保存冻结输入，再保存接纳结果")
  Rel(adapter, commands, "登记成功才提交；恢复只查询")
  Rel(commands, kernel, "按原 requestId 核对")
```

重新打开显示原操作的核对入口，不自动重发。缺失回执保持 unknown；请求、动作或 epoch 不匹配不能标记 accepted。用户明确再次点击相同动作时可使用原身份重试，Kernel 继续负责幂等和陈旧 epoch 拒绝。远端已接纳但本地结果写入失败时，保留登记记录供下次查询。存储失败不能先发送，登记期间关闭视图也不能迟到派发。取消保持独立，不受待核对暂停阻塞。

独立 Session ChatView 的核对优先识别此协议，不能误路由到 composer 命令或消息提交核对；不会清理聊天草稿，也不会伪造历史消息。默认工作台注入现有持久 ledger；直接嵌入 InvocationPanel 的宿主若需要跨视图恢复，也必须提供持久 operations 端口。

本批补齐调用卡片链路，但审查发现旧 DAG Goal 编辑器仍可用 status 字段触发执行控制，尚需收敛到同一控制入口。F17 保留该迁移与组合验收项；F16、F20—F24 仍按原计划推进，不将整个实施目标标为完成。

验证：隔离候选适配层 187 项、UI 控制/调用/轮询/提交核对 57 项通过，适配层类型检查及 12 个 Mermaid 图、16 个本地链接检查通过。同批生产代码已通过构建和架构检查；新增回归覆盖接纳后本地回执保存失败、登记期间关闭视图，以及并发视图通过既有 CAS 保存同一操作。无部署、重启或生产控制操作。

## 22. F17 Goal 文字编辑与执行控制分离

旧 DAG Goal 对话框保存文字时总会发送 status（默认 active），后端将 active/paused 映射为执行控制。因此文字编辑可能意外恢复执行。编辑器改为仅发送 objective，并显式携带原 Session/根 Task；不将目标元数据解释为用户的暂停、恢复或完成意图。后端既有部分字段更新机制无需新增存储或调度器。

```mermaid
C4Component
  title Goal 编辑与执行控制的职责边界
  Component(goal, "DAG Goal 编辑", "UI", "只提交 objective；视图切换后旧弹窗失效")
  Component(control, "Invocation 控制", "UI 适配", "持久意图、明确动作、原回执核对")
  Component(api, "Flow 应用端口", "后端", "目标更新与执行控制按输入职责处理")
  ContainerDb(metadata, "Session shared goal", "已有存储", "目标元数据")
  Container(kernel, "Kernel", "执行机制", "控制版本、幂等回执和停止确认")
  Rel(goal, api, "仅 objective")
  Rel(control, api, "明确 status、requestId、expectedEpoch")
  Rel(api, metadata, "合并目标字段")
  Rel(api, kernel, "仅明确的执行控制动作")
```

关闭视图或切换运行后，不提交旧 Goal 弹窗；已经发出的保存仍可完成，但迟到回复不刷新或覆盖新视图。独立 DAG 运行页的暂停/恢复/撤回按钮与持久 operations 注入仍需接到统一控制链，本节不将移除隐式入口等同于完成该迁移，F17 保留未完成状态。

验证：新增行为先在旧实现复现 3 项失败；隔离候选 DAG 与调用控制共 55 项通过，适配层类型检查、13 个 Mermaid 图及 16 个本地链接通过。覆盖保存失败的具体提示、切换/销毁后禁止提交、迟到保存不刷新旧运行。仅提交本节对应修改，其他未完成产物代码保留。
