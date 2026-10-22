# llm-settings-ui 开发说明

本包是 LLM 设置编辑器（Agent / Provider / Connection / MCP / Skill / Cost / SystemPrompt）+ LLM 配置导入/导出。

ModelDefaultsEditor 是「模型与服务」的统一默认用途设置页，复用连接、Provider 及现有探测端口；保存不运行验证。对话、绘图和语音候选按用途过滤，凭据与模型目录仍由原有工具箱编辑器管理；详见 [用途默认](../../doc/design/model-purpose-defaults.md)。旧全局默认展示及操作仅表示对话默认。

文字识别通过注入 OcrControls 和共享 OcrSettingsForm 在同页直接选择默认视觉连接，右侧图标按需打开宿主提示词弹窗；不另建 OCR 配置存储。modelsPath:false 的 Provider 禁用目录刷新并说明原因，保留预置和手动模型；显式目录地址可覆盖该声明。

连接表单上方独立显示默认对话连接、模型与就绪状态；默认标识不能替代凭据/停用状态。列表将默认连接及所属 Provider 置顶，其余连接按就绪、待配置、停用排列，OAuth 就绪使用安全 credentialsReady 元数据。聊天模型就绪判断复用 contracts.resolveChatModelForTier，未知、已移除或媒体模型不能标为就绪，显式无效档位不跳过回退。

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

Agent 执行方式通过 execution 绑定内部注册 Flow；第四个参数的 listFlows 由宿主提供目录。可跟随最新发布或固定 revision，并编辑默认参数及连接绑定 JSON。普通 Agent 策略与未展示字段继续保留，非法 JSON 阻止保存；Flow 不反向声明 Agent。回归见 tests/agent-execution.test.ts。

- Provider 连接测试仅使用显式文本模型，无可用文本模型时隐藏文本模型选择、凭据存储与子进程说明及「测试连接」，保留凭据输入和独立操作验证；模型分类变化时同步显示状态；图片/TTS 在独立操作验证中复用正式适配器并提供临时预览。测试不依赖先保存，结果必须与当前配置及操作参数一致；不得把 HTTP/RPC 成功当作业务成功。
- Provider 表单只消费安全 getProviders 元数据，不读取 getFullProvider 回填密钥。省略 apiKey 由宿主保持同地址凭据，空字符串显式清除；更换地址不得自动复用旧凭据。原明文存储约定不变，相关说明折叠展示。
- 模型推理选项来自 reasoning/reasoningByProtocol，不硬编码固定等级。Connection 按模型保存 effort/预算；无声明时显示服务端默认，媒体模型隐藏聊天专用参数。原始配置与常用控件共享同一草稿，不因切页签或渲染丢失未展示字段。

媒体验证示例通过 MediaProbeExamples 由宿主注入 ProviderSettingsEditor 与 ModelDefaultsEditor，设置组件不内置测试提示词，不从 i18n 获取测试正文。按操作选择示例，仅在初始化或切换操作时预填；同一操作刷新保留用户编辑和显式清空，预填不触发验证。

Provider 高级页通过可选 getProviderReferences 快照展示只读接口资料；不按厂商 ID 分支，不将文档记录的未实现能力转换成可编辑请求参数。音色名称用于展示，提交和校验仍使用配置中允许的真实音色 ID。
