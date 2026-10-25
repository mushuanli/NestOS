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

Session 根调用使用 session.targets.list、session.submit 与 session.submission.inspect；--agent/--flow 互斥，prepare/submit/receipt 沿用原冻结文件与身份。文件以 wx/0600 写入并同步后才派发；核对不打开会话视图、不自动重放。等待以本次 Submission 的 Round/Task 和持久成员为准，队列暂停或结果未知明确返回，不借全局完成/审批事件判断本次结束。conversation query/reconcile-query 使用独立查询端口，不先加载原生历史。原生 context 选择仍未在本批 CLI 开放。
