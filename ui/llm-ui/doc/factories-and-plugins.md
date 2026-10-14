# llm-ui 工厂与组件边界

`createLLMFactory()` 创建 Conversation 编辑器，供 MemoryManager 按 nodeId 复用。

```text
LLMWorkspaceEditor
├── ChatInputView
├── HistoryView
├── DagWorkbench
├── BranchIndicatorView
└── StatusIndicatorView
```

关键规则：

- 高层操作通过 `ICommandBus` 委托给 Conversation。
- `RunAttachmentController` 只通过 `TaskHandle` 观察和控制执行。
- 特权 Slash Command 只依赖 `IPrivilegedCommandService`；Program 与平台能力由 App Shell 注入。
- `DagWorkbench` 从 `DagPluginCatalog` 加载 Manifest 与 UI Contribution。
- UI 不加载插件 Runtime，不识别具体节点执行类型。
- TTY 输出按文本写入 DOM；输入必须经 Kernel signal/tool 控制面。
