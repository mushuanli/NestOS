# llm-settings-ui 开发说明

本包是 LLM 设置编辑器（Agent / Provider / Connection / MCP / Skill / Cost / SystemPrompt）+ LLM 配置导入/导出。

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
