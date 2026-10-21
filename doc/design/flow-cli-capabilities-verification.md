# CLI Flow + Skill + tools 与 Session 持久化验证

当前源码状态（2026-10-21）：Agent 选择题与多 Session 状态总览已修复并验收，见文末实施章节；2000 端口仍为旧 release，未部署。前文按日期保留历史实测，不作为当前源码的缺陷清单。

核验日期：2026-09-16。使用当前工作树构建的 `apps/cli/dist/cli.js`，真实 DeepSeek 模型、本地 stdio MCP 服务；不是仅调用 CLI 内部函数。使用独立临时 profile，未修改用户日常配置。

## 结论

| 项目 | 实测结果 |
|---|---|
| Flow 派发隔离子 Task | 成功；初始消息只有 system/user |
| 加载 Skill 指令、快照及工具声明 | 成功；任务保存 `review` Skill 和 `lookup` 工具 |
| 模型调用 MCP 工具 | 成功；本地 MCP 服务收到一次 lookup 调用 |
| 等待批准、退出进程、批准、恢复 | 成功；run 退出码 3，respond/resume 均为 0 |
| 流式输出 | Kernel 保存 4 条 `stream:content` 事件 |
| 最终结果 | 成功；score=9，evidence=RUBRIC_FROM_MCP，skillMarker=SKILL_REVIEW_ACTIVE |
| Session 文件与执行记录 | 已创建；Kernel 保存消息、工具结果、批准记录、最终输出 |
| 新进程 status/export 读取 | 成功；导出检查与路由节点的 transcript |
| UI 所需的聊天 History | 已接通；保存参数、执行引用、交互身份与最终回复；旧 Run 补投影后 Round 数量为 1 |

工具的评分是验证服务的固定返回，用于证明工具结果经过模型进入最终 JSON，不代表作文质量验收。本次 maxRounds=1；此前作文多维评审的真实模型验证见 [作文 CLI 验证](essay-review-cli-verification.md)。

脱敏证据：[flow-skill-cli-evidence.json](fixtures/flow-skill-cli-evidence.json)。成功 Run/Session ID 为 `20260915235623-7c216fed`，三个 Kernel Task 均 succeeded；Agent 保存的消息角色为 `system, system, system, user, assistant, tool, assistant`，完成两次模型交互。83 条全局 Kernel 事件记录了执行过程。

## 独立 CLI 进程验证

构建后按以下顺序运行（参数、Skill 和 MCP Server 已在验证 profile 中配置）：

```bash
node apps/cli/dist/cli.js run -f /tmp/x1-flow-skill-cli-20260916/review.flow \
  --params /tmp/x1-flow-skill-cli-20260916/params.json \
  --profile /tmp/x1-flow-skill-cli-20260916/profile --headless --json

node apps/cli/dist/cli.js respond <run-id> <interaction-id> --approve \
  --profile /tmp/x1-flow-skill-cli-20260916/profile --json

node apps/cli/dist/cli.js resume <run-id> \
  --profile /tmp/x1-flow-skill-cli-20260916/profile --headless --json

node apps/cli/dist/cli.js export <run-id> \
  --profile /tmp/x1-flow-skill-cli-20260916/profile \
  --out /tmp/x1-flow-skill-cli-20260916/export.json --json
```

原始验证产物保留于 `/tmp/x1-flow-skill-cli-20260916/`。profile 含本机模型配置，不应直接提交或共享；仓库证据只保留白名单字段。

## 存储位置与实际内容

相对验证 profile：

```text
var/lib/sessions/<session-id>/
  session.seq                 Session 身份、设置及挂载
  history.seq                 聊天分支索引、Round、交互身份与最终回复
  kernel/events.seq           执行事件，包括流式增量与批准
  kernel/tasks/<task-id>/task.seq
                              Task 输入、消息状态、Effect、交互与输出

var/lib/cli-runs/runs/<run-id>/
  run.json                    CLI 运行状态、Task 映射、resultPath
  events.jsonl                CLI 事件副本
  result.json                 选定的最终结果
  artifacts/                  节点输出
```

本地 VFS 的 seq 文件是逻辑记录容器，记录由 `profile/_meta/index.db` 承载；不能仅按 seq 文件字节数判断是否保存，也不能只复制空的 seq 文件作为备份。本次同时通过 SessionRepository/Seq API 回归、新进程 CLI export，以及只读 SQLite 核对。

**History 缺口已修复**：CLI 通过共享 `FlowRunProjection` 在运行、等待和退出时调用 RoundLog，按根 Task ID 幂等保存 Round。跨进程 respond/resume/export 会恢复投影；已完成 Round 不重复追加。之前真实模型 Run 使用新版构建 CLI export 补回 1 个 completed Round，含节点、工具、批准请求、用户批准共 4 条交互，再次 export 保持单个 Round。

History 区分展示角色与执行身份：用户输入/批准为 user，节点回复为 assistant，工具显示工具名、调用 ID、所属节点及可确认的 Skill 来源。Skill 是能力来源，不虚构独立发言。身份随 Round 保存，分支切换和重新打开使用相同投影。路由、汇总、判断等内部逻辑继续隐藏。

## 本次修复与回归

首次实际运行暴露了构建产物独有的问题：MCP stdio 的 cross-spawn 在 ESM bundle 中调用 require，报 `Dynamic require of "child_process" is not supported`。已在 [CLI 构建配置](../../apps/cli/tsup.config.ts) 为 ESM chunk 注入 Node createRequire；修复后重新运行并跨进程恢复成功。

[集成回归](../../apps/cli/tests/flow-capabilities.test.ts) 增加构建 CLI 的独立进程场景，同时检查结果文件、工具成功事件、Session 身份、等待/完成 Round、节点和工具身份、Skill 来源、用户批准、Kernel 记录和重复 export 幂等性。三项回归均通过，CLI 类型检查与构建通过。

## 2026-10-21：未完成交互的终端重连接验证

使用源码 CLI 的独立 Node 进程、本地确定性模型 fixture、独立临时状态目录和真实 OS PTY 验证，无外部模型请求。此处验证应用持久交互的重新呈现，不代表任意外部 CLI 进程可以在其 PTY 宿主丢失后恢复。

| 检查 | 结果 |
| --- | --- |
| headless run 遇到输入问题 | 保存问题并以退出码 3 退出 |
| 错误 interactionId 回答 | 退出码 2；原问题保持未回答 |
| 未回答直接 headless resume | 仍以退出码 3 退出；问题、根 Task 和节点 Task 身份保留 |
| 交互式 resume | 真实终端重新显示原问题、选项和输入提示 |
| 提示显示后 SIGKILL，再启动新的交互式 resume | 同一问题再次显示；不重新请求模型生成问题 |
| 输入答案后继续 | 原 Task 成功完成；pendingInteractions 清空 |
| 检查事件及模型调用次数 | requested / resolved 各一次；模型总请求两次 |
| 完成后再次 resume | 退出码 0；不重新打开问题或调用模型 |

首次运行暴露收尾错误：CLI 已经 dispose kernel，FlowRunProjection 同步历史仍调用 openSession，导致原本等待退出的命令报 DISPOSED。现改用 inspectSession 冷读取；历史投影不登记 worker，也不启动调度。

[HITL 回归](../../apps/cli/tests/hitl.test.ts) 增加未回答重连检查，覆盖单节点、下游节点、独立 CLI 进程和连续提问，并断言问题事件不重复。

本轮 9 项真实 CLI / PTY 检查全部通过；HITL 4 项、历史投影 6 项、CLI Flow 能力与运行集成 20 项回归全部通过。CLI 和 llm-session 类型检查通过，活文档检查通过（保留 7 条既有告警）。

```bash
pnpm --filter @itookit/cli exec vitest run tests/hitl.test.ts --fileParallelism=false
pnpm --filter @itookit/llm-session exec vitest run __tests__/flow-history.test.ts
```

当前重显示由 CLI resume 和既有待回答记录驱动；尚无通用设备 attach / wake / refresh 协议。若增加此协议，应由宿主在设备接入时通知，设备读取权威 snapshot 并从 asOfSequence 继续观察。刷新可以重复或合并，不能重新登记同一问题；已回答的问题以持久状态为准关闭。设备离线不等于取消 Task，onChanged 也不能单独承担断线期间的可靠投递。

## 2026-10-21：实际 httpd 前端交互验证（修复前版本）

通过已登记的客户端证书访问实际运行的 `https://127.0.0.1:2000`。测试前后认证 health 均返回 release `20261021T091359-c33a7c2f-dirty`；没有替换静态资源、重启服务或修改模型配置。使用专用测试 Session，经公开 HTTP 能力提交宿主已注册的 flow.input、flow.human 和 approved-effect Program，以确定性输入验证真实持久交互、RPC、SSE 和浏览器 DOM；未调用外部模型，也未拦截或伪造浏览器 API 响应。

| 检查 | 结果 |
| --- | --- |
| fields/select 结构化输入 | 模态表单显示正确，选择项与说明字段可操作 |
| 空值提交 | 显示校验错误，表单保持打开 |
| 刷新页面 | 同一未回答问题恢复，只显示一个表单 |
| 取消展示、切换到笔记再返回 | 未回答表单重新显示，Task 未取消 |
| 手机 390 × 844 | 表单边界在视口内，无横向溢出 |
| 两个浏览器视图 | 同时恢复同一问题；一端回答后，另一端通过 SSE 收起表单 |
| 回答后核对后端 | 原 Task succeeded，interaction resolved，保存选择与说明，pendingInputs 为 0 |
| 完成后刷新 | 不重新显示已回答表单 |
| 普通 input + 顶层 options 字符串数组 | 内联卡片和选项按钮正确；刷新可恢复，提交后成功 |
| approval | 备注、批准、拒绝按钮正确；刷新可恢复；拒绝后 APPROVAL_DENIED，未登记或执行 Effect |
| Agent questions[].options[] 结构 | 问题和 JSON 详情可恢复、可手动回答，但没有呈现选项按钮；此项展示适配不完整 |

结构化表单的 10 项浏览器检查通过，未观察到浏览器异常或失败 HTTP 响应。补充三类卡片验证确认了上述 questions 格式缺口，不能据此宣称所有 Agent 选择题均已正确呈现。该补充使用与 Agent 相同的 payload 结构，不代表验证了真实模型提问的完整 Agent Loop。

缺口位于 [inputInteraction](../../ui/llm-ui-adapter/src/shell/input-interaction.ts)：该发布版本只从顶层 options 提取字符串，将 questions 序列化为详情。与 [Agent 交互生成](../../backend/llm-tasks/src/durable/agent-program.ts) 产生的嵌套 question/options 格式未对齐。下面记录工作树中的修复与验证。

## 2026-10-21：Agent 选择题呈现修复

[问题适配](../../ui/llm-ui-adapter/src/components/input/agent-questions.ts) 将嵌套 questions 投影为通用 InputField，[InteractionPanel](../../ui/llm-ui-adapter/src/components/input/InteractionPanel.ts) 复用独立 llm-ui 的 InteractionCard。单题、多题、单选、多选、选项说明和自填答案均使用同一套控件；Flow InvocationPanel 也使用相同投影。所有题目都有效后才允许提交。无效或不完整的协议记录保留原有可读文本回退，不静默丢掉其中某题。

兼容原有字符串回应契约：提交值为 JSON 字符串，例如 `{"answers":{"下一步？":"继续","需要哪些能力？":"[\"读取\",\"写入\"]"}}`。每个答案仍为字符串，多选使用 JSON 数组字符串保存边界，重复问题文案用题号区分。Agent 继续把该字符串放入工具回应，不会出现 `[object Object]`；普通文本输入与审批回应保持原契约。

验证使用新构建的完整 httpd UI 和当前 2000 端口真实 mTLS 后端。测试浏览器仅替换静态 HTML/JS/CSS 为新构建，所有 API、SSE 和存储均使用实际服务，没有伪造 API 结果；实际运行的 release 仍为上文记录的旧版本，不能把此次验证描述为已部署。

9 项浏览器检查通过：问题与说明展示、全部必答校验、原 Task 刷新恢复、手机内部滚动、断网失败保留选择、联网不自动重发、手动提交后的全部答案持久化和两端 SSE 收起、完成后不重开，以及单题自填答案；未观察到未捕获浏览器异常。后端核对了单题/多题的成功终态和每项答案。

适配包 123 项测试与相关 app-shell 23 项 DOM/真实 Kernel 回归通过，其中新增 10 项协议投影和 6 项 DOM 回归。适配包及 app-shell 类型检查、httpd UI 生产构建、架构检查和样式检查通过。修复没有新增轮询或改变 kernel 的持久等待机制。

## 2026-10-21：多 Session 侧栏状态审查（修复前历史证据）

本节记录旧 release 的修复前行为；当前源码实现见下一节。

在同一实际 httpd 上创建两个专用测试场景：一个 Session 的 Task 等待 approval，另一个 Session 的 Task 等待 input。两者均保存 task.status=waiting、wait.type=interaction 和 pending 的交互种类；分别打开对应会话时，正文交互卡片显示正确。两次浏览器视图均找到了两个侧栏 Session 行，但两行的 waiting indicator 均为 false，未显示待确认或待输入；检查完成后取消了测试等待任务。

Kernel Session 的 phase=open 是生命周期状态，不能解释为其中任务没有等待。ConversationManifest 与 SessionSummary 也尚无聚合执行状态字段；聊天历史 Round 的 waiting 状态不代表该 Session 下所有 Task 的状态。

[SessionWorkbench](../../ui/app-shell/src/projects/SessionWorkbench.ts) 有内存 waiting 集合，[HITL bridge](../../ui/app-shell/src/workspaces/hitl-bridge.ts) 依赖 session_hitl_active / session_hitl_resolved 实时事件，但不加载已持久化的待办基线；当前会话执行实现也没有发出这两个事件。[Session 导航行](../../backend/app-core/src/session/session-browser.ts) 只投影组织和显示信息，未聚合本地 Task 状态。远程原生会话另有 observation/status 链路，不能视为本地 Session 已具备同样能力。

旧 release 的侧栏无法可靠显示多个本地 Session 的待办。此缺口已由下节的持久活动投影和状态通知修复：数量从权威索引重建、单个回答保留其他待办、内容流不扫描导航。该历史复现不再作为当前源码的未完成项。

## 2026-10-21：多 Session 状态汇总实施与验收

上节审查发现的本地侧栏缺口已在当前源码修复。Kernel 新增 sessionActivity 冷查询：Task 与无正文的活动投影同事务提交，分别累计待确认、待输入、运行、排队、暂停和等待停止确认。应用后端只查询最终可见的本地 Session 行，8 路有界并发、最多 256 条视图缓存；结构变化只失效对应 Session，内容流不触发全树重读，显式刷新清理活动缓存。远程 Harness 的状态投影继续走原链路。

SessionWorkbench 的侧栏 subtitle 与目录描述共享本地状态格式，橙色提示由持久待办数量派生。回答一个审批不会清除其他审批或输入；完成/取消后按当前数量清理指示；读取失败显示可重试的未知状态，安全日志只含操作、阶段、Session 身份、耗时和错误分类。没有加载聊天历史来计算状态。

在临时数据根启动新源码 httpd，加载新生产 UI，使用真实 mTLS HTTP、公开应用端口、SQLite 存储及 SSE；API 与静态资源均未模拟。两个浏览器视图验证 7 项：两个 Session 的多个待办、刷新重建、回答一个审批后保留其他待办及跨端同步、仅清除已完成 Session 的提示、前端选择回答原 Task、deferred / Session pause-resume / Task start 状态、无浏览器异常。测试后释放临时 host；现有 2000 端口 release 未替换或重启。

新增恢复并发回归发现并修正：目录枚举后 Task 可能完成或新增，在线恢复必须在索引/等待图修复事务内按 Task version 复核，只重读发生变化的 Task，不能用旧枚举覆盖最新投影。正常完整索引恢复仍只批读一次 Task 正文。

独立库进一步使用常见 Harness 组合验证同 Session 并行 Task、跨 Session 请求/回复、Session 与 Task 独立控制、模型→审批→工具→模型的重建恢复、文件回调、关闭与定时；另以两个真实 OS 进程验证团队请求/回复及 SIGKILL 后多菜单恢复。证据与限制见[独立库 Harness 场景验证](../../libraries/durable-kernel/docs/harness-scenarios.md)。

最终验收：独立 checkout 的 401 项库测试（349 项单元/契约、52 项真实进程）、类型检查、构建及仓库外 tarball 消费通过；应用后端 700 项回归通过，侧栏/交互相关前端 20 项回归通过。全量应用测试首次高并发运行有一项 IndexedDB 压测超时，单独重跑及限制 2 个 worker 后全套通过，没有放宽超时或修改该测试。架构、样式与活文档检查通过，文档检查保留既有 7 条历史告警。

当前格式下摘要查询不读 Task 正文。旧格式没有活动索引，不能从“Task 已终态”推断外部清理已经完成，因此首次冷读会批量读取缺少投影的记录，包含终态；后台恢复补齐后按轻量索引读取。这一兼容路径保留正确的清理责任，不把性能优化建立在停止确认假设上。

独立库已推送提交 [f31e4a2](https://github.com/mushuanli/durable-kernel/commit/f31e4a2b69736a26fe88fe908f09a8b213fcc241)，[GitHub CI](https://github.com/mushuanli/durable-kernel/actions/runs/39605690642) 的安装、类型、401 项测试、构建与独立包消费全部通过。工作台集成位于当前 x1 工作树，未包含进独立库仓库，也未部署到现有服务。
