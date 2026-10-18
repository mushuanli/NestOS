# AGENTS.md — AI 助手配置

## 语言
- 始终使用**中文**交流
- 代码注释用英文，Git commit 用 Conventional Commits (`type(scope): description`)

## 项目概览
- **itookit**：pnpm monorepo，承载 **MindOS**（浏览器/桌面的个人知识 OS：虚拟文件系统 + Markdown 编辑器 + LLM 对话/Agent 执行）
- 工具链：`pnpm@10.20.0`（`workspace:*`）、TypeScript 5.9 strict（`target: ES2022`、`moduleResolution: bundler`，见 `tsconfig.base.json`）
- 无前端框架：原生 DOM + TypeScript
- 20 个业务/共享 package（`ui/`、`backend/`、`shared/`）+ 9 个独立库源码工作区（`libraries/`）+ 5 个 app + 共享 Node 宿主适配包，详见 [包结构](./doc/pkgstructure.md)

## 开发原则
SOLID / DRY / KISS / YAGNI / CoC / LoD — 函数≤30行，圈复杂度≤10

- 非通用业务通过独立的外部 Tool 包与 Flow 定义接入；新增核心代码只提供通用机制，不内置具体业务的字段、提示词、模板、打包实现或按工具名分支。
- Flow 可以确定性调用 Tool，Agent 模型调用只是另一入口。平台负责授权、版本、连接绑定及持久执行；工具负责业务规则与副作用核对。详见 [策略与机制边界](./doc/design/application-policy-boundaries.md)。

## 常用命令

```bash
pnpm dev                              # Web app 开发服务器
pnpm build:libs                       # 构建 ui/backend/shared/libraries 工作区
pnpm typecheck                        # 全仓类型检查
pnpm docs:check                       # 活文档与代码同步检查
pnpm styles:check                     # markup 类名 ↔ CSS 规则一致性检查
pnpm test                             # 全量测试矩阵（含 Rust 边界；crash-matrix 自动隔离）
pnpm --filter @itookit/<pkg> test     # 单包测试（vitest）
pnpm --filter @itookit/<pkg> typecheck
```

## httpd 日志与运行版本

- 排查 httpd 默认查看 release 日志：运行日志 `/var/log/mindos/httpd.runtime.log`，审计日志 `/var/log/mindos/httpd.audit.jsonl`；轮转文件追加 `.1`、`.2`、`.3`。
- `MINDOS_HTTPD_LOG_DIR` 可覆盖日志目录，`--audit-file` 可单独覆盖审计文件；以启动参数和启动输出为准。部署时需确保日志目录由运行用户拥有并可写。
- 当前运行版本通过携带客户端证书请求 `GET /api/health` 的 `version` 字段核对；运行日志中的最新 `Version:` 为启动版本。`release/httpd/current.json` 仅表示下次启动选用的 release，不能代替运行版本核对。
- 版本 ID 格式为 `<UTC构建时间 YYYYMMDDTHHmmss>-<Git提交前8位>[-dirty]`，文件名和日志目录不带版本。查询命令见 [HTTP 宿主发布与诊断](./doc/http-app.md#启动与认证)。

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
| [文档导航](./doc/README.md) | 按架构、API、运行与设计主题查找当前文档 |
| [协议历史背景](./doc/feat/README.md) | 当前协议仍引用的三份历史材料（不作为当前 API 依据） |

> 上表为**活文档**（随代码更新）。改代码时按此表定位对应文档即可，无需全量扫描；`pnpm docs:check` 可校验活文档中的悬空路径与已删除符号。
> 各包开发说明见 `ui/<pkg>/AGENTS.md`、`backend/<pkg>/AGENTS.md`、`shared/<pkg>/AGENTS.md`；目录边界见 [前后端模块](./doc/design/frontend-backend-modules.md)。

## UI 约定

- **技术栈**: 原生 DOM + 模板字符串 + `addEventListener` 委托绑定
- **CSS**: BEM 命名 (`llm-input__xxx`), 变量在 `llm-ui-adapter/src/styles/variables.css`
- **图标**: 从 `@itookit/common` import (`ENTITY_ICONS`, `ACTION_ICONS` 等), 禁止硬编码 emoji
- **i18n**: `t('domain.section.item')`, key 在 `common/src/i18n/zh-CN.ts` 先加 → `en.ts` 同步

## UUID 与稳定身份

- 跨平台、浏览器及 WebView 代码禁止直接调用 `crypto.randomUUID()`；HTTP 局域网地址和部分 WebView 中该方法可能缺失或抛错。需要 UUID v4 时，从 `@itookit/common` 公开入口使用 `randomUUID()`，不要用 `generateUUID()`、时间戳或临时拼接代替 UUID v4。
- 独立库保持既有依赖边界，复用库内兼容 UUID 工具或注入 ID 生成器，不为生成 UUID 引入应用包；涉及此类代码的修改应覆盖原生 `randomUUID` 缺失和抛错的回归场景。
- 草稿首次提交复用已分配的 Session ID；同一次提交及其重试保留稳定身份，不在渲染、刷新或重试过程中重新生成会话或操作 ID。

## LLM 子系统速查

```
LLMProvider (云厂商) → LLMConnection (tier→model) → AgentDefinition (system prompt)
```

- 关键类型: `https://github.com/mushuanli/driver-llm/blob/main/src/types/`（通信）、`llm-context/src/domain/`（消息）、`kernel-adapters/src/llm-management/contracts/`（配置）、`llm-session/src/contracts/`（会话）；从各包公开入口导入
- Provider 实现: `https://github.com/mushuanli/driver-llm/blob/main/src/providers/`
- 联网搜索: `resolveWebSearchStrategy` → `WebSearchMode`（详见 [联网搜索](./doc/web-search.md)）
- 详见 [架构设计](./doc/architecture.md)
