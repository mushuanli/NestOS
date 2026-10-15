# Tool / Skill / MCP 配置与执行

## 授权来源

Agent 的 `capabilityPolicy` 位于定义顶层：

- `toolIds` 未设置：Harness 使用宿主可用的 `Read / Glob / Grep / Write / Edit / Bash`。显式 `[]` 不授予直接工具；普通 Chat 不因此获得工具。
- `skillIds` 加载指定 Skill 的指令及快照。直接 Harness 中，Skill 工具仍需进入 `toolIds`；输入面板加载 Skill 不自动扩大工具权限。Flow 的显式 Skill 引用按节点能力合并规则加入绑定工具。
- `mcpProfileIds` 是对服务器能力的显式授权，与直接工具白名单叠加。提交前执行真实能力发现，将工具与资源/Prompt 读取能力展开为固定 ID，写入 Task 的 `tools / allowedToolIds / externalToolIds`。在途 Task 不因后续勾选变更自动扩大权限。
- Agent 在每次实际工具分派前检查 Task 的显式白名单，包括审批恢复和同批次后续调用；未授权工具返回 `TOOL_NOT_ALLOWED`，不会执行。v2 宿主单独授予内置 context 检索/检查点工具，不扩大文件或 MCP 授权。没有白名单的历史 Task 保持旧执行契约。
- 旧 `config.mcpServers` 仅在缺少顶层策略时兼容读取；编辑器保存到顶层策略。

Agent 编辑器保留未展示字段、策略和嵌套配置，`.llm` 导入导出同样保留这些字段。模型策略和顶层系统指令存在时，表单展示并更新实际生效值。工具表单区分宿主默认、显式勾选与额外工具 ID；MCP 和 Skill 可单独选择。

llm-ui 的 Skill 面板分别显示指令加载状态和当前 Agent 声明的工具授权数量，提供配置入口。Flow 模式显示由节点配置管理，并导航到 Flow。授权数量不代替本轮工具审批，也不证明某个远程服务当前在线。

## MCP 宿主与协议

后端 LLM 驱动启动后异步连接已经填写 endpoint/command 的 MCP，`autoConnect` 缺省或 true 表示启用，显式 false 保留关闭；空草稿、宿主不支持的 stdio 不发起连接。工具箱新建不写隐式 false，导入保留原配置，表单按相同缺省规则显示。连接及发现不阻塞 LLM/宿主就绪，失败只影响对应 MCP；销毁等待在途连接并释放传输。

启动连接复用管理器的按 ID 串行队列，完成标准发现与扩展验证、引用约束检查后更新运行时能力，再通知后端远程项目目录并发布事件。启动发现不改写持久配置。工作台依赖已验证的远程能力与后端通知，不依赖工具箱 UI 装配；本地导航不等待所有远端在线，访问不可用远端时沿用现有连接检查与错误/重试路径。已保存的有效远程描述仍可用于目录投影；连接、MCP 能力与远程文件 HTTP 状态分别由后端管理。

```mermaid
flowchart LR
    Host[后端启动] --> Driver[LLM 配置就绪]
    Driver --> Connect[MCP 连接与标准发现]
    Connect --> Verify[扩展验证与引用约束]
    Verify --> Catalog[运行时能力与远程目录]
    Catalog --> Notify[后端变更通知]
    Notify --> Workbench[工作台更新远程导航]
    Shell[前端首屏] --> Toolbox[工具箱导航预加载]
    Shell --> Workbench
```

使用官方 `@modelcontextprotocol/client` / `@modelcontextprotocol/core` **2.0.0**，Node 最低版本为 20。通用 MCP 客户端采用 `Client.versionNegotiation.mode: 'auto'` 和 SDK 支持的协议版本：优先 `server/discover`，遇到旧协议或未知方法时由 SDK 使用 `initialize` 协商。认证失败及服务器故障不会触发协议降级。`MCPDiscovery.protocolVersion` 返回实际协商版本；`MCP_PROTOCOL_VERSION` 是现代协议版本常量。piagent-driver 的专用 harness 网关仍要求服务声明的 2026-07-28 契约。

只保留 stdio 和 Streamable HTTP（JSON-RPC over HTTP，可返回 JSON 或 SSE）。移除旧 HTTP+SSE 和 WebSocket 配置入口；已有旧传输配置显示“不支持”，连接或保存时明确拒绝，需要选择支持的传输。SDK 按协商版本生成请求头、客户端元数据并验证响应；现代协议不建立 MCP 协议级 Session，旧协议的初始化及 Session 生命周期由 SDK 管理。

本次覆盖 tools/resources/prompts、分页、取消、超时及 progress。未启用 sampling/roots/elicitation 的宿主回调，也不声明这些客户端能力；收到需要这些交互的 `input_required` 时 SDK 明确报错，不误报工具成功。参见 [官方版本说明](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions) 与 [SDK 迁移说明](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)。

| 宿主 | stdio | Streamable HTTP |
| --- | --- | --- |
| CLI | MCP SDK Node transport | MCP SDK transport |
| Tauri | 原生子进程桥 + SDK Client | WebView 中的 SDK transport |
| Web | 不可用，配置页明确提示 | SDK transport；服务器需允许浏览器访问 |

Tauri 在装配 LLM 服务时通过 `createMCPStdioTransportFactory` 创建实例桥并注入 MCP 选项。每个连接拥有独立子进程，JSON 行通过有界队列传输；消息最多 4 MiB，积压最多 8 MiB / 1024 行，stderr 最多保留 16 KiB。溢出会失败并停止进程，不静默丢失协议响应。启动、写入、轮询和停止经后台任务执行。关闭清理进程组；Linux 等待组成员停止，应用退出拒绝迟到进程注册。

stdio 服务器是用户配置的外部进程，使用该服务器的启动目录、参数和环境变量。其文件访问不经过 Session VFS；MCP 调用属于 external 能力并走工具审批。Session 的内置文件工具与 Bash 继续使用各自挂载和隔离边界。

“测试连接”使用当前表单草稿进行 MCP 协议协商和能力发现，不把 HTTP 200 视为协议成功。成功后保存配置与服务器返回的 tools/resources/prompts。发现列表不可通过手工添加虚构运行时能力。资源支持读取，Prompt 支持填写参数并预览；模型侧对应能力也经过工具白名单和 external 审批。

配置页支持 HTTP headers 与 stdio env 的字符串 JSON 对象；所有配置和返回文案先转义再渲染。导出不包含 apiKey、headers、env 中的凭据。

## MCP 配置扩展

`MCPConnectionOptions.extensions` 注册 `MCPConfigurationExtension`。管理器完成标准发现后，以本地 `matches` 筛选扩展；扩展只消费 `MCPDiscovery.metadata` 或经同一连接调用已声明的工具。普通 MCP 不发 pi-agent 能力探测。服务名称只用于展示，不参与类型识别。

pi-agent 在 `server/discover._meta['itookit/pi-agent']` 中声明安装身份、同源文件端点和项目/harness 能力；应用扩展验证描述后生成 `MCPDiscovery.extensions`。旧服务只有声明 `piagent_capabilities` 或 `fsagent_capabilities` 时才调用对应工具。元数据无效时失败，不回退以绕过验证。这里的描述是应用扩展，不是 MCP 标准的项目或 harness 接口。

验证结果按配置 ID 和连接身份保留在管理器内存中。测试成功后的保存及显示名修改复用结果；地址、认证、headers、stdio 参数或环境变量变化时重新验证已识别扩展。导入的新扩展描述不能代替验证。新的发现不再声明扩展时移除旧描述；删除、身份变更或关闭管理器清理缓存。授权钩子继续检查项目引用，扩展发现不会授予工具或目录权限。兼容迁移的纯 HTTP 文件连接保留旧 itookit/fs-agent 描述，不要求旧文件服务提供 MCP；显式升级到新扩展须完成通用发现。

设置 UI 只呈现已验证配置。宿主的 `MCPConfigurationControlsRegistry` 按扩展匹配展示控件，`PiAgentMCPControls` 提供控制中心；验证属于管理器及应用扩展，测试与保存共用一条发现链。增加服务扩展无需为每一种 MCP 修改通用表单。

## 超时与连接生命周期

配置持久化使用毫秒，并写入 `timeoutUnit: "ms"`；表单显示秒。兼容历史配置时，未标单位且 `timeout <= 300` 的正数按旧 UI 的秒解释，更大的值沿用毫秒。需要明确设置短毫秒超时的导入配置必须带 `timeoutUnit: "ms"`。

连接、发现和请求使用配置超时；工具调用同时受宿主执行预算与取消信号限制。MCP protocol progress 映射到工具进度，不能延长宿主预算或替代最终结果。

同一服务器的连接/修改/删除串行处理。传输配置变化会关闭旧连接；reload 用修订号避免覆盖并发保存，删除后的旧请求不得重建服务器。关闭管理器等待在途操作并拒绝新连接。失败的清理保留可重试的连接引用。

## llm-ui 输出

工具执行前消费 `getActivityDescription`。Bash 将 stdout/stderr 分段传回宿主，MCP 将协议 progress 通知传入 `ToolExecutionContext.onProgress`，再通过 `tool:progress` 投影到 History 卡片。

进度只保留一个待写快照和一个在途写入，约 250ms 合并一次，预览最多 8192 字符。它是活动提示和替换预览，不是最终工具证据。终态结果覆盖预览；迟到进度不能覆盖终态。没有协议进度的资源读取/Prompt 请求只展示运行状态和最终结果。

助手执行节点在运行中和持久历史恢复后使用同一 `round-<id>-assistant` ID，失败/取消状态事件也使用该 ID，避免界面留在 RUNNING。

CLI 的 worktree 创建、恢复和清理由宿主 Git 通道执行；Agent 的 Bash 与文件工具继续使用 Session 挂载的隔离副本。普通路由将未选的非循环分支标记为跳过，允许后续汇合；循环节点的共享执行上限取显式上限的最大值，各节点自己的上限仍优先，避免单次 worker 截断 supervisor 的多轮路由。

## 验证入口

- [配置表单测试](../../ui/app-shell/tests/capability-settings.test.ts)：策略保留、MCP 授权、转义、单位换算、草稿测试和失败处理。
- [Agent 导入导出](../../backend/kernel-adapters/tests/llm-management/agent-config-roundtrip.test.ts)：显式空白名单、策略和嵌套配置。
- [连接管理测试](../../backend/kernel-adapters/tests/llm-management/mcp-manager.test.ts)：配置失效、并发修改、删除、reload 及旧单位。
- [配置扩展测试](../../backend/kernel-adapters/tests/llm-management/mcp-extensions.test.ts)：匹配、结果复用、身份变化、导入验证及失败不保存。
- [pi-agent 扩展测试](../../backend/app-core/tests/pi-agent-mcp-extension.test.ts)：标准元数据、已声明工具兼容、名称不能冒充和同源验证。
- [真实 pi-agent 集成](../../ui/app-shell/tests/web-project-sync.test.ts)：通用 MCP 发现、保存/改名无额外验证及远程项目绑定。
- [宿主 stdio 测试](../../backend/kernel-adapters/tests/llm-management/mcp-host-transport.test.ts)：真实子进程、SDK 2026-07-28 协商、分页、资源、Prompt、progress 和启动取消。
- [MCP 工具适配](../../backend/kernel-adapters/src/tool/mcp-tools.test.ts)：能力 ID、参数验证、external 标记及进度。
- [Harness 提交](../../backend/llm-session/__tests__/direct-execution-mode.test.ts)：profile 展开进入实际 Task 输入，Chat 不加载 MCP。
- [CLI 集成](../../apps/cli/tests/flow-capabilities.test.ts)：显式工具 / Skill / profile、真实 stdio、审批、恢复和重跑。
- [CLI worktree](../../apps/cli/tests/worktree-run.test.ts)：宿主 Git 装配、文件隔离、恢复，以及模型请求未授权工具时无文件副作用。
- [Tauri 子进程](../../apps/tauri-app/src-tauri/src/mcp_process.rs)、[Bash 输出](../../apps/tauri-app/src-tauri/src/bash_process.rs)：原生进程隔离、输出限制、清理、结束前输出。

2026-09-22 的隔离 Tauri/WebKit 验证使用真实配置编辑器、LLMDeviceDriver、MCP SDK、原生 stdio、Session Bash 和 HistoryView：MCP 2026-07-28 progress 约 64ms 可见（约 116ms 完成），Bash 首段输出约 254ms 可见、1058ms 完成；资源与 Prompt 的配置页预览及工具调用均成功。测试使用本地协议 fixture，没有调用远程 LLM。临时报告保存在 `/tmp/x1-capability-tauri-probe/profile/capabilities-result.json`。

MCP 2.0.0 初次迁移验收：driver-llm 全包 80 项测试、CLI MCP 集成 4 项、配置页 6 项通过；全仓类型检查、driver-llm 构建、Tauri 前端构建、文档与样式检查通过。2026-10-08 的配置扩展重构将通用连接改为协议自动协商：协议测试验证旧版本/未知方法可协商旧协议，鉴权失败/服务故障不回退，并保留 HTTP JSON-RPC headers 与逐请求元数据、SSE 实时进度及未实现多轮交互的失败语义。完整测试矩阵在初次 SDK 迁移前通过；各次改动复测受影响模块及集成。
