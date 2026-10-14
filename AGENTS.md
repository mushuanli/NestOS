# AGENTS.md — AI 助手配置

## 语言
- 始终使用**中文**交流
- 代码注释用英文，Git commit 用 Conventional Commits (`type(scope): description`)

## 项目概览
- **itookit**：pnpm monorepo，承载 **MindOS**（浏览器/桌面的个人知识 OS：虚拟文件系统 + Markdown 编辑器 + LLM 对话/Agent 执行）
- 工具链：`pnpm@10.20.0`（`workspace:*`）、TypeScript 5.9 strict（`target: ES2022`、`moduleResolution: bundler`，见 `tsconfig.base.json`）
- 无前端框架：原生 DOM + TypeScript
- 19 个业务 package + 8 个独立库源码工作区（`libraries/`）+ 4 个 app，详见 [包结构](./doc/pkgstructure.md)

## 开发原则
SOLID / DRY / KISS / YAGNI / CoC / LoD — 函数≤30行，圈复杂度≤10

## 常用命令

```bash
pnpm dev                              # Web app 开发服务器
pnpm build:libs                       # 构建 packages/*
pnpm typecheck                        # 全仓类型检查
pnpm docs:check                       # 活文档与代码同步检查
pnpm styles:check                     # markup 类名 ↔ CSS 规则一致性检查
pnpm test                             # 全量测试矩阵（含 Rust 边界；crash-matrix 自动隔离）
pnpm --filter @itookit/<pkg> test     # 单包测试（vitest）
pnpm --filter @itookit/<pkg> typecheck
```

## 构建

| 类型 | 工具 |
|---|---|
| 逻辑包 (`common`, `llm-context`, `vfs-core`, `driver-llm`, `device-tty`, `tools`, `kernel-adapters`, `durable-kernel`, `llm-tasks`, `llm-flow`, `llm-session`, `llm-settings-ui`, `ui-common`, vfsdrivers) | **tsup** (CJS+ESM+.d.ts) |
| UI 包 (`llm-ui`, `vfs-ui`, `mdx`, `app-settings`) | **vite build** |
| 无构建脚本 (`app-core`, `app-shell`) | 由宿主 app（web-app / tauri-app / cli）打包 |

## 项目文档

| 文档 | 内容 |
|---|---|
| [包结构](./doc/pkgstructure.md) | 工作区包与独立 npm 库职责、LLM 四层分层 |
| [架构设计](./doc/architecture.md) | 系统全貌 — VFS / LLM / Agent / Skill / Session / Flow / TTY |
| [运行时架构](./doc/runtime-architecture.md) | `createApplicationRuntime` / `createKernelRuntime` 装配与端口 |
| [集成链](./doc/integration-chains.md) | VFS / Chat / AppShell 端到端调用链 |
| [接口契约](./doc/interface-contracts.md) | 跨包核心接口 + 实现/消费关系 |
| [事件流](./doc/event-flows.md) | Agent / VFS / HITL / TTY 事件消费链 |
| [开发模式](./doc/dev-patterns.md) | 新增 Provider/Connection/Agent/Tool/i18n 流程 |
| [文件索引](./doc/file-index.md) | 场景 → 关键文件快速定位 |
| [Kernel API](./doc/kernel-api.md) | 执行内核 API + 源码结构/存储路径 |
| [Context API](./doc/context-api.md) | 独立上下文模块、持久窗口与 Agent/Chat v2 接入 |
| [llm-tasks API](./doc/llm-tasks-api.md) | Durable Program 层 API + 文件结构 |
| [llm-flow API](./doc/llm-flow-api.md) | DAG 编排层 API + 文件结构 |
| [llm-session API](./doc/llm-session-api.md) | 会话语义/持久化 API + 文件结构/VFS 路径 |
| [联网搜索](./doc/web-search.md) | 三态 WebSearchMode 决策 + citations[] 事件链 + Provider 适配 |
| [CLI HTTP 模式](./doc/http-mode.md) | `-d/--http` 远程模式、`/api/*` 路由 |
| [RunDefinition](./doc/run-definition.md) | CLI/`.flow` → RunDefinition → DagRunSpec |
| [MindOS profile](./doc/mindos-profile.md) | `--profile` / 数据根 / Session lease |
| [最小系统](./doc/minimal-system.md) | 两节点 YAML 与运行说明（含桌面操作教程） |
| [最小系统验收记录](./doc/minimal-system-acceptance.md) | 当前工作树的构建/测试/桌面端到端验收记录 |
| [TODO 与进度](./doc/todo.md) | 目标、已完成范围与待办（活文档） |
| [设计文档](./doc/design/) | 当前设计规范（VFS / harness / flow / skill / session 浏览） |
| [Durable 证据映射](./doc/design/durable-harness-evidence.md) | 五篇 Durable 设计的目标 → 实现 → 持久记录 → 故障证据 |
| [历史设计归档](./doc/feat/) | 已实现特性的设计/评审记录（**归档，不随代码更新**） |
| [已归档文档](./doc/deprecated/) | 一次性评审记录与已被取代的方案（**归档，不随代码更新**） |

> 上表为**活文档**（随代码更新）。改代码时按此表定位对应文档即可，无需全量扫描；`pnpm docs:check` 可校验活文档中的悬空路径与已删除符号。
> 各包的开发说明见 `packages/<pkg>/AGENTS.md`。

## UI 约定

- **技术栈**: 原生 DOM + 模板字符串 + `addEventListener` 委托绑定
- **CSS**: BEM 命名 (`llm-input__xxx`), 变量在 `llm-ui/src/styles/variables.css`
- **图标**: 从 `@itookit/common` import (`ENTITY_ICONS`, `ACTION_ICONS` 等), 禁止硬编码 emoji
- **i18n**: `t('domain.section.item')`, key 在 `common/src/i18n/zh-CN.ts` 先加 → `en.ts` 同步

## LLM 子系统速查

```
LLMProvider (云厂商) → LLMConnection (tier→model) → AgentDefinition (system prompt)
```

- 关键类型: `https://github.com/mushuanli/driver-llm/blob/main/src/types/`（通信）、`llm-context/src/domain/`（消息）、`kernel-adapters/src/llm-management/contracts/`（配置）、`llm-session/src/contracts/`（会话）；从各包公开入口导入
- Provider 实现: `https://github.com/mushuanli/driver-llm/blob/main/src/providers/`
- 联网搜索: `resolveWebSearchStrategy` → `WebSearchMode`（详见 [联网搜索](./doc/web-search.md)）
- 详见 [架构设计](./doc/architecture.md)
