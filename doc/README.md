# 项目文档导航

当前代码、公开契约和对应版本的验证结果共同决定已实现范围。设计文档中的目标、历史测试数字和临时日志不能替代当前验收。

## 架构与开发

| 文档 | 内容 |
| --- | --- |
| [包结构](pkgstructure.md) | 工作区、独立库与职责分层 |
| [系统架构](architecture.md) / [运行时装配](runtime-architecture.md) | 服务所有权、宿主装配与生命周期 |
| [前后端模块边界](design/frontend-backend-modules.md) / [策略与机制](design/application-policy-boundaries.md) | 目录、依赖与公共契约 |
| [接口契约](interface-contracts.md) / [集成链](integration-chains.md) / [事件流](event-flows.md) | 跨模块调用和事件消费 |
| [开发模式](dev-patterns.md) / [文件索引](file-index.md) | 常用扩展方式与源码入口 |
| [独立 npm 库](design/npm-library-consumption.md) | 源码工作区、构建与发布 |

## API 与运行

| 文档 | 内容 |
| --- | --- |
| [Kernel](kernel-api.md) / [Context](context-api.md) | 执行内核与上下文 |
| [独立 durable-kernel API](../libraries/durable-kernel/docs/api.md) / [事件契约](../libraries/durable-kernel/docs/events.md) / [Harness 验证](../libraries/durable-kernel/docs/harness-scenarios.md) | 随 npm 制品提供的接口、停止恢复、补读与验证边界 |
| [Tasks](llm-tasks-api.md) / [Flow](llm-flow-api.md) / [Session](llm-session-api.md) | 持久程序、编排与会话 |
| [RunDefinition](run-definition.md) / [联网搜索](web-search.md) | 调用输入与搜索策略 |
| [HTTP 宿主](http-app.md) / [CLI HTTP 模式](http-mode.md) | 共用界面、应用 API 与远程 CLI |
| [Profile 与数据根](mindos-profile.md) / [最小系统](minimal-system.md) | 配置、部署和运行步骤 |
| [Firecracker 隔离服务](../tools/firecracker-server/README.md) | Rust microVM API、Debian 13、virtio-fs 目录直通、持久卷与 vsock |

## 领域设计与验证

| 主题 | 入口 |
| --- | --- |
| 文件与挂载 | [VFS](design/VFS-design.md)、[Session 挂载](design/vfs-session-mount-access.md)、[HTTP 文件系统](design/vfs-http-driver.md) |
| 导航与编辑器 | [项目导航](design/project-session-navigation.md)、[工具箱](design/toolbox-navigation.md)、[浏览器边界](design/vfs-ui-boundary-review.md)、[编辑器生命周期](design/ui-lifecycle-refactoring.md) |
| LLM 能力 | [Tool / Skill / MCP](design/tool-skill-mcp-capabilities.md)、[Skill](design/skill-design.md)、[Context GC](design/context-gc.md) |
| 聊天 UI 独立化 | [单依赖边界、操作回调与快照订阅（设计提案）](design/llm-ui-independent-module.md) |
| 图片处理与聊天接入 | [image-parser、Scanic、裁剪及默认 1024 resize](design/chat-image-editing.md) |
| 非 ML 纸边检测验收 | [风险、68例回归与正式接入门槛](design/image-parser-detector-validation.md) |
| 远程项目与同步 | [Agent 服务](design/agent-server.md)、[项目模型](design/mindos-node-project-model.md)、[客户端同步](design/project-sync.md)、[服务端同步](design/mindos-node-sync.md) |
| RAPTOR 用例与远程编排 | [现有 Flow、Composite、Claude Code、执行连接与沙箱边界](design/raptor-harness-integration.md)、[可执行 Flow 示例](../apps/cli/examples/raptor/README.md)、[远程 Harness 执行连接](design/remote-harness-connections.md) |
| Anki 工作流 | [三连接 Flow、Rust 工具、YAML 清单与打包](design/anki-flow.md) |
| 数字分身 | [当前规则驱动设计与支持边界](design/digital-twin.md) |
| Durable 契约 | [主协议](design/durable-harness-protocol.md)、[目标与证据映射](design/durable-harness-evidence.md)、[接口与事件审查](design/durable-kernel-interface-review.md) |
| Session 指令队列 | [前后端 C4、编辑规则与恢复边界](design/session-instruction-queue.md) |
| 默认模型与服务 | [用途默认、前后端 C4、迁移和执行快照](design/model-purpose-defaults.md) |
| 性能诊断 | [启动与导航](design/startup-diagnostics.md)、[会话打开](design/llm-ui-session-performance.md)、[VFS 读取](design/vfs-read-performance-review.md) |
| 待办与验收 | [目标与待办](todo.md)、[按日期记录的验收证据](minimal-system-acceptance.md) |

其他专题保留在 [design/](design/)，分别标明实现、设计目标与验证边界。[feat/](feat/README.md) 只保留当前协议仍引用的历史背景。

## 维护约定

- 同一功能保留一个当前设计入口，调用方链接到该入口。
- 已废弃方案、旧包文档副本和逐轮状态快照从工作树删除，历史内容通过 Git 查阅。
- 保留尚未完成的契约、支持限制和可复现验收依据；删除文档不改变交付状态。
- 更新文档后运行 `pnpm docs:check`；历史归档的文件链接也应保持可解析。

- [Flow 图片处理与资产引用](./design/flow-image-processing.md)：版本化配方、宿主引擎、原图与派生图、处理回执及发送预算。
