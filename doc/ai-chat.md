# Markdown 聊天输入

Markdown 文件使用独立行 `::@`，在预览模式显示 Agent/Flow 选择、提示词输入框、附件和发送按钮。例如：

```markdown
::@ 请分析这些附件
```

保存后切换到预览；编辑模式显示原始 Markdown。代码围栏和普通行内文字不触发输入框。Web/HTTPS 与桌面宿主共用此入口。

## 当前主流程

1. 选择已发布的 Agent 或 Flow，输入提示词并按需添加附件。
2. 提交时先保存文档。宿主使用本次操作的稳定 ID 创建独立 Session 及 `chat-<operationId>` branch；来源项目由文件宿主明确绑定。
3. 普通 Agent 附件复用 Session 附件上传；Flow/Flow Agent 复用已有发布版本、参数表单和连接槽位准备。
4. 宿主通过既有 Session 持久队列接纳请求；确认接纳后导航到新 branch。
5. 新 branch 使用普通 user/LLM 排版，可继续聊天、添加附件、处理审批和停止执行。

当前回复显示在普通会话页面。`::>` 折叠结果以及回复内嵌文档暂缓。新 branch 不自动继承其他已打开会话的历史；原 Markdown 文件保留输入标记。

## 提交与诊断

同一草稿及其失败重试使用相同 operationId、Session ID 和 branch 名。准备完成后的请求被冻结；网络返回不明时核对原请求回执，重试不创建另一个 branch。已接纳后导航失败，再次提交先查询原回执并重新打开原 branch。

文件附件支持本地 File 和宿主资源引用。宿主引用必须从该文档获授权的资产端口读取，不能作为服务器文件路径或任意 URL。上传与执行由宿主负责，mdxeditor 不持有 Session 或后台执行。

前端日志通道为 `document-chat`、`session-chat-assets`、`session-chat-editor`，后端为 `session-draft`、`session-submission`。日志记录 operationId、阶段、结果、错误码、数量/大小和耗时，不输出提示词、文件正文、完整参数或凭据。

## 实现入口

- `ui/app-shell/src/browser/document-chat.ts`：文档插件启用、来源绑定、附件读取、原请求核对和导航。
- `backend/app-core/src/session/create-session-draft.ts`：稳定草稿身份和 branch 初始化。
- `backend/app-core/src/session/submit-session.ts`：使用宿主会话上下文提交，不重绑其他编辑器。
- `ui/llm-ui-adapter/src/independent/session-submission.ts`：复用已发布 Flow 表单与 Session 附件准备。
- `ui/llm-ui-adapter/src/shell/IndependentSessionEditor.ts`：正式会话 ChatView、分支草稿、队列和控制。
- `libraries/mdxeditor/doc/ai-chat.md`：独立 AiChatPlugin 契约。

本轮按用户要求未增加独立测试或浏览器验收；发布只完成必要构建和服务就绪确认。首次项目草稿及旧 handoff 仍保留兼容入口，旧渲染器清理不阻塞当前主流程，不能据此宣称整个独立 UI 迁移或功能合入计划已经清零。
