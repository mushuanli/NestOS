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

离线 `.flow` 的组合定义通过 siblingFlowResolver 从入口同目录读取 `<flowId>.flow`，校验安全 ID、实际身份与显式 revision。编译图保存到 RunDefinition，恢复不重新解析最新子定义；不静态依赖任何业务 Flow。

Session 根调用使用 session.targets.list、session.submit 与 session.submission.inspect；--agent/--flow 互斥，prepare/submit/receipt 沿用原冻结文件与身份。文件以 wx/0600 写入并同步后才派发；核对不打开会话视图、不自动重放。等待以本次 Submission 的 Round/Task 和持久成员为准，队列暂停或结果未知明确返回，不借全局完成/审批事件判断本次结束。conversation query/reconcile-query 使用独立查询端口，不先加载原生历史。原生 context 选择见下文，严格 continue 仍未开放。


CLI 上下文入口已接宿主：session contexts 在打开 Session view 前只读查询安全 binding/检查点摘要，--cursor 原样传递目录游标，--branch 仅过滤。--context 文件经公共 ConversationSelection 校验，随 prepare/send 的 Submission 冻结；submit/receipt 不接受该覆盖，也不重读选择文件。目录只证明观察事实，真正派发仍复验能力和 binding 修订；严格 continue 未开放。查询诊断区分本地校验与宿主读取，不记录游标、文件内容或远端错误正文。


独立调用使用 session call-prepare/call-submit/call-receipt，共用已发布目标解析、大小限制与独占同步写文件。冻结文件同时保存原 request、title 和可选 transfer；恢复禁止覆盖，不重读参数或材料引用文件。call-receipt 只调用 session.call.inspect，不打开视图。call-submit 在本地默认观察子执行，--connect 默认只返回接纳，--follow 才在 CLI 自身作用域打开子 Session 继续观察；子交互和退出状态复用 watchSubmissionExecution，不按父会话状态判断。CLI 本地进程退出不承诺后台执行，后台工作使用持久远程宿主。
