# @itookit/llm-ui

原生 DOM 聊天、历史和 Flow 展示。按需要选择公开入口：

```ts
import { createLLMFactory, type SessionViewPort } from '@itookit/llm-ui/chat';

const factory = createLLMFactory(agentService, {
  sessionManager: conversation.sessionManager,
  sessionRepository,
  commandBus: conversation.commandBus,
  kernel,
  defaultHarnessToolIds: hostToolIds,
});
```

`agentService` 接受公共 `IAgentConfigService`，无需创建 VFSAgentService；`sessionManager` 接受结构化 `SessionViewPort`（查询、事件与命令通道），可由宿主实现。提示词历史是可选的 `PromptHistoryPort`。仓储、OCR、工具授权、Skill 和特权命令由宿主接入。未传默认工具列表时，UI 不自行假定授权；真实授权由执行层校验。

聊天入口不加载设置编辑器；需要设置界面时安装可选 peer `@itookit/llm-settings-ui`，再从 `@itookit/llm-ui/settings` 导入 `createAgentEditorFactory`、`createSkillsEditorFactory` 或设置编辑器。包根现在等同于 `/chat`；已删除旧 `/legacy` 聚合入口和单例回退。`/startup` 用于启动菜单与 Flow 模板安装接口，`/style.css` 提供聊天样式。

`/chat` 创建正式会话编辑器时必须传入 `sessionManager`，或通过 `resolveSessionView` 延迟获取实例；缺少端口会明确报错。提示词历史通过实例上的可选 `promptHistory` 接入。所有入口均要求显式实例注入。当前 UI 仍消费 Session/Flow 契约和仓储能力，并非只依赖通用 UI 的展示组件包。

仅依赖 mdxeditor 的拆分目标、操作回调和快照订阅方案见 [独立模块设计提案](../../doc/design/llm-ui-independent-module.md)（待实施）。

验证：`pnpm --filter @itookit/llm-ui typecheck`、`build`、`test`。
开发说明见 [AGENTS.md](./AGENTS.md)。

会话正文与输入区共享 `--llm-content-width`（默认 780px）。用户消息为按内容收缩的浅色气泡，助手回答采用无外框正文；复制、重试、折叠在正文下方，编辑、删除和分支操作收进消息菜单。思考默认折叠；工具以名称和状态摘要呈现，展开查看完整参数和结果，失败自动展开。审批及人工回复仍直接显示在输入区。

标题栏用图标打开「提问目录」，直接列出最近提问并提供全文过滤；数量少时全部显示，超过 100 条时先展示最近 100 条，可继续展开，无需翻页。支持开头/中间/最近定位及单行/三行摘要。点击只展开目标消息并暂停自动跟随；远距离直接定位，近距离平滑滚动。窄屏为底部面板，选中后收起。原生引用不进入摘要；已加载片段没有提问时，打开目录会按需向前读取最多 3 页，错误停止并允许手动重试。目录旁提供折叠/展开所有，已移除隐藏历史功能；原有批量历史导航仍在更多菜单中。

原生远程会话的系统事件以淡紫色“系统提示”摘要呈现，默认折叠，展开仍为转义后的原始文本；工具记录以灰色“工具”标签和操作/目标呈现。两者保留轮内顺序，不生成正文级标题，也不把原生 HTML 当作可执行标记。快照更新保留已展开系统提示的状态。

原生用户消息中有明确来源标记的项目指令、运行环境和附加上下文默认折叠，点击展开可查看、复制完整原文，刷新保留展开状态。正文继续直接展示；仅依据 `contentPartKinds` 判定来源，不按文件名、标签、长度或位置猜测。Codex 的标记由 pi-agent 从 rollout 元数据透传；旧服务、未知来源及没有来源元数据的 Claude 用户文本保持原样。

输入工具栏保留添加、模式、助手、模型和发送。模型选择器统一选择连接与档位；搜索、聊天设置、预设提示词及帮助位于更多菜单。连接与档位不再重复显示活动标签；历史范围、非流式设置仍有提示。用量信息在输入区下方折叠查看。远程会话继续隐藏本地模型和执行设置，原生历史保持只读。

本地模型输入在发送前显示缺少默认连接、凭据/授权未就绪、停用和缺少聊天模型，提供相应设置入口；发送时复查配置，失败保留草稿和附件。原生执行器与 Flow 各自使用自身配置校验。宿主可注入 `EditorOptions.executorUsage`，按成功提交时间排列同类别助手，保存由宿主负责。

移动端可通过 `EditorOptions.mountCompactNavigation` 在同一标题栏挂载宿主返回、项目与窗口切换控件，避免多排导航。输入框从一行自适应增长，长草稿内部滚动；触屏 Return 换行，发送按钮提交。键盘改变历史区高度时，贴底阅读继续跟随，已滚到前面的阅读位置保持不变。

Flow 模板由宿主提供，不再从 UI 导出 `builtinFlowLibrary`。安装与恢复必须显式传入 `readonly FlowDraft[]`：

```ts
await installFlowLibrary(commands, hostTemplates);
await restoreFlowLibrary(commands, hostTemplates);
const menu = createFlowContextMenuConfig({ ...runOptions, library: hostTemplates });
```

未提供 `library` 的菜单不显示恢复入口。MindOS 使用 app-core 的 `createMindosFlowLibrary()`，其他用户可提供任意符合公共契约的模板。

Agent 设置工厂使用 `createAgentEditorFactory(service, { defaultToolIds: hostToolIds })` 显式注入宿主默认授权；不传则默认目录为空。UI 不选择 Read/Write/Bash 等工具。该默认列表仅用于展示与编辑，实际工具授权由执行层校验。

SessionViewPort 可通过可选的 getDirectAgentPolicy 返回实际 Agent 策略。聊天编辑器据此显示 maxExchanges，独立 ChatInput 可直接传 maxAgentExchanges；没有该端口时沿用 llm-tasks 的通用默认预算。

迁移：旧根入口的设置编辑器和工厂改从 `/settings` 导入；`VFSAgentService` 改从 `@itookit/llm-session` 导入；使用返回的 SessionManager 实例替换单例调用，并传给 UI。

发布依赖：driver-llm、tools、kernel-adapters、llm-tasks 只作为开发契约依赖；声明在构建时内联，少量任务契约常量进入 UI 产物。直接运行依赖从 12 个降到 8 个。Session/Flow、VFS、common/ui-common 与 Kernel 仍有功能或公开类型依赖，传递依赖仍存在；公共控制端口引用 Kernel 公开 Task/Session 类型；传入真实 Kernel 时仍然兼容。

会话创建的初始 text/agentId 通过 EditorOptions.initialInputState 显式传入，UI 不读取宿主 storage 键。导航创建由宿主将请求状态传给工作区，再传给对应编辑器实例；标题由持久 Session manifest 提供。

`kernel` 参数接受结构化 `EditorTaskControlPlane`，远程客户端也可以实现：

```ts
import type { EditorTaskControlPlane } from '@itookit/llm-ui/chat';
const control: EditorTaskControlPlane = {
  openTask: id => remote.openTask(id),
  openSession: id => remote.openSession(id),
  listSessionTasks: id => remote.listSessionTasks(id),
};
const factory = createLLMFactory(agentService, { sessionManager, sessionRepository, kernel: control });
```

`openTask` 返回支持事件订阅和任务控制的 `AttachedTask`；`openSession` 只需共享挂接身份的读写与任务状态读取。事件重放、批准响应和身份切换必须满足端口契约。编辑器初始化失败也释放已创建资源；`destroy()` 幂等并汇总清理失败，调用方应等待其完成。

Markdown 显示通过 mdxeditor 的 `scrollMode: 'host'` 和 `--mdx-content-*` 公共变量嵌入；原生历史与打印选择 `htmlPolicy: 'literal'`。展开状态由 mdxeditor 按普通 key 在实例内存中维护，系统/工具的名称、摘要、颜色和默认折叠规则继续留在 llm-ui，mdx-adapter 只映射这些公共选项。

新建项目草稿先选择助手对话、原生执行器或工作流。切换助手/原生执行器不创建 Session，保留正文、附件和独立模型连接偏好；工作流入口保存草稿后打开流程库，再沿用流程参数和连接槽表单运行。Agent 定义继续只保存职责、指令与工具，不按 Provider 创建新类型。

已有会话在更多菜单提供「切换执行方式」。模型、连接与助手可在两轮之间切换；跨 Chat、原生执行器和 Flow 则先保存原输入，将文字及附件追加到项目草稿，再选择目标，原会话和任务保留，历史不自动迁移。该动作不自动提交新任务，已有草稿也不会被覆盖。

输入区模型菜单按连接和服务商分组，以具体模型名选择配置好的档位，同时更新连接和档位；同名模型仍有连接来源。`auto` 显示「跟随默认」，沿用 optimal 默认解析，不表示按任务自动选模。思考强度独立设置；缺少凭据或没有模型的选择不可用，已知非聊天模型不进入 Chat 选择。原生执行器显示「原生配置」；Flow 会话显示「节点模型」，通过流程定义及运行参数表单管理各节点连接。已有连接缺失时保留其身份供纠正，不静默切换其他连接。
