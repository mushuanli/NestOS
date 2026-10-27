# CLI 与 HTTP 应用模式

CLI 应用命令、HTTP 浏览器和 Tauri 直接 API 共用 `ApplicationClient`、应用视图、Project/Session 模型和持久化 schema。`llm-ui` 负责输入、历史和状态呈现，权限、恢复、发送及回执由后端端口执行。

## 默认本地单进程

```bash
pnpm cli project list --profile /path/to/data
pnpm cli project create "Example" --profile /path/to/data
pnpm cli session create <project-id> "Example session" --profile /path/to/data
pnpm cli session show <session-id> --profile /path/to/data
pnpm cli session send <session-id> "Hello" --agent <agent-id> --profile /path/to/data
```

默认直接装配 Node 宿主 → `createApplicationRuntime` → `openApplicationView`；不监听端口，不启动浏览器，不请求 httpd。CLI 只转换参数和输出，应用命令默认输出 JSON；启动进度和诊断走 stderr。消息用引号作为一个参数传入。

数据根解析与 NestOS profile 一致。显式路径的 OAuth 目录默认是同级 `<data-root>.auth`，desktop 使用 release 的私密授权目录，可用 `--auth-dir` 覆盖。主机凭据和日志必须位于 VFS 根之外。应用宿主获取数据锁及授权锁，同一数据根不能与已运行 httpd 同时启动第二个写宿主；锁冲突明确失败，此时显式使用 `--connect`。文件名 `httpd-host-lock.sqlite` 为兼容已有宿主保留。

本地 `session send/submit` 等待本次 Submission 对应的历史与执行引用完成、失败、终止或等待人工输入，再关闭宿主；执行失败或终止返回退出码 2，等待人工输入返回 3；`--follow` 额外输出会话事件 JSONL。同 Session 其他调用的完成或审批不能提前结束本次等待。Flow 使用 RunGet.controlTaskIds 核对真实持久成员；Kernel rootTaskId 不能代替 Flow 成员归属。队列暂停时返回 execution.waitingForDispatch，不将接纳标成完成。关闭视图不会重发消息，也不会把关闭转换为远程 interrupt。

## Agent 与已发布 Flow 的统一调用

```bash
pnpm cli session targets --profile /path/to/data
pnpm cli session contexts <session-id> --profile /path/to/data
pnpm cli session contexts <session-id> <binding-id> --profile /path/to/data
pnpm cli session prepare <session-id> "继续检查" --agent <harness-agent-id> \
  --context selection.json --submission-file context-call.json --profile /path/to/data
pnpm cli session send <session-id> "检查接口" --agent <agent-id> --profile /path/to/data
pnpm cli session send <session-id> "检查接口" --flow <flow-id> --params values.json \
  --submission-file call.json --profile /path/to/data
pnpm cli session prepare <session-id> --flow <flow-id> --params values.json \
  --submission-file call.json --profile /path/to/data
pnpm cli session submit <session-id> call.json --profile /path/to/data
pnpm cli session receipt <session-id> call.json --profile /path/to/data
```

`--agent` 与 `--flow` 互斥；省略选择时使用 default Agent。默认 Agent 未持久列入目录时由宿主已有默认策略解析，CLI 不伪造版本或摘要，身份仍在后端接纳时冻结。Flow 不需要包装 Agent。`--params` 是 JSON 对象；有位置文字时使用 composer 来源，按发布定义的 inputSource 确定性绑定；文字看起来像 JSON 也不解析为参数。省略位置文字时使用 arguments 来源，允许纯参数、全部默认值和零参数 Flow。连接覆盖通过 `--connection-bindings` 提供 JSON 对象，目标未声明 Flow 输入时拒绝此覆盖。Flow Agent 的参数签名也随请求保存，后续绑定 Flow 修订变化必须重新准备，不能按新表单解释旧文件。

`prepare` 只读取目标目录与 Session 元数据并保存请求，不激活会话或执行调用；它不表示后端已经接纳或完整校验。`--branch` 在 prepare 中记录预期分支，不切换当前分支。`send --submission-file` 在派发前独占创建权限为 0600 的文件，同步文件及父目录；文件存在或保存失败时不发送。文件冻结显式输入、目标版本/摘要及提交身份，后端仍在接纳时展开默认值和冻结实际执行计划。省略该选项的 send 不提供 CLI 请求文件恢复副本。

`submit` 使用文件中的原身份明确提交；CLI 不自动重放写入。提交丢回复时使用 `receipt`，不能把 unknown 当成未发送或自动换 ID 重试。文件式 submit/receipt 不接受覆盖目标、参数、连接或分支；需要改变输入时准备一个新请求。call.json 含原始输入，应作为调用工件保存，不作为诊断日志。

`receipt` 通过 `session.submission.inspect` 查询原冻结摘要，不打开或激活 Session 视图，不创建 Kernel Session、不唤醒队列，也不改变其他视图绑定。accepted 只证明持久接纳，unknown 只表示证据不足；该查询不证明执行完成。原有绑定内 `session.submission.receipt` 保留严格绑定校验。本地宿主启动时的正常恢复独立发生；需要观察现有运行宿主时使用 --connect。

`session contexts` 经只读 `session.context.bindings` 查询安全绑定摘要；指定 binding-id 时分页读取已确认检查点。将返回的 nextCursor 原样传给 `--cursor '<cursor-json>'`，集合推进后重新查询。`--context` 文件只接收 ConversationSelection，随原调用冻结；后续编辑该选择文件不改变已准备的请求，submit/receipt 禁止该覆盖。普通模型 Agent、Flow 及不支持的原生能力不能因传入文件而获得续接权；严格原 thread 续接仍拒绝。上下文模式及完整实施范围见[绑定协议](design/execution-context-binding.md#84-已确认检查点与只读目录)。

远程使用这些入口需要 httpd 构建包含 session.targets.list、session.submit 与 session.submission.inspect。旧宿主缺少命令时明确失败，不回退到旧 session.send 或本地执行。快速退出时，启动协调器继续允许已接纳恢复工作读取既有就绪 Promise，拒绝新初始化并排空原工作。

## 显式连接现有 httpd

```bash
pnpm cli project list --connect https://host:2000 \
  --client-cert /private/client.crt --client-key /private/client.key --ca-cert /private/ca.crt
```

应用命令均可选择 `--connect`，使用与浏览器相同的 `/api/application`、SSE 和文件能力，严格校验服务端证书并提供 mTLS 客户端身份。此模式不打开本地 profile；不能和本地 profile/授权/宿主参数混用。证书认证失败或网络中断直接报错，不回退本地，不自动重放写请求。远程 `session send` 默认返回接收结果，`--follow` 等待执行状态。

## 无 UI 验证原生远程会话

下列命令均可在末尾添加本地 `--profile` 或上述远程连接参数：

```bash
pnpm cli project list
pnpm cli conversation profiles <project-id>
pnpm cli conversation create <project-id> <profile-id> <workspace-id>
pnpm cli conversation list <project-id> <profile-id>
pnpm cli conversation show <project-id> <profile-id> <native-session-id>
pnpm cli conversation send <project-id> <profile-id> <native-session-id> "测试消息"
pnpm cli conversation reconcile <project-id> <profile-id> <native-session-id>
```

`create` 使用 profiles 返回的 workspace ID，显式创建真实原生会话并返回 session；操作携带 epoch 与唯一 requestId。`list` 可追加上一页返回的 cursor。`show` 返回后端快照，包括 canSend、pending、disconnected 和 observation。`send` 调用与 llm-ui 相同的 `ProjectConversationPort.send()`，保留后端错误 code、remoteCode、outcome、requestId；结果未知时用 `reconcile` 查询回执，不自动再次发送。还支持 branches、fork、interrupt。发送、分支和中断均为真实操作，读取命令不会试发消息。turn 被接受只表示提交成功，模型最终回复或失败需继续检查原生事件与会话状态。

这可以分离界面问题与后端问题：若 CLI 同样返回 `HARNESS_SESSION_BUSY`，应处理原生线程的 active writer；若同一端口发送成功而 UI 无回显，再检查界面订阅和投影。复查当前运行 httpd 的挂载、授权和占用状态应使用 `--connect`，本地模式用于隔离验证同一实现。

nestos-node 0.1.3 起支持同一远程项目的多个原生 session 并发执行；同一 session 仍只允许一个活动 turn。提交与收据按 session/requestId 隔离，一个会话等待审批不阻塞其他会话。活动执行共享文件保护，最后一个执行结束前，文件 API、project_exec 与挂载变更仍返回忙；独立修改代码时显式使用 worktree。此能力需要升级实际运行的 nestos-node，仅更新 CLI 或 httpd 不会解除旧服务的项目串行限制。

## CLI 启动 HTTPS 服务

```bash
pnpm cli -d 127.0.0.1:2000 --profile /path/to/data \
  --cert-dir /private/http-certs --auth-dir /private/http-auth --static apps/http-app/dist
```

`-d/--http` 现在委托 `apps/node-host/http`，与独立 httpd 相同：完整 Web UI、mTLS、HTTP/SSE 应用端口和初始化完成后 listen。静态目录默认 `apps/http-app/dist`，证书使用 httpd 已生成的私密目录。旧 Tauri invoke shim、原始 SQL/FS bridge、精简轮询界面已删除。路由、权限和证书初始化见 [HTTP 应用宿主](http-app.md)。

## 远程会话用量与费用估算

nestos-node 0.1.5+ 的 Codex/Claude profile 声明 `capabilities.usage`，提供只读 `harness_session_usage`。现有 `harness_session_read`（首页）及 `harness_session_info` 同时返回 `session.usage`，客户端沿用已有历史读取、15 秒状态核对及终态刷新，不新增费用轮询。CLI `conversation show` 与 Web/Tauri 消费相同的 `usage` 和 `usageEstimate`。

- nestos-node 只读取已授权原生历史，按文件身份与偏移缓存新增记录；重启后重建，不保存价格或消息副本。每次最多扫描 32 MiB，单记录最多 2 MiB，最多 8192 个计量项，超过扫描窗口、记录异常或计数器重置时明确返回 `complete: false`；条目容量超限明确报错。读取失败保留会话可用性并标记 `usageUnavailable`。
- `usage.scope = "transcript"`：估算当前原生历史中可见的用量，包含分支继承的历史，不代表该分支新增消费；独立子会话或原生未提供的用量不会凭空补齐。此投影不能跨分支直接相加当作实际账单。
- 输入、缓存读取、缓存写入为互斥 token 桶；推理 token 是输出的子集，不重复计价。Codex 的累计快照只取增量；Claude 按原生 message ID 替换重复帧。失败和取消不会清空已观察用量。
- `nestos-node-driver` 校验身份、非负安全整数、重复项和汇总一致性，只搬运用量。`app-core` 注入估算函数；`kernel-adapters/contracts` 提供纯定价解析与计算，不读取 VFS 或网络。UI 只展示结果。
- 价格优先级：供应商与模型精确匹配 → 模型名称/别名 → `fallbackFor` 包含供应商 ID 的默认价 → 全局 `default`。具体默认金额只放在可选产品预设，已有配置只补缺失的供应商默认条目，不覆盖用户设置；新增自定义供应商从用户配置的全局默认价生成可编辑条目，没有全局模板时不凭空生成价格。
- 定价编辑器可修改 `fallbackFor`（供应商 ID，逗号分隔），`.llm` 的 pricing 条目保留此字段。示例：`{id: "my-default", fallbackFor: ["my-provider"], providers: {}, price: [2, 8, 2, 0.2]}`，单位 USD/百万 token。
- `usageEstimate` 使用当前定价，并携带各条目的价格快照、匹配依据与用量 revision；未知价格返回 null，不把缺失数据当作零费用。远程估算不写入本地 `cost.seq`，不修改已入账历史费用，避免重复统计。

## 日志与其他入口

| 模式 | 默认文件 |
|---|---|
| CLI 本地 | `<config>/logs/cli/cli-local-<timestamp>-<pid>.jsonl` 与 `cli-local-<pid>-audit.jsonl` |
| CLI 连接 httpd | `<config>/logs/cli/cli-remote-<timestamp>-<pid>.jsonl`；服务端审计仍写 httpd 自己的文件 |
| CLI `-d` | `<config>/logs/cli/httpd-cli-<timestamp>-<pid>.jsonl`、`<config>/logs/http/httpd-cli-audit.jsonl` |
| httpd release | `/var/log/nestos/httpd.runtime.log` 与 `/var/log/nestos/httpd.audit.jsonl` |
| httpd dev | `/var/log/nestos/httpd.debug.runtime.log` 与 `/var/log/nestos/httpd.debug.audit.jsonl` |
| Tauri dev/release | `<config>/logs/desktop/tauri-<mode>-<timestamp>-<pid>.jsonl`；LLM 元数据位于 `<data>/var/log/llm/tauri-<mode>-<session>.json` |
| nestos-node 0.1.4+ | nestos-node 配置文件同级 `logs/nestos-node-<启动时间>-<pid>.jsonl`；默认每份 10 MiB、每次启动最多 5 份，`[logging]` 可配置 |

`<config>` 遵循 XDG_CONFIG_HOME。httpd 的 `NESTOS_HTTPD_LOG_DIR` 覆盖运行与审计日志目录；系统默认目录需先授权给运行用户，准备命令和运行版本查询见 [HTTP 宿主](http-app.md#启动与认证)。CLI 的 `NESTOS_DIAGNOSTICS_DIR` 只覆盖诊断目录，`--audit-file` 只覆盖当前宿主审计路径。新应用诊断记录操作阶段、错误码、提交结果和请求 ID，不写 prompt、消息正文或凭据。旧日志不删除。

已有 `run/resume/respond` 等 YAML/RunDefinition 离线执行命令继续使用 `createKernelRuntime` 和自己的 RunStore 工件；它们不是应用 Session 命令，不支持 `--connect`，不能将旧 run-id 当作应用 session-id。`twin` 使用本地共享应用 Runtime；旧 memory/fs 辅助入口按原作用域执行。

原生只读诊断使用共享应用端口，不发送 prompt：`pnpm cli conversation query <project-id> <profile-id> <session-id> session:status [query-id] --connect https://host:2000`，认证参数同其他应用命令。报告保存待核对时使用 `conversation reconcile-query <project-id> <profile-id> <session-id> <query-id>`。这两个入口不先读取完整历史；节点需声明 commandQueries 能力，缺失时明确报错。它们核对查询报告，原执行仍通过原 submission/control 身份核对。

## Flow 调用控制 CLI

应用 Flow 使用 `flow-run`，身份为 Session ID 与根 Task ID，不能与离线 YAML 的 run-id 混用。使用 `--connect` 操作现有 HTTP 宿主；未指定时沿用 CLI 本地宿主启动/关闭和 profile 互斥行为，不承诺 CLI 退出后继续后台调度。

```bash
pnpm cli flow-run show <session-id> <root-task-id>
pnpm cli flow-run pause <session-id> <root-task-id> <request-id> <observed-epoch>
pnpm cli flow-run resume <session-id> <root-task-id> <request-id> <observed-epoch>
pnpm cli flow-run withdraw-pause <session-id> <root-task-id> <request-id> <observed-epoch>
pnpm cli flow-run receipt <session-id> <root-task-id> <request-id>
pnpm cli flow-run cancel <session-id> <root-task-id>
pnpm cli flow-run reattach <session-id> <root-task-id>
```

先用 show 读取根 `control.epoch`，未设置控制时为 0。调用方须在发送前保存 request-id 和该 epoch；同一次操作核对或显式重试保留二者，新意图使用新身份。CLI 不生成隐含新控制 ID，不在网络异常后自动重试。`resume` 解除本调用已确认的暂停；`withdraw-pause` 撤回尚未确认的暂停；`reattach` 只恢复宿主调度，不能替代解除暂停。

receipt 按 requestId 查询 Kernel 保留的原接纳记录：存在返回 `observed`，`receipt.accepted` 是当时控制，`receipt.current` 是当前控制，`action` 区分恢复与撤回暂停。原记录在后续控制覆盖、Task 终结后仍可查询；历史 acknowledged 不代表当前子树已停止，当前执行状态用 show 核对。无保留记录返回 `unknown`，不能据此自动重发。查询不改变执行、队列或 Session 绑定；本地宿主正常启动恢复仍独立存在。


## CLI 原生上下文目录与冻结选择

```bash
pnpm cli session contexts <session-id> [binding-id] --branch main
pnpm cli session contexts <session-id> [binding-id] --cursor '<nextCursor JSON>'
pnpm cli session prepare <session-id> '本轮增量输入' --agent <agent-id> --context selection.json --submission-file call.json
pnpm cli session submit <session-id> call.json
pnpm cli session receipt <session-id> call.json
```

可附加现有 --connect 与认证参数。contexts 不打开 Session view、不领取 writer，返回安全绑定摘要；指定 binding-id 时读取检查点，nextCursor 保留查询范围与修订。目录变化导致游标无效时重新查询，不能改写游标继续拼接旧观察。CLI 本地启动的正常宿主恢复独立存在。

selection.json 使用公共 ConversationSelection，例如 `{"mode":"fork","sourceBindingId":"binding-id","expectedBindingRevision":4,"expectedGeneration":1,"checkpointRef":"checkpoint-ref"}`；字段值必须来自实际目录。prepare 只冻结请求，不表示接纳或执行资格已确认。Flow 不接受此覆盖，模型 Agent 和不支持的能力由宿主拒绝；严格 continue 仍不开放，fork 不恢复工作区文件系统。

原选择文件之后的编辑不改变 call.json；submit/receipt 禁止 --context 覆盖。提交丢回复应使用 receipt 查询原身份，不自动换 ID 或重发。查询和准备诊断只保留阶段、结果、关联 ID、耗时及安全错误码，不记录游标或用户输入。


## CLI 独立 Agent / Flow 调用

```bash
pnpm cli session call-prepare <caller-session-id> --flow <flow-id> --params input.json --call-title '独立检查' --submission-file call.json
pnpm cli session call-prepare <caller-session-id> '本次任务' --agent <agent-id> --call-title '独立任务' --submission-file agent-call.json
pnpm cli session call-submit <caller-session-id> call.json
pnpm cli session call-receipt <caller-session-id> call.json
```

call-prepare 不执行调用，call.json 保存完整 IndependentCallInput（request/title/可选 transfer），不能与普通 session prepare 的文件混用。可选 --transfer reference.json 指定显式材料引用 `{sessionId,id}`；参数、标题及材料引用在准备时冻结，后续编辑来源文件不影响原请求。文件按 0600 独占创建并同步，不能覆盖；默认参数和执行策略仍由宿主在接纳时冻结。

call-submit 明确提交原文件身份，由宿主创建独立子 Session。调用方会话不重复入队、不自动继承其历史。丢回复后用 call-receipt 查询；unknown 不代表没有发送，accepted 只代表持久接纳。submit/receipt 不接受重新指定标题、材料、目标或分支。

本地提交默认等待该子调用完成或进入人工交互/待派发/待核对状态；失败/取消沿用 CLI 退出码 2，等待输入为 3。远程 --connect 默认返回接纳及 executionSessionId；添加 --follow 在 CLI 自身观察作用域打开该子 Session，等待其真实执行，不以父级状态判断。回执查询不打开视图，--follow 仅适用于 call-submit。CLI 本地进程退出不承诺继续后台调度，需要后台执行时使用持续运行的远程宿主。
