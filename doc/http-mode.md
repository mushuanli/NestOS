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

数据根解析与 MindOS profile 一致。显式路径的 OAuth 目录默认是同级 `<data-root>.auth`，desktop 使用 release 的私密授权目录，可用 `--auth-dir` 覆盖。主机凭据和日志必须位于 VFS 根之外。应用宿主获取数据锁及授权锁，同一数据根不能与已运行 httpd 同时启动第二个写宿主；锁冲突明确失败，此时显式使用 `--connect`。文件名 `httpd-host-lock.sqlite` 为兼容已有宿主保留。

本地 `session send` 等待本轮完成、失败、终止或等待人工输入，再关闭宿主；执行失败或终止返回退出码 2，等待人工输入返回 3；`--follow` 额外输出会话事件 JSONL。关闭视图不会重发消息，也不会把关闭转换为远程 interrupt。

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
pnpm cli conversation list <project-id> <profile-id>
pnpm cli conversation show <project-id> <profile-id> <native-session-id>
pnpm cli conversation send <project-id> <profile-id> <native-session-id> "测试消息"
pnpm cli conversation reconcile <project-id> <profile-id> <native-session-id>
```

`list` 可追加上一页返回的 cursor。`show` 返回后端快照，包括 canSend、pending、disconnected 和 observation。`send` 调用与 llm-ui 相同的 `ProjectConversationPort.send()`，保留后端错误 code、remoteCode、outcome、requestId；结果未知时用 `reconcile` 查询回执，不自动再次发送。还支持 branches、fork、interrupt。发送、分支和中断均为真实操作，读取命令不会试发消息。

这可以分离界面问题与后端问题：若 CLI 同样返回 `HARNESS_SESSION_BUSY`，应处理原生线程的 active writer；若同一端口发送成功而 UI 无回显，再检查界面订阅和投影。复查当前运行 httpd 的挂载、授权和占用状态应使用 `--connect`，本地模式用于隔离验证同一实现。

## CLI 启动 HTTPS 服务

```bash
pnpm cli -d 127.0.0.1:2000 --profile /path/to/data \
  --cert-dir /private/http-certs --auth-dir /private/http-auth --static apps/http-app/dist
```

`-d/--http` 现在委托 `apps/node-host/http`，与独立 httpd 相同：完整 Web UI、mTLS、HTTP/SSE 应用端口和初始化完成后 listen。静态目录默认 `apps/http-app/dist`，证书使用 httpd 已生成的私密目录。旧 Tauri invoke shim、原始 SQL/FS bridge、精简轮询界面已删除。路由、权限和证书初始化见 [HTTP 应用宿主](http-app.md)。

## 日志与其他入口

| 模式 | 默认文件 |
|---|---|
| CLI 本地 | `<config>/logs/cli/cli-local-<timestamp>-<pid>.jsonl` 与 `cli-local-<pid>-audit.jsonl` |
| CLI 连接 httpd | `<config>/logs/cli/cli-remote-<timestamp>-<pid>.jsonl`；服务端审计仍写 httpd 自己的文件 |
| CLI `-d` | `<config>/logs/cli/httpd-cli-<timestamp>-<pid>.jsonl`、`<config>/logs/http/httpd-cli-audit.jsonl` |
| httpd dev/release | `<config>/logs/http/<mode>/<release-id>/httpd-<mode>-runtime.log` 与 `httpd-<mode>-audit.jsonl` |
| Tauri dev/release | `<config>/logs/desktop/tauri-<mode>-<timestamp>-<pid>.jsonl`；LLM 元数据位于 `<data>/var/log/llm/tauri-<mode>-<session>.json` |

`<config>` 遵循 XDG_CONFIG_HOME。CLI 的 `MINDOS_DIAGNOSTICS_DIR` 只覆盖诊断目录，`--audit-file` 只覆盖当前宿主审计路径。新应用诊断记录操作阶段、错误码、提交结果和请求 ID，不写 prompt、消息正文或凭据。旧日志不删除。

已有 `run/resume/respond` 等 YAML/RunDefinition 离线执行命令继续使用 `createKernelRuntime` 和自己的 RunStore 工件；它们不是应用 Session 命令，不支持 `--connect`，不能将旧 run-id 当作应用 session-id。`twin` 使用本地共享应用 Runtime；旧 memory/fs 辅助入口按原作用域执行。
