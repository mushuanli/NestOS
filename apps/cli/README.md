# MindOS CLI

MindOS CLI 在指定工作区中运行声明式多 Agent workflow graph。无环数据依赖按 DAG 调度，并支持有界循环、条件路由、动态子图与 Supervisor。CLI 与 Tauri 共用 `@itookit/app-core` 的 `createKernelRuntime` 组合，以及 LLM、Tool、Kernel 和持久化内核，不需要启动桌面 UI。CLI 要求 Node.js 22.13 或更高版本，并使用内置 `node:sqlite` 持久化运行状态，无需安装原生 SQLite npm 扩展。

无显示服务器的最小 DAG、Bash 子 harness 验收及平台边界见 [最小系统运行说明](../../doc/minimal-system.md)，公开配置见 [minimal-dag.yml](examples/minimal-dag.yml)。

文件工具、Skill、本地 MCP 及组合流程的可运行定义和审批验证见 [Harness 验证例子](examples/harness-validation/README.md)。

CLI 的运行异常会自动写入 `~/.config/mindos/logs/cli/`（遵循 `XDG_CONFIG_HOME`，可用 `MINDOS_DIAGNOSTICS_DIR` 覆盖），失败时 stderr 显示具体路径；详见 [运行日志](../../doc/mindos-profile.md#tauri--cli-运行日志)。

## 使用

```bash
cp apps/cli/mindos.example.yml mindos.yml
export ANTHROPIC_API_KEY=...

pnpm cli:build
node apps/cli/dist/cli.js validate
node apps/cli/dist/cli.js run
```

构建后可以从仓库根目录直接运行：

```bash
pnpm cli validate -f apps/cli/mindos.example.yml
pnpm cli run -f mindos.yml --headless --json
```

最小配置可以使用简写形式：

```yaml
version: 1
name: review
goal: 分析代码并输出报告
model: anthropic/claude-sonnet-4-5
env:
  api_key: ANTHROPIC_API_KEY
tasks:
  - id: inspect
    prompt: 检查代码
  - id: report
    needs: inspect
    prompt: 汇总检查结果
result: report
```

`prompt`、`needs`、`uses` 和字符串形式的 `result` 会在校验前展开成完整配置。需要多 provider、多 agent 或模型分层时仍可使用 `providers`、`connections`、`agents` 完整写法。

## `.flow` 输入

除 YAML 外，`run` 也接受 `.flow` 文件：

```bash
mindos --profile desktop run -f workflow.flow
```

`.flow` 支持：

- draft 文件（`draftVersion`）自动转为临时 revision；
- revision 文件（`revision` + `digest`）；
- inline 节点配置；
- 从所选 profile 读取 Provider / Connection / Skill；节点支持显式 `toolIds`、`skillIds` 和 `mcpProfileIds`；
- `--params file.json` 传递参数对象，未提供时使用定义默认值；
- 保留草稿的 `outputs` 返回声明，并编译为持久返回节点。

当前限制：

- `.flow` 中的 `agentId` / `systemPromptId` 引用需要宿主身份解析器；CLI 例子使用 inline 配置；
- `.flow` 默认使用最后一个节点 + `result` 输出作为最终结果；
- 参数 `--param` 尚未实现。

## 校验、图与运行管理

```bash
mindos validate -f mindos.yml --offline
mindos graph -f mindos.yml --offline --json
mindos runs --state-dir .mindos
mindos status <run-id> --state-dir .mindos
mindos tasks <run-id> --state-dir .mindos
mindos rerun <run-id> --state-dir .mindos
mindos export-config <run-id> --state-dir .mindos
mindos export <run-id> --state-dir .mindos --out run.json --max-bytes 262144
mindos delete <run-id> --state-dir .mindos
```

`tasks` 展示节点状态和已生成产物，不是可恢复的状态快照；`rerun` 使用原配置创建全新的完整运行；`export-config` 只导出配置快照；`export` 把 manifest 与每个节点的 transcript（受 `--max-bytes` 字节预算约束，默认 256 KiB）写到真实文件，需要持有 Session 租约。当前不提供 checkpoint replay 或 state fork。

### Profile 与本地目录挂载

CLI 默认连接桌面 profile：

```text
$XDG_CONFIG_HOME/mindos/mindos.json
或
~/.config/mindos/mindos.json
```

数据根解析顺序：

```text
MINDOS_ROOT
  → mindos.json#rootDir
  → <configDir>/data
```

使用 `--profile` 切换：

```bash
mindos --profile desktop run -f mindos.yml       # 默认，共享桌面数据根
mindos --profile /path/to/profile run -f mindos.yml
```

CLI 不再直接以 Node fs 访问工作目录，而是通过 Session 挂载：

```bash
mindos --set-home /path/to/project run -f mindos.yml
mindos --add-dir /path/to/lib:ro run -f mindos.yml
mindos --add-dir /path/to/cache:rw run -f mindos.yml
```

- `--set-home <dir>`：挂载到 `/workspace`，作为 Session 工作目录，默认 `rw`。
- `--add-dir <dir>[:ro|rw]`：追加宿主目录，默认 `ro`；可重复。
- workflow YAML 本身仍从宿主路径读取，它属于 CLI 输入，不是 Agent 可见文件。

无头模式会把事件作为 JSONL 写到 stdout，适合 CI。`--json` 自动采用无头行为，遇到人工输入时返回退出码 `3`，不会读取交互式 stdin：

```bash
mindos run --headless --json
mindos resume <run-id> --headless --json
mindos respond <run-id> <request-id> --approve
```

退出码 `0` 表示成功，`1` 表示运行失败，`2` 表示配置或命令错误，`3` 表示等待人工输入或等待 Effect 裁决。

### 崩溃恢复与 Effect 裁决

Run 的聚合根和调度检查点在第一个节点派发前就已持久化，因此进程在任意后续时刻被杀掉后，`resume` 都能从已提交的调度状态继续，而不是重跑整张图。崩溃时无法核对结果的外部 Effect（例如已发出、结果未落盘的模型请求）会被 Kernel 恢复为 `indeterminate`：

```bash
mindos resume <run-id> --json                     # 退出码 3，run.json 写入 blockedEffects 并打印裁决命令
mindos resume <run-id> --retry-indeterminate      # 授权重放同一逻辑 Effect 后继续
```

`--retry-indeterminate` 只重放逻辑 Effect（`effectId` 不变、确定性 `requestId`），不会重新开始已完成的迭代；确认外部副作用不可重放时应改用 `mindos cancel <run-id>`。

`mindos cancel` 用于取消**没有活宿主**的 Run（宿主崩溃、Effect 阻塞）。Session 是单写者：如果 Run 正由另一个 CLI 进程执行，该进程持有 Session 租约，`cancel` 会以退出码 2 明确拒绝并提示租约持有者，不会干扰在途请求；取消正在运行的 Run 请对该进程发送 `SIGINT`（退出码 130，Run 持久为 `cancelled`）。

`mindos delete` 有两道互斥守卫：本机用 Run 目录内的 SQLite 写锁（`run/resume/delete` 共用，争用即拒绝），跨主机再看该 Run 的通用调度租约（Session shared `flow.run.<rootTaskId>.scheduler-owner`）。共享存储（NFS/S3 类）上本地文件锁不可靠，因此只要另一个宿主的租约还没到期，`delete` 就会拒绝并保留 Run 目录，报错给出持有者与到期时间；宿主崩溃后租约到期（默认 30s，可用 `MINDOS_SCHEDULER_LEASE_TTL_MS` 缩短）即自动放行。跨主机共享数据根时，若各主机时钟可能不一致，用 `MINDOS_SCHEDULER_LEASE_SKEW_MS` 声明允许的时钟误差：接管会在旧租约到期后再等这段时间，避免快时钟主机抢走慢时钟主机的活租约（默认 0，适合单机或统一时钟源）。

Session 单写者租约同理：`MINDOS_SESSION_LEASE_SKEW_MS`（默认 0）声明允许的时钟误差，接管会在旧 Session 租约到期后再等这段时间。

## HTTP 模式（`-d` / `--http`）

CLI 可以作为 HTTP 主机，直接提供 Tauri UI：

```bash
mindos -d 127.0.0.1:8080
mindos -d 0.0.0.0:8080
mindos -d 8080
```

规则：

- 默认绑定 `127.0.0.1`；
- 端口为 `0` 时由系统分配；
- 静态资源优先使用 `apps/tauri-app/dist`，不存在时回退 `apps/web-app/dist`；
- 页面注入 Tauri IPC shim，将 `window.__TAURI_INTERNALS__.invoke` 转发到 CLI HTTP API；
- 启动时先完成 MindOS runtime 初始化，再监听 HTTP；
- 数据根来自 `--profile desktop` 或显式 `--profile <path>`；
- `--set-home <dir>` 指定 HTTP 模式下暴露给 UI 的宿主 home 目录；
- `GET /api/status` 返回 runtime 是否 ready、profile、workspace 和 Session 数；
- 浏览器端注入 `window.__MINDOS_MODE__ = 'remote'`，不再执行本地 `initApp()`；
- `GET /api/sessions` / `GET /api/runs` 提供 remote UI 数据。

当前 HTTP 模式支持：

- `get_home_dir` / `get_root_dir`
- `fs_*`
- `directory_open` / `directory_io` / `directory_close`
- `plugin:sql|*`
- `sidecar_begin` / `sidecar_execute` / `sidecar_select` / `sidecar_finish`
- `plugin:dialog|*` 返回不可用/空结果

暂不支持：

- `session_shell_exec` / `shell_exec`
- `codex_*`
- 原生 ripgrep / fd

这些命令在 HTTP 模式下返回明确错误。

## 文件与进程权限

- 文件工具默认只能访问工作区及其子目录，`.mindos` 始终对 Agent 隐藏。
- 外部路径必须先调用 `RequestWorkspaceAccess`，经人工批准后获得当前 run 有效的只读或读写授权。
- Native 模式中的 Bash/TTY 每次都需要批准；批准后的进程具有当前系统用户权限，因此 Native 是能力控制，不是 OS 强隔离。TTY 使用 node-pty 分配真伪终端（`supportsPty=true`），交互式程序（REPL、vim）可正常检测 `isatty()`，输出已规范化 CRLF。
- OCI 模式把 Bash 与 TTY 都放入 rootless Podman 或 Docker。工作区挂载到 `/workspace`，默认断网、只读根文件系统、无 Linux capabilities，并限制 PID、CPU、内存和执行时间。TTY 会话通过 `engine run -i` 保持持久 stdin，容器内进程与宿主环境隔离。
- 显式选择 OCI 后若容器引擎不可用，运行立即失败，不会降级为 Native。
- 未配置 `sandbox.mode` 时默认使用 OCI；只有显式设置 `native` 或传入 `--sandbox native` 才会使用宿主 Bash。

### 隔离工作区（`runtime.workspace`）

`mindos.yml` 可用 `runtime.workspace` 让整个 Run 在独立 Git worktree 里执行：

```yaml
runtime:
  workspace:
    mode: worktree        # shared（默认）| worktree | read-only（要求 OCI）
    base: head            # head | current | <git ref>
    merge: manual         # manual | auto-if-clean | discard
    cleanup: on-success   # on-success | always | keep
sandbox:
  mode: native            # worktree 只支持 native 沙箱
```

- 工作区建在 `<state-dir>/worktrees/<run-id>`，**整个 Session 工作区**都指向这份隔离副本：Bash/Glob 的 cwd、VFS 文件工具（`Read`/`Write`/`Edit`，挂载在 `/workspace`）、路径授权与系统提示里的 Workspace 路径一致，基础仓库不在原位改动；worktree 目录与分支名随 Run 持久化，宿主崩溃后 `resume` 会重新挂载同一个 worktree，不会新建第二个。
- 与 `--set-home` 同时使用时保留该目录作为 Session 工作区（隔离副本只作为 Agent shell 的 cwd），并在 stderr 明确提示。
- `merge: auto-if-clean` 仅在 worktree 无未提交改动时把分支快进合并回基础仓库；`manual`（默认）保留分支供人工处理。
- `cleanup: on-success`/`always` 只在工作区干净时移除——有未提交改动时 Git 拒绝删除，Run 结果不受影响，工作区保留，避免静默丢弃 Agent 产物；需要保留时用 `cleanup: keep`。
- OCI 沙箱只挂载工作区根目录，隔离目录对容器不可见，因此 worktree 模式要求 `sandbox.mode: native`，否则配置校验直接失败。

首次使用 OCI 模式时构建最小镜像：

```bash
podman build -t mindos-sandbox:v1 -f apps/cli/sandbox/Dockerfile .
# 或 docker build -t mindos-sandbox:v1 -f apps/cli/sandbox/Dockerfile .
```

运行状态位于 `.mindos/runs/<run-id>/`，包括配置快照、`run.json`、`events.jsonl`、产物和最终结果。API Key 只从环境变量读取，不写入配置快照；LLM 的运行时配置使用内存 VFS。

`runtime.workspace.mode: read-only` 仅接受 OCI 沙箱：宿主 Git 创建独立副本，文件工具、Bash 和交互 TTY 的所有用户挂载均只读，写授权申请被拒绝。`merge` 可省略或设为 `discard`，不允许合并副本改动；`cleanup` 沿用工作区策略。此模式不能与 `--set-home` 合用。native 模式不提供只读进程边界，配置及运行时均拒绝。当前仅有配置/挂载参数回归，真实 OCI 运行仍待验收。

OCI 命令和交互 TTY 的工作目录按 Session 挂载路径映射：接受已挂载的宿主路径或会话虚拟路径（含子目录），嵌套宿主目录优先使用最具体的挂载。挂载范围外的 cwd 会报错，不会静默退回工作区根目录。

### Agent 记忆策略

CLI 使用显式 scope 授权，`tools` 与 `memory_policy` 必须同时声明。默认记忆存于本次 Run 的 Kernel Session，不自动跨新 Run 共享；文件工作区权限不替代记忆权限。

```yaml
agents:
  - id: worker
    connection: default
    tools: [memory_list, memory_write, memory_remove]
    memory_policy:
      namespace_id: worker
      read_scopes: [project]
      write_scopes: [project]
      retrieval_limit: 10
      retention:
        max_entries_per_scope: 100
```

写工具参数为 `scope`、`entryId`、`content`，删除工具不需要 `content`。可传 `expectedContentHash`：旧内容摘要用于冲突检查，null 只允许新建；省略为无条件写入。列表仅返回 read_scopes 中的条目。CLI Flow 节点不自动注入检索结果，可通过 memory_list 显式读取。策略冻结到 Task 输入；修改 YAML 不扩大已提交任务权限。

### 租约接管的时钟偏差配置

`MINDOS_SESSION_LEASE_SKEW_MS` 和 `MINDOS_SCHEDULER_LEASE_SKEW_MS` 分别传给 Session 租约及 Flow 调度租约，单位为毫秒。未设置时使用库默认值 0；显式 0 有效。配置必须为非负安全整数，空白、负数、非整数和非法数值在 CLI 创建运行时资源前报错。不同拥有者须等到旧租约到期时间加偏差预算后再接管；显式释放的 Flow 租约无需等待。该配置不自动校准主机时钟，也不证明共享存储或多主机 fencing 已通过验收。

### Run 隔离工作区

YAML 的 runtime.workspace 支持 mode: shared/worktree/read-only，以及 base、merge: manual/auto-if-clean/discard、cleanup: on-success/always/keep。worktree 要求显式 sandbox.mode: native，副本位于 `<state-dir>/worktrees/<run-id>`，默认 Session 文件挂载与进程 cwd 指向副本；恢复重连已记录的副本。--set-home 会保留用户指定的 Session 目录并明确提示差异。

成功且 merge 非 discard 时，未提交改动会阻止移除；discard 或失败/取消后的清理可以强制移除，因此需要保留产物时使用 cleanup: keep。auto-if-clean 仅接受干净副本并快进合并。收尾前通过共用屏障等待在途操作并关闭 Run 能力。

read-only 只接受 OCI，拒绝写授权和 --set-home，所有用户挂载降为只读；当前配置及挂载参数测试通过，真实 OCI 验收仍待完成。OCI cwd 仅接受已挂载宿主或虚拟路径，范围外路径报错。

mindos delete 在本机锁之外，通过持久调度记录 CAS 写入删除标记，与识别该协议的宿主接管互斥；活租约（含配置时钟偏差）拒绝删除。标记写入后才删除 CLI 投影目录，失败保留标记供重试，不宣称旧宿主或跨主机外部副作用已经强隔离。

### 原生进程结束与取消

一次性 native shell 调用拥有它创建的进程组。取消或超时先发送 SIGTERM，仍未退出时升级 SIGKILL；父进程正常退出也会停止该组剩余后台成员。CLI 等待输出管道关闭及停止确认后才返回，启动前已取消不会执行命令。Linux 通过进程状态排除无法执行的 zombie；无法确认时保持清理等待，不用超时伪造成功。需要长期后台执行的服务不应借助一次性 Bash 调用遗留进程。native 模式不限制程序主动脱离进程组，不提供 OCI 或 Tauri bwrap 的隔离边界。

### 本地动态委派

Agent 任务可用 YAML 配置有界委派。父 Agent 获得 `delegate_tasks` 工具，其 `items` 数组生成子任务；子任务使用指定 Agent 的模型与提示，工具权限取父子声明的交集，不能扩大父任务权限。

```yaml
tasks:
  - id: plan
    agent: planner
    description: 拆分工作并调用 delegate_tasks
    delegation:
      agent: worker
      instruction: Handle one payload
      max_tasks: 8
      max_concurrency: 1
      failure_policy: fail-fast
```

`planner` 和 `worker` 必须在 `agents` 中声明。省略上限时默认为 8 个任务、并发 1，单项最大 32；嵌套委派不开放。`continue` 允许其余子任务继续并保留失败结果；默认 `fail-fast` 取消同组剩余工作。CLI 使用相同的持久调度与恢复路径。

### 结构化输出与节点契约

Agent 的 `response_format` 接受 `text`、`json_object` 或 `json_schema`。后者将解析后的 JSON 绑定到节点的 `result` 端口，并保留原始 `message.content`。例如：

```yaml
agents:
  - id: writer
    connection: default
    response_format:
      type: json_schema
      json_schema:
        name: report
        schema:
          type: object
          required: [title]
          properties:
            title: {type: string}
    output_validation: {on_invalid: repair, retries: 1}
tasks:
  - id: write
    agent: writer
    description: 生成报告
    port_schemas:
      outputs:
        result: {id: report, version: '1'}
```

消费者通过 `port_schemas.inputs.<端口名>` 引用相同 schema；普通节点可通过 `definition` 内联定义。未显式命名的 Agent result 使用 `agent.response.<节点 id>.<name>@1`。同身份不同定义会被拒绝，契约随 Run 持久化。Flow 使用受支持的 schema 子集并严格失败；Agent 的 `continue` 不能绕过 Flow 端口验证。具体错误在 Run 结果中，原始响应在 Task transcript 中，可从已有重试入口重新执行。

### 显式共享 Memory

宿主管理命令（均可传 `--profile <path>`）：

```bash
mindos memory create team notes creator-session
mindos memory list
mindos memory inspect team <incarnation>
mindos memory grant team <incarnation> <session-id> --value '{"readScopes":["project"],"writeScopes":["project"]}'
mindos memory revoke team <incarnation> <session-id>
mindos memory audit team <incarnation>
mindos memory delete team <incarnation>
```

Agent YAML 的 `memory_policy.shared_memory: {id: team, incarnation: <创建结果>}` 选择资源，仍需配置 namespace_id/read_scopes/write_scopes。引用本身不授权；新 Run 显式传 `--grant-memory team` 才为本次 Session 授予所引用 Agent 策略的 scope 并集，或事先使用管理命令授权已知 Session。资源名称、incarnation 与 namespace 必须一致。删除创建者 Session 不删除共享资源，资源删除后旧引用失效；审计和操作回执保留。

写入/删除支持 `expectedRevision`，应使用 memory_list 返回的版本进行条件修改；null 表示仅新建。`memory_compact` 需单独加入 tools 白名单，参数为目标 scope/entryId/content 与 sources（entryId/revision 数组），原子复验源版本、保存较短摘要及来源引用并保留原文。压缩不等于语义检索，后者暂未实现。

## 本地数字分身

`mindos twin` 使用同一 profile 的 SQLite SeqFile，通过宿主服务操作，普通 memory 工具不能直接读写分身。先用 `list` 获得来源/记忆/设置的当前 revision，条件修改必须明确传该版本。所有会话默认可使用相关知识，无需会话授权；使用全局忽略和规则级忽略限定资料范围。

```bash
mindos twin list --profile desktop
mindos twin preview-source --value '{"kind":"file","target":"/home/admin/minds/context.md","label":"背景"}'
mindos twin add-source --value '{"kind":"file","target":"/home/admin/minds/context.md","label":"背景","connectionId":"default"}'
mindos twin analyze <source-id>
mindos twin review <memory-id> <revision> confirm
mindos twin review <memory-id> <revision> correct --value '{"content":"新的独立用户陈述"}'
mindos twin add-memory --value '{"content":"希望 Alpha 使用 TypeScript","kind":"preference","project":"Alpha"}'
mindos twin settings <settings-revision> --value '{"tokenLimit":100000,"paused":false,"useEnabled":true}'
mindos twin link-execution <goal-memory-id> <revision> --value '{"sessionId":"<session-id>","taskId":"<existing-task-id>"}'
mindos twin forget <memory-id>
mindos twin forget-project Alpha
mindos twin forget-subject <subject-id>
mindos twin suppress <memory-id> <revision>
mindos twin revoke-source <source-id> <revision>
mindos twin enable-source <source-id> <revision>
mindos twin remove-source <source-id> <revision>
mindos twin cancel <job-id>
```

自动规则使用总览配置的分析模型；来源分析会发送至明确选择的模型连接；CLI 的 add-source/grant 命令本身代表该项显式授权。未知计费保留预留额度，不当作免费。`forget` 可用 `--value '["<session-id>"]'` 明确要求同时删除曾用过该条的整个会话；省略时保留历史副本并阻断后续模型使用。原始来源、导出、手动复制、外部备份及服务商数据不在本地清理范围。来源移除保留独立用户陈述与其修订历史。

分身扫描规则在“数字分身 → 自动更新”管理，自动发现所有登记项目的文本文档、原生与可读 harness 会话。全局忽略在通用设置中，模型与累计预算位于高级选项；每条规则定义范围、关注点、忽略规则、周期与可选提取类型，不再逐个授权来源。

```bash
mindos twin settings <settings-revision> --value '{"connectionId":"default","tokenLimit":100000,"globalExclude":["file:**/private/**"]}'
mindos twin rule-preview --value '{"include":["file:**/*.md","session:native/**"],"exclude":[]}'
mindos twin rule-create --value '{"name":"项目资料","include":["project:Alpha"],"exclude":["file:**/drafts/**"],"intervalMinutes":30}'
mindos twin rule-update <rule-id> <revision> --value '{"name":"文档与会话","include":[],"exclude":["session:harness/codex/temporary-*"],"intervalMinutes":60}'
mindos twin scan-plans --profile desktop
mindos twin plan-run <rule-id>
mindos twin scan-runs
mindos twin plan-pause <rule-id> <revision>
mindos twin plan-enable <rule-id> <revision>
mindos twin plan-delete <rule-id> <revision>
mindos twin scan-cancel <scan-run-id>
mindos twin scan-tick --profile desktop
mindos twin watch --profile desktop
```

`rule-create/update` 默认白名单/黑名单为空、30 分钟、全部提取类型、启用。`project:` 匹配项目 ID 或名称，`file:` 匹配项目内相对路径，`session:native/` 和 `session:harness/` 匹配会话 ID / profile+会话 ID；支持 `*`、`**`、`?`、目录末尾 `/` 和整行 `#` 注释。白名单任一命中即可，黑名单在当前规则内优先，多规则取并集，全局排除优先。`rule-preview` 返回 `resources` 和 `excluded`，不读取正文/不新增来源。忽略模式可省略前缀，例如 `*.log`、`drafts/`，开头 `/` 锚定项目根。`focus` 可设置自然语言关注点，不同关注点拥有独立提取进度。来源删除、替换、全局排除会使旧证据失效，离线不视作删除；明确主体的信息自动生效，未知主体待确认；同名人物保持独立，可在对象详情中手动合并。

旧 `add-source/analyze/plan-create/plan-update` 及指定来源计划保留兼容，不扩大既有范围。新规则共享全局模型和预算，重叠来源/类型复用进度。

Web/Tauri 应用在线时自动每 15 秒调度检查；页面关闭、休眠、节流或进程退出会延迟运行。`watch` 在当前 CLI 进程持续运行，Ctrl+C 或 SIGTERM 关闭；如需长期后台运行，由用户的进程管理器承接。一次性管理命令不启动自动调度，也不把 cwd 注册为项目。`scan-tick` 执行一次到期检查及排队处理；错过的触发合并补跑，不逐个重放。`plan-run` 等待本次完成，超过 180 秒报告等待超时，运行状态以 `scan-runs` 为准；取消使用 `scan-cancel`。

暂停或删除计划会阻止迟到结果提交；暂停或删除规则保留最后一次有效知识快照和运行记录，停止更新的记忆有明确标记。预算不足保留已提交进度，通过新建一次运行继续；失败/取消时未知模型用量保持预留。旧开发版本中没有扫描作用域的分析 Job 不自动恢复发送，需要核对后重新发起。扫描租约依赖同一 profile 的事务与可比较时钟，不代表多端同步或跨时钟故障矩阵已通过。

扫描协议使用 schema 1/layout 4；打开已知 layout 2/3 数据时只在事务内升级权威元数据，保留记忆、身份、遗忘代次与 tombstone。旧客户端需刷新升级后再访问同一 profile；未知或缺少布局版本的数据保持拒绝，不清空重建。

消费接入本地原生 Chat/Agent；不自动为 YAML Flow 开启分身检索。当前最多 10000 来源、50 规则、500 当前记忆、单来源 1 MiB/本地当前分支 2000 轮；每次手动分析约 4000 字符。关联执行不启动任务或推断目标完成。完整支持和身份限制见[设计与支持边界](../../doc/design/digital-twin.md#实现与边界)。
