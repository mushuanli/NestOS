# 开发模式与约定

## 新增 Provider

1. `backend/kernel-adapters/src/llm-management/constants/providers.ts` — 在 `LLM_PROVIDERS`（`Record<string, LLMProvider>`，key = provider.id）中追加 provider 定义
2. `https://github.com/mushuanli/driver-llm/blob/main/src/providers/registry.ts` — 注册 provider 名→构造函数映射
3. 如需新 Provider 类（非 OpenAI 兼容）：`https://github.com/mushuanli/driver-llm/blob/main/src/providers/` 新建类 → `extends BaseProvider`
4. `https://github.com/mushuanli/driver-llm/blob/main/src/index.ts` — 导出

Provider 设置页通过 `IConnectionService.listProviderModels(provider)` 获取模型目录；`https://github.com/mushuanli/driver-llm/blob/main/src/providers/model-catalog.ts` 按接入类型处理 OpenAI 兼容、Anthropic、Gemini 的地址、认证、返回结构和分页。请求使用尚未保存的表单地址、Key 与 `modelsPath` 覆盖（相对路径或完整 URL），失败不返回部分目录。刷新只按 ID 追加新模型，已有模型、顺序和未保存编辑保留，刷新成功后自动保存新增模型。新增模型默认启用 `supportsVision`、`supportsThinking`、`supportsTools`，这三个能力不提供开关；模型分类、Thinking 模式、首选协议和其他能力在折叠详情中配置。浏览器访问目录仍受 CORS 限制。

Provider 高级设置以 `supportedProtocols` 声明可用协议，以 `defaultProtocol` 选择默认协议；每个协议的端点可独立覆盖（`chatPath` / `responsesPath` / `anthropicPath` / `geminiPath`），留空采用内置路径。Connection 只列出该 Provider 已配置的协议。模型的 `preferredProtocol` 用于连接未指定协议时：连接显式协议 → 当前请求模型的首选协议 → Provider 默认协议 → 旧实现回退；同一 Driver 切换模型时也重新选取协议。旧配置从 implementation 和非空兼容路径推断支持集合；原 Session 的 Anthropic 路径默认选择保持兼容。显式配置协议后，内置 Provider 的启动同步不覆盖用户的地址和路径。目录刷新成功不代表协议验证成功，高级设置可逐个协议发起真实模型请求，验证结果仅对当前编辑有效。新增字段及模型首选协议支持 `.llm` 导入导出，导出继续剥离 API Key。

## LLM 配置自动保存

`ui/ui-common/src/components/SettingsAutoSave.ts` 统一管理 LLM 设置编辑器的延迟、校验、串行写入和状态提示。普通文本停止输入 600ms、长文本 1000ms 后保存；开关/选择立即保存，API Key 和带 `data-autosave-defer` 的标识输入失去焦点后保存。输入法组合输入完成前不写入。程序修改列表时调用 `requestSettingsSave(root)`，搜索和临时图标输入不触发保存。

Provider / Connection 使用 `configuration-form.ts` 的自动保存表单，新增资源使用稳定 ID；API 刷新也自动保存，失败保留编辑草稿并提供重试。Agent 优先通过宿主 `saveContent` 写入当前源，未注入宿主时使用 `saveAgent`，避免与宿主 `interactiveChange` 自动保存重复写入。Skill / MCP / SystemPrompt / Cost 使用同一控制器，完整配置经校验后整体写入；不合法的 JSON、路径/协议或未完成条目不覆盖上一次有效配置。

保存成功只更新状态和局部标题，不调用整页 `render()`；服务自己的变更通知在保存/编辑期间不重建表单。切换资源和销毁前先提交有效草稿，失败保留 DOM；删除、重置、导入仍通过显式操作执行。自动保存不会主动重启 Agent 或 Flow，后续请求使用保存后的配置。

## 新增 Provider 内置联网搜索能力

1. `backend/kernel-adapters/src/llm-management/constants/providers.ts` — provider 定义加 `capabilities.serverSideWebSearch: true`
2. `backend/kernel-adapters/src/llm-management/contracts/connection.ts` — `supportsServerSideSearch()` 确认协议支持
3. provider 实现类注入内置工具并提取 `citations`（参考 `responses.ts` / `gemini.ts`）
4. 详见 [web-search.md](./web-search.md)

## 新增 API 协议（如 openai-responses）

1. `https://github.com/mushuanli/driver-llm/blob/main/src/types/connection.ts` 的 `ApiProtocol` 加枚举值
2. `driver-llm` `resolveProtocol()` 加 URL/provider 推断；`createProvider()` 加协议→Provider 类分发
3. Provider 类实现该协议端点路径（如 `responsesPath`）

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
- **CSS 变量**: 唯一权威来源 `llm-ui/src/styles/variables.css`
- **函数 ≤30 行**，圈复杂度 ≤10
- **i18n 零硬编码**，图标统一从 `@itookit/common` 导入
- **Git commit**: `type(scope): description` (Conventional Commits)

Connection 推理强度按模型 ID 存于 `metadata.modelReasoningEfforts`；同一模型的多个 tier 共用配置，空值使用模型默认。旧统一 `reasoningEffort` 在编辑保存时迁移到当前有效模型，移除旧 `tierThinking`；请求显式推理强度优先于连接的模型配置。

Provider 保存为启用且包含聊天模型时，如尚无对应 Connection，通信层创建一个启用的默认连接；已有连接的独立禁用状态保留。有效启用状态由 Provider 与 Connection 共同决定。

聊天连接候选由 `llm-ui/src/shell/connection-options-cache.ts` 按配置服务共享缓存与在途请求，`onChange` 同步失效；打开连接菜单读取缓存，配置通知立即刷新下拉与已打开弹窗，保留搜索文本。最后一个编辑器关闭时解绑缓存订阅；过期异步结果不回填已销毁或更新后的输入视图。

ChatInput 的 Agent、Connection、模型层级及其他会话配置修改立即提交保存，正文草稿单独防抖。`StateManager.saveInputConfiguration` 在调用时复制配置并固定 Session/branch，通过串行队列写入 Session settings 和分支草稿；菜单与斜杠配置命令共用该路径。编辑器 `flushPendingSave` 等待并重试当前配置，成功后才释放。设置写入通知 Session 投影缓存失效，切回会话读取已提交数据。

Responses 请求统一发送 `input` item 数组，包括单条纯文本消息，以兼容只接受列表的代理；图片内容使用 `input_image`，`image_url` 为 URL 字符串，`detail` 为独立字段。

### Tauri 开发模块校验

`node --experimental-vm-modules scripts/check-tauri-dev-modules.mjs` 使用隔离 Vite 缓存和原生 ESM 链接检查桌面入口的静态开发模块图，不执行界面代码。缺失 default/named export 会直接失败，避免仅凭生产构建成功遗漏开发模式错误。对应回归位于 `ui/app-shell/tests/tauri-dev-modules.test.ts`。

`vfsdriver-local` 的 Node SQLite 回退在 WebView 中不可运行；Tauri 通过 `createDb` 注入原生 `TauriSqlSidecarDb`。Vite 将 `better-sqlite3` 映射到显式的不可用适配器，防止开发服务器直接向浏览器发送 CommonJS 原生模块。Node 文件系统内置模块仍由生产构建外置，宿主通过 `createFs` 注入原生端口。
