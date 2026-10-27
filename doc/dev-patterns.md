# 开发模式与约定

## 新增 Provider

NestOS 默认仅装配 DeepSeek、火山引擎和豆包语音及对应连接。其他服务从工具箱「新建 → 模型服务商」按需添加，旧工作区已保存的配置保留；系统恢复不再提供 Provider/Connection 条目，配置异常时从工具箱删除后重新添加。完整厂商定义仍可供宿主显式组合，默认选择只在产品预设入口 `createNestosLlmPresets` 中决定。

新建 Provider 的预设来自 `createNestosProviderTemplates`，由宿主注入 `ToolboxResources`。该目录不自动创建 Provider；本地 Codex 等固定身份的宿主服务不作为可复制的 API 预设。UI/RPC 只读取预设 ID 和名称；新建界面不另设配置名称，选择列表预设或输入其精确名称时，提交对应预设 ID 及其名称，列表外输入作为自定义服务商名称。后端按配置字段白名单深拷贝并清除内置身份、凭据、费用等运行数据。预设服务商使用预设的稳定 ID，自定义服务商分配 UUID；已有预设 ID 或同名服务商（去除首尾空白、忽略大小写）时拒绝创建，未知预设同样在持久化前拒绝。多个视图的创建按同一管理服务串行核对，避免并发覆盖已有配置；删除后可从预设重新添加。自定义创建空白 OpenAI 兼容配置。创建不调用验证，也不改变已有实例或全局默认。

工具箱新建弹窗先选类型，再填写对应参数，保留 MCP 等原有可创建类型；模型相关类型显示为「模型服务商」和「模型连接」。新服务商详情与连接引导仅在弹窗内装配，复用已有编辑器并在完成前提交待保存配置；创建后的加载失败重试已有资源，不重复创建。现有工具栏、菜单和详情页沿用原有布局。

1. `backend/device-llm/src/providers.ts` — 在 `LLM_PROVIDERS`（`Record<string, LLMProvider>`，key = provider.id）中追加 provider 定义
2. `https://github.com/mushuanli/driver-llm/blob/main/src/providers/registry.ts` — 注册 provider 名→构造函数映射
3. 如需新 Provider 类（非 OpenAI 兼容）：`https://github.com/mushuanli/driver-llm/blob/main/src/providers/` 新建类 → `extends BaseProvider`
4. `https://github.com/mushuanli/driver-llm/blob/main/src/index.ts` — 导出

Provider 设置页通过 `IConnectionService.listProviderModels(provider)` 获取模型目录；`https://github.com/mushuanli/driver-llm/blob/main/src/providers/model-catalog.ts` 按接入类型处理 OpenAI 兼容、Anthropic、Gemini 的地址、认证、返回结构和分页。请求使用尚未保存的表单地址、Key 与 `modelsPath` 覆盖（相对路径或完整 URL），失败不返回部分目录。未声明 modelsPath 时从聊天端点的 API 前缀派生目录地址。刷新按 ID 追加新模型并合并已有模型的显式能力和操作声明，保留名称、协议、思考模式及未返回的配置，成功后自动保存。模型能力从接口的明确字段、模态及 supported_parameters 读取，缺失显示未知（capabilitiesKnown=false），不再默认启用视觉、推理或工具；能力图标与模型显示名称同行，声明在详情中编辑。浏览器访问目录仍受 CORS 限制。

Provider 高级设置以 `supportedProtocols` 声明可用协议，以 `defaultProtocol` 选择默认协议；每个协议的端点可独立覆盖（`chatPath` / `responsesPath` / `anthropicPath` / `geminiPath`），留空采用内置路径。Connection 只列出该 Provider 已配置的协议。模型的 `preferredProtocol` 用于连接未指定协议时：连接显式协议 → 当前请求模型的首选协议 → Provider 默认协议 → 旧实现回退；同一 Driver 切换模型时也重新选取协议。旧配置从 implementation 和非空兼容路径推断支持集合；原 Session 的 Anthropic 路径默认选择保持兼容。显式配置协议后，内置 Provider 的启动同步不覆盖用户的地址和路径。目录刷新成功不代表协议验证成功，高级设置可逐个协议发起真实模型请求，验证结果仅对当前编辑有效。新增字段及模型首选协议支持 `.llm` 导入导出，导出继续剥离 API Key。

## LLM 配置自动保存

Provider/Connection 配置可以打包为标准 `itookit.toolbox` v1 归档，从工具箱导入；通用导入器按资源分配新 ID 并重写 Provider 引用，不加载第三方专用解析器，也不自动绑定已有 Flow。内置厂商目录由 itookit 的 `createNestosLlmPresets()` 提供，并出现在系统恢复中；豆包语音与火山方舟分别配置。厂商协议由独立 driver-llm 适配，业务工具不携带 Provider、模型目录或凭据；Flow 经连接槽执行音频生成，再将媒体交给 anki-cli 打包。

工具箱的模型分类提供折叠能力筛选，按钮组合稳定的 `tag:chat`、`tag:vision`、`tag:image.generate`、`tag:speech.synthesize` 等查询，与普通文字搜索取交集；显示名称通过 presentation.tagLabel 本地化，查询和资源身份不随语言改变。能力来自 Provider 模型目录及 Connection 实际档位，生成操作还须具有受支持的媒体适配器；音频输入与音频分类不等于 TTS。标签与凭据就绪状态分别呈现，不能代替运行前准入检查。

`ui/ui-common/src/components/SettingsAutoSave.ts` 统一管理 LLM 设置编辑器的延迟、校验、串行写入和状态提示。普通文本停止输入 600ms、长文本 1000ms 后保存；开关/选择立即保存，API Key 和带 `data-autosave-defer` 的标识输入失去焦点后保存。输入法组合输入完成前不写入。程序修改列表时调用 `requestSettingsSave(root)`，搜索和临时图标输入不触发保存。

Provider / Connection 使用 `configuration-form.ts` 的自动保存表单，新增资源使用稳定 ID；API 刷新也自动保存，失败保留编辑草稿并提供重试。Agent 优先通过宿主 `saveContent` 写入当前源，未注入宿主时使用 `saveAgent`，避免与宿主 `interactiveChange` 自动保存重复写入。Skill / MCP / SystemPrompt / Cost 使用同一控制器，完整配置经校验后整体写入；不合法的 JSON、路径/协议或未完成条目不覆盖上一次有效配置。

保存成功只更新状态和局部标题，不调用整页 `render()`；服务自己的变更通知在保存/编辑期间不重建表单。切换资源和销毁前先提交有效草稿，失败保留 DOM；删除、重置、导入仍通过显式操作执行。自动保存不会主动重启 Agent 或 Flow，后续请求使用保存后的配置。

## 模型设置、文本测试与媒体验证

工具箱 Provider 详情使用概览、模型目录、连接配置、高级四个页签；切换页签保留同一份 DOM、无效草稿与自动保存状态。模型媒体能力和端点提供常用字段表单，原始 JSON 仍可编辑。凭据输入框只写，不读取已保存密钥；宿主仅在同一 Provider、基础地址和认证实现下解析现有凭据，显式空字符串表示清除，省略则保持同地址的已保存值。存储后端仍沿用原 Provider 存储，不宣称已迁移加密凭据库。

Provider 的“测试连接”统一使用用户选定的文本模型：目录中 category 为 chat（含兼容缺省值）的模型才可选，connectionTestModel 可声明预设选项。通信库不猜模型、不把媒体模型送到聊天端点；无可用文本模型时隐藏文本模型选择、凭据存储与子进程说明及「测试连接」，保留凭据配置和独立操作验证，不能借用其他服务商或其他地址的密钥。文本测试成功只证明该次文本请求，不证明其他操作可用。

图片和语音通过独立的操作验证调用同一 testConnection 服务，但必须显式提供 operation 和匹配的 MediaGenerationInput；它们复用正式生成适配器，一次提交、不自动重放。小于等于 8 MiB 的测试产物经已有字节 DTO 返回并由浏览器临时 Blob URL 预览，超出预算仅返回验证成功信息；URL 在重新验证、配置变化与编辑器关闭时释放，不写入正式任务产物。正式 Flow 继续使用 llm.media Effect 的授权、资产校验与持久回执。验证结果绑定开始时的完整配置和操作参数，变化后不能显示旧成功。

媒体操作的默认测试输入保存在应用层 `ui/app-shell/src/config/media-probe-examples.json`，按 image.generate / speech.synthesize 声明。宿主将同一份示例注入 Provider 配置页、新建配置弹窗和「模型与服务」页；设置组件只消费 MediaProbeExamples，不内置产品提示词或从 i18n 读取测试正文。用户编辑或清空输入后，同一表单刷新保留当前内容；示例不写入 Provider JSON，不自动发起生成请求。

reasoning 声明属于模型，reasoningByProtocol 可针对具体路由协议覆盖或禁用；包含 efforts（稳定 ID、显示名及可选 API 值）、canDisable、defaultEffort、预算范围及 transport。未声明不生成一组猜测的等级；服务端默认与显式关闭分开。设置页与聊天输入按实际模型显示选项，主力/常规/快速是路由档位，不是推理等级。切换模型恢复当前会话中该路由的选择，不改变全局默认。旧的未声明能力请求保留兼容；明确声明的等级、关闭和预算在通信前校验。

内置目录是产品预设，厂商变更只更新 presets；通信模块不按模型名称猜协议。豆包文本目录与语音服务分开配置，Seedream 使用 volcengine-images 原生图片适配器及显式能力。参照 [方舟文本目录](https://docs.volcengine.com/docs/ark/model-list?lang=zh)、[图片 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)、[语音 HTTP API](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh) 与 [DeepSeek 模型元数据](https://api-docs.deepseek.com/api/list-models/)，本次核对日期为 2026-10-22；目录声明不是账号权限验证。

诊断关联 connection.test.started/completed、media.request.started/completed/failed，记录 requestId/operationId、阶段、结果、错误分类、上游业务码、状态码和耗时。HTTP 200 与 RPC 正常返回不能替代 success；日志不记录输入、产物、完整请求/响应或凭据。失败详情供前端展示，诊断日志只使用安全元数据。

豆包语音的产品目录位于 `backend/device-llm/src/catalogs/doubao-speech.json`，记录版本、核对日期、官方来源、HTTP 鉴权与参数、格式/采样率约束、公开音色快照及适配器支持状态。`createDoubaoSpeechProvider` 只将已实现的资源模型、格式与音色派生为可运行配置；请求体模型变体与未实现能力仅作为资料，不能自动启用。`getProviderReferences` 经既有模型管理服务和 RPC 快照公开只读资料，Provider 高级页展示来源和支持状态，音色选择显示名称与 ID。该资料不是用户凭据或账号权限清单，不写入用户 Provider JSON；旧配置中的地址、音色及能力限制保持用户值。官方 ListSpeakers 是独立目录 API，当前尚未接入，不能使用通用 /models 或假设 TTS Key 能直接鉴权。

豆包语音 JSON 行流与 SSE 响应的成功结束帧可携带 `code:20000000,data:null`，该帧不作为音频解码；无音频、非法 Base64 或后续业务错误仍拒绝返回产物。

文本、协议和媒体操作验证共用结果呈现：显示操作、模型、stage、业务错误码、可用的 HTTP 状态/上游错误码、耗时及 requestId。浏览器 `Failed to fetch` 归为 transport/NETWORK_ERROR，没有响应时不猜测 HTTP 状态、密钥错误或服务不稳定；Node 的 DNS/TCP/TLS 已知原因通过 transportCode 保留，原始异常内容不进入诊断日志。MCP 启动错误单独记录 mcp.startup、serverId、连接/发现阶段和安全分类，不能当作模型验证失败。

2026-10-22 无凭据 OPTIONS 核对：方舟图片接口允许请求的 Authorization/Content-Type；豆包语音 HTTP 接口当前允许头列表缺少官方鉴权所需的 X-Api-Key，浏览器直连可能被预检拦截。此时应使用 Node HTTP 宿主或支持跨域的授权网关，不修改为不匹配的鉴权头，也不通过连续重试规避。预检不是账号权限或真实生成成功验收。

目录刷新只保留用户改过的媒体/推理 JSON 草稿；未修改字段跟随新目录更新，不能将旧 textarea 快照重新保存覆盖新能力。聊天配置恢复和能力刷新只更新展示，不改写已保存的推理偏好；只有用户切换模型时才恢复该模型的临时偏好。

## 新增 Provider 内置联网搜索能力

1. `backend/device-llm/src/providers.ts` — provider 定义加 `capabilities.serverSideWebSearch: true`
2. `backend/kernel-adapters/src/llm-management/contracts/connection.ts` — `supportsServerSideSearch()` 确认协议支持
3. provider 实现类注入内置工具并提取 `citations`（参考 `responses.ts` / `gemini.ts`）
4. 详见 [web-search.md](./web-search.md)

## 新增 API 协议（如 openai-responses）

1. `https://github.com/mushuanli/driver-llm/blob/main/src/types/connection.ts` 的 `ApiProtocol` 加枚举值
2. `driver-llm` `resolveProtocol()` 加 URL/provider 推断；`createProvider()` 加协议→Provider 类分发
3. Provider 类实现该协议端点路径（如 `responsesPath`）

## 增加订阅认证方式

认证方式与线协议分开：`chatgpt` 是独立 Provider implementation，继续使用 Responses。账号目录不推断工具、模态或定价。OAuth 回调、令牌保存和刷新由宿主的 `ProviderAuthorizationHost` 实现，UI 仅使用安全的状态与命令接口。HTTP 能力描述必须显式登记，不能把私有 credentials 方法加入 RPC。工具箱把 ChatGPT 标记为“订阅”，OpenAI 保留 API Key 配置并提供订阅跳转。

MCP 的自动连接开关位于详情顶部，使用既有自动保存控制器；从关闭切为开启时，后端在配置落盘后异步连接并发现目录，通过既有事件更新侧栏；失败不撤销已保存的策略。重复保存不重复连接，关闭开关不主动断开当前连接。

## 新增 Connection

通过 Settings UI (`ui/llm-settings-ui/src/editors/ConnectionSettingsEditor.ts`) 操作，
或直接写入 VFS `etc:/llm/.connections/<id>.json`

## 新增 Agent

1. `backend/kernel-adapters/src/llm-management/contracts/agent.ts` — 更新 `AgentDefinition` 接口（如需新字段）
2. `backend/kernel-adapters/src/llm-management/constants/agents.ts` — `DEFAULT_AGENTS` 预设模板
3. `ui/llm-settings-ui/src/editors/AgentConfigEditor.ts` — 编辑器 UI
4. `backend/llm-session/src/session/agent-resolver.ts` — AgentResolver.resolve()

## 新增通用工具 (Built-in Tool)

1. `backend/tools/src/tools/<Name>/prompt.ts` — 工具 prompt
2. `backend/tools/src/tools/<Name>/<Name>Tool.ts` — `buildTool(def)` 实现
3. `backend/tools/src/index.ts` — 在 `BUILTIN_TOOLS` 数组注册

工具驱动在 `call()` 前执行输入 schema、`validateInput` 和 `checkPermissions`，权限回调更新的参数会重新校验。已知的参数/操作前提错误可抛出 `ToolInputError(code, message)`，Agent 会收到可纠正的失败结果；存储异常或可能已发生副作用的未知失败应保持普通异常。不要把任意异常包装成可重试错误。结构化 `data` 与模型文本分别受输出上限限制，超大 data 被省略。人工审批由 Durable Agent interaction 承担，工具权限回调只负责 allow/deny。

## 新增 Kernel 工具 (需运行时引用)

1. `backend/kernel-adapters/src/tool/<name>.ts` — ToolMeta + ToolDefinition + ToolHandler
2. `backend/kernel-adapters/src/runtime/create-kernel-adapters-runtime.ts` — 运行时注册
3. 如需 Durable 执行，在 `backend/kernel-adapters/src/effects/` 增加 EffectAdapter，并由 KernelAdaptersPlugin 注册

## 新增 i18n 文案

1. `shared/common/src/i18n/zh-CN.ts` — 添加 key (source of truth)
2. `shared/common/src/i18n/en.ts` — 添加相同 key (TypeScript 静态校验)
3. 组件中使用 `t('new.key')`

## 新增图标

`shared/common/src/i18n/icons.ts` — 添加新图标常量，禁止组件硬编码 emoji

## 新增 Test

- vitest, `*.test.ts` 模式
- 测试目录为 相应 `ui/`、`backend/`、`shared/` 包下的 `__tests__/` 或 `tests/`；仅部分包有 包内的 `vitest.config.ts`（其余走 vitest 默认配置）
- 不 mock 数据库（集成测试原则）

## 构建

| 类型 | 工具 | 命令 |
|---|---|---|
| 逻辑包 | tsup | `pnpm build` (CJS+ESM+.d.ts) |
| UI 包 | vite build | `pnpm build` (app bundle + CSS) |
| 无 build 脚本 | — | `app-core`/`app-shell` 以 TS 源码被 app 消费 |

- **tsup**：`common`/`durable-kernel`/`llm-tasks`/`llm-flow`/`llm-session`/`kernel-adapters`/`driver-llm`/`device-tty`/`tools`/`vfs-core`/`vfsdriver-indexeddb`/`vfsdriver-local`，以及 UI 包中的 `llm-settings-ui`/`ui-common`。
- **vite build**：`llm-ui`/`vfs-ui`/`mdx`/`app-settings`/`demo`。

### dev server 的 workspace 别名（唯一来源）

`apps/tauri-app` 与 `apps/web-app` 的 `resolve.alias` 都从 `scripts/workspace-sources.mjs` 取：`workspaceAliases()` 给出「每个 workspace 包 → `src/index.ts` + 包内 CSS 子路径」的数组形式别名，`workspaceExcludes()` 供 `optimizeDeps.exclude` 使用。目的：dev 图里每个包只有一份源码副本（HMR 生效，且不会出现新旧转译结果混用导致的 `x is not a function`）。

- 包根用 `^包名$` 正则精确匹配，因此包内其它 `exports` 子路径（如 `@itookit/durable-kernel/core`）仍按 package.json 解析；CSS 等子路径入口由字符串别名处理，排在包根之前。
- **新增/删除 package、或新增包内子路径入口时，必须同步 `scripts/workspace-sources.mjs`**，不要在两份 `vite.config.ts` 里各自加别名。
- 改了工作区包源码后请**重启 dev server** 再验证，不要只刷新页面：长驻 server 可能保留了部分文件的旧转译结果。

## 代码约定

- **Ports/Adapters**: Shell 只通过 port 接口与视图通信，内部 DOM 完全封装
- **接口依赖**: 调用方类型为接口 (`IVFSManager`, `IFileSystem`)，具体实现在 bootstrap 注入
- **CSS 变量**: 唯一权威来源 `llm-ui-adapter/src/styles/variables.css`
- **函数 ≤30 行**，圈复杂度 ≤10
- **i18n 零硬编码**，图标统一从 `@itookit/common` 导入
- **Git commit**: `type(scope): description` (Conventional Commits)

Connection 推理强度按模型 ID 存于 `metadata.modelReasoningEfforts`；同一模型的多个 tier 共用配置，空值使用模型默认。旧统一 `reasoningEffort` 在编辑保存时迁移到当前有效模型，移除旧 `tierThinking`；请求显式推理强度优先于连接的模型配置。

Provider 保存为启用且包含聊天模型时，如尚无对应 Connection，通信层创建一个启用的默认连接；已有连接的独立禁用状态保留。有效启用状态由 Provider 与 Connection 共同决定。

聊天连接候选由 `llm-ui-adapter/src/shell/connection-options-cache.ts` 按配置服务共享缓存与在途请求，`onChange` 同步失效；打开连接菜单读取缓存，配置通知立即刷新下拉与已打开弹窗，保留搜索文本。最后一个编辑器关闭时解绑缓存订阅；过期异步结果不回填已销毁或更新后的输入视图。

ChatInput 的 Agent、Connection、模型层级及其他会话配置修改立即提交保存，正文草稿单独防抖。`StateManager.saveInputConfiguration` 在调用时复制配置并固定 Session/branch，通过串行队列写入 Session settings 和分支草稿；菜单与斜杠配置命令共用该路径。编辑器 `flushPendingSave` 等待并重试当前配置，成功后才释放。设置写入通知 Session 投影缓存失效，切回会话读取已提交数据。

Responses 请求统一发送 `input` item 数组，包括单条纯文本消息，以兼容只接受列表的代理；图片内容使用 `input_image`，`image_url` 为 URL 字符串，`detail` 为独立字段。

### Tauri 开发模块校验

`node --experimental-vm-modules scripts/check-tauri-dev-modules.mjs` 使用隔离 Vite 缓存和原生 ESM 链接检查桌面入口的静态开发模块图，不执行界面代码。缺失 default/named export 会直接失败，避免仅凭生产构建成功遗漏开发模式错误。对应回归位于 `ui/app-shell/tests/tauri-dev-modules.test.ts`。

`vfsdriver-local` 的 Node SQLite 回退在 WebView 中不可运行；Tauri 通过 `createDb` 注入原生 `TauriSqlSidecarDb`。Vite 将 `better-sqlite3` 映射到显式的不可用适配器，防止开发服务器直接向浏览器发送 CommonJS 原生模块。Node 文件系统内置模块仍由生产构建外置，宿主通过 `createFs` 注入原生端口。
