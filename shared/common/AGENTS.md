# @itookit/common 开发说明

共享接口、类型、工具和 i18n。运行时包通过这里的协议解耦。

`src/` 分五组：`events/`（导航事件）、`i18n/`（`t()`/`setLocale`、zh-CN 与 en 资源、图标表）、`interfaces/`、`types/`、`utils/`。

## 模块边界

本包没有运行时包依赖，只提供通用工具、导航接口、日志、i18n 和图标元数据。llm-common 与原有 llm-compat.ts 已删除；LLM 类型和函数不再由本包导出。

调用方直接使用公开契约：driver-llm/contracts（通信）、llm-context（上下文）、tools/contracts 与 tools/mcp-contracts（工具、Prompt 与 MCP）、llm-tasks/contracts（执行）、llm-flow/contracts（编排）、llm-session/contracts（会话）、kernel-adapters/contracts（配置管理与定价）。不得通过重新转发引入这些能力包。

通用哈希工具在本包独立实现；llm-context 为保持独立运行保留自身实现，算法兼容性由测试覆盖。

## VFS 核心协议（@itookit/vfs-core）

VFS 协议与事件总线在 `@itookit/vfs-core`（`src/interfaces/` + `src/eventbus/`）：

| 层级 | 接口（位于 vfs-core） |
| --- | --- |
| 存储 | `IStorageBackend` |
| 系统管理 | `IVFSManager` |
| 文件系统视图 | `IFileSystem` |
| 驱动 | `IFileSystemDriver`（= `IFSDriver`）、`IFSMetaDriver` |
| 文件 | `IFile`、`AssetObj` |

## 命令

```bash
pnpm --filter @itookit/common build       # tsup
pnpm --filter @itookit/common typecheck
```

## 约束

- 新增跨包 LLM 协议定义在对应能力模块，VFS 协议定义在 `@itookit/vfs-core`，本包不再新增协议。
- 接口优先使用 `interface`，判别联合使用 `type`。
- 公共协议不得 import 上层包。
- 不在本包实现 Kernel、Session Service 或 UI Projection。
- 新增 i18n key 时同步更新中英文资源（`src/i18n/zh-CN.ts` → `en.ts`）。

相关文档：[架构设计](../../doc/architecture.md)、[接口契约](../../doc/interface-contracts.md)
