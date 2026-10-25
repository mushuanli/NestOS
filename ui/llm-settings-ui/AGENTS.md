# llm-settings-ui 开发说明

本包是 LLM 设置编辑器（Agent / Provider / Connection / MCP / Skill / Cost / SystemPrompt）+ LLM 配置导入/导出。

ModelDefaultsEditor 是「模型与服务」的统一默认用途设置页，复用连接与 Provider 配置；页面不执行验证。对话、绘图和语音候选按用途过滤，凭据与模型目录仍由原有工具箱编辑器管理；详见 [用途默认](../../doc/design/model-purpose-defaults.md)。旧全局默认展示及操作仅表示对话默认。

默认连接候选仅显示连接与服务商名称，选中项下方显示实际用途模型名称、去重能力图标和价格，复用 modelChoice/modelPrice 与管理服务可选 getPricingConfig，不把连接其他档位价格用于当前用途。用途候选直接展示全部兼容连接，不提供页顶模型搜索；说明中的模型配置为链接，导航到工具箱连接分类，不再显示底部管理按钮或优先级与外部执行器说明。已选连接通过下拉框右侧的配置图标进入对应工具箱编辑器，title 与 aria-label 包含连接名；OCR 复用相同入口。不显示已配置提示或运行验证入口。ModelDefaultsEditor 的宿主容器独立纵向滚动，显式恢复用途选择与 OCR 表单字段，同时更新配置入口；保存仍在进行时暂停恢复，不重复提交。

文字识别通过注入 OcrControls 和共享 OcrSettingsForm 在同页直接选择默认视觉连接，右侧图标按需打开宿主提示词弹窗；不另建 OCR 配置存储。modelsPath:false 的 Provider 有内置目录时提供“更新预置模型”，没有时禁用目录刷新并说明原因；合并声明时保留凭据、自定义名称和手动模型；显式目录地址可覆盖该声明。

默认用途统一在「模型与服务」设置，不在单个模型连接表单重复显示全局默认对话连接摘要。列表将默认连接及所属 Provider 置顶，默认标识不能替代凭据/停用状态；其余连接按就绪、待配置、停用排列，OAuth 就绪使用安全 credentialsReady 元数据。聊天模型就绪判断复用 contracts.resolveChatModelForTier，未知、已移除或媒体模型不能标为就绪，显式无效档位不跳过回退。

## 目录

```text
src/
├── index.ts                    统一导出
├── editors/
│   ├── AgentConfigEditor.ts    实现 IEditor（统一搜索 / 折叠展开）
│   ├── ProviderSettingsEditor.ts / ConnectionSettingsEditor.ts
│   ├── MCPSettingsEditor.ts / SkillSettingsEditor.ts
│   ├── CostEditor.ts / SystemPromptSettingsEditor.ts
│   ├── llm-import.ts           YAML 导入、冲突检测与执行
│   └── skill/                  Skill 导入 / 操作 / 渲染 / 支持字段
└── utils/modelBadges.ts
```

## 约束

- 只做设置/配置 UI，不依赖 llm-ui 的 chat/history/dag 组件。
- 依赖最小：`@itookit/common`（工具与 i18n）、`@itookit/ui-common`（BaseSettingsEditor/Modal/Toast/IEditor）、`@itookit/driver-llm`（导入导出）、`@itookit/vfs-core`（EventBus）、`@itookit/kernel-adapters/contracts`（配置管理与定价）、`@itookit/tools/contracts`（Prompt/Skill）、`@itookit/tools/mcp-contracts`（MCP）、`js-yaml`（YAML 解析）。
- 多数编辑器继承 `BaseSettingsEditor<T>` 基类（统一生命周期/保存/校验）；`AgentConfigEditor` 直接实现 `IEditor`。

运行：

```bash
pnpm --filter @itookit/llm-settings-ui typecheck
pnpm --filter @itookit/llm-settings-ui test
```

Agent 编辑必须保留未展示的策略字段；工具授权写顶层 `capabilityPolicy`，不再写旧 `config.mcpServers`。MCP 测试经管理服务执行真实协议握手与发现，不可使用普通 HTTP 探测代替；导入字段和远端文案必须转义。见 [能力配置与执行](../../doc/design/tool-skill-mcp-capabilities.md)。

AgentConfigEditor 的第 4 个参数接收 AgentCapabilityOptions.defaultToolIds，并在构造时复制、去重。默认目录为空，不内置 MindOS 工具授权；未设置 toolIds 表示继承宿主策略，显式空数组表示无授权。

配置导入导出使用 kernel-adapters/llm/config，stdio 能力经管理服务 supportsMCPStdio() 查询，缺省视为不可用；禁止加载 /llm 聚合入口，否则会把设备运行时与产品预设带入设置包。

CostEditor 默认展示本月费用账本摘要；趋势、Provider/会话明细和定价配置默认折叠。cost-trend.ts 按 UTC 账本日期聚合本月每日、最近 12 个月用量与费用；折叠图表按需查询，费用和 token 分开刻度。定价自动保存，不重算历史费用。统计只包含已入账调用，不包含远程 harness session 内部费用；数字分身分析远程会话的费用以实际入账为准，缺失记录不等于免费。

- `.llm` 导入 UI 只负责解析、选择冲突策略和展示结果；通过注入服务的 ConfigurationImportPort 查询冲突并提交导入，不编排 Provider/Connection/Agent/Skill 写入。执行用例归宿主后端。

- Provider 媒体 JSON 草稿与模型对象分开保存，搜索、排序和删除不能因草稿无效而失败；保存时才解析为配置。ChatGPT 订阅类型隐藏并禁用媒体字段，切回 API 类型时恢复草稿与校验；隐藏字段不参与保存校验。
- Provider 模型能力图标与显示名称同行，手机将 API ID 放上一行；详情只保留声明编辑。无 API 能力信息显示未知，不在加载或新增时默认填 true。目录刷新合并同 ID 的显式能力、上下文及操作声明，保留自定义名称/协议/思考模式和接口未返回的配置；supportsXXX 的 false 与 undefined 分别保留。媒体操作有独立文生图/TTS 图标，不从音频输入推断语音合成。

AgentConfigEditor 可消费 EditorOptions.mountSettings 挂载宿主偏好，生命周期包含 isDirty、flush 与 destroy；偏好字段不写入 AgentDefinition，保存失败阻止离开并保留表单。

AgentConfigEditor 通过可选 EditorOptions.onStartConversation 打开宿主聊天工作区，不发送消息；点击先 flush 宿主偏好及 Agent 自动保存，保存失败保留草稿并展示具体原因。开始聊天按钮在桌面固定身份栏右侧，手机与 mountCompactNavigation 的公开导航槽同行；手机将原身份表单移动到基本页，复用相同 DOM，四页签常驻且仅活动面板滚动。宿主导航存在时声明 data-editor-mobile-navigation="embedded"，销毁释放挂载与媒体查询监听；只读模式允许聊天导航，异步启动去重，隐藏或销毁取消尚未提交的启动。诊断日志仅记录 operationId、阶段、结果、固定错误分类和耗时，不记录表单或异常正文。

Agent 表单的共享样式统一位于 `ui/app-settings/src/styles/_agents.css`，Web/Tauri 宿主不重复定义同名选择器。页头与四个配置页签常驻，活动 `.agent-editor-panel` 是唯一纵向滚动区域，宿主承载层不增加滚动或 padding。页签切换仅设置 hidden，保留各页 DOM 草稿与滚动位置；只读模式仍支持页签与折叠导航。旧版 type 分类在高级页只读展示，不控制行为、授权字段的显示和保存；执行行为由执行配置决定。隐藏页面的校验失败会切回对应页面并展开字段所在段。折叠标题和页签使用原生 button，并同步 aria-expanded/aria-selected。

主执行入口分为 Agent、Composite 和 Workflow。Composite 编辑主持者、允许成员及分工/并发限制，保存后由应用服务发布受管 Flow 并返回规范绑定；无额外运行参数时不弹空表单。已登记 Agent 通过 saveAgent 保存，不能借 hostContext 原始写入绕过校验与编排准备；独立未登记的文件草稿仍交宿主保存。行为与模型页的「模型选择」按 chat/image.generate/speech.synthesize 配置 modelDefaults，未设置继承系统，候选复用模型能力声明过滤，不以音频输入推断 TTS。Workflow 的具名槽位另称「流程连接覆盖」，只作用于所绑定流程，不能另建一套 Agent 用途默认；输入图片处理明确表示发给模型的图片缩放。

Agent 执行方式通过 execution 绑定内部注册 Flow；第四个参数由宿主提供目录、发布版本、当前发布定义及连接候选。版本下拉包含 latest 与真实发布列表，默认参数及连接槽按所选发布定义生成控件，公共渲染与校验复用 llm-ui/forms；设置包不加载 Chat/Flow 视图。普通 Agent 策略与未展示字段继续保留，非法字段阻止保存并保留草稿；Flow 不反向声明 Agent。切换 Flow/版本保留窗口草稿，迟到读取不覆盖新选择。回归见 tests/agent-execution.test.ts 与 tests/agent-execution-controller.test.ts。

- Provider 连接测试仅使用显式文本模型，无可用文本模型时隐藏文本模型选择、凭据存储与子进程说明及「测试连接」，保留凭据输入和独立操作验证；模型分类变化时同步显示状态；图片/TTS 在独立操作验证中复用正式适配器并提供临时预览。测试不依赖先保存，结果必须与当前配置及操作参数一致；不得把 HTTP/RPC 成功当作业务成功。
- Provider 表单只消费安全 getProviders 元数据，不读取 getFullProvider 回填密钥。省略 apiKey 由宿主保持同地址凭据，空字符串显式清除；更换地址不得自动复用旧凭据。原明文存储约定不变，相关说明折叠展示。
- 模型推理选项来自 reasoning/reasoningByProtocol，不硬编码固定等级。Connection 按模型保存 effort/预算；无声明时显示服务端默认，媒体模型隐藏聊天专用参数。原始配置与常用控件共享同一草稿，不因切页签或渲染丢失未展示字段。

媒体验证示例通过 MediaProbeExamples 由宿主注入 ProviderSettingsEditor，设置组件不内置测试提示词，不从 i18n 获取测试正文。按操作选择示例，仅在初始化或切换操作时预填；同一操作刷新保留用户编辑和显式清空，预填不触发验证。

Provider 高级页通过可选 getProviderReferences 快照展示只读接口资料；不按厂商 ID 分支，不将文档记录的未实现能力转换成可编辑请求参数。音色名称用于展示，提交和校验仍使用配置中允许的真实音色 ID。

远程执行连接与模型连接分开：Agent execution.kind=harness 选择具名授权目标，设置面板通过可选管理端口按需读取已授权项目/profile并CAS新建或编辑，不能接受地址或凭据；候选失败可重试，保存失败保留草稿与稳定ID，迟到读取不得打开已销毁编辑器的弹窗。Composite允许远程成员，远程主持项禁用；最终准入仍由宿主校验。见[执行连接](../../doc/design/remote-harness-connections.md)。

主力模型与高级路由选项显示能力及价格，选择后的说明同步更新；相同图标合并能力说明，无模型价格标为未知，不把缺失当作零，也不以 Provider/全局估价代替模型价格。Provider/Connection 编辑器显式捕获内部模型数组、声明草稿和表单字段，HTTP 重建时只在内存恢复，保留程序赋值及未完成 JSON，恢复不触发自动保存。

Connection 模型选择在各档位候选弹层内提供搜索，多个空格/逗号分隔的关键词取交集，匹配模型 ID、名称与明确能力；Provider 目录搜索复用同一规则。连接档位使用 ModelPicker，在弹层内搜索并显示模型能力与价格，收起后只显示模型名称；保留原 select 作为表单值与恢复字段。输入过滤不保存，点击候选或键盘确认才派发 change。标准与快速留空时直接使用主力模型，不经其他路由档位回退。连接名称在顶部直接编辑，提供商固定且保存时不接受换绑；名称输入参与自动保存和恢复。价格来自管理服务 reference_catalog，显示原币种/单位、分档区间和来源核对日期；UI 不导入厂商目录或访问厂家网页。

单连接表单挂载期间由表单持有草稿，服务变更通知不能替换 DOM，包括没有触发 input/change 的程序赋值；HTTP 重建从该表单捕获快照，不能依赖脏标记判断是否保留。

连接表单页头保持一行：启用、可编辑名称、配置服务商及更多菜单；自动保存失败与重试在页头下方显示。服务商与协议同排，模型与推理选项同排；能力、价格仍在下方。新建连接默认启用，保存不能更换提供商。

AgentPublicationController 提供显式发布、只读核对和原身份重试，自动保存仅改草稿。准备失败或首次只读核对失败不能变成未知写锁；确实发出写请求后保留冻结身份。精确接纳回执可解除悬挂 Promise 的限制，迟到响应及状态查询不能覆盖后续操作；回执必须匹配目标和两份摘要。UI 日志只记录操作、阶段、错误码和耗时，不记录策略正文。未确认写入时关闭须保留操作身份并提供核对入口，不能静默丢弃。
