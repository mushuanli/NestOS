# VFS / Session 重构实现与验证

日期：2026-09-09。当前规范见 [C4、目录与接口](vfs-c4-review.md)。这是当前工作区实现状态，不代表已发布版本。

## 已完成

- 系统根与 `/home/admin` 用户目录分离；`/run` 为内存来源；移除旧模块注册、隐式系统映射、全局工具文件上下文和 manager 便捷 IO。
- `SessionRepository` 按 Session ID 创建、查询和持久化。元信息、设置及挂载配置在 `session.seq`，Round/history/profile 在 `history.seq`，附件在同一 Session 的 `attachments/`。没有 `conversation/` 或 `.chat` 身份依赖。
- Session 用户文件视图默认仅 `/attachments/`；显式挂载后才增加工作目录。历史与系统数据经业务服务读取，不进入普通文件上下文。文件工具和搜索使用当前 Session 上下文。跨 Session 只读映射与来源撤销已有集成测试；编辑器附件子视图也随 Session 撤销，上传不能绕过文件上下文。
- `SessionWorkbench` 使用 vfs-ui 与可写 SessionBrowser 投影（`createSessionBrowser` 以 `access: 'rw'` 创建，实现位于 `backend/app-core/src/session/session-browser.ts`）。Session 默认 main 聊天，直属仅 tasks/files；Task 查询执行历史，映射文件通过所属 Session 上下文打开和保存。投影支持 Session/文件夹 CRUD 与 `/files` 下的文件 CRUD；files 直接代理实际受限上下文，不依赖隐藏系统目录。分支草稿独立保存，旧手写侧栏已删除。接口与 C4 见 [Session 浏览实现](vfs-session-browser.md)。
- 公开 `EditorOptions.nodeId/ownerNodeId` 已移除；文件、Session、实体通过 `EditorTarget` 区分。历史、上传、资产管理和打印使用明确的 Session 附件来源。
- `SessionManager.bindSession`、Session runtime/TaskInput 仅保留真实 Session ID；Flow 创建会话返回 `{ sessionId }`。消息和 DAG 的节点 ID 保留其业务含义。
- 文件元数据、records、搜索、事件和附件均经过视图边界；backend records 使用 backend-local 坐标。内部模块字段统一为 viewId。
- SQLite schema 4 拒绝旧版本；IndexedDB schema 5 可从完整 v3/v4 数据库升级，补齐目录父路径与类型查询索引，更旧或缺失必需 store 的结构报错。
- Web/Tauri/CLI 接入新目录和来源。Tauri 外部目录独立于全局根；卸载先销毁工作区，应用关闭先释放消费者再释放来源。启动失败清理已打开的来源。
- `/add-dir <dir> [r|w]` 默认 rw，`r` 只读；`/set-home <dir>` 只保存偏好。files 的“＋”和主视图共用挂载弹窗，支持应用目录选择、默认目录、权限/cwd、卸载和重连。默认目录显式挂到 `/workspace`。
- 授权变更使旧工具/编辑器上下文失效，清理 adapter 缓存，重载聊天保留当前 branch 和草稿；存在非终态 Task 时拒绝变更。来源失效保留挂载身份并拒绝内容访问。
- 目录来源及默认目录偏好放在受保护的 `/var/lib/kernel/local-sources/session-directories.json`，不存于 Agent 可挂载的用户配置目录。
- Tauri 使用目录 scope 的原生 IO，拒绝路径逃逸、符号链接及关闭后的 scope；规范化同源目录复用 backend。LocalFS 不再按 `__` 名称重定向内容，真实项目目录如 `__tests__` 保持原位置。
- C4 图、流程及接口文档已同步为当前实现，原设计中的迁移提案明确作废。

## 验证

下表为 2026-09-09 在工作区的实测结果：各包用 `pnpm --filter <pkg> test`（llm-ui 无 test 脚本，用 `exec vitest run`），Rust 用 `cargo test --lib`，类型检查用各应用 `typecheck`。跨包批次不同步，计数随代码漂移，以对应命令的实际输出为准；历史批次可从 Git 查阅。DOM 测试覆盖 vfs-ui 到宿主路由、映射保存、挂载管理与分支保留，不代替原生 GUI 验收。

| 检查 | 结果 |
| --- | --- |
| vfs-core | 172 通过 |
| app-core | 8 通过 |
| durable-kernel | 180 通过 |
| llm-flow | 132 通过 |
| kernel-adapters | 82 通过 |
| llm-session | 85 通过 |
| app-shell | 154 通过，30 跳过 |
| vfs-ui | 88 通过，含真实 DOM 导航 |
| llm-ui | 15 通过 |
| vfsdriver-indexeddb | 15 通过 |
| vfsdriver-local | 54 通过，含独立 OS 进程与 SIGKILL 恢复 |
| CLI 全套 | 71 项中 70 通过；1 项失败（supervisor 循环分派），以实际输出为准 |
| mdxeditor | 本工作区未安装 vitest，未执行 |
| Web / Tauri / CLI TypeScript | 通过 |
| Rust 单元测试 | 12 通过（directory_boundary、scoped_directory、session_bash、bash_process、sidecar）；完整 Tauri cargo check 仍受 glib-2.0 缺失阻塞 |
| Mermaid | 总体、浏览、挂载共 9 张设计图解析通过 |

跳过测试没有计入通过数。历史回归日志是临时文件，不作为当前依据。

## 明确边界

- 未执行真实 GUI 人工验收。完整 Tauri cargo check 下载依赖后被环境缺少 glib-2.0 开发库阻塞，不能以独立 Rust 模块测试替代整机编译验收。
- SessionFS 是文件能力边界，不是操作系统 sandbox；原生 IO 的路径检查也不是抵抗外部宿主恶意换链的完整 OS 沙箱。Tauri 受限 Session 不再注入无约束宿主 shell、原生 skill handler 或本地 Codex app-server；进程执行改由 Bubblewrap runner 实施（`apps/tauri-app/src-tauri/src/session_bash.rs`、`apps/tauri-app/src/shell/session-bash.ts`，经 `backend/app-core/src/vfs/session-process-context.ts` 与 `apps/tauri-app/src/main.ts` 接线）：除固定的运行库/系统资源外只绑定显式 Session 挂载，只读挂载用 `--ro-bind`、可写挂载用 `--bind`，cwd 必须落在授权挂载内，不继承宿主环境变量。它不隔离网络，也不是完整 OS 沙箱。
- Web 当前支持应用内目录挂载；Tauri 另支持宿主目录。Web File System Access provider 和 CLI slash UI 不属于本次实现。
- Session 挂载配置由单宿主协调；没有宣称多宿主同时修改 history 和挂载的完整 fencing 协议。
- 工作区归档不是完整 Session/Kernel 系统快照，跨来源 restore 不具备全局事务原子性。
- Session 原始目录删除只经业务生命周期：`SessionLifecycleService`（`backend/app-core/src/session/session-lifecycle.ts`）按 `closeSession(id, true)` → 等待 `sessionStat(id).phase === 'closed'` → `removeSession(id)` → `repository.deleteSession(id)` 执行，其中「等待」上界 `closeTimeoutMs`（默认 30s）也覆盖 `closeSession` 调用自身——在途 Effect 不确认停止时报 `EBUSY` 而不是无限等待，任一步失败都保留全部数据并报 `EBUSY`；`session-browser.ts` 对 Session 与文件夹递归复用该链路，不把文件树删除直接接到数据根。本轮仍不提供自动 Session 数据 GC；关闭编辑器、禁用文件视图都保留 Session 历史与后台任务。后续数据回收须由业务生命周期协调。

上述边界没有通过保留旧接口来补偿。旧数据版本不兼容应报错，由用户重建数据，不能自动回到旧布局。

Session 浏览当前边界：Task 列表、版本及事件已有存储分页，界面提供继续加载；旧存储首次建索引仍可能全量扫描。URL 已编码 branch，路由回放传递指定分支；文件树提供 Session/文件夹 CRUD 与 `/files` 文件 CRUD。详见浏览实现文档。历史验证日志为临时文件，不作为当前依据；验证以各包测试命令的实际输出为准。
