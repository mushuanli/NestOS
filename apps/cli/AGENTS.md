# @itookit/cli

CLI 是应用表示层和 Node 入口；本地/远程传输选择属于宿主。

- 应用命令默认本地单进程，openNodeApplication + openApplicationView，不监听 HTTP。只有显式 --connect 才使用共享 HTTP 客户端，失败不得回退本地。
- application-command 只消费 ApplicationClient；权限、项目、会话发送/恢复、回执和分支规则由后端端口执行。
- conversation send 复用 llm-ui 的 ProjectConversationPort，不实现第二套原生协议，不重发结果未知的命令。
- -d/--http 委托 node-host/http；禁止重建 Tauri invoke、SQL 或原始存储桥。
- 应用命令 stdout 为 JSON/JSONL，启动进度及诊断走 stderr；cli-local、cli-remote、httpd-cli 使用不同日志名，不记录 prompt/凭据。
- 旧 YAML/RunDefinition 离线执行入口保留独立 RunStore；不能将 run-id 与应用 session-id 混用，不隐式支持 --connect。
- 真实诊断发送、interrupt、取消等具有副作用；测试使用临时 profile 和确定性 fixture，禁止试发用户真实消息。
- CLI 全套回归按 scripts/test-all.mjs 串行，crash-matrix 单独隔离。

Session 根调用通过 session.targets.list 和 session.submit 共用 UI 的 TargetRef、输入来源、签名、冻结计划与队列；--agent/--flow 互斥，不为 Flow 创建包装 Agent。--params 提供 JSON 对象，位置文字始终是 composer.text，不按内容猜测 JSON。prepare 只保存调用请求，默认值仍在后端接纳时展开；--submission-file 用 wx/0600 独占创建，并同步文件与父目录后才派发，失败或旧文件存在均不发送。

session submit/receipt 读取原冻结文件，不接受重新指定目标、参数、分支或输出文件。submit 是用户明确的新提交动作，不自动重放；丢回执使用 receipt。receipt 走 session.submission.inspect，必须保留 expectedSessionId 和 submission，不能通过打开/激活视图来核对。查询只读既有队列与历史，不创建 Kernel Session、不改变其他视图绑定。正常本地宿主启动恢复独立存在，不把此端口描述为关闭所有后台工作。

本地发送及 --follow 等待本次 Submission 的 Round 与真实执行引用；Session 全局完成或其他调用的审批只用于唤醒查询，不能作为本次结束证据。Flow 待交互按 RunGet.controlTaskIds 的持久成员判断，不按 Kernel rootTaskId 猜测节点归属；已暂停队列返回 waitingForDispatch，不冒充执行完成。原生 conversation 协议仍独立，通用资产、无人值守交互策略和 YAML/RunDefinition 根身份迁移尚未完成。

离线 `.flow` 的组合定义通过 siblingFlowResolver 从入口同目录读取 `<flowId>.flow`，校验安全 ID、实际身份与显式 revision。编译图保存到 RunDefinition，恢复不重新解析最新子定义；不静态依赖任何业务 Flow。

conversation query / reconcile-query 复用展示端口的 queryCommand / reconcileQuery，支持显式查询 ID，不先加载完整原生历史、不查询原生修改 receipt。日志仅保留安全关联 ID、阶段、结果和错误码，不记录查询正文或原生输出；旧节点缺少能力明确报错，不回落为普通 send。

session contexts 在打开 Session view 之前查询绑定/检查点目录，--cursor 只传原分页对象；--branch 过滤明确分支。session prepare/send 的 --context JSON 文件只表达 ConversationSelection，使用公共校验器并随原 Submission 冻结；submit/receipt 禁止附带该覆盖，不重新读取原选择文件。上下文选择不授予连接或原生写入能力，实际派发仍由宿主复验。

Session 根调用使用 session.targets.list、session.submit 与 session.submission.inspect；--agent/--flow 互斥，prepare/submit/receipt 沿用原冻结文件与身份。文件以 wx/0600 写入并同步后才派发；核对不打开会话视图、不自动重放。等待以本次 Submission 的 Round/Task 和持久成员为准，队列暂停或结果未知明确返回，不借全局完成/审批事件判断本次结束。conversation query/reconcile-query 使用独立查询端口，不先加载原生历史。原生 context 选择见下文，严格 continue 仍未开放。


CLI 上下文入口已接宿主：session contexts 在打开 Session view 前只读查询安全 binding/检查点摘要，--cursor 原样传递目录游标，--branch 仅过滤。--context 文件经公共 ConversationSelection 校验，随 prepare/send 的 Submission 冻结；submit/receipt 不接受该覆盖，也不重读选择文件。目录只证明观察事实，真正派发仍复验能力和 binding 修订；严格 continue 未开放。查询诊断区分本地校验与宿主读取，不记录游标、文件内容或远端错误正文。


独立调用使用 session call-prepare/call-submit/call-receipt，共用已发布目标解析、大小限制与独占同步写文件。冻结文件同时保存原 request、title 和可选 transfer；恢复禁止覆盖，不重读参数或材料引用文件。call-receipt 只调用 session.call.inspect，不打开视图。call-submit 在本地默认观察子执行，--connect 默认只返回接纳，--follow 才在 CLI 自身作用域打开子 Session 继续观察；子交互和退出状态复用 watchSubmissionExecution，不按父会话状态判断。CLI 本地进程退出不承诺后台执行，后台工作使用持久远程宿主。
