# Slash Command

`/tool` 打开统一工具/MCP 选择器及 Schema 参数表单，`/tool <id> <JSON>` 直接提交显式参数；`/mcp` 使用同一入口，仅显示已配置 MCP 工具。目录使用安全缓存元数据，实际调用前重新准备并校验工具及版本；空目录需先在 MCP 设置中连接/发现服务。工具命令提交 `kernel-adapters.tool` 持久 Task，默认请求审批，失败保留输入。精确请求在派发前保存到既有操作台账，回执未知及刷新后的显式重试复用 requestId；已启动或终态 Task 不再绑定能力或启动。终态结果经任务附着展示，也进入 Flow 参数来源的「已完成流程或工具的结果」；来源选择只读取结果，不重复执行工具。新方法通过应用端口与 RPC 显式暴露，UI 不直接调用 ToolService。

工作台原生会话也提供宿主命令 `/branch [name]`（从末尾创建并切换分支）与 `/branches`（打开分支列表）。它们不调用 harness.command，不作为普通消息提交，不自动运行模型。失败保留命令输入；成功仅清理仍匹配的命令草稿。用户提问下的分支图标表达从该轮之后继续；仅支持末尾分叉的执行器在选择旧轮次时要求明确确认。原生是否支持分叉由 forkSupport/canFork 决定，不直接透传终端导航命令。

`/flow` 打开 Flow 选择器；`/flow <id> [JSON 参数]` 预填参数表单并创建独立持久调用。多次调用在当前会话显示独立卡片，普通聊天模式保持可用。Flow 后台运行不会禁用输入；普通聊天生成期间也可通过 slash 发起 Flow。卡片分别处理输入/审批、取消、恢复、固定版本重跑和结果引用。多个调用存在时，通用任务控制命令提示使用对应卡片。详见 [Flow 调用与组合](../../../doc/design/flow-invocation-composition.md)。

```text
ChatInputView
→ SlashCommandPlugin.onBeforeSend
→ buildSlashCallbacks（SlashCommandRouter）
→ IPrivilegedCommandService（仅特权命令）
→ app-core PrivilegedCommandService
→ llm-flow submitRun（CompiledRunDefinition）
→ Kernel SessionHandle.submit → TaskHandle
```

`SlashCommandPlugin` 只负责解析和分发：`onBeforeSend` 命中静态命令或 `/sk-<skillId>` 时返回 `false`，阻止普通消息发送。普通会话修改走 `CommandBus`（`@itookit/llm-session`，`ICommandBus`）；特权命令经 `IPrivilegedCommandService` 提交或控制 Durable Task，不直接依赖具体 Program、Effect 或平台实现。

| 命令 | 行为 |
|---|---|
| `/plan <goal>` | 提交 `llm.plan@1`，计划在输入区的固定审批卡片中呈现（payload `{ plan }`），等待用户批准或拒绝 |
| `/exec <command>` | 提交 `kernel-adapters.exec@1`，approval 通过后才创建 `process.exec` Effect |
| `!<command>` | 与 `/exec` 共用直接执行通道，不发送 LLM；使用会话已有目录与执行授权，不改变对话模式。无执行能力或带附件时明确报错，不回退普通消息。stdout/stderr 与退出码显示在输入区的内联输出面板 |
| `/approve` | 响应当前附着 Task 最新的 pending approval |
| `/cancel` | 取消当前附着 Task |
| `/resume` | 启动尚未开始的 Task，或向等待 resume 的 Task 发送 Signal |

这些命令是控制面语法，与 `/sk-<skillId>` 的 Skill 调用是两条独立路径。命令文本只由 llm-ui 解析，Program 只接收结构化 input（`goal` / `command`）。当前附着 Task id 记录在 Session shared key `ui.privileged.active-task`，编辑器重载后会重新附着；Task 状态本身不在 UI 中复制。

待审批请求持续显示在 ChatInput 内，提供命令/计划详情、可选备注和「批准并继续 / 拒绝」按钮；简单人工输入请求提供回复框，带字段定义的 Flow 请求继续使用参数表单。提交时核验 attachment revision、interaction id、pending 状态和 Task 非终态；失败保留备注并在卡片内显示错误。切换任务、请求已解决或任务结束时移除卡片，重新打开会话从 Kernel 重放尚待处理的请求。普通聊天草稿独立保留，`/approve [备注]` 仍可使用。

桌面验证：发送 `/exec printf 'APPROVAL_TEST_OK\n'`，确认卡片保持可见，批准前命令不执行；批准后继续执行，拒绝则不执行。批准后的 stdout/退出码由 `handleRunEvent` 经 `readDirectCommandOutcome` 读取 `task.exit` 并渲染到 `ChatInputView.showToolOutput`（内联面板，不回写会话历史）；失败显示失败原因（如无执行后端时的 `chatInput.command.unavailable`），取消显示 `chatInput.command.cancelled`。回归覆盖见 `ui/app-shell/tests/input-interaction.test.ts`、`ui/app-shell/tests/input-approval-exec.test.ts` 和 `ui/app-shell/tests/direct-command-output.test.ts`。

关键文件：

| 职责 | 文件 |
| --- | --- |
| 解析与命令定义 | `src/components/input/plugins/SlashCommandPlugin.ts` |
| Shell 回调 | `src/shell/SlashCommandRouter.ts` |
| 消息发送 | `src/commands/SendMessageCommand.ts` |
| 编辑器装配 | `src/shell/LLMWorkspaceEditor.ts` |
| Task 控制适配 | `src/shell/RunAttachmentController.ts` |
| 固定审批与回复卡片 | `src/components/input/InteractionPanel.ts` |
| 特权命令抽象端口 | `src/domain/ports/IPrivilegedCommandService.ts` |
