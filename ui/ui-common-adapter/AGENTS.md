# @itookit/ui-common-adapter

NestOS 的通用编辑器宿主契约和设置基础设施。只依赖 common、vfs-core 与独立 ui-common；不得导入聊天、模型设置、执行器或工作台实现。

- `interfaces/IEditor.ts` / `IEditorFactory.ts` 定义资源编辑器、文件上下文、恢复及宿主挂载端口。聊天专属 `conversation`、`remoteAgents`、`sessionDraft` 由 llm-ui-adapter/contracts 的 ChatEditorOptions 扩展。
- `BaseSettingsEditor`、`SettingsAutoSave`、`form-recovery` 供多种应用设置页面复用。自动保存串行写入，失败保留字段；恢复值仅在内存交接，不持久化到浏览器或记录日志，不派发保存事件。
- `Modal` 仅注入产品文案；弹窗、Toast、确认框和剪贴板机制由独立 ui-common 实现。时间展示包装只提供应用 locale。导航包装只提供应用图标和文案，不决定路由或历史。
- 独立 ui-common 提供共享导航、标题栏、菜单 DTO 和 DOM 工具；样式从其公开 navigation.css / components.css 入口消费。
- ConversationControls、SessionDraftControls 和 conversationStatus 归 llm-ui-adapter 的 contracts / presentation 入口。OCR 服务接线类型由 app-contracts/services 提供，配置表单归 llm-ui/settings，识别交互归独立 llm-ui。
- 不恢复旧 ISessionUI、资源列表或自动补全定义；这些列表能力直接消费独立 vfs-ui 的公开契约。
- EditorOptions.mountTitleBar 优先于兼容 compact/window 端口，交接原节点并返回清理函数；宿主提供项目、返回和窗口行为。不得为统一样式重建输入或按钮。
- EditorOptions.mountSettings 返回 isDirty/flush/destroy；导航与销毁前保存，失败保留输入。业务读模型经 initialData 泛型传入，不在公共包解释。
- Session、项目、Agent、Flow 与原生 harness 策略不进入本包。浏览器 UUID 从 common 获取。

验证：`pnpm --filter @itookit/ui-common-adapter typecheck` / `build`；使用方的 jsdom 集成测试覆盖设置恢复与宿主生命周期。
