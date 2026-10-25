# DSH 原生会话与命令队列验收：2026-10-26

本记录区分运行端事实、发现的故障、修复证据和待部署范围。原故障会话未发送测试消息；真实发送使用新建验收 Session。没有用原生 idle 或回复正文代替 turn 的完成确认。

## 运行端核对

通过客户端证书访问原服务，GET /api/health 返回 ready=true、mode=release、version=20261025T224517-fe9ff3c7-dirty；运行日志最新 Version 与之相同。该版本包含主仓已合入代码，不能据此推断 node 已更新。

原 URL 对应 x1 项目 f876a57c-bb4f-44af-ad81-f897b87f54d0，DSH Session 为 session-b5e3139e-77c9-49fc-8971-180e624854b3。共享应用端口观察：active=false、pending=false、canSend=true、canQueue=true、无人工请求、online、stale=false。命令目录成功返回 session:models、status、session:status，均为 query，没有此前 EBUSY。独立 session:status 查询的原 operationId 回执可读，pendingQueryReports=0。

真实 Chromium 通过原 URL 打开页面，HTTP 200；输入框可编辑，草稿为空，没有提交状态待确认条，也没有页面脚本错误。这证明当前重开页面与后端状态正常，不证明用户原浏览器进程的旧内存状态，也不证明后续发送完成。

## 队列与真实发送

新建验收 Session pi-3db2b25a34fa51114d6182058a4c77493bc0a06318597d21ef6841a3ce7d3330。暂停、两次接纳、正文编辑、旧 revision 冲突拒绝、排序、合并、删除、关闭重开保留暂停状态、空队列恢复均通过；此阶段没有执行原生 prompt，messages=0。

随后在暂停状态接纳两条仅要求回复标记、不调用工具或修改文件的消息，恢复队列。第一条 operationId 为 verify-turn-a-0383c44f-6fc2-4288-a6ad-e7647d87ce03，第二条为 verify-turn-b-96aca656-46dd-4b2a-9510-c4f2b0d1b4e5。

第一条已经收到含预期标记的 completed 助手消息，原生 rawStatus=idle；宿主却仍保留 activeTurnId、execution=running，且 canInterrupt=false。90 秒观察内队列保持 dispatching/pending，未发送第二条。该组合明确记为失败，不能宣称队列端到端通过。已持久暂停验收队列并移除尚未发送的第二条，保留第一条待核对身份，未伪造完成或强行删除在途项。

## 根因与修复

实际 DSH 0.2 的 SessionEventMap 中，turn/start 与 turn/end 携带 turn；user/message 使用 UserMessage，只携带消息身份、内容和 source。mindos-node 原代码错误要求 user/message.data.turn 为数字，故无法把真实 requestId 与正在观察的 turn 关联；其测试替身也额外填入了不存在的 turn 字段，掩盖了故障。

新增真实消息形状的回归在旧代码失败：native_turn=None，预期为 Some(1)。修复在连续事件流内以匹配 requestId、原冻结内容与追加语义的用户消息，关联已经观察到的 turn/start；匹配 turn/end 后才发布 turn/completed。新的提交和已关闭 turn 会清除旧上下文，避免借用前一轮编号；缺少已确认上下文时继续保持未核对，不凭 idle 释放。

修复同时调整共享 DSH 测试替身，不再人为向用户消息添加 turn。node 版本提升到 0.4.1。格式检查、Rust 全量测试 386 通过、2 个显式忽略，以及离线 release 构建通过；这是更新源码和本地产物证据，不是运行端已修复的证据。

## 运行更新与后续验收

实际原生端点为 http://127.0.0.1:8787，监听进程使用 tools/svr。此文件不由 httpd 的 release 更新。修复产物位于 tools/mindos-node/target/release/mindos-node，版本 0.4.1，SHA-256 为 6c2092fbf51efb341e2e283992609985630cca136cd24b0c84b64e8e8876bc1b。

尚未替换或重启 tools/svr。后续更新需保留原配置与凭据，核对其他原生工作和未确认控制；正常关闭原进程后切换已验证二进制，再验证两个新 turn 顺序完成、队列排空、发送能力恢复、独立查询和精确取消，以及旧待核对验收项的恢复。更新 httpd、清空 UI 状态或删除 journal 均不能替代这一验收。
