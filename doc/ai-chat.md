# Markdown 聊天输入

Markdown 文件使用独立行 `::@`，在预览模式显示 Agent/Flow 选择、提示词输入框、附件和发送按钮。例如：

```markdown
::@ 请分析这些附件
```

保存后切换到预览；编辑模式显示原始 Markdown。代码围栏和普通行内文字不触发输入框。Web/HTTPS 与桌面宿主共用此入口。

## 界面兼容

默认会话恢复原有 LLMWorkspaceEditor / RemoteConversationEditor，沿用 ChatInputView、MDxController、标题栏、右侧提问目录及消息操作。非必要配置继续收在设置内；独立 ChatView 保留为待完善的迁移入口，不作为按钮与移动布局尚未对齐时的产品默认。Session 消息的 AiChatPlugin 由原 MDxController 按持久消息锚点安装，保留附件、同 Session 分支与跳转。

## 当前主流程

1. 选择已发布的 Agent 或 Flow，输入提示词并按需添加附件。
2. 普通文件提交时先保存文档，以完整文件附件引用加本次提示词创建新 Session 和 `chat-<operationId>` branch。文件属于项目时沿用其项目；无归属文件进入默认个人项目。Session 消息中的输入框则在原 Session 内分支，沿用原项目。
3. 普通 Agent 附件复用 Session 附件上传；Flow/Flow Agent 复用已有发布版本、参数表单和连接槽位准备。
4. 宿主通过既有 Session 持久队列接纳请求；确认接纳后导航到新 branch。
5. 新 branch 使用普通 user/LLM 排版，可继续聊天、添加附件、处理审批和停止执行。

当前回复显示在普通会话页面。`::>` 折叠结果以及回复内嵌文档暂缓。普通文件不继承其他会话历史，原文件保留输入标记。Session 内的输入框使用持久消息锚点：LLM 锚点保留至该回复；user 锚点保留此前历史，并将截至该条的原 user 输入及内嵌输入作为多条 user 消息提交。锚点后续 history 不进入新 branch。多条 user 输入在历史与模型上下文中保留独立边界。

完整文件直接引用目前采用 256 KiB 上限；超出时明确提示选段，不静默截断、不自动切换 Harness。按能力读取大文件的引用模式尚未接入。文档标题栏原有“引用到新 AI 会话”可用于发送选中片段。

Session 的 user/LLM 正文继续由 mdxeditor 渲染；可信宿主按消息和正文片段挂载 AiChatPlugin，返回或重开时从原 Markdown 标记恢复输入入口。输入框尚未发送的临时草稿仍只在插件实例中保存。

“查看产物”仅出现在对应 Flow 回复后，点击后才读取执行详情。普通聊天隐藏它。调用 Flow 的选择器默认“不调用”，只展示公开已发布 Flow 名称，内部 ID 不拼入标签；选择不会隐式发布草稿。

## 提交与诊断

同一草稿及其失败重试使用相同 operationId、Session ID 和 branch 名。准备完成后的请求被冻结；网络返回不明时核对原请求回执，重试不创建另一个 branch。已接纳后导航失败，再次提交先查询原回执并重新打开原 branch。

文件附件支持本地 File 和宿主资源引用。宿主引用必须从该文档获授权的资产端口读取，不能作为服务器文件路径或任意 URL。上传与执行由宿主负责，mdxeditor 不持有 Session 或后台执行。

前端日志通道为 `document-chat`、`session-chat-assets`、`session-chat-editor`，后端为 `session-draft`、`session-submission`。日志记录 operationId、阶段、结果、错误码、数量/大小和耗时，不输出提示词、文件正文、完整参数或凭据。

## 实现入口

- `ui/app-shell/src/browser/document-chat.ts`：文档插件启用、来源绑定、附件读取、原请求核对和导航。
- `backend/llm-session/src/session/branch-submission.ts`：消息锚点校验、历史截断及原 user 输入保留。
- `ui/llm-ui-adapter/src/independent/message-markdown.ts`：会话消息 MDx 插件接线。
- `backend/app-core/src/session/create-session-draft.ts`：稳定草稿身份和 branch 初始化。
- `backend/app-core/src/session/submit-session.ts`：使用宿主会话上下文提交，不重绑其他编辑器。
- `ui/llm-ui-adapter/src/independent/session-submission.ts`：复用已发布 Flow 表单与 Session 附件准备。
- `ui/llm-ui-adapter/src/shell/IndependentSessionEditor.ts`：正式会话 ChatView、分支草稿、队列和控制。
- `libraries/mdxeditor/doc/ai-chat.md`：独立 AiChatPlugin 契约。

本轮按用户要求未增加独立测试或浏览器验收；发布只完成必要构建和服务就绪确认。首次项目草稿及旧 handoff 仍保留兼容入口，旧渲染器清理不阻塞当前主流程，不能据此宣称整个独立 UI 迁移或功能合入计划已经清零。
