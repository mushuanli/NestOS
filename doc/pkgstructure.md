
## Workspace Structure

pnpm monorepo：前端包位于 `ui/`，后端包位于 `backend/`，共享应用契约与基础工具位于 `shared/`，宿主位于 `apps/`（`apps/web-app` = `nestos-web`）。十二个独立库（包括 llm-ui、mdxeditor、vfs-ui）均位于 `libraries/`。目录迁移保留全部包名和公共入口。

| 目录 | 模块 |
|---|---|
| `ui/` | app-shell、app-settings、llm-ui-adapter、llm-settings-ui、mdx-adapter、ui-common |
| `backend/` | app-core、llm-context、llm-session、llm-flow、llm-tasks、kernel-adapters、device-llm、tools、sanbox、sync-adapters |
| `shared/` | app-contracts、common、app-transport |
| `libraries/` | driver-llm、nestos-node-driver、vfs-core、vfs-sync、vfsdriver-indexeddb、vfsdriver-local、vfs-ui、mdxeditor、llm-ui、image-parser、durable-kernel、device-tty |
| `apps/` | web-app、tauri-app、cli、http-app、demo、node-host（共享 Node 宿主适配包） |

19 个业务/共享包 + 12 个独立库 + 5 个应用 + 1 个共享 Node 宿主适配包；另有 tools/nestos-node 工具工作区。原 `packages/` 已清理，不再使用。目录和加载规则见 [前后端模块边界](design/frontend-backend-modules.md)。

### LLM 子系统分层（单向依赖）

```
llm-session ──▶ llm-flow ──▶ llm-tasks ──▶ durable-kernel ──▶ vfs-core
（会话/持久化） （DAG 编排） （LLM 任务单元）  （执行内核）
```

### Package 清单

| Package | Role |
|---|---|
| `@itookit/common` | 通用工具、导航接口、日志、i18n 与图标元数据；无运行时包依赖，不再转发 LLM 契约。 |
| `@itookit/llm-context` | 零运行时依赖的上下文领域：Profile、装配、窗口预算、Notes、原始历史、不可变请求与内容存储端口。详见 [Context API](context-api.md)。 |
| `@itookit/durable-kernel` | 持久化执行内核：`DurableTaskProgram`（init/reduce 状态机）、`EffectAdapter`、Task/Resource/Budget/Interaction 调度与恢复。 |
| `@itookit/llm-tasks` | 平台无关的 LLM Durable Program 层：`llm.agent`/`llm.chat`/`llm.plan` 状态机、依赖收集（`collectDependency`/`dependenciesReady`/`dependencyWait`）、`extractNodeOutput`、`buildLlmTaskInput`、ContextTaskProgram v2 bridge。 |
| `@itookit/llm-flow` | DAG 编排：`DurableFlowExecutor`（route/loop/spawn/compensate/on_failure/budget）、内置插件、Flow programs、环检测（`findCycles`）、FlowDefinitionStore。 |
| `@itookit/llm-session` | 用户可见的会话语义 + 持久化：SessionManager、Round/Branch、SessionRepository（会话资产）、FlowEngine（Flow 定义存储）、RoundLog、SessionEventBus、UI projections。依赖 llm-flow。 |
| `@itookit/kernel-adapters` | Kernel 能力适配器：Effect、Exec/ApprovedEffect 程序与运行时装配；`/llm` 子入口提供 VFS 模型设备、配置、费用、Skill 和 MCP 管理。 |
| `@itookit/device-llm` | LLM device 支持目录：内置 Provider、模型能力、接口资料与价格；根入口返回独立快照，/contracts 提供不加载目录的纯契约；仅依赖 driver-llm。 |
| `@itookit/driver-llm` | 独立模型通信：OpenAI/Responses/Anthropic/Gemini/Codex、SSE、取消与注入式网络/日志/重试；通信消息契约归本包，源码与发布产物不依赖其他 itookit 包；独立仓库 `mushuanli/driver-llm`。 |
| `@itookit/device-tty` | 独立 Node TTY 驱动：pipe / node-pty 交互会话，拥有 /contracts；tools/contracts 兼容转发，唯一直接运行依赖 node-pty。 |
| `@itookit/sanbox` | Seatbelt / Bubblewrap 策略与启动计划；根入口平台无关，`/node` 负责真实路径与启动探测，`native/` Rust crate 已接入 Tauri Session/Flow Bash，见 [系统沙箱](design/system-sandbox.md)。 |
| `@itookit/tools` | 内置工具实现（`buildTool()` 工厂）：File/Search/Shell/Task/Agent/Bash/Skill 等；拥有 Tool/TTY 公共执行契约，Skill/子代理契约和 MCP 纯协议入口也归本包；外部 Skill/Agent 经最小端口注入。 |
| `@itookit/vfs-sync` | 多端文件同步核心：规范 manifest、扫描完整性与三方计划、持久操作序列、冲突决策和恢复；零运行时依赖，I/O 由端口注入。 |
| `@itookit/vfs-core` | VFS 引擎核心：协议层 + 引擎实现 + 事件总线 + 通用 IO（IIOStream/pipe）。 |
| `@itookit/vfsdriver-indexeddb` | IndexedDB 存储后端（浏览器）；既有 SeqFile 记录存储与通用原生事务能力；同步适配、原子应用与 Web Locks 由 sync-adapters 提供。 |
| `@itookit/nestos-node-driver` | 统一 nestos-node 连接/凭据接入：文件、远程进程、HTTP 同步与 MCP harness 控制；独立于应用策略与 UI。 |
| `@itookit/vfsdriver-local` | SQLite + 本地 FS 后端（Node/Electron）。 |
| `@itookit/llm-ui` | 独立 Chat + Flow 通用 UI；只依赖 mdxeditor，Flow 由同包 /flow 子入口与功能开关控制。 |
| `@itookit/image-parser` | 独立图片缩放、裁剪与 Scanic 透视校正；/ui 多图编辑面板，/vfs 可选授权读取。 |
| `@itookit/llm-ui-adapter` | NestOS 的 Session/Task/Flow/VFS 接线与原产品编辑器兼容入口。 |
| `@itookit/llm-settings-ui` | LLM 设置 UI：Agent/Provider/Connection/MCP/Skill/Cost/SystemPrompt 编辑器 + 配置导入导出（`llm-import`）。 |
| `@itookit/vfs-ui` | 独立文件/资源浏览 UI：目录导航、标签、内容大纲；仅依赖 vfs-core，通过公开接口注入数据源、动作、展示和持久化。 |
| `@itookit/mdxeditor` | 独立 CodeMirror 6 编辑器（[独立仓库](https://github.com/mushuanli/mdxeditor)，源码工作区接入），不依赖其他内部包；宿主通过公共附件、存储、导航和保存接口注入能力。 |
| `@itookit/mdx-adapter` | NestOS 编辑器适配：VFS/namespace/Session 校验、文件格式、插件元数据、附件管理 UI、文件聊天引用及会话打印。 |
| `@itookit/ui-common` | 共享 UI 组件、契约、浏览器工具。 |
| `@itookit/app-settings` | 设置 UI 与导航投影：SettingsEngine；技能文件系统、持久化、标签和维护用例归 app-core，Web 快照归宿主。 |
| `@itookit/app-contracts` | 共享应用 DTO、事件、设置端口、身份与纯变换；不加载后端执行或 UI 实现。 |
| `@itookit/app-transport` | 平台中立的 HTTP/SSE 与能力 RPC，应用描述/selector 注入机制，不加载 Node 或 UI。 |
| `@itookit/app-core` | 无 UI 应用核心：NestOS profile、RunDefinition、共享 Session 文件/目录服务，以及统一装配 `createApplicationRuntime`（VFS/LLM/Session/Flow）与 headless `createKernelRuntime`（durable-kernel + kernel-adapters + Flow programs）。Web/Tauri/CLI 共用。 |
| `@itookit/app-shell` | Web/Tauri UI shell：`initApp()`（宿主注入 services/localBackend，不创建 Runtime）、workspace 策略、路由、Workbench/编辑器装配；通过 shared/app-contracts 的独立服务接口与宿主注入端口调用后端。 |

### App 清单

| App | Role |
|---|---|
| `nestos-web`（`apps/web-app`） | 主浏览器 SPA（IndexedDB 后端、workspace 配置、入口）。 |
| `@itookit/cli`（`apps/cli`） | 命令行表示层：应用命令默认本地直调，显式 --connect 调 httpd；保留 YAML 离线执行入口。 |
| `tauri-app`（`apps/tauri-app`） | Tauri 桌面壳。 |
| `@itookit/http-app`（`apps/http-app`） | HTTP/SSE 薄入口：委托 node-host，client 只加载前端。 |
| `@itookit/node-host`（`apps/node-host`） | CLI/httpd 共用的 Node Runtime、SQLite、私密授权、锁、日志、mTLS 客户端和 HTTPS 服务。 |
| `@itookit/demo`（`apps/demo`） | 历史演示宿主，部分脚本使用已弃用 API。 |

### 独立 npm 库与同步接入

独立库均位于 `libraries/`，参与 pnpm workspace；全部以 Git 子模块固定提交，包括 [durable-kernel](https://github.com/mushuanli/durable-kernel)、[llm-ui](https://github.com/mushuanli/llm-ui) 与 [device-tty](https://github.com/mushuanli/device-tty)。libraries 下的目录就是唯一开发工作树；先向各自远端提交，再由主仓库记录子模块提交；npm 发布独立进行。日常开发通过源码 exports 联调；`pnpm lib:build [库名]` 增量准备本地 tarball 快照，供 `pnpm httpd:build` 在隔离目录消费。`pnpm libraries:use <ID>` 可显式将整个工作区切到制品验收模式，`pnpm libraries:source` 恢复源码。各库保留独立 npm 发布能力，`pnpm build:registry` 在隔离目录构建固定 npm 版本。原 HTTP 驱动并入 nestos-node-driver，文件与进程实现位于其 src/files。目录、安装和发布流程见 [独立库接入](design/npm-library-consumption.md)。

VFS 驱动和 vfs-ui 的内部运行依赖仅为 vfs-core；本地驱动另依赖 better-sqlite3。vfs-sync、driver-llm 没有运行时包依赖。`backend/sync-adapters` 负责宿主同步接入，调用 vfs-sync 与驱动公共端口；同步范围和项目绑定由应用决定。

VFS `IPlugin` 可以提供变更提示，但不能替代跨窗口扫描、恢复日志与条件提交。core 不内置同步业务。

数字分身的领域服务与 SeqFile 布局归 app-core 的 `digital-twin/`，五页工作台归 app-shell 的 `digital-twin/`。kernel-adapters 仅注入通用发送前钩子，vfsdrivers 的 IndexedDB/SQLite schema 不加入分身表或业务字段；固定槽分页与版本链由 SeqTwinStore 管理。见[数字分身实施边界](design/digital-twin.md#实现与边界)。

`tools/image-tools` 是参与 pnpm 工作区的通用外部 Tool 包；核心工厂与 Node 引擎位于该包，Canvas 装配在 Web 宿主，Tauri 复用公开宿主入口。Rust `tools/anki-cli` 仍独立管理，未加入 pnpm 包工作区。
