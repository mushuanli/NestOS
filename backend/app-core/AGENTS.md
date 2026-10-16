# @itookit/app-core

平台无关的**应用用例与装配层**：封装项目组织、配置关联操作等应用策略，并把 VFS / LLM 设备驱动 / durable-kernel / kernel-adapters / llm-session / llm-flow 装配成运行时，供 Tauri、Web 与 CLI 共用。详见 [运行时架构](../../doc/runtime-architecture.md)、[包结构](../../doc/pkgstructure.md)。

## 定位与铁律

- **平台无关**：`src/` 内不出现 `node:*`、DOM、`window`、`localStorage`；宿主差异一律通过注入传入（`ApplicationKernelPlatform`：`createSessionProcesses` / `skillSourceForSession` / `configureSession` / `configure`）。
- **依赖只朝下**：只依赖共享 `app-contracts`、`llm-context`、`common`、`vfs-core`、`durable-kernel`、`kernel-adapters`、`llm-flow`、`llm-session`、`llm-tasks`、`tools`、`driver-llm`、`vfs-sync`、`piagent-driver`（harness 类型端口及纯 authorization 校验入口）；不得依赖 `app-shell`、UI 包或任何 app。
- **用例与装配分开**：应用策略放入 configuration/projects/session 等可单测服务；`runtime/` 负责接线与生命周期，不内联业务用例。宿主差异通过端口注入，DOM、导航与确认交互归 app-shell。
- **显式公共出口**：`src/index.ts` 按需导出服务与契约，不使用 `export *`，内部实现与辅助函数不默认公开。`pnpm architecture:check` 检查生产源码与运行依赖的层次边界。
- `js-yaml` 仅作为明确允许的纯编解码依赖；平台 I/O 仍由宿主端口提供，不据此开放任意 SDK 依赖。
- 无构建脚本：`main` 直接指向 `src/index.ts`，由宿主 app（web-app / tauri-app / cli）打包。

## 结构

```
src/
├── index.ts                     统一导出（历史别名 createMindOSRuntime/MindOSRuntime 已于 2026-09-11 移除）
├── runtime/
│   ├── infrastructure.ts        VFS + LLM 设备驱动（/run 挂载、设备注册与冻结、固定用户布局预热）
│   ├── create-kernel-runtime.ts 平台无关 Kernel 组合：Kernel + kernel-adapters + Durable programs
│   ├── session-recovery.ts      Session 租约获取/恢复循环与心跳（可单测服务）
│   ├── conversation-system.ts   会话系统装配（工具过滤、Session 上下文、生命周期）
│   ├── workspace-scope-cleanup.ts 工作区清理前等待后台成员并关闭 Run 能力作用域
│   └── create-application-runtime.ts 应用运行时装配：VFS → LLM → 会话/Flow → 租约与恢复 → RunCatalog
├── configuration/               工具箱资源/分组/目录、模型关联删除与工具授权
├── projects/                    项目生命周期、会话组织查询/命令、项目归档与业务目标
│   ├── drafts/                  项目草稿策略 service / 端口 contracts / 事务 store / 数据校验 record-codec
│   ├── favorites/               项目收藏：contracts 端口 / policy 纯函数 / store SeqFile 事务 /
│   │                             service 同项目串行 / lifecycle 提交事件适配 / routes 收藏解析
│   └── execution/               remote-provider 适配共享文件+进程端口，policy 集中授权与隔离校验
├── session/                     Session 语义与数据交换（可依赖 vfs/）
│   ├── browser-routes.ts        纯路由解析与目标归属（无 repository/Kernel/VFS I/O）
│   ├── session-browser.ts       浏览器侧数据投影与 VFS 适配
│   ├── session-bundle.ts        会话导出/导入格式（带版本与校验）
│   ├── session-lifecycle.ts     Session 删除顺序与有界等待（含 closeSession 调用本身的上界）
│   ├── session-route.ts         路由解析
│   └── workspace-paths.ts       /home/admin/<name> 数据根工作区路径
├── vfs/                         Session 文件与挂载域服务（VFS 视图/后端）
│   ├── session-files.ts         Session 命名空间（revision CAS + per-session 串行队列）
│   ├── directory-mounts.ts      宿主目录挂载（DirectorySourceProvider 端口）
│   ├── session-attachments.ts   Session 附件挂载
│   ├── session-process-context.ts Session 进程上下文（native shell/tty 注入点）
│   ├── workspace-process-context.ts 同一授权 revision 的隔离文件视图与原生进程挂载获取/清理
│   ├── errors.ts                结构化错误（宿主本地化；本包不写用户文案）
│   ├── tool-context.ts          工具可见 VFS 上下文（readFile/writeFile/listFiles/stat）
│   ├── workspace-namespace.ts   项目工作区规范命名空间（/workspace 与相对路径换算）
│   └── unavailable-directory.ts 挂载源缺失时的占位目录
├── kernel/
│   ├── session-lease.ts         Session 单写者租约（CAS + fencingToken，默认 TTL 60s）
│   ├── sync-skills.ts           Skill catalog → Kernel 同步
│   └── privileged-command-service.ts 受限 plan/exec 命令
├── profile/mindos-profile.ts    数据根解析（mindos.json#rootDir）
├── run/
│   ├── run-definition.ts        RunDefinition 契约 + FlowRevision 编译
│   └── run-catalog.ts           Run 目录投影（flow-root 任务）
└── core/WorkspaceController.ts  工作区控制器接口
```

## 入口

```ts
// 完整应用运行时（Tauri / Web / CLI 共用）
const runtime = await createApplicationRuntime({ backend, additionalMounts, ownerKind, kernelPlatform });

// 只要 headless Kernel（CLI 子 harness 等）
const kernel = await createKernelRuntime({ systemFS, llmDriver, storageResolver, recover: false });
```

`createApplicationRuntime` 的顺序是：`createInfrastructure`（VFS + LLM 驱动）→ 核心服务（agent/flow/session files/mounts）→ `createKernelRuntime` → 取租约并**后台**恢复租约集合（`recoverSessionsWithLeases` 只等每批最多 100 个 Session 的批量租约事务与最多 10 路并发宿主核对）→ 会话系统（`initializeConversationSystem`）→ 默认 Flow 播种 → `RunCatalog`。恢复不再阻塞宿主首屏：写入门（`acquireLater`）与结构写（`acquireMetadataLease`）等待该 Session 所属的批量恢复完成，失败向写入方报错并保持拒写；`release()` 等待在途恢复后再释放租约。释放走 `cleanupFns` 逆序 + `AggregateError`，VFS 最后释放。

## 约束

- 工具路径相对 cwd 做 POSIX 解析（支持 `../reference`），再交给挂载视图授权；项目编辑器以 `/workspace` 为规范根（`vfs/workspace-namespace.ts` 是唯一换算点），source view 和导航路由只用于内部操作/展示。`openFiles()` 是 source view，`openWorkspace()` 才是编辑器/执行的规范视图。
- 项目根是独立文件空间：新建本地根、远程绑定和访问均校验重复/父子重叠；旧重叠映射拒绝访问并保留数据。远程项目以 source.kind=remote 和 project:<id> 逻辑引用保存，不创建本地正文目录。SessionFiles.workspaceProvider 拥有远程来源句柄并随视图释放，本地来源继续沿用授权目录；远程根缺失不得回退本地。
- 浏览器投影不得逐节点回查目录catalog：`session-browser` 每次列目录解析一次 `FileProjection`（项目、远端授权、收藏查询）；浏览器目标归属文件夹统一走 `browserTargetFolder`，Session 归属只认 manifest。
- `projects/execution` 从远程项目根与服务器能力派生临时目录执行上下文；不依赖旧的持久绑定。只读目录要求进程侧内核强制权限。
- `projects/execution` 将 contracts（来源/工作区端口）、policy（当前挂载、隔离能力与远程进程命名空间校验）、service（获取/释放编排）、remote-provider（端口适配）分开。远程根目录默认使用服务器声明的执行能力，不持久化工作台执行开关；旧 execution 记录不再读取。服务器不支持执行时保持文件访问，不得回退宿主 Shell。`REMOTE_EXECUTION_ISOLATION` 是自动派生执行上下文的隔离要求。
- 收藏读取会校准 Session 标题与成员（`ProjectFavorites.list`），因此 `list()` 可能发布一次变更通知；`has`/`hasSession` 只读缓存，调用方需先 `list`。`FavoriteUpdate` 必须保持纯函数（store 可能调用多次）。

- Session 与 Kernel 的所有写入都必须先持有 Session 租约（`SessionLeaseStore`）；拒租只让该 Session 保持只读，不影响其他 Session。该「只读」由 `createApplicationRuntime` 注入的写入门强制（`ensureWritable` → `recovery.acquireLater` → `initializeConversationSystem.canWriteSession` → `SessionManager.sendMessage`），被拒的 Session 会在追加 round 前报 `Session is owned by another host`。
- `ApplicationKernelPlatform.configure(kernel, services)` 在 Session 恢复扫描前等待完成；`services` 提供已初始化的 `sessionFiles`/`directoryMounts`，宿主可据此绑定工作区工厂。
- 修改挂载前必须确认该 Session 没有未结束的 Task（`mountGuard`）。
- Context GC 只登记已授权恢复/执行的 Session；完整应用每个 Task 前检查租约，关闭作用域先等待维护事务。策略和可达性算法在 context，事务适配在 kernel-adapters，装配层不裁剪历史根。
- `SessionFilesService.acquireWorkspaceFiles` 为宿主提供独立工作区视图：替换唯一匹配的现有挂载，来源由宿主提供；默认 rw 要求原授权可写，可选 ro 将全部用户挂载同时降权而不改持久授权。原授权配置改变、禁用或服务销毁时撤销全部派生工作区视图。运行时已透传 `scopeForEffect`/`fileContextForScope` 到 kernel-adapters；提供作用域文件工厂时默认按 llm-flow 持久成员及工作区租约选择 Run。Tauri 已连接独立副本文件视图、进程映射及释放，并在成功取得 Session 写租约后的 beforeSessionRecovery 回调核对创建意图。
- 用户可见文案不写在本包：结构化错误（宿主可分支/本地化，见 `src/vfs/errors.ts`）或 `t()` 键（文案在 `@itookit/common`）。`tests/no-user-copy.test.ts` 守卫本包源码不含 CJK 文案。
- 长耗时启动步骤应经 `traceBoot`/`logStep` 暴露进度，便于宿主显示启动状态。

## 运行

```bash
pnpm --filter @itookit/app-core test        # vitest：目前 39 文件 / 215 用例
pnpm --filter @itookit/app-core typecheck
```

> 本包模块的测试已在 `tests/`（2026-09-11 从 app-shell 迁回，app-shell 的兼容 re-export shim 全部删除）；app-shell 只保留其 UI 层测试。

## 相关文档

| 文档 | 内容 |
|---|---|
| [运行时架构](../../doc/runtime-architecture.md) | 装配顺序、端口注入、headless Kernel 组合 |
| [接口契约](../../doc/interface-contracts.md) | 跨包接口与实现/消费关系 |
| [VFS Session 挂载访问边界](../../doc/design/vfs-session-mount-access.md) | 命名空间、挂载与授权语义 |
| [Session 浏览](../../doc/design/vfs-session-browser.md) | `session-browser` 的路由与投影契约 |
| [MindOS profile](../../doc/mindos-profile.md) | 数据根与 Session 租约规则 |

- 项目收藏位于 `projects/favorites/`：contracts 定义存储/变更端口，policy 无 I/O，store 封装 SeqFile 事务，service 串行化同项目读写，lifecycle 适配 VFS 提交事件；UI 跳转展示策略留在 app-shell。

- `digital-twin/` 提供 DigitalTwinService：来源、Kernel 提取、审核、默认知识检索、发送前校验、目标与遗忘；SeqTwinStore 以固定索引页和版本链实现原子存储/清理，只用公开 VFS 契约，不访问数据库内部。native-service 负责运行时装配，UI 在 app-shell。普通 Memory 工具不读写分身资源。支持规模、布局版本和适配器局限见 [数字分身设计](../../doc/design/digital-twin.md)。
- 扫描计划与运行在 `digital-twin/scan-*` 和 `scans.ts`；SeqFile CAS 保存队列、检查点和宿主 fence，Kernel 负责实际提取任务。默认串行、在线 15 秒检查；自动触发是间隔/变化轮询。Runtime 退出先关闭扫描，CLI 一次性管理用 `digitalTwinAutoStart=false`，`twin watch` 显式开启；不把界面页面生命周期当作后台服务生命周期。

- `browser-routes.ts` 是路由语义唯一来源；显式的 Session manifest `folder: null` 表示根目录，不回退到陈旧路由前缀。远程 provider 的实例方法必须保留 receiver，不能取出后无绑定调用。

- 作文业务预设位于 `src/presets/essay-review.json`，以声明数据保存提示词与参数；`presets/default-flows.ts` 只负责复制和播种。产品文案不得混入通用 Session 机制。
- `contextEngineOptions` 与 `agentResolution` 由应用装配透传；Conversation 系统的清理使用返回实例的 dispose，不重置进程单例。

- UI 模板目录位于 `src/presets/essay-review-isolated.json`，公共 `createMindosFlowLibrary()` 返回副本；Web/Tauri 显式接入 UI 的安装、恢复和菜单机制。产品提示词不进入 llm-ui 包。

MindOS 默认工具列表属于 `src/presets/harness-tools.ts`，通过 app-core 公共出口供 app-shell 装配聊天与 Agent 设置 UI；禁止从公共配置契约读取产品默认授权。

MindOS Agent 默认执行策略位于 `src/presets/direct-agent.json`，createMindosDirectAgentPolicy 返回副本；ApplicationRuntimeOptions.directAgentPolicy 可替换整个策略（包括空对象），会话装配显式注入，不在 Session 机制中保留产品指令。

- `projects/sync` 封装项目同步策略与绑定生命周期，`ApplicationRuntimeOptions.sync` 注入宿主 provider/coordinator 后开放 `runtime.projectSync`；默认不创建连接。文件机制归 `vfs-sync`，具体 HTTP 与 IndexedDB 不进入本包。

- `projects/project-directory-recovery.ts` 恢复有数据的工作台直属旧目录：条件补建 info.seq、沿用旧项目身份与会话归属；不移动正文，读取故障或根重叠不能当作不存在。

- 分身扫描规则通过 `scan-rules` / `source-index` 维护自动来源；`project-catalog` / `harness-reader` 复用项目与会话公开接口。文件的到期检查核对正文 hash，失败范围不推断删除。新规则全局模型/预算，明确主体信息自动生效；layout 4 原子迁移 2/3，旧指定来源计划保留兼容。

- 扫描 `focus` 随 run/scope 固化并参与检查点身份；无关注点的旧检查点保持兼容。规则停用或删除保留知识快照，`retained` 不代表继续读取源文件；全局排除仍使其失效。`graph.ts` 从可用记忆派生图，人物合并通过 entity 映射与版本检查点完成，不能按同名自动合并。

- 数字分身仅自动加入邮件；普通工作区目录由 `workspace-catalog` 补充发现，菜单显式规则按来源身份匹配、最具体范围决定类型。`selection` / `identity` 封装类型与用户身份；移除来源清理派生知识但保留禁用定位记录，禁止永久墓碑阻止显式重新加入。

启动扫描：项目身份目录最多 4 路并发，initializeSources 复用身份扫描并仅在目录变更后重读；Session 租约通过 acquireMany 在同一事务批量观察并提交，保持单写者与 fencing token。并发核对失败先排空在途工作再清理租约，Kernel 批量恢复必须等待全部核对成功。回归见 session-recovery、session-lease、map-concurrent、projects 与 http-app 的 storage 测试。

- `settings/` 承载设置持久化、标签和维护用例，存储快照由宿主 SnapshotPort 注入。`host/application-client.ts` 创建本地服务端口和 UI 服务绑定；contracts 子入口只导出类型，不能重新导出实现的运行时值。
- backend.settings 等待 SettingsService.init 后返回已就绪端口；工作区描述与文件视图分开，SettingsFiles 按操作解析声明的 workspace 身份。OCR 自行共享并等待首次配置读取，readSettings/label/ready 不生成默认配置；仅显式 prepareConfiguration/preparePromptEditor 创建默认值。设置的延迟文件视图与 configFiles 必须保持宿主原有写保护。

- configuration/skills-files.ts 拥有技能文件系统与服务订阅，tool-groups.ts 拥有产品默认工具分类；toolbox-resources.navigation 聚合目录、分组与说明。host.toolboxView 不接收前端文件系统，返回后端准备的 initial 快照与实时端口。导航初始化/刷新不回调浏览器取数。
- Skill 的非空导入与所有写入必须先解析、校验再保存；存储错误不得触发空白资源回退，身份变更的旧记录删除失败必须报错。媒体授权转换由 DigitalTwinService.authorizeMedia 统一处理，语音 input/instructions 保持独立文本边界；Runtime 只接线。媒体回执通过 Kernel.inspectSession 按身份定位存储，不枚举其他 Session。
