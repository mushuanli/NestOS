# Harness 工具、Skill、MCP 验证例子

这四个 `.flow` 使用 `builtin.agent` 执行 Harness 工具循环，可以从 `/flow` 或 CLI 运行。它们验证 **Flow 内的 Harness 调用能力**，不包含“模型主动调用另一个 Flow”的工具。

| Flow ID | 执行步骤 | 核对证据 |
| --- | --- | --- |
| `harness-tools` | Grep 搜索 → Read 读取 | 返回 `HARNESS_CHECK` 所在行，以及负责人 Lin |
| `harness-skill` | 显式加载 `validation-review` → Read → 按规则回复 | 模型请求含 Skill 指令；结果同时含 `HARNESS_SKILL_READY` 和文件内容 |
| `harness-mcp` | 发现本地 MCP → 请求批准 → lookup | 批准前无调用日志；批准后产生 `MCP_VALIDATION_OK` 和真实调用记录 |
| `harness-combined` | Read → MCP lookup → 按 Skill 审查 → transform 汇总 | 两个 marker、文件证据、topic 和下游返回值均保留 |

此处 Skill 是 NestOS 的提示词 Skill：通过节点 `skillIds` 显式加载，不是一个单独运行的 Task。文件权限由 `toolIds` 声明，MCP 能力由 `mcpProfileIds` 解析。所有例子均未授权 Write、Edit 或 Bash。

## 自动验证

从仓库根目录执行：

```bash
pnpm --filter @itookit/cli test tests/harness-validation-examples.test.ts
```

测试在独立临时 profile 中运行这些文件，使用可控模型响应驱动真实 Harness、Grep/Read、Skill 装配、MCP SDK 和本地 stdio 子进程。MCP 服务是仓库当前协议版本的本地 fixture，不访问外部系统。测试不调用付费模型；因此证明执行链路、审批、返回值和持久化，不证明某个真实模型一定会正确选择工具。

另外覆盖拒绝 MCP 审批（不产生调用）、模型越权请求 Write（`TOOL_NOT_ALLOWED` 且无文件落盘）。测试会清理自己的临时目录。

本次验证：六个示例/边界测试，加上 Flow CLI 与运行控制回归，共 11 项通过。MCP 子进程受当前执行沙箱限制，相关测试在沙箱外重跑通过。没有执行真实模型或人工 GUI 验收。验证过程中同时修复了 CLI 草稿读取遗漏 `outputs`、以及根任务结束后终态节点投影可能仍使用上一拍快照的问题。

## 准备供手工验证的 profile

需要 Node.js 22.13+。从仓库根目录运行，目标目录必须尚不存在：

```bash
node apps/cli/examples/harness-validation/prepare.mjs /tmp/nestos-harness-validation
pnpm --filter @itookit/cli build
```

脚本创建：

```text
/tmp/nestos-harness-validation/
  profile/home/admin/flows/       四个可编辑定义
  profile/etc/llm/.skills/        validation-review.yaml
  profile/etc/llm/.mcp/           validation.json，绝对路径指向本地 fixture
  workspace/notes.txt            文件工具读取的真实文件
  mcp-server.mjs                 本地验证服务器
  mcp-calls.jsonl                首次真正调用后才生成
```

脚本不复制个人配置，也不生成模型密钥。手工使用前需在这个 profile 配置可用的 Provider/Connection。例子默认 `connectionId: "default"`；若实际连接 ID 不同，请修改生成的四个 `.flow` 的对应字段。准备脚本拒绝覆盖已有目录。

stdio MCP 适用于 CLI/Tauri；纯浏览器宿主不能启动这个本地进程。MCP 配置页测试连接应发现 `lookup(topic)`。fixture 的协议版本固定为仓库使用的 `2026-07-28`，不是通用旧协议服务器。

## 聊天界面验证

使用该 profile 打开应用；在会话工作目录设置中授权并选择上面的 `workspace`。若使用 CLI HTTP 界面：

```bash
node apps/cli/dist/cli.js --profile /tmp/nestos-harness-validation/profile --http 127.0.0.1:18777
```

在设置中完成模型连接配置后，在同一聊天依次输入：

```text
/flow harness-tools {"keyword":"HARNESS_CHECK"}
/flow harness-skill {"file":"./notes.txt"}
/flow harness-mcp {"topic":"release"}
/flow harness-combined {"file":"./notes.txt","topic":"release"}
```

`/flow` 的 JSON 只预填参数。当前所有有参数的例子都会打开模态参数表单，提交后才启动；表单不是嵌在 ChatInput 内。文本/JSON 显示文本框，数字显示数字框，boolean 显示复选框，声明 select widget 的参数显示下拉框。优先级是命令 JSON → 参数默认值 → 用户填写。不会自动读取聊天正文、选中内容、附件或文件正文。这里 `file` 传递的是路径，文件内容由 Harness 的 Read 工具读取。

不带 ID 的 `/flow` 先选择定义；没有参数的 Flow 直接启动。参数校验失败保留表单，取消不启动。模型响应可能包含文件内容，返回字段是该节点的实际最终结果。

可同时启动两个不同 topic 的 MCP 例子，核对两张卡片的审批目标。批准一个、拒绝另一个：日志应只有获批调用；当前聊天草稿和其他调用应保留。结果默认留在各自卡片，点击“用于对话”才进入聊天草稿。

## CLI 验证与证据

配置好连接后运行：

```bash
node apps/cli/dist/cli.js run \
  --profile /tmp/nestos-harness-validation/profile \
  --set-home /tmp/nestos-harness-validation/workspace \
  -f /tmp/nestos-harness-validation/profile/home/admin/flows/harness-combined.flow \
  --headless --json
```

CLI 使用参数默认值；自定义值通过 `--params /absolute/path/params.json` 传入 JSON 对象，不显示浏览器参数表单。

MCP 例子首次运行应退出码 3，状态 waiting。记录输出中的 Run ID 和 interaction ID：

```bash
node apps/cli/dist/cli.js respond <run-id> <interaction-id> --approve \
  --profile /tmp/nestos-harness-validation/profile --json
node apps/cli/dist/cli.js resume <run-id> \
  --profile /tmp/nestos-harness-validation/profile --json
```

拒绝分支将 `--approve` 改为 `--deny`。以 `profile/var/lib/cli-runs/runs/<run-id>/run.json`、`events.jsonl`、结果文件以及 `mcp-calls.jsonl` 为依据；不能仅凭模型说“我调用了工具”判定成功。`outputs` 会编译为持久的 `__flow_return` 节点；CLI 最终结果仍沿用所选末尾节点的 result。
