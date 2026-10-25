# 目标、进度与后续任务

2026-10-25 统一执行增量：不可变输入资产与通用文件表单已合入 `a2989fc4`，剩余功能及证据见[功能合入计划](design/functional-merge-plan.md)。新增[子会话与函数调用视图](design/session-invocation-ui.md)决策：独立任务/Flow 可拥有自己的子 Session；每次独立运行使用不同 Session/Invocation，同一子会话仍可续聊或重跑。外层先实现输入、状态、最终输出与打开真实子会话；内嵌消息、完整调用树及分页属于后续详情增强。具体前置、未完成状态和验收条件已列入[计划第 7 节](design/functional-merge-plan.md#7-子会话与函数视图的交付安排)，未按设计稿宣称功能完成。

2026-10-25 入口合入：`630455b4` 接通默认工作台、独立 ChatView 和本地首次草稿的 Agent/Flow 平级目标及持久冻结请求。首个发送回复悬挂仍可继续入队，恢复核对原 Session/分支和完整摘要；目标、文字、参数和当前附件有修订保护。隔离适配层 156、相关 UI 146、项目草稿 16 项通过。完整附件崩溃消费、独立子 Session 路由和最小函数调用组继续列为未完成，不能用普通目标入口替代这些要求。

基线核对：2026-09-14，`345a8994`；后续增量见下文。**该基线中本地 P1 已有完成记录，P2 部分实现已提交；整体目标未完成，并记录过 1 个待排查的调度租约回归失败。** 基线结果不能当作当前版本结论。本文维护剩余要求和证据入口；逐轮经过从 Git 查阅，实机步骤见[最小系统验收记录](minimal-system-acceptance.md)。

2026-09-28 增量：HTTP 外挂文件系统已接通基础读取、条件写入、项目/Session 与工作台。Settings → Storage 管理命名连接及用户名/密码；新建项目选择本地/远程，同一服务路径复用项目，会话仅在项目内创建。部署说明及明确的未开放能力见 [HTTP VFS 第 14 节](design/vfs-http-driver.md#14-本轮实现与验收边界2026-09-28)。原有 Durable 待办状态不因本次变更更新。

2026-09-28 修复：按只读审查结论校正 Range 校验、写入结果分类与错误码、批量 stat 预算、命名语义门控、删除项目忙时预检、连接/挂载状态分离、catalog 容错与来源复用；离线远程项目不再抛错中断启动恢复，只禁用受影响项目的视图。服务端源码以 submodule 形式落在 `tools/mindos-node`，驱动集成测试改为对该仓库的 Cargo manifest 真机运行。逐项见 [HTTP VFS 第 14.4 节](design/vfs-http-driver.md#144-断线降级与契约校正2026-09-28-修复)。

2026-10-21 Durable 增量：独立库、幂等输入、drain、持久定时、归档及活动汇总已实施；401 项库测试（含 52 项真实进程）通过。同 Session/跨 Session 多 Task Harness 组合与审批恢复已有证据，工作台侧栏数量、刷新和 SSE 已在隔离 httpd 验收；现有 2000 端口仍未部署。参见[接口审查](design/durable-kernel-interface-review.md)及[实施验收](design/flow-cli-capabilities-verification.md)。此增量不代表其余 P0/P2 或跨主机目标全部完成。

2026-10-23 远程编排增量：已新增具名 HarnessExecutionConnection，复用已授权 mindos-node 项目与凭据，贯通普通 Agent、Flow 和 Composite 远程成员；入队冻结修订/授权，持久子操作回执、交互响应和确认停止已实施。设置页具备连接新建/编辑，App/CLI与RPC共用服务。真实网关使用安装的Claude Code及本地固定模型peer，不代表真实云模型或完整RAPTOR远程迁移；节点epoch变化无法核对时仍保留未知。使用与验证边界见[远程执行连接](design/remote-harness-connections.md)及[RAPTOR实施](design/raptor-harness-integration.md)。此增量不改变下列其余Durable任务状态。

2026-10-23 真实模型复验：通用远程Agent、并行Flow、Composite、同一Kernel Effect丢回复核对及两个CLI入口已使用实际模型通过；原生usage回报deepseek-v4-pro，主持者为deepseek-v4-flash。代码审查、原生Read和未入prompt的文件挑战值相互核对。记录见[实际模型验收](design/fixtures/remote-harness-real-model-evidence.json)，不覆盖此前固定peer结果，完整RAPTOR远程迁移及跨机器节点仍独立验收。

## 1. 目标与完成标准

原始目标：扫描 `doc/design`，保证设计与代码同步，并完成仍有效的未完成任务。明确被取代的方案不重新实施；最小系统优先不代表其他要求被移出范围。

Tauri 与 CLI 共用执行核心。第一优先级是 Durable Kernel 的持久 Task/Effect、取消与恢复，Skill 加载及指令注入，多节点 DAG 传值，以及以下真实调用链：

`Tauri 外层 harness → Kernel tool.call → Bash → 原生进程 → CLI 子 harness → DAG → 输出、退出状态和持久记录`

Web 保留平台接口，不启用本机 Bash。跨 Session Memory 已有实现但尚未完成全部契约与验收；Skill 自动委派未实现；语义/向量检索按用户要求延期。

完成必须逐项核对有效设计、代码、持久记录及实际运行证据。包级测试、DOM 测试、跨进程 SIGKILL、真实 GUI/IPC、跨主机验证是不同层次；某组测试通过不证明整个工作包完成。`docs:check` 检查路径和预设符号，不验证设计语义、链接锚点或测试覆盖。

## 2. 当前已实现能力

以下仅总结已有实现，不替代第 3 节的剩余验收。

数字分身本地闭环已接入：五页、规则驱动的项目文档/原生及 harness 会话自动发现、周期更新、全局模型/排除、明确主体信息自动生效和全会话默认使用（全局/规则忽略可定制）、原生会话使用门禁、目标、范围遗忘与清理恢复，以及 CLI twin / SQLite 重开。固定索引页和版本链使本域读取/清理有界；严格来源身份、真实 GUI/进程崩溃、多主机、备份恢复及 S2/S3 仍未验收。详见[分身实现与支持边界](design/digital-twin.md#实现与边界)。

扫描计划已接入：自动更新规则与折叠详情、多计划持久队列、每次与总预算、分类检查点、扫描租约、间隔/变化轮询、离线合并补跑、仅状态核对，以及 CLI `twin watch` / `scan-tick`。自然语言关注点、类似 gitignore 的路径忽略、暂停保留快照和多实体局部关联图已接入。候选审核仍保留；自动计划依赖在线宿主。事件推送、独立系统后台服务、提醒及剩余 S2/S3 尚未实施，扫描多宿主接管测试不替代完整多端同步/崩溃矩阵。

| 编号 | 当前实现 | 主要边界 / 证据入口 |
| --- | --- | --- |
| D01 | 祖先取消屏障、后代恢复、终态回执重放 | Kernel/LocalFS 跨进程测试；本地故障矩阵见 P1-05 |
| D02 | Effect 清理超时、pending 保留、取消等待真实完成 | 超时不伪造成功；在途操作未完成时不能宣称已停止 |
| D03 | Session 附件与显式目录授权，文件/工具/进程视图一致 | 来源注册不自动授权；[挂载设计](design/vfs-session-mount-access.md) |
| D04 | Skill 加载/卸载、持久身份、上下文注入、操作队列 | 已补持久版本策略；自动委派与系统性竞态核验仍属 P2-01 |
| D05 | Skill → Agent → transform 多节点 DAG | 组合测试通过；不替代完整真实桌面操作 |
| D06 | 人工回应后同进程 DAG 延续，连续多次暂停 | 沿用同一 Run |
| D07 | 人工检查点与 CLI 独立 run/respond/resume 进程 | 本地约定故障窗口已由 P1-01 验证，不声称覆盖任意崩溃点 |
| D08 | 及时发布 live Run 句柄，退出前等待调度结束 | `waitIdle()` 不强制中断任意宿主回调 |
| D09 | 本机 CLI SQLite 互斥及删除前通用调度租约检查 | 同机控制见 P1-02；当前回归失败跟踪于 P0-05，跨主机后移 |
| D10 | Run 成员重连、单任务及图级重试、物理分页 | 见 P1-04、P1-06；不再列为未实现 |
| D11 | 人工暂停 Run 的最终 token/耗时统计持久化 | 旧缺失 metadata 的记录未自动回填 |
| D12 | Tauri Session Bash 工厂、目录句柄与 Web 接口 | Web 无原生工厂；Tauri 不回退到未隔离 shell |
| D13 | Bash 输出/退出码、进程组取消与超时 | Linux bwrap 已有真实进程证据；共享宿主网络 |
| D14 | Bash 清理错误聚合、幂等 release、每流 1 MiB 输出上限 | 仍排空管道；不限制子进程磁盘、内存和输出速率 |
| D15 | 外层 Kernel/Bash → 子 CLI DAG 及重开记录 | 真实窗口链路见 P0-01 |
| D16 | Tauri 构建、Xvfb/AT-SPI 窗口与目录操作 | 不等于其他平台、发布安装包或全部 GUI 验收 |
| D17 | Session 本地 Memory、管理 UI、模型工具及 CLI 配置 | 已有持久化和 HTTP mock 调用；已补显式跨 Session 共享、版本冲突处置与内容压缩；语义检索延期 |
| D18 | 设计/API/包说明阶段性审计与历史方案归档 | 本地生命周期见 P1-05；扩展设计闭合属 P2-05 |

## 3. 任务清单

### 当前未完成内容总览

| 归属 | 尚未完成 | 性质 |
| --- | --- | --- |
| 外部 Anki Tool + Flow | 已提供独立 Rust anki-cli、文本/图片双入口与公共 Flow、资产引用与可定制图片预处理、视觉识别与人工校对、确定性字段合并、旧项目迁移、媒体生成、YAML 清单与 apkg 打包，通过模拟端点和包内容验收；厂商专用语音、宿主要求匹配和真实 Anki 导入仍待完成。详见[设计方案](design/anki-flow.md) | 后续能力 + 真实导入验收 |
| P0-05 | 定位 `scheduler-paused-owner.test.ts` 的 `Host exited: 1`，修复后重跑；原因未确定，不能归因为环境或视作已解决 | 当前回归失败 |
| P0-02 | 发送性能达到 ≤2 秒 / ≤100 次公开 IPC；IPC/发送失败、保存重试、pause 与未确认停止的真实窗口闭环 | 实现优化 + 验收 |
| P0-04 | 原生目录选择完整授权路径、支持平台及发布安装包、深层 cwd 的 Skill 级联 | 平台验收 |
| P2-01 | Skill 自动委派编译、稳定请求身份与有界监管；完整版本/作用域生命周期矩阵、CLI 漂移处置入口核对 | 实现 + 验收 |
| P2-02 | 审计变更明细与来源展示；IndexedDB、双进程撤权/删除重建/并发清理、桌面跨 Session 链路 | 契约补齐 + 验收 |
| P2-03 | 模型工具的结构化冲突/最新版本引用；完整压缩 Task 恢复与 GC 矩阵；真实窗口和云模型 | 契约补齐 + 验收 |
| P2-04 | 保持编辑器打开后撤权，再保存失败且草稿保留；浏览/工具/附件及后端故障矩阵 | 验收 |
| 样式 | 本批新增样式的真实窗口检查（主题、窄布局、长内容、打印） | 视觉验收 |
| P0-05 | 最终源码全量测试、构建、全新依赖安装、发布产物和真实窗口复核 | 最终验收 |
| 延期 | 语义/向量检索、embedding 索引及真实召回验证 | 用户明确延期，本轮不执行 |

`345a8994` 已交付的 Skill 快照/漂移策略、共享 Memory 存储及管理入口、条目 revision/冲突比较、内容压缩提交和样式规则不重复列为“缺实现”。以下子项分别记录剩余要求；P1 的历史完成结论不代表当前整树回归通过。

### P0：最小系统验收

- [x] **P0-00 两端核心装配一致性**
  - 已实现：app-core 共用装配、项目规则与 Skill 解析；CLI 模型请求、Tauri 宿主装配及真实窗口首次加载已有证据。
  - 已收口（2026-09-13）：`SKILL.md` 新增 `auto-load` 覆盖，使文件系统来源能表达「可加载但不自动注入」；项目规则锚定项目根，parent-fs/local-fs 的嵌套 `_agent/AGENT.md` 不合并/不替换，Skill 仍按层级级联。CLI 与真实 Tauri 入口均核对：命中加载并持久身份、重开后按身份恢复、卸载后不复活、再次命中可重新加载；包级（真实 runtime+Kernel+文件来源）、桌面宿主装配（`createApplicationRuntime`+`TauriSkillSource`）、CLI 真实请求与真实窗口四段闭环（Xvfb/dbus/AT-SPI）逐层取证。
  - 见[验收 §71](minimal-system-acceptance.md)、`session-file-source.test.ts`、`session-skill-restore.test.ts`、`tauri-host-skill-context.test.ts` 与 `run-skill-context.test.ts`。
  - 2026-09-14 补齐真实面板操作：滚动设置面板后点击 Skill 复选框，完成加载 → 重开保持 → 卸载 → 重开不复活；四段分别核对模型 system 消息与持久身份，未直接修改加载记录。见[复选框验收](minimal-system-acceptance.md#2026-09-14skill-复选框真实加载卸载与重开)。嵌套边界见 P0-04：单挂载内的目录树已有窗口证据，更深 cwd 下的 Skill 级联仍待验证。

- [x] **P0-01 完整 Tauri 调用链**
  - 真实窗口 → 外层 harness → Bash/IPC/bwrap → CLI 子 DAG → 结果和退出码，重开 transcript 已通过。应用内挂载对话框建授权亦通过。
  - 见[验收 §3、§18、§20](minimal-system-acceptance.md)。模型为本地 mock；其他失败场景归 P0-02。

- [ ] **P0-02 应用级失败、取消与性能闭环**
  - 已实现/验收：取消与失败使用 ABORTED/TIMEOUT 区分；真实窗口取消、约 60 秒模型超时及重开原因保留；独立“关闭会话并保留记录”入口和运行中删除均已有窗口证据。关闭挂起模型约 0.45 秒确认连接停止并保留记录；超时 live 终态在连接关闭后 +0.75～+1.53 秒间收敛。不能外推远端供应商物理停止，AT-SPI 终态文本仍缺独立断言。
  - 已实现：发送到 Provider 响应头的动作边界计量、并发保存与失败重试、数据库未知失败保留、宿主在途消失后的重开续发；这些包级或局部证据不替代全部窗口矩阵。
  - [ ] **性能优化及重测**：最新有动作边界的历史样本为 2870 ms / 1301 次公开 IPC、2731 ms / 1173 次，均未达到 **≤2 秒 / ≤100 次**。已实现嵌套视图目标检查去重、目录元数据与 SeqFile 精确字段批量读取，且保留事务内恢复检查；仍需在最终桌面构建重录同口径样本。空闲历史样本已达 70 秒 VFS 0、sidecar 32 次，不重复列作未实现。
  - [ ] **失败与重试窗口**：IPC 故障、发送失败保留草稿/已接受消息、保存失败与人工重试；核对磁盘、live 状态与重开记录一致。
  - [ ] **控制状态与停止确认**：真实 GUI 区分“请求已接受 / 状态已变化 / 外部已停止”，补 pause 同类文案和路径；设备不确认停止时有界失败并保留数据，核对监控/取消的 live 与重开一致性。
  - 证据：[发送边界](minimal-system-acceptance.md#2026-09-14发送provider-动作边界的真实-ipc-计量)、[关闭保留](minimal-system-acceptance.md#2026-09-14运行中的-session-真实窗口关闭并保留记录)、[超时收敛](minimal-system-acceptance.md#2026-09-14模型超时的-live-收敛上界与重开原因)、[取消文案](minimal-system-acceptance.md#2026-09-14取消事件与界面终态文案)及 `run-control.test.ts`、`session-delete-lifecycle.test.ts`、`host-restart-inflight.test.ts`。

- [x] **P0-03 可复用运行入口与交付说明**
  - [运行说明](minimal-system.md)已覆盖启动、隔离数据根、Provider/Connection、目录授权、子进程凭证注入与预期结果。
  - 用户决定保持 API Key 明文落盘；设置页已注明路径和 Session Bash 不继承宿主环境，见[验收 §28](minimal-system-acceptance.md)。不重新引入密钥环方案。

- [ ] **P0-04 平台实机验证**
  - 已有 Linux bwrap/目录/符号链接边界、取消/超时、缺隔离器拒绝、Xvfb/AT-SPI 窗口与应用内目录授权证据。
  - 剩余：其他目标平台的支持范围及真实行为、原生 GTK 目录选择器（仅验证到弹出：见下）、发布产物的支持边界；多层级嵌套挂载收窄为「单挂载内的嵌套目录树」并验证；更深 cwd 下的 Skill 级联仍未覆盖。Skill 面板真实勾选/取消及重开持久身份已于 2026-09-14 验收通过（见 P0-00）。
  - 2026-09-14 桌面字体/导航补验：10 个本地 FontAwesome 字体面在真实 WebView 加载成功，修复 Vite 内联小字体被 CSP 拦截；11 个静态导航控件具有稳定 AT-SPI 名称。文件列表方框字符已定位为本机缺少 emoji 字体（见下条支持边界），字体面加载通过不等于全部图标渲染通过。见[字体与导航验收](minimal-system-acceptance.md#2026-09-14桌面本地字体与导航可访问名称)。
  - 2026-09-14 边界收口（见[平台边界验收](minimal-system-acceptance.md#2026-09-14p0-04-平台边界图标字体与原生目录选择器)）：**方框字符根因已定位**为宿主缺少 emoji 字体——列表图标是 `@itookit/common` 的 emoji 码位，而本机 `fc-list ':charset=1F4C1'`/`1F5D1`/`2795` 均为 0 条，应用不自带该字体；属支持边界而非本轮代码回归。**原生 GTK 选择器**经 XDG Portal 真实弹出 `Select Folder`（含文件选择小部件与 `取消/打开`），但**未能完成选择**：合成输入会破坏 GTK 位置栏路径（实测 `/ome/…`、`/home/lli/…`），且容器无 `/dev/fuse` 使门户文档门户不可用，未产生挂载记录。**发布产物**未构建（无 AppImage/linuxdeploy 工具、无网络）；受版本控制的 `release/dist/` 停留在 2026-09-04。**其他平台未验证**，不能由 Linux 证据外推。
  - 2026-09-14 嵌套边界收窄（见[嵌套规则验收](minimal-system-acceptance.md#2026-09-14项目规则在真实窗口的嵌套边界p0-04)）：**「多层级嵌套挂载」在本实现不可表达**——`SessionFilesService.create` 要求挂载点 `at` 匹配 `^\/[a-zA-Z0-9_-]+$`（单段），`at: '/workspace/inner'` 实测抛 `EACCES Reserved or invalid mount point`；真正存在的嵌套是**一个挂载内部的多层目录树**。按此收窄后在真实窗口验证：单挂载 `/workspace` 的树内含 `inner/_agent/AGENT.md` 与 `inner/_agent/skills/...`，请求体出现 `OUTER-PROJECT-RULE-MARKER`(1) 与 `OUTER-SKILL-BODY-MARKER`(1)，`INNER-NESTED-RULE-MARKER`(0) 与 `INNER-SKILL-BODY-MARKER`(0)，即内层项目规则不合并、不替换。cwd 等于项目根时内层 Skill 不级联（级联需更深 cwd，属 Flow/工作区作用域路径，本场景未覆盖）。
  - 2026-09-14 选择器静默失败已修（见[静默失败验收](minimal-system-acceptance.md#2026-09-14原生目录选择器的静默失败p0-04)）：`openDirectoryDialog` 原为 `catch { return null }`，把“取消”与“选择器损坏”合并，且点击处理没有 `catch`，失效时唯一症状是按钮无反应。现抽出 `apps/tauri-app/src/services/directory-dialog.ts`：取消返回 `null`，真实失败记录并重新抛出；点击处理报告挂载/选择失败。回归 `ui/app-shell/tests/directory-dialog.test.ts` 3 项通过。**验证缺口**：改动后本环境合成输入不再激活窗口（诊断标题从未改变，同期导航点击也失效），因此修复后的端到端行为未在窗口复验；门户选择失败的确切形态（reject / null / 挂起）仍未判定，原生选择器在本机的可用性**未结论**。
  - Tauri Session Bash **共享宿主网络**；无出网或连接超时不能当作网络沙箱证据。见[验收 §29](minimal-system-acceptance.md)。

- [ ] **P0-05 当前最终回归**
  - [ ] **优先排查当前失败**：`345a8994` 提交批次 app-shell 为 221 通过 / 1 失败 / 30 跳过；`ui/app-shell/tests/scheduler-paused-owner.test.ts` 返回 `Host exited: 1`，单独重跑仍失败。保留子进程 stderr、定位失败阶段并修复或明确环境前置条件后，重跑该用例和整包。未定位前不判定为无关失败，不用旧 P1 通过记录覆盖。
  - 最近 P2 批次类型/文档/样式检查、kernel-adapters 128、llm-session 124、app-core 103、CLI Skill/Memory 4 及共享 Memory 13 项通过；没有执行该提交的全量最终矩阵、完整构建和真实窗口。见 [P2 批次证据](minimal-system-acceptance.md#p2-版本与共享-memory-提交批次)。
  - 旧树 `d883a497` 的阶段性矩阵已完成并保留在[验收记录](minimal-system-acceptance.md)，不能作为后续大量改动后的最终通过证据。
  - 2026-09-14 统一测试入口批次：以 `a308eb65` 加本批选定文件的隔离快照运行 `pnpm test`，Vitest 1,593、调度器 3、Rust 36 项通过，共 1,632 项；30 项既有跳过。CLI 107 项与 SIGKILL 矩阵 10 项分开执行；CLI 类型与文档检查通过。Node 26.8.1 / pnpm 10.20.0，复用本机依赖与 Rust 编译缓存，未做全新依赖安装验证。这是当前入口的阶段性回归，不是最终全仓/GUI 验收。
  - 2026-09-14 类型/构建入口批次：补齐六个 workspace 的 typecheck，24 个实际执行通过；Web/Tauri 文件列表覆盖 app-shell 全部 12 个 src TS 文件，demo 仍为手工 JS 示例。20 个库和四个应用构建、冻结锁文件核对、tsx 子进程三项 SIGKILL 回归通过。见[清单验收](minimal-system-acceptance.md#2026-09-14类型检查覆盖与包清单收口)。未替代最终全矩阵、全新安装或 GUI。
  - 2026-09-14 当前树全量批次：工作树 `3c3afe5d`（`git status` 干净），按 §4 入口逐条执行，11 个阶段全部 rc=0——typecheck 25 个 workspace、`docs:check`、`styles:check`、20 个库构建、CLI/前端构建、`cargo test` 36 项、包测试 **1508 通过/30 跳过**、CLI 非崩溃 **108**、crash-matrix **12**、`custom-protocol` 原生构建、调度器 **3**，合计 **1667 项通过 / 30 项跳过**。见[当前树全量回归](minimal-system-acceptance.md#2026-09-14当前树全量回归p0-05-阶段批次)。
  - 仍未达最终验收：P0-02 性能阈值未达成、P0-04 尚有未做窗口场景；未做全新依赖安装，未构建发布安装包（`bundle.targets: "all"`，本机无 AppImage/linuxdeploy 工具且无网络）。受版本控制的 `release/dist/` 停留在 2026-09-04，与当前树不同步，本轮未重新生成。
  - 待其余有效要求闭合后，对最终工作树执行类型、文档、样式、库/CLI/前端/原生产物构建、全量测试矩阵与真实窗口验收，记录版本、命令、结果和剩余跳过项。

### P1：完备的本地 Durable/Flow 运行

**当前范围（用户于 2026-09-14 收窄）**：单主机、当前版本、本地事务存储，CLI/Tauri 可运行、可控制、可恢复、可重开核对。保留同机多进程/多 Session 的正确性；迁移、跨主机执行及通用分布式协议不再是本地 P1 的完成条件。细分边界见[本地 P1 设计](design/p1-transition.md)。下列本地路径已有完成记录；不按旧设计章节是否全部实现决定完成。当前调度租约用例失败单列于 P0-05，须排查后才能恢复当前整树回归通过的结论。

- [x] **P1-01 本地崩溃恢复闭环**
  - 已实现：稳定 requestId/spec 去重、根和检查点持久化、循环/patch/委派恢复；不确定 Effect 默认阻断，显式授权才重放。提交/检查点间隙、委派在途、已完成循环迭代已有真实 SIGKILL 回归。新增根提交后、首检查点前的真实 SIGKILL 回归；初始调度/工作区身份与根同事务持久，终态到收尾 pending 的窗口也可恢复。
  - 已补验证：首个能力回执后、Task.start 后、动态 patch 检查点前、委派全部完成但根 join 信号前四个真实 SIGKILL 窗口；恢复保持 Task 身份、已完成输出及模型调用次数。结果不确定时仍阻断并要求显式裁决，不追求外部服务恰好执行一次。
  - 入口：`apps/cli/tests/crash-matrix.test.ts`、`backend/llm-flow/__tests__/durable-flow-executor.test.ts`、[验收记录](minimal-system-acceptance.md)。

- [x] **P1-02 同机所有权与全部本地控制入口**
  - 已实现：Session/Run 租约、epoch、CLI 本机锁；Run 到期即失效、迟到心跳不续活；节点提交、共享状态和根信号在事务内检查所有权；失权不触发失败清理。
  - 已核对取消、pause/resume、图重试、委派兄弟取消、资源授权及工作区清理的旧句柄/迟到回调路径。已补 TaskHandle cancel/pause/interrupt/resume/start/signal/retry、资源创建和预算事务 guard；后台委派在截止前保留所有权，终态恢复也收敛后台任务。独立 DAG 命令已接上 Session 写权限门、工作区管理器以及本 Kernel 的 Run 租约；失权/异宿主控制被拒，HITL 响应同样事务校验。同机并发控制串行化，重复 retry 复用回执；暂停/恢复仅作用于当前 Run，不再暂停整个 Session。
  - 已验收：CLI 两个进程争用及活跃拥有者拒绝取消；真实 LocalFS/SQLite 进程 SIGSTOP → 租约过期 → 新进程 epoch 2 接管 → SIGCONT 后八种迟到写入全部拒绝，新拥有者与任务保持不变。清理不确认时已在 5 秒后持久记录 pending 说明，桌面显示且 CLI 退出等待期间报告；继续保留数据和租约，确认停止后才清理。保留本机时钟变化的安全失败边界，不实现跨主机时钟协议。

- [x] **P1-03 本地工作区与委派可用性**
  - 已实现：CLI/Tauri worktree、持久创建意图与租约、文件/进程/cwd 一致、detached deadline 恢复、pending 收尾、脏副本保留；已有真实 LocalFS/SQLite/Kernel/Flow SIGKILL 和 Tauri IPC/bwrap 探针证据。
  - 已补齐：授权变化或 Kernel 无法发现 Session 的遗留意图已保留并报告具体路径和处理建议；工作区恢复失败释放调度租约，清理等待保留租约与文件并有界报告。CLI YAML 已提供有界 delegation 配置、Agent 引用检查及父子工具交集，真实 SIGKILL 回归已改为经 YAML 配置。
  - 真实窗口已验收：会话挂载授权后启动工作区 Flow、桌面重启恢复原目录、取消节点后的失败清理；脏副本阻止自动合并但不改写 Run 成功，重开仍显示目录/分支及错误。人工提交后从窗口重试收尾，快进合并成功、副本/分支/意图清空。按策略保留目录/分支的说明同步写入持久状态并由 CLI 输出。完整冲突编辑器及自动冲突解决后移。
  - 平台边界：当前 Linux 原生/bwrap 为本地验收目标。OCI 不是基础 P1 前置条件；若选择或声称支持 CLI OCI/read-only 模式，则必须独立真实验收，不能用原生模式冒充只读隔离。

- [x] **P1-04 图级 retry 与本地控制验收**
  - 已实现：图级/委派组/隔离工作区重算、下游取消、代数更新、token 退款、DagWorkbench 入口；直接以合成委派子节点为重试源仍拒绝。
  - 已补真实入口：工作流工具栏「运行记录」→ Run 控制台→「继续运行」；重开后的图重试自动恢复调度。列表、快照和 transcript 浏览不激活 Session。真实 Tauri 窗口完成 source 重算、gate 下游替换、重启继续、人工回应、after 与根成功；再次重开保持成功及重试历史。旧拥有者重试/取消的命令隔离归 P1-02。
  - 入口：`graph-retry.test.ts`、`durable-flow-executor.test.ts`、`dag-run-retry.test.ts`。

- [x] **P1-05 现有本地存储与资源生命周期**
  - 已实现：预算 usageId 幂等、Task/Session cache 清理、消息结算确认与保留、history/event 裁剪水位、现有资源申请/释放/清理回执和布局识别。
  - 已验收：LocalFS/SQLite 两进程、root/module 两种挂载下，消息消费后 SIGKILL、发送/接收 Session 并发 GC 保留未结算回执，重投递不重复消费；双方结算后才裁剪，重开保持。现有同组物理清理 adapter/receipt 两个 SIGKILL 窗口验证未确认停止保留容量、重启恢复和回执重放不重复分配；single-use cache 提交前/后 SIGKILL 证明消费原子性。Kernel resource/retention/protocol 测试验证未知或超时清理保持占用、旧回执不复活资源、usageId 幂等与历史裁剪水位。无须重构存储表。
  - 不要求：Storage §5 全量记录族拆分、account/allocation/export/import 通用服务、可插拔 cache provider、可恢复业务字节流、真实供应商收费幂等、多 store 迁移。
  - 完整设计对照仍见[证据映射](design/durable-harness-evidence.md)，其中扩展缺口不阻塞当前本地 P1。

- [x] **P1-06 Transcript 存储分页与导出**
  - 物理分页、固定版本、maxBytes 裁剪及水位、CLI 真实文件导出、UI 独立遍历分页导出已有证据；UI 导出保留单调性和 10k Effect 上限守卫。
  - 入口：`transcript-budget.test.ts`、`task-transcript-dialog.test.ts`、CLI `run.integration.test.ts`。

- [x] **P1-07 本地节点输出契约**
  - 已实现：受支持 schema 子集与同 id 跨版本兼容、所有生产者输出独立验证、Run/动态图及清单/schema 冻结；无效输出使 Run 失败，不派发严格下游，原输出保留。
  - 已补齐：节点 `portSchemas` 输入/输出引用及内联定义、Agent responseFormat 到解析后 result 的绑定；发布/直接执行/动态图/恢复复用冻结目录，同身份不同定义和削弱插件契约被拒绝。CLI YAML 提供 `response_format` / `output_validation` / `port_schemas`；原文保留在 Task，具体错误进入 Run，沿用既有 transcript 与人工重试入口。真实 CLI 正反例及 Flow 回归证明严格端口不会被 Agent continue 绕过。
  - 当前策略：Flow 端口默认 fail，使用已有人工修正/重试路径；Agent 内部已有 repair/continue 保留。通用自动修复 Task、invalid 分支 DSL、任意 schema 转换及插件产物版本仓库不作为本地 P1 前置条件。
  - 当前版本运行并重启应可恢复；不支持契约漂移时静默续跑。跨应用版本升级迁移与旧插件包自动归档后移。

- [x] **P1-08 Effect 回滚缺陷**：Skill 身份持久化失败只回滚本次新加载，清理逐项执行并聚合原始/清理错误；`create-kernel-adapters-runtime.test.ts` 有回归。
- [x] **P1-09 CLI supervisor 累积结果**：回边使用来源最新已完成实例，支持轮流派发 worker；普通 Loop 语义保持，CLI/Flow 已有回归。
- [x] **P1-10 CLI 非交互监控窗口**：持久根建好后及时发布 live 句柄，调度期失败写入 Run；Tauri 监控/取消窗口剩余验收归 P0-02。

本地 P1 完成标准：上述本地路径全部闭合，执行最终工作树的相关测试/类型检查与真实 CLI、桌面验收；不存在靠直接改持久记录或仅靠测试夹具才能使用的核心能力。P0 的性能、发布包及其他平台验收保持各自归属，不重复算作 P1 实现任务。

### P2：扩展与设计闭合

实施拆分、协议边界和逐项验收标准见 [P2 实施与验收契约](design/p2-completion.md)。该文档定义目标，不作为已实现证据；P2-01～P2-04 仍按下列剩余项闭合。

本轮范围调整（用户明确指定）：**语义/向量检索暂不实现**，保留延期，不作为本轮完成条件。现有词项检索保持原行为；其余 P2 待办继续推进。

- [ ] **P2-01 Skill 完整生命周期**
  - 已合入 `a8288084`：Skill 初始快照、直接会话/Flow 接线、UI/宿主入口与关闭屏障整批隔离验证；action Skill 不自动进入 system 提示。已补严格版本冻结；自动委派与其余竞态要求仍开放。
  - 已实现：直接会话/Flow 初始 Skill 快照及工具交集、编辑器 glob open/close、列表变更通知、手动斜杠入口。
  - 已实现：持久定义/正文/支持文件/工具快照、默认 require-reload 与显式 keep-old 策略、持久漂移标记和面板重新加载；旧 ID 记录要求显式 reload。直接聊天与 Flow 的初始选择使用同一版本入口，keep-old 不恢复撤销的授权。
  - [ ] **自动委派实现**：宿主显式允许后编译到现有 TaskGroup/Flow 委派组，固定 Skill 版本、父子工具交集、模型/角色、输入输出和数量/并发/深度/预算上界；接直接聊天与 Flow 正式入口。定义稳定触发身份，加载列表或刷新 UI 不触发任务。
  - [ ] **自动委派恢复验收**：子任务创建前后、子任务完成而父 join 未提交时 SIGKILL；重复匹配/Effect 重放不重复创建，父取消或失权后迟到创建被拒。已有显式 Flow 委派证据不替代此链路。
  - [ ] **版本与生命周期矩阵**：正文/compact/支持文件/工具/来源变化及删除、禁用、撤权，经直接聊天、Flow、load_skill、面板和真实进程重开复核；扫描/读取/工具注册/身份提交/订阅与 load/unload、cwd 切换、关闭重建交错，不残留部分授权。
  - [ ] **CLI 版本处置**：核对并补齐持久漂移的正式查询与显式 reload 路径、旧 ID 记录处置，不能只依赖桌面面板或直接改持久记录。
  - 当前通知仅进程内；跨进程直接修改文件不触发。在途 Task 的 system 消息不改，后续上下文组装复核持久版本并执行漂移策略。见[Skill 设计](design/skill-design.md)。
  - 已补错误边界：身份 CAS 仅重试 Kernel CONFLICT，提交前/后非冲突错误直接报告；自动加载回滚聚合身份写入与清理错误；批量恢复失败撤销本次新增加载、保留已有选择并允许修正后重试，action 定义不能经旧身份自动恢复。`loaded-state.test.ts`、`prompt-context.test.ts`、`restore-loaded-skills.test.ts` 有回归，早期批次 kernel-adapters 120 项通过；`345a8994` 批次含版本回归共 128 项通过，不替代完整竞态/窗口验收。
  - 完成标准见 [P2 契约 §2](design/p2-completion.md#2-p2-01-skill-生命周期)。

- [ ] **P2-02 跨 Session Memory**
  - 已实现：独立 `/var/lib/memory/shared.seq` 资源、不可复用 incarnation、精确 Session/scope 授权、来源记录；授权/CAS/数据/幂等回执/审计在同一事务提交。管理对话框和 CLI 提供创建、选择、授权、撤权、删除及审计入口，模型工具不提供管理权限。
  - Session shared state 只在当前 Session 内共享。同一 namespaceId 不自动跨 Session；CLI 新 Run 不自动读取旧 Run 记忆。
  - 已有回归：两个真实 Session 的双进程条件写竞争、创建者删除后共享数据保留；写入/删除/prune/压缩各三个 SQLite 事务故障窗口的 SIGKILL、重开与回执审计一致性。
  - [ ] **审计与来源契约**：当前审计记录 action、Session、资源/数据提交版本及部分 Task/Effect 来源；补齐可复核的条目前后版本、授权变更内容和管理操作来源，管理 UI 展示条目来源。当前 `mutate` 事件未记录具体写/删/压缩内容身份，授权事件也未保存前后 scope 列表。
  - [ ] **共享边界矩阵**：IndexedDB 事务独立验证；真实双进程撤权与在途写入、资源删除重建/旧引用、重复操作与并发清理；直接聊天/Flow/CLI/管理 UI 的两个 Session 正式链路，桌面重开后权限与来源一致。
  - 已知保留边界：墓碑、审计和回执永久保留；history 默认前 100 项、上限 1000，无分页归档或物理历史 GC。此为当前保留策略，不把物理历史 GC 擅自增加为本轮前置条件；条目 retention 的并发清理验收仍须完成。
  - 标准见 [P2 契约 §3](design/p2-completion.md#3-p2-02-跨-session-memory)。不以伪造同一 sessionId 实现共享。

- [ ] **P2-03 Memory 模型写入与管理**
  - 已实现：SessionMemoryProvider 的 CAS 存储、scope 授权、完整列表、不可复用 revision 与摘要条件编辑/删除、容量/时间水位清理；并发 prune 计数和同毫秒裁剪缺陷已修；仅 Kernel CONFLICT 重试，其他提交前/后存储错误直接返回。
  - 已实现：Files 页记忆管理 UI，固定 Session、写租约检查、冲突保留输入；直接会话与 Flow 的策略快照；memory_list/write/remove/compact 经 tool.call 校验持久 Task 白名单及策略。CLI Agent `memory_policy` 同步进入节点和 RunDefinition。
  - 已验证：DOM + 真实 LocalFS/SQLite 重开后编辑保留、删除不复活；真实 Durable Agent 两轮调用；真实 CLI + 本地 HTTP mock 调用及退出后磁盘读取；取消等待和普通 ToolService 绕过被拒；CLI 写入/删除成功回执后 SIGKILL，恢复保持记忆版本及工具执行次数不变；另有写入/删除服务调用前及提交后未写回执的四个 SIGKILL 窗口，默认阻断、显式重放后成功。
  - 已实现：冲突后读取最新内容、保留草稿、显式采用比较版本再提交；memory_compact 在持久 Agent 工具链中提交更短摘要，原子复验源版本与读写授权，保存来源版本/摘要/模型并保留原文。
  - [ ] **模型冲突返回契约**：当前条件冲突抛普通错误，工具成功仅返回 success；补齐可识别的冲突类型及授权范围内的最新版本引用，验证模型不自动转为无条件覆盖。已完成的 UI 比较重提不替代模型工具契约。
  - [ ] **压缩 Task 完整验收**：使用真实 Durable Agent → tool.call 链验证预算、源版本并发变化、撤权、取消、结果不确定后的显式恢复、摘要提交后父 Task 恢复和原文保留。已有 SQLite 事务内三个 SIGKILL 窗口调用 provider，不等于完整模型任务恢复验收；核对模型/程序/策略版本的持久可追溯性。
  - [ ] **retention/GC 并发验收**：同机多进程清理与写入交错、多 scope 部分失败及重开计数；不重复实现已有时间/容量裁剪或重做已经通过的事务故障窗口。
  - [ ] **真实入口验收**：Tauri 创建/编辑/删除/版本冲突处置/切 Session/重开；真实云模型记录 Provider/模型、授权 scope、工具请求/回执和重开内容。目前只有本地 HTTP mock 证据，真实云模型配置尚未确定。
  - **延期**：语义/向量检索与 embedding 索引按用户要求暂不实现或验收。
  - 写工具属于 local 副作用，崩溃结果不确定时不盲目重放。条件编辑支持 expectedRevision，能拒绝相同内容的删除重建；共享工具通过 Task/Effect 操作身份复用事务回执。见[Memory API](llm-session-api.md)、[CLI 配置](../apps/cli/README.md)及[验收 §61–63](minimal-system-acceptance.md)。
  - 词项、向量与压缩分别验收，见 [P2 契约 §4](design/p2-completion.md#4-p2-03-memory-管理检索与压缩)。

- [ ] **P2-04 VFS/C4 完整验收**
  - 附件-only、逃逸拒绝、全部只读变更动词、同名挂载跨 Session 隔离、默认目录不隐式授权、卸载保留文件与旧句柄失效已有包级证据；真实 GUI 挂载/撤销/只读与 bwrap 边界已有记录。
  - 已合入 `f8c1f181`：普通与工作区视图同时关闭入口再等待在途操作；配置变更、禁用和释放均有受控交错回归。只读来源拒绝 rw 授权；多挂载 SeqFile transaction 返回 ECAPABILITY 且不执行回调。
  - 剩余：旧句柄失效的真实窗口可观察路径及有效设计要求的浏览/编辑/工具/附件/平台故障矩阵；不重做已被取代的方案。
  - 矩阵按消费者、撤权/在途/存储故障和后端分别记录；旧句柄窗口路径为保持编辑器打开 → 正式入口撤销挂载 → 保存失败且草稿保留。见 [P2 契约 §5](design/p2-completion.md#5-p2-04-文件消费者与平台矩阵)，复用 P0 已有证据，未执行项保持开放。

- [x] **P2-05 文档同步审计（已记录范围）**：已完成阶段性设计/API/AGENTS/README 核对及历史方案归档；本地语义与故障证据见已完成的 P1-05；扩展要求仍由其余未勾选项闭合。
- [x] **P2-06 app-core 包内边界与技术债**：包说明、测试归属、app-shell 兼容 shim 删除、runtime/infrastructure 拆分、公开 VFS ioStats、session/vfs 目录归类、index 别名收口、静默失败可见化、租约 init 去重及已有 app-core 文案 i18n 均已完成。
  - 分批合入验证：应用层整理提交快照通过 app-core 72 项、app-shell 112 项、CLI HTTP 2 项测试（另有 30 项既有跳过），以及 app-core、Web、Tauri、CLI 类型检查；新增基础设施初始化失败和清理失败回归。最终全仓验收仍见 P0-05。

- [ ] **样式视觉验收（规则实现已提交）**：Agent 快捷 Prompt、DAG 空态/运行视图、同步设置、VFS 列表/移动弹窗/mention 预览、mdx 打印及零散元素已增加实际样式，并移除相应豁免；allowlist 仅保留 48 个选择器/状态类。`styles:check` 通过；仍需真实窗口核对明暗主题、窄布局、长路径/长正文、按钮可用性和打印内容，视觉实机验收未执行。本地图标字体与 Mermaid 本地延迟 chunk 已接入；MathJax/Vega 仍在实际内容出现后使用配置的 CDN。

## 4. 下一步与验证入口

先定位 P0-05 的调度租约回归失败。随后按 [P2 实施契约](design/p2-completion.md) 补 Skill 自动委派与剩余 Memory 契约，并完成版本/共享/压缩的系统矩阵。已有版本快照、共享存储、冲突 UI、压缩提交和样式规则不重新实现。真实窗口合并复核 P0/P2 的相关场景，性能和发布平台保持各自完成条件。语义检索继续延期。最后对最终工作树执行全量回归、构建及交付验收。

| 主题 | 入口 |
| --- | --- |
| 最小系统与桌面操作 | [运行说明](minimal-system.md)、[验收记录](minimal-system-acceptance.md) |
| Flow 恢复与工作区 | [Flow 设计](design/flow-execution-model.md)、[Flow API](llm-flow-api.md) |
| Durable 完整要求 | [证据映射](design/durable-harness-evidence.md)、[Kernel API](kernel-api.md) |
| Memory 实现与配置 | [Session API](llm-session-api.md)、[CLI README](../apps/cli/README.md)、`apps/cli/tests/run-memory.test.ts` |
| 共享装配 | [运行时架构](runtime-architecture.md)、[包结构](pkgstructure.md) |
| Skill 与文件边界 | [Skill 设计](design/skill-design.md)、[挂载设计](design/vfs-session-mount-access.md)、[Session 浏览](design/vfs-session-browser.md) |
| 其余有效设计 | [VFS 总设计](design/VFS-design.md)、[实现状态](design/vfs-implementation-status.md)、[C4 核验](design/vfs-c4-review.md)、[运行时诊断](runtime-architecture.md)、[标签存储](design/label-storage.md) |

最近已提交批次（各批验证范围不同，**不是当前整树最终矩阵，不累加为独立测试总数**）：

| 提交 | 功能 | 当批通过项数 |
| --- | --- | --- |
| `345a8994` | Skill 版本、共享 Memory、冲突/压缩及样式 | 128 / 124 / 103 / CLI 4+13；app-shell 221 通过、1 失败、30 跳过，详见 P0-05 |
| `f8c1f181` | 挂载权限与旧句柄撤销 | 294；30 项跳过 |
| `c0fd1568` | 数据库失败保留与定向关闭 | 271；30 项跳过 |
| `f814d609` | 桌面 IPC 计量与动作边界 | 188；30 项跳过；另有真实 Vite 开关构建探针 |
| `6922e7da` | 调度扫描复用与空闲读取 | 643；30 项跳过 |
| `66dcf24c` | 跨宿主并发保存与编辑器重试 | 121（含 Rust） |
| `6af6e452` | 批量类型检查、链接拒绝与跨进程恢复 | 611（含 Rust） |
| `fb059403` | 资源 authority 事务隔离 | 771 |
| `bfe3cbf4` | 缓存与已确认消息保留 | 759 |

各批类型/文档检查和测试边界可从对应 Git 提交及[验收记录](minimal-system-acceptance.md)查阅。原始日志在临时目录，长期复核应使用对应提交的测试与命令重新执行。真实窗口的历史数据不能证明这些提交后的性能。

从仓库根目录执行，按改动先跑相关包；最终验收不能省略完整矩阵与实机步骤：

```bash
pnpm typecheck
pnpm docs:check
pnpm styles:check
pnpm build:libs
pnpm --filter @itookit/cli build
pnpm --filter tauri-app build
cargo test --offline --manifest-path apps/tauri-app/src-tauri/Cargo.toml
pnpm -r --filter '!@itookit/cli' test
pnpm --filter @itookit/cli exec vitest run --exclude tests/crash-matrix.test.ts
pnpm --filter @itookit/cli exec vitest run tests/crash-matrix.test.ts
cargo build --offline --features tauri/custom-protocol --manifest-path apps/tauri-app/src-tauri/Cargo.toml
```

统一入口：`pnpm test`（别名 `pnpm test:matrix`）先执行调度器回归，再按 workspace 顺序运行包测试、CLI 非崩溃测试、独立 CLI crash-matrix 和 Rust 边界测试。任一阶段失败立即停止；从任意目录直接执行脚本也固定使用仓库根目录。llm-tasks 默认 test 不进入 watch，编辑器已有测试纳入入口。

覆盖边界：包测试沿用各自 Vitest 配置及既有跳过；无测试文件的包不自动获得行为验收。测试入口不执行类型、样式、构建或真实 GUI，这些仍按 P0-05 单独验证。Session 删除测试等待已持久的 waiting 状态后再检查活任务删除屏障，避免把异步调度时机误当功能失败。

后端/网络/GUI 操作受环境限制时通过正常权限机制重试，不能把未执行当通过。保护已有工作树修改，不擅自回滚或提交；无明确授权不启动子代理。Xvfb 已用于真实窗口验收，AT-SPI 需要可写缓存与显示会话；临时探针入口、前端和原生二进制均需恢复为正常版本。`/tmp` 日志会消失，长期证据以测试源文件与可复现验收记录为准。

## 5. 文档维护规则

- 本文保留当前任务状态，每项只写“已实现 / 剩余 / 证据”，不追加逐轮流水账。
- 详细实验步骤、数据根、截图、命令和结果放入[验收记录](minimal-system-acceptance.md)，设计决策更新对应活文档。
- 已完成行若仍含有效未完成要求，应拆开或取消总项勾选；不能通过删掉要求来闭合任务。
- 逐轮进度快照已从文档树移除，需要时查阅 Git 历史；历史计数、旧工作树和已被取代结论不作为当前完成证明。

- 数字分身：邮件默认扫描，文档/目录/本地及远程会话“数字分析”菜单、首次加入后台立即扫描、类型选择与证据对话框、移除派生知识及再次加入、模型与姓名/别名配置、实际提取提示词展示已接入；真实 DeepSeek API 已在独立内存存储的完整 Kernel 链中完成提取、严格校验、提交及清理；正式浏览器界面和远程 harness 来源仍需验收。

- 初始文件恢复：设置 → 文件系统/系统恢复提供折叠、默认全选的文件清单，支持 demo.md 与两份作文 Flow 的选择性恢复；只补缺失、保留修改、逐文件反馈，写入当前宿主文件系统。

2026-10-20 增量：通用 image.process Tool、浏览器/Node 配方引擎、原图与派生资产、单图回执恢复及发送时解析已接通；Flow 源码检查 API、编辑器诊断和 CLI validate 同步落地。验证入口及当前资产保留策略见 [图片处理](design/flow-image-processing.md) 和 [Flow API](llm-flow-api.md#用户定义-flow-的源码检查)。
