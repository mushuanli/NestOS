# Session 挂载与访问边界

状态：已实现，2026-09-09。本文替代“完整 SessionFS 加隐藏目录”和“打开时自动挂载 admin-home”的旧行为。平台能力及验证限制见第 5、7 节。

## 1. 核心契约

Session 可访问的用户文件 = 自有 attachments + 持久化的会话挂载。Tauri/CLI 默认项目使用宿主当前目录，Web 默认项目使用 VFS 目录；项目会话把所属项目目录授权为 `/workspace`（rw）。主目录设置仅供查看，不降低文件读写权限，额外挂载可独立增删。应用 profile 的 `rootDir` 是会话记录/配置的存储根，与工作目录分开。

- 来源注册只意味着宿主能够连接该来源，不授予任何 Session 访问权。
- 未挂载目录不能通过列目录、绝对路径、搜索、编辑器、附件引用或后台 Task 访问。
- vfs-ui、文件编辑器、文件工具使用同一份受限文件上下文；侧栏不是授权过滤器。
- 挂载点不能占用 `attachments`、`etc`、`var`、`dev`、`run`、`history`、`session` 等保留名称；这些路径不进入用户文件上下文。Session 历史与 Task 信息继续由 repository/Kernel 业务接口提供。可信运行时需要的系统投影不通过用户文件工具公开。
- 挂载对整个 Session 生效，包含各 history branch；branch 是对话状态，不能隐式更改授权。

附件沿用唯一的 `/attachments` 命名，不添加 `/attachment` 别名。

## 2. 目录

未配置默认目录的 Session（例如 Web）：

```text
<sessionId>/
  tasks/
  files/
    attachments/          Session 自有附件，可读写
```

用户选择目录后，例如：

```text
<sessionId>/
  tasks/
  files/
    attachments/
    workspace/            rw → /home/admin/projects/demo
    notes/                ro → /home/admin/notes
    reference/            ro → 用户选择的宿主目录
```

files 是 Browser 前缀。Agent 和编辑器使用 `/workspace/src/a.ts`，不使用 `/<sessionId>/files/workspace/src/a.ts`。

挂载点采用根下一层名称，UI 默认建议 workspace 或来源目录名；名称冲突要求重新命名。未挂载时不生成空 workspace、mounts、home 等目录。禁止挂载 `/`、覆盖 attachments、重叠挂载或占用系统保留名称。vfs-core 仍保留通用组合能力，这些约束由 SessionFilesService 实施。

项目会话的 cwd 固定为 `/workspace`；没有工作区授权的旧会话 cwd 为 `/`；根只能列目录，不能凭空创建未授权的顶层路径。仅未归属项目的会话可勾选“设为工作目录”，或移除当前工作目录后回到 `/`。项目主挂载不能被移除、重定向或改权限，附加挂载不能改变 cwd。

Session 持久布局保持 `/var/lib/sessions/<id>/{session.seq,history.seq,attachments/,...}`，跨 Session 的文件夹索引在 `/var/lib/sessions/folders.seq`。用户挂载是映射，不复制到 Session 目录，卸载不删除来源。上传附件则是复制进当前 Session，不能因此获得对原附件所在目录的访问权。

## 3. UI

llm-ui 标题栏「工作目录与挂载」与标题栏/输入工具栏右键菜单共用宿主 `directoryCommands.configureWorkspace` 接口。项目会话显示「查看项目工作目录」及挂载管理：主目录仅展示和重连，附加目录可切换权限、重连和移除。未归属项目的会话仍可替换 `/workspace` 映射并保留其他挂载。附加目录默认只读；工作目录默认读写。运行中 UI 禁用入口，宿主继续拒绝任何非终态 Task 期间的授权变更。

Tauri 在创建 Session 返回前完成启动 cwd 的默认挂载；已显式设置的默认目录优先。CLI 未指定 `workspace.root` 时使用调用进程 cwd，显式相对路径仍相对于 Flow 配置文件。CLI 重开 Session 保留已保存挂载；`--set-home` 显式替换主目录。本机选择器与 CLI 路径使用 `host:` 解析，避免与 `/home/admin` 应用命名空间混淆。

files 行提供一个“＋”动作，点击 files 主视图顶部也提供“挂载目录”和“管理挂载”。两处复用同一个挂载弹窗（`ui/app-shell/src/files/mount-dialog.ts`）与宿主控制器 `DirectoryMountService`（`backend/app-core/src/vfs/directory-mounts.ts`），不写两套业务逻辑。vfs-ui 仅提供通用条目动作扩展点。

未挂载目录的 Session files 主视图显示 attachments 和说明：“尚未挂载工作目录，此会话仅能访问附件。”

挂载弹窗：

```text
挂载目录
来源        [默认目录 ▾]  [选择其他目录…]
目录        /home/admin/projects/demo
会话路径    /workspace
访问        ○ 只读   ○ 可读写
            □ 设为工作目录
                         [取消] [挂载]
```

- 默认目录是用户设置的快捷选项，点击挂载才授权；不自动附加到新 Session。
- “选择应用目录”从 /home/admin 开始逐层选择；默认目录未设置时不猜测或自动授权。
- “选择其他目录”由平台提供受限目录选择器，可选应用内目录或宿主目录。弹窗展示实际来源、范围、会话路径和读写方式。
- 按用户要求，挂载默认可读写；UI 可选择只读，命令用 r 指定只读。
- 挂载行展示实际来源、只读/读写和工作目录标识；项目主目录只允许重连，额外挂载可修改权限或移除。下图的设置 cwd 能力仅用于未归属项目的会话。
- 卸载只撤回该 Session 的授权，不删来源文件；本次没有提供全局删除来源动作。
- 外部来源失效保留“需要重新连接”的挂载条目，读写报错，不以同名目录或用户 home 替代。

宿主选择来源时可以浏览自己的管理视图；选择器获得的宿主能力不传给 Agent。平台没有目录授权能力时禁用该来源选项，不能用上传文件夹冒充持续挂载。

## 4. 接口与实现归属

复用现有 SessionMountRecord，补齐 FilesRecord.cwd；继续在 session.seq 的 files 记录中通过 revision/CAS 更新，不新增第二份授权表。

```ts
interface SessionMountRecord {
  mountId: string;
  sourceId: string;
  root?: string;            // 来源内的授权子目录，不是宿主绝对路径
  at: string;              // Session 内挂载点
  access: 'ro' | 'rw';
}
interface FilesRecord {
  revision: number;
  state: 'active' | 'draining' | 'disabled';
  cwd: string;
  mounts: SessionMountRecord[];
}

interface SessionFilesService {
  initialize(): Promise<void>;             // 要求 transactional SeqFiles
  registerSource(sourceId: string, source: IFileSystem): void;
  inspect(sessionId: string): Promise<FilesRecord | null>;
  configure(sessionId: string,
    config: { mounts: SessionMountRecord[]; cwd: string },
    expectedRevision: number): Promise<FilesRecord>;
  disable(sessionId: string, expectedRevision: number): Promise<FilesRecord>;
  acquire(sessionId: string): Promise<{ vfs: ToolVFSContext; cwd: string; release(): Promise<void> }>;
  acquireFiles(sessionId: string, cwd?: string): Promise<FileSystemContextOwner>;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}
```

这是已实现接口；configure 的旧 mounts 数组参数已删除。编辑器的相对路径可从已取得的上下文派生 cwd，但必须验证仍在视图范围；不能通过传入 cwd 扩大访问。

平台来源端口属于宿主；Web 当前仅支持应用内目录，Tauri 注入原生目录来源。没有平台 provider 时不显示宿主目录按钮。

```ts
interface DirectorySourceProvider {
  selectDirectory(): Promise<string | null>;
  openDirectory(path: string): Promise<IFileSystem>;
  dispose(): Promise<void>;
}
// DirectoryMountService，宿主服务，不注册为 Agent 工具。
getHome(): string | undefined;
setHome(directory: string): Promise<string>;
mountHome(sessionId: string): Promise<string>;
addDirectory(sessionId: string, directory: string,
  access?: 'ro' | 'rw', at?: string, asCwd?: boolean): Promise<string>;
remove(sessionId: string, mountId: string): Promise<void>;
update(sessionId: string, mountId: string, access: 'ro' | 'rw', asCwd: boolean): Promise<void>;
reconnect(sessionId: string, mountId: string): Promise<void>;
listDirectories(path?: string): Promise<string[]>;
describe(mount: SessionMountRecord): string;
get canSelectHost(): boolean;
chooseDirectory(): Promise<string | null>;
processMounts(sessionId: string): Promise<SessionProcessMount[]>;
// EditorHostContext 注入，仅供用户 slash 命令。
directoryCommands?: {
  addDirectory(directory?: string, access?: 'ro' | 'rw'): Promise<string>;
  setHome(directory?: string): Promise<string>;
};
// vfs-ui 的通用目录动作扩展，不包含 Session 业务。
directoryAction?: {
  label: string; visible(path: string): boolean; run(path: string): Promise<void>;
};
```

持久来源定位与默认目录在 `/var/lib/kernel/local-sources/session-directories.json`，版本为 1。它属于授权管理数据，不能放进可挂载的 `.config`，否则 Agent 可能改写重启后的宿主来源。Session 自身授权仍只有 `session.seq` 的 files 记录；注册来源不等于授权。

命令及 UI 共用 DirectoryMountService：

```text
/set-home /home/admin/projects/demo   保存默认目录，不挂载
/add-dir /home/admin/notes r          挂到 /notes，只读
/add-dir "/path/with spaces" w        Tauri 宿主目录，可读写
/add-dir /path/to/demo                默认可读写，挂到 /demo
/add-dir                             打开挂载管理
/set-home                            打开默认目录设置
```

路径支持引号，不执行 shell 展开。`~` 表示应用用户目录 `/home/admin`；Tauri 原生选择器以 `host:` 标识宿主来源。未归属项目的会话可点击“挂载默认目录”建立 `/workspace`，可读写并设为 cwd；项目会话不提供此按钮，命令也不能覆盖项目主目录。设置默认目录不会改变现有项目。其他挂载默认不改变 cwd。额外目录名称由 basename 建议，冲突可在 UI 改名，不静默遮蔽。`workspace` 是本应用的工作目录约定，`home` 留给真实用户根的含义。

| 层 | 改动 |
| --- | --- |
| app-shell SessionWorkbench | 删除自动 admin-home → /workspace；加入挂载动作与管理 UI |
| app-core SessionFilesService | 附件加显式挂载组成唯一用户文件上下文；cwd、只读、revision 与撤销统一校验（`backend/app-core/src/vfs/session-files.ts`） |
| app-core DirectoryMountService | 宿主来源登记、默认目录与挂载增删改（`backend/app-core/src/vfs/directory-mounts.ts`） |
| app-core session-attachments | 删除 system-mounts 旧入口；只组装当前 Session 附件 |
| app-core SessionBrowser | files 直接代理受限上下文，删除目录黑名单，不再代理完整系统视图 |
| vfs-ui | 通用条目动作钩子；files 的“＋”与挂载状态由宿主提供 |
| llm-ui | 文件搜索、上传、引用、当前目录提示使用同一授权上下文；挂载变化后重新绑定或明确失效 |
| kernel-adapters / device 工具 / TTY | 文件工具不允许回退宿主 fs；进程访问边界必须与 Session 授权一致 |
| Web / Tauri | 共用挂载 UI 和 slash；Web 提供应用内目录，Tauri 另有受限宿主目录 provider；CLI 不新增这些 UI 命令 |
| vfs-core / localfs driver | 保持业务无关；验证挂载边界、只读、撤销、符号链接与真实路径约束 |

## 5. 访问执行与撤销

```mermaid
flowchart LR
  Picker[宿主目录选择器] --> Sources[宿主持有的目录来源]
  UI[用户挂载操作] --> Config[Session 授权配置与 revision]
  Sources --> Files[受限 Session 文件上下文]
  Config --> Files
  Attachments[当前 Session 附件] --> Files
  Files --> Browser[vfs-ui files 投影]
  Files --> Editor[编辑器与搜索]
  Files --> Tools[文件工具]
  Repo[SessionRepository 与 Kernel] --> History[聊天与 Task 历史]
```

必须覆盖 list/stat/read/write、递归搜索、元数据、附件解析、复制目标与源，以及宿主符号链接/真实路径的越界。未挂载路径拒绝，不能把虚拟路径解析失败转为宿主绝对路径读取。来源本身只读时，Session 配置不能提升为读写。

所有非终态 Task（含等待和暂停状态）会阻止宿主挂载变更，用户需先完成或取消 Task。运行 Task 持有启动时的授权 revision。变更挂载使旧上下文失效，不能静默切换到新目录或让现有 Task 自动获得新增授权；变更后清理缓存的 Kernel adapter scope，下一次执行重新取得授权。聊天编辑器重建时保留当前 branch 与对应草稿。缩小权限与卸载必须使旧句柄失败。进程若不能实时撤销对应目录访问，应停止并回收该进程后才报告卸载成功。

进程执行是必要的独立检查点：VFS 只能约束经过 VFS 的操作。原生 shell/PTY 若仍可直接读宿主文件，则仅修改 cwd、过滤路径或限制文件工具不能实现本方案。提供 process 能力的平台必须通过 OS 沙箱/容器/受控执行器实施等价文件范围；无法实施的平台不得向受限 Session 提供无约束宿主 shell。运行程序所需的运行库等系统资源由执行器固定提供，与用户数据挂载分开，不借此授权其他用户数据。

Tauri 已移除向 Session 注入无约束 native shell、原生 skill tool handler 和本地 Codex app-server 传输；进程执行改由 Bubblewrap runner 实施：`apps/tauri-app/src-tauri/src/session_bash.rs` 按显式 Session 挂载生成 `bwrap` 命令（`--ro-bind`/`--bind`、`--unshare-pid/--unshare-ipc/--unshare-uts`、`--die-with-parent`），cwd 必须落在授权挂载内，宿主环境变量被清空；`apps/tauri-app/src/shell/session-bash.ts` 经 `directory_open`/`directory_close` 取得目录句柄并接线到 `SessionProcessFactory`（`backend/app-core/src/vfs/session-process-context.ts`）。该 runner 不隔离网络，也不是完整 OS 沙箱。CLI 默认 OCI 使用同一 Session 挂载列表；主挂载被卸载时 Shell/TTY 拒绝启动，不能从旧 Flow 路径自动恢复授权。`RequestWorkspaceAccess` 返回实际会话挂载路径。CLI 显式 `native` 模式仍以宿主权限执行，不具备等价的 OS 文件范围隔离。

Tauri 文件 IO 使用原生 directory_open/close/io，保存规范化目录根，每次拒绝 parent traversal 和符号链接，关闭 scope 后 IO 失败；元数据位于独立 sidecar，用户内容保持原路径，包括 __tests__。这不等于 OS 进程沙箱，也不宣称能抵抗外部宿主进程在路径检查和 IO 之间恶意换链的竞态。

## 6. 其他 harness 的参考

以下为官方文档描述；关于 NestOS 的选择是本方案的设计判断，不能把这些机制都等同于 VFS 挂载。

| Harness | 官方机制 | 本方案借鉴与区别 |
| --- | --- | --- |
| Codex | `--cd` 设置工作目录；`--add-dir` 增加工作区之外的可写目录；CLI 提供平台沙箱入口 | 借鉴主工作目录和额外授权；add-dir 的写授权不代表未列目录一律不可读。[官方文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli) |
| Claude Code | `--add-dir`、`/add-dir`、additionalDirectories 扩展目录访问；读与编辑规则另行控制 | 借鉴会话内添加目录与明确权限；不能只把允许编辑目录当成完整读隔离。[官方文档](https://code.claude.com/docs/en/permissions) |
| OpenCode V2 | 外部目录先检查 external_directory，再检查 read/edit；文档说明 shell 使用宿主用户权限，对命令参数中的目录并非完整边界 | 借鉴目录授权与操作授权分层；必须补足进程边界。[官方文档](https://opencode.ai/v2/docs/permissions) |
| Aider | 以一个 Git repo 为编辑中心，可 `/read` 另一个 repo 的文件 | 借鉴工作项目与只读参考；加入模型上下文不是 OS 文件隔离。[官方文档](https://aider.chat/docs/faq.html) |

NestOS 的目标更明确：未配置默认来源的 Session 不附加用户目录；每个挂载是该 Session 的真实访问授权；用户只需理解附件、工作目录与附加目录。

## 7. 验收

1. 未配置挂载的 files 仅列 attachments；直接访问 home、workspace、系统目录、history 与其他 Session 附件失败。
2. 挂载 demo 后只访问 demo 子树，兄弟项目不可通过绝对路径、..、链接或搜索访问。
3. 只读挂载不能写入、重命名、删除、写 metadata，也不能经 shell 绕过。
4. 两个 Session 选择同名挂载点不会串来源；注册来源不会让其他 Session 自动获得访问。
5. 默认目录设置不改变已有 Session；Tauri/CLI 新建时按宿主当前目录或显式默认配置挂载，Web 未配置时保持无用户挂载。
6. 卸载不删文件，旧句柄失效；重新连接不会扩大根目录或权限。
7. 文件工具与受限进程执行分别验证访问边界；Bubblewrap runner 已覆盖只读/可写授权与保留路径拒绝，但未完成真实 GUI 与网络隔离验收，不能宣称完整隔离。

**逐项证据映射（2026-09-11 第四十三轮核对）**：
1. `backend/app-core/tests/directory-mounts.test.ts`「only grants attachments until the default directory is explicitly mounted」、「keeps the same mount point name bound to each Session source independently」；`session-files.test.ts`「exposes only attachments without system directories, kernel records, or another Session」。
2. 同上第一条（B 仅见 `attachments`；绝对兄弟路径 ENOENT）；第四十三轮在该文件的只读用例中补 `/demo/../notes/secret.md` 遍历拒绝与根视图只含 `attachments`+`demo`；链接逃逸由 Tauri 侧 `directory_boundary::tests::rejects_link_outside_selected_directory`（`pnpm --filter tauri-app test:rust`）覆盖。
3. `directory-mounts.test.ts`「defaults to read-write, attenuates explicit read-only, and removes grants without deleting data」第四十三轮扩展为 `writeContent`/`rename`/`move`/`delete`/`updateMetadata`/`setTags`/`createDirectory` 全部 `EROFS`；shell 侧由 `session_bash::tests::confines_bash_to_readonly_and_writable_grants` 覆盖只读/可写绑定。
4. 第四条「keeps the same mount point name bound to each Session source independently」：同一虚拟路径 `/demo` 绑定不同来源，互不可见。
5. 第一条（`setHome` 不改变已有 Session 的挂载，新建 Session 不隐式挂载）。
6. 第二条（`remove` 保留宿主文件、旧句柄 EACCES、重连不扩大根目录）。
7. 部分：Bubblewrap runner 的只读/可写授权与越界拒绝已由 `cargo test`（`pnpm --filter tauri-app test:rust`，12 通过）覆盖；**仍缺真实 GUI 与网络隔离验收**。

完整 Tauri cargo check 被环境缺少 glib-2.0 开发库阻塞；独立编译实际 Rust 路径与 IO 模块的测试已通过。尚无真实 GUI 人工验收。


## 2026-09-14：只读挂载与源权限验收补充

新增回归覆盖 appendContent、createFile、直接 SeqFile setEntry 均返回 EROFS，且源内容、源记录和目录保持不变。多挂载 Session 视图的 SeqFile transaction 因缺少该能力返回 ECAPABILITY，事务回调未执行；这是事务能力边界，不是已进入事务后的只读检查。

来源本身只读时，申请 rw 挂载在配置阶段返回 EROFS，files 记录仍为空；随后申请 ro 能读取，不能写入。以上是既有实现的验收补充，最初测试对事务错误码与授权拒绝阶段的假设已按实际契约修正，未把测试假设错误记为生产缺陷。当前 app-core 全套 98 项与类型检查通过；将随挂载权限验收批次合入，P2-04 的真实窗口和平台故障矩阵保持开放。


## 2026-09-14：挂载权限与旧句柄撤销

Session 配置变更、禁用和服务释放会先同时关闭普通视图与工作区视图的入口，再等待已接受操作结束。此前顺序等待工作区读操作时，普通旧句柄仍能写入；IndexedDB/真实视图的受控在途读取回归已复现并验证修复。撤销失败会保留错误，不发布可用的新权限记录；这不是外部进程强制停止或跨主机 fencing 验收。

目录授权回归覆盖两 Session 同名挂载来源隔离、只读 write/append/create/rename/move/delete/metadata/tag/SeqFile setEntry 拒绝，以及源文件和记录不变。多挂载视图的 SeqFile transaction 返回 ECAPABILITY 且回调未执行，不能称为事务内 EROFS 检查。只读来源申请 rw 在配置阶段被拒绝且不留记录，改为 ro 可正常读取。

隔离 app-core 101、app-shell 193 项通过，共 294 项，另有 30 项既有跳过；app-core/Web/Tauri 类型检查与文档检查通过。P2-04 的真实窗口旧句柄路径、P0-02 设备不确认停止时的有界失败、跨进程/平台矩阵仍开放。
