# 前后端目录与模块边界

本规范区分模块加载、应用能力和部署位置。前端负责展示、交互、草稿和视图缓存；后端负责持久数据、业务用例、授权、执行和恢复；宿主选择平台与传输并装配双方。

## 目录归属

所有业务 UI 工作区统一放在 ui/，后端业务工作区统一放在 backend/，app-contracts/common 放在 shared/；apps/ 只承担宿主接线。原 packages/ 已清理，不再使用。独立 UI 库 vfs-ui、mdxeditor 保留在 libraries/，维持 Git 子模块与 npm 发布身份，但加载边界按前端检查。

| 归属 | 目录 | 入口规则 |
|---|---|---|
| 前端 | ui/app-shell、app-settings、llm-ui、llm-settings-ui、mdx-adapter、ui-common 的 src | 不导入后端实现，不创建执行 Runtime |
| 前端独立库 | libraries/vfs-ui、libraries/mdxeditor | 保留通用展示、编辑和注入端口 |
| 后端应用 | backend/app-core/src/application、configuration、settings、projects、session、runtime、host 等 | 不加载 UI、CSS 或 DOM 组件 |
| 后端领域与能力 | backend/ 下的 llm-context、llm-session、llm-flow、llm-tasks、durable-kernel、kernel-adapters、tools、device-tty、sanbox、sync-adapters | 领域契约与实现入口分开 |
| 后端独立库 | driver-llm、piagent-driver、vfs-sync、vfsdriver-* 的实现 | 存储、网络和执行能力由宿主选择 |
| 共享应用契约 | shared/app-contracts/src | 应用 DTO、事件、设置端口、身份与纯变换；无执行或存储实现 |
| 所属领域契约 | 各包公开 contracts 入口及目录 | 类型、命令标识与纯校验；不转发执行类的运行时值 |
| 共享文件机制 | libraries/vfs-core | 文件接口和通用机制；展示文件源可使用 MemoryBackend，不装配应用执行 Runtime |
| 宿主装配 | apps/* 的 main 与平台装配代码 | 本地宿主可同时装配双方，前端模块本身不能反向创建后端 |
| HTTP 双端 | apps/http-app/src/client 与 src/server | client 经 HTTP/SSE；server 持有唯一 ApplicationHost |
| Web 存储适配 | apps/web-app/src/storage | 浏览器内的后端存储能力，不属于设置 UI |

“后端”是职责归属。Web 本地模式的执行与 IndexedDB 适配可以运行在浏览器内；Tauri 本地模式可通过直接 API。HTTP 浏览器只加载前端。当前未把 Web 的本地后端移到 Worker，也未把 Tauri 的整个执行内核移到 Rust 进程。

## app-shell 与 app-core

app-shell 的完整本地入口接收 `services: LocalApplicationServices` 与 `localBackend: LocalBackendPort`，不再接受 backend、平台启动配置或自动创建 Runtime。`AppHandle.services` 不提供 Runtime 的 dispose、openConversation、RunCatalog；宿主拥有运行时生命周期。

```ts
import { createApplicationRuntime } from '@itookit/app-core';
import { bindLocalApplicationServices, createLocalBackendPort } from '@itookit/app-core/host';
import { initApp } from '@itookit/app-shell';

const runtime = await createApplicationRuntime(runtimeOptions);
const app = await initApp({
    services: bindLocalApplicationServices(runtime),
    localBackend: createLocalBackendPort(),
    workspaces,
    ui,
});
// The owning host closes consumers before the runtime.
await app.destroy();
await runtime.dispose();
```

后端服务创建与业务操作在 [local-backend](../../backend/app-core/src/host/local-backend.ts)；独立服务与工厂接口在 [services](../../shared/app-contracts/src/services.ts)，按 files、projects、session、configuration、sync、digital-twin、local 分在 ports/。前端从 app-contracts/services 导入类型，不引用 app-core，包括其类型入口。接口不使用 Pick<ApplicationRuntime>、ConstructorParameters 或服务类的私有类型；宿主适配的返回类型在编译时验证实现满足契约。应用身份与纯路由变换由 app-contracts 共享，app-core 的旧内部路径转发同一份实现。

本地端口仍覆盖较宽的既有领域服务，并含持续文件句柄。它明确用于本地宿主，不能直接 JSON 序列化成 HTTP RPC。远程应用使用 [ApplicationPort](../../shared/app-contracts/src/application/contracts.ts) 的具名查询、命令和事件，通过 app-shell/application 的展示适配接入。模块加载解耦不等于所有本地能力已接入远程协议。

## Settings 与配置导入

- app-settings 保留编辑器、导航投影、表单与展示文件源；SettingsService、LabelStore、导入导出与持久化位于 app-core/settings。
- SnapshotService 位于 Web 存储宿主，通过 SnapshotPort 注入。Node/Tauri 未提供快照适配时，写维护操作明确拒绝；不会误操作浏览器数据库或关闭 VFS 后假成功。
- 存储估计、主题和日志偏好通过设置端口访问。浏览器存储 API 不出现在设置 UI。
- llm-settings-ui 保留文件选择、格式解析提示、冲突选择和结果展示。冲突查询、ID 分配、关联重映射、凭据保留与按依赖顺序保存由 app-core/configuration/configuration-import 执行；ConfigurationImportPort 属于配置领域契约。
- llm-ui 保留交互命令、投影与视图缓存，通过 Session/Task/Conversation 公开端口调用。UI 的 services 或 commands 文件夹名称不表示后端实现。

## 策略与机制

项目归属、配置关联、导入冲突、执行授权和产品默认值属于应用策略；存储事务、网络传输、通用格式与任务调度属于机制。页面布局、选择和展示筛选是前端策略。按职责分别组织，再通过契约连接，不能将所有策略都放到前端。

## 验证与限制

`pnpm modules:check` 检查所有前端、后端与共享生产源码的传递运行时依赖，包括 re-export、动态 import 和 require；应用类型引用也受检查：UI 和共享层禁止引用 app-core；后端和共享层禁止引用 UI。领域类型通过中立 contracts 入口引用。检查同时覆盖 HTTP client/server 和 CLI 后端入口。通过共享 barrel 间接加载另一端也会失败。

`pnpm modules:buildcheck` 将八个前端包的完整公开根入口一起构建，构建图出现后端实现即失败。HTTP Vite 和服务端 tsup 另检查实际构建输入；这两种检查补充源码守卫，避免只靠 tree shaking 或 package.json 判断边界。

物理目录、独立应用服务接口与加载边界已实施。完整 HTTP 工作区迁移继续按 [应用宿主迁移评审](application-host-migration-review.md) 推进：项目、挂载、收藏、完整设置、工具箱、数字分身及 Flow 的远程能力尚未全部覆盖。这里不以隐藏入口、宽服务类型或本地测试替代完整 HTTP 功能验收。


## 2026-10-14 目录隔离验收

- 六个业务 UI 包位于 ui/；十一个后端包位于 backend/；app-contracts/common 位于 shared/。八个独立库仍在 libraries/，其中 mdxeditor/vfs-ui 按前端检查；demo 移至 apps/demo。原 packages/ 已删除。
- 冻结锁文件离线安装与工作区实际链接检查通过；包名、公共入口和独立库 Git 子模块身份保持一致。
- 全仓类型检查、架构/目录/应用类型边界、文档和样式检查通过；脚本套件 45 项通过。
- 八个前端公开根入口的聚合构建通过，没有加载后端实现。所有有构建脚本的业务包/独立库、Web、Tauri 前端、HTTP 前后端、CLI 构建通过；llm-ui 的公开声明检查通过。
- pnpm test 完整矩阵退出码为 0：包括 app-core 510、app-shell 640（另 30 跳过）、HTTP 43、CLI 常规 202、CLI 崩溃恢复 22；Rust 沙箱 8、Tauri Rust 62 全部通过。
- npm registry 工作区 prepare-only 与目录迁移用例通过。后续补丁替代发布将 driver-llm 升级到 0.2.2、vfs-ui 升级到 0.5.8，已删除 patches/ 和补丁配置生成逻辑；详见 [独立库发布记录](npm-library-consumption.md)。本轮未执行完整 registry 安装/构建或桌面 GUI 验收。
