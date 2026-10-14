# 最小系统运行与验收

本页针对当前代码。已验收：CLI 与原生模块组合链；真实 Tauri 窗口（X11）→ 默认 Agent（mock Provider/Connection）→ 外层 harness → Bash tool → 真实 IPC `session_shell_exec` → bwrap → 子 CLI 两节点 DAG → 界面/结果重开（证据见下方「桌面端到端」）。总进度见 [todo](todo.md)。不需要 X11 即可执行以下 CLI 命令。

## 桌面端到端（Tauri）

P0-01 的验收链已在真实应用窗口上跑通，证据：

- 子 Run `20260909145050-deab21b0` / `20260909150550-a0b663ab` `status=succeeded`，两节点 succeeded，`result.txt = child-first-result`；
- 外层 kernel 的 Bash Effect succeeded → 第二轮模型请求携带工具结果 → 外层 `task.succeeded`；
- 界面显示 Bash 工具节点、`[exit 0]` 与子 Run 事件；
- 应用重启后 transcript 仍含 `OUTER-HARNESS-DONE`、`[exit 0]`、`child-first-result`（结果重开通过）。

### 启动与数据根

开发模式与生产模式的差别只有前端资源来源，但**必须二选一**，否则窗口会报 `cannot connect to localhost`：

```bash
# A. 生产模式：前端已打进二进制（推荐用于验收）
pnpm --filter tauri-app build                       # 先构建前端 dist/
cd apps/tauri-app/src-tauri
cargo build --offline --features tauri/custom-protocol
./target/debug/tauri-app

# B. 开发模式：需要另开 Vite（tauri.conf.json 的 build.devUrl）
pnpm --filter tauri-app dev                          # 或 pnpm tauri:dev
```

Rust 侧沙箱与进程边界测试（真实 bwrap 授权边界、取消/超时的进程组终止、目录与符号链接逃逸、输出上界），无需 X11：

```bash
pnpm --filter tauri-app test:rust                    # cargo test，12 通过
```

数据根由 `mindos.json#rootDir` 决定，默认 `<config>/data`；验收时可用 `MINDOS_ROOT` 指向隔离目录，避免污染真实数据：

```bash
env -u http_proxy -u https_proxy -u all_proxy -u no_proxy \
  DISPLAY=:0 MINDOS_ROOT=/tmp/mindos-acceptance/data \
  apps/tauri-app/src-tauri/target/debug/tauri-app
```

### 模型与目录授权

1. 设置 → Provider：新增 OpenAI-compatible 地址与 API Key；验收可用本地 mock。Key 按已确认的落盘方案，以**明文**保存在数据根的 `/etc/llm/.providers/<id>.json`，表单已标注存储路径。Provider 列表接口与 `.llm` 配置导出不包含该字段；如果把凭证写入消息或命令，仍可能进入对应记录。`api_key_env` 是 CLI YAML 从环境变量读取凭证的配置，桌面 Provider 表单没有该字段。回归见 `backend/kernel-adapters/tests/llm-management/provider-export.spec.ts` 和 `ui/llm-settings-ui/tests/ProviderSettingsEditor.key-storage.test.ts`。
2. 设置 → Connection：把 tier 指向实际模型 ID；Agent 保持默认即可。
3. 目录授权：只有明确授权（`directory_open`）的目录才进入 Session 命名空间。典型映射是仓库只读 `/app` + 可写工作目录 `/workspace`；未授权目录在 Bash 里不可见。
4. 发送一条要求“运行子 harness”的消息。Agent 会调用 Bash 工具，命令形如：

```bash
node /app/apps/cli/dist/cli.js run -f /workspace/workflow.yml --state-dir /workspace/.mindos --headless --json
```

子 Run 的输出目录是 `/workspace/.mindos/runs/<run-id>/`（`run.json`、`result.txt`）。预期：界面出现 Bash 工具节点与 `[exit N]`，外层 Task succeeded，子 Run 的 `result.txt` 与节点依赖一致。

### 子进程凭证注入

原生 Session Bash **清空继承环境**（只保留 `PATH=/usr/local/bin:/usr/bin:/bin`、`HOME=/tmp`、`LANG=C.UTF-8`），因此终端里 `export MINIMAL_API_KEY=...` 不会进入子 harness。该行为有回归测试：`session_bash::tests::clears_host_credentials_and_exposes_only_the_fixed_session_environment` 与 `session_bash::tests::never_falls_back_to_a_host_shell`（`pnpm --filter tauri-app test:rust`）。可选做法：

- 在 Bash 命令里显式前缀注入（最简单，但命令会进入持久记录与界面，**不要写真实 key**）：`MINIMAL_API_KEY=<值> node /app/apps/cli/dist/cli.js run ...`；
- 让子 harness 从工作目录内的受控文件/环境变量名读取（例如把凭证放到 Session 可读但不可写的位置，配置里只写变量名）；
- 生产部署建议由宿主在启动子进程时注入，而不是让模型拼命令。

桌面 Provider 表单也说明了 Session Bash 不继承宿主环境；子 harness 的凭证需按上述约定单独提供，桌面 Provider 中保存的 Key 不会自动传入子进程。

## 不依赖外部模型的组合验收

从仓库根目录执行，环境需已安装依赖、Node.js ≥22.13、Rust、Bash 和 Linux Bubblewrap：

```bash
pnpm --filter @itookit/cli test tests/nested-harness.test.ts
```

测试自动启动本地固定模型响应服务，用标准外层 Kernel tool.call 调用 Bash，调用真实 Tauri Rust 进程模块，在只读 `/app` 与可写 `/workspace` 映射内执行 CLI 子 harness。子 DAG 为 `first → second`；成功场景断言第二节点收到第一节点输出、子结果落盘、外层 Task/Effect 成功且存储重开一致。另有第二节点模型拒绝的失败场景：子 Run failed、没有成功 result.txt，外层工具结果保留 `[exit 1]` 并可重开。Bash 非零退出是工具返回数据，不能仅凭 Effect succeeded 判断子 Run 成功。临时文件由测试清理，不要求真实 API key。非 Linux 平台跳过此测试，不代表验收通过。

测试读取下方同一份公开 YAML 示例，仅替换服务端口。它绕过真实 Tauri IPC，因此不能作为桌面窗口端到端证据。另可运行：

```bash
pnpm --filter @itookit/cli test tests/hitl.test.ts tests/run-scheduler-lock.test.ts tests/run-scheduler-lease-delete.test.ts tests/worktree-run.test.ts
pnpm --filter @itookit/app-shell exec vitest run tests/minimal-skill-dag.test.ts tests/tauri-bash.test.ts
```

分别验证人工暂停的跨进程恢复/调度互斥/删除保护/隔离工作区，以及 Skill→Agent→DAG/平台桥接。沙箱若禁止本地端口或子进程，应在允许这些能力的环境运行。

## 使用自己的模型运行两节点 DAG

公开配置：[minimal-dag.yml](../apps/cli/examples/minimal-dag.yml)。该例明确使用 native 模式且 Agent 不配置 Bash/TTY 工具，适合先验证节点传值；不要把 CLI native 当作 Tauri Session 的 Bubblewrap 隔离。

```bash
pnpm --filter @itookit/cli build
mkdir -p /tmp/x1-minimal-demo
cp apps/cli/examples/minimal-dag.yml /tmp/x1-minimal-demo/workflow.yml
```

编辑复制后的配置：`base_url` 是你的 OpenAI-compatible 服务地址，`default_path` 是聊天接口路径；将 `models[0].id` 与 `connections[0].tiers.standard` 的 `local-model` 同时改为服务实际模型 ID。默认地址 `127.0.0.1:8080` 只是配置示例，本命令不会自动启动模型服务。

在当前终端设置 `MINIMAL_API_KEY` 为服务所需凭证；不需要认证的服务可设置非空测试值。配置文件只保存环境变量名，不写入凭证正文。然后执行：

```bash
node apps/cli/dist/cli.js validate -f /tmp/x1-minimal-demo/workflow.yml --offline
node apps/cli/dist/cli.js graph -f /tmp/x1-minimal-demo/workflow.yml --offline --json
node apps/cli/dist/cli.js run -f /tmp/x1-minimal-demo/workflow.yml --headless --json
node apps/cli/dist/cli.js runs --state-dir /tmp/x1-minimal-demo/.mindos --json
```

`workspace.root: .` 相对于 YAML 所在目录。输出状态位于 `/tmp/x1-minimal-demo/.mindos/runs/<run-id>/`，包括 `run.json`、`result.txt` 和配置快照；成功退出码为 0。模型结果会变化，验收应检查 `first → second` 依赖、Run 成功与结果存在，不要求固定措辞。

若使用含人工交互的其他配置，退出码 3 表示等待输入，从等待事件/manifest 获取 request-id 后执行：

```bash
node apps/cli/dist/cli.js respond <run-id> <request-id> --state-dir /tmp/x1-minimal-demo/.mindos --approve --json
node apps/cli/dist/cli.js resume <run-id> --state-dir /tmp/x1-minimal-demo/.mindos --headless --json
```

以上尖括号参数需替换实际值。resume 复用已有 Run，rerun 创建新 Run。正常人工暂停检查点可恢复，不保证任意崩溃点无重复提交。另一个调度器持锁时 run/resume/delete 的冲突操作会被拒绝。

## Tauri 与 Web 接口

Tauri 已接入 Session Bash 工厂。用户需先明确授权目录：例如仓库只读映射 `/app`，示例工作目录可写映射 `/workspace`；文件存在于映射内且 CLI 已构建时，Bash 工具命令的结构为：

```bash
node /app/apps/cli/dist/cli.js run -f /workspace/workflow.yml --headless --json
```

原生 Session Bash 清空继承环境，因此不能假设终端导出的 API key 会自动进入子 harness。组合验收使用显式注入的无敏感性测试值；真实凭证的桌面子进程注入与配置交付仍需验收，不建议将真实 key 写进会持久记录的 Bash 命令。该命令结构和目录示意尚不是完整桌面操作教程。

Bash 返回 stdout/stderr/退出码，支持超时与取消；原生每个输出流最多保留 1 MiB 原始字节，超出后排空并标注截断。Linux 隔离共享网络，运行库/DNS/证书等可见，不是全封闭网络环境。

桌面端的模型请求由 webview 直接发起，受 `apps/tauri-app/src-tauri/tauri.conf.json` 的 CSP `connect-src` 约束。该指令现放行 `https: http: ws: wss:`（外加 `ipc:`），因为 Provider 地址由用户在设置里配置；若收紧到固定域名，需同时把用到的 Provider 域名列入，否则界面会报 `Load failed`。图标字体已本地打包，MathJax/Mermaid 仍从 `https://fastly.jsdelivr.net` 加载，因此离线时公式/图渲染不可用。

Web 保留 `createSessionProcesses` 接口，默认不注入本机 shell；不能在浏览器界面执行上述原生命令。无 X11 可编译 Tauri 和执行 CLI，但真实窗口、IPC、授权与错误反馈仍需单独验收。


桌面链路现已贯通到「真实窗口 + 真实 IPC + 外层工具调度」（见上方「桌面端到端」）：不再停留在编译或开发者控制台重复求值。


## 已知问题与测量方法（P0-02）

应用被强杀后重启的前几次发送，从用户消息落盘到 `task.created` 存在 11–25s 的空档。已用无界面探针测量同一份数据根上的共享路径（`backend/app-core` + `llm-session`，LocalFS 进程内后端）：

```bash
# 需要一个 OpenAI-compatible mock 服务（默认 127.0.0.1:8399）
cd apps/cli && npx tsx ../../.tauri-acceptance/measure-ipc.mts <dataRoot> <每次后端调用延迟ms> <发送次数>
```

结果（同一会话、10 个已提交 Task）：

| 每次后端调用延迟 | 第 1 次发送 → task.created | 后端调用数 | 第 2 次发送 |
|---|---|---|---|
| 0ms | 96ms | 643 | 4ms（26 次调用） |
| 1ms | 411ms | 718 | 14ms |
| 5ms | 1532ms | 779 | 1339ms |

结论：共享路径本身很快（进程内 96ms/4ms），延迟与**每次 VFS 后端调用的跨进程开销**近似线性；桌面端每次后端调用要走 Tauri IPC（`TauriFsOps` + `TauriSqlSidecarDb`），因此 600–800 次调用被放大到秒级。已确认的下一层问题是「桌面端每次发送为什么仍要数百次调用」（进程内同会话第二次只有 26 次），需要在应用内统计后端调用数（Rust 侧计数或 webview 侧 `ioStats` 落盘）后定位。可接受阈值建议：热路径单次发送 ≤ 2s、`task.created` 前后端调用 ≤ 100 次。

2026-09-10 在真实窗口复现同一现象：发送 06:45:13 → `task.created` 06:45:33.720（20.7s），随后链路正常完成；应用内探针（`VITE_MINDOS_TRACE=1` 构建）进一步显示近乎空闲时仍有 ≈60 次 VFS 操作/秒（99% stat），与发送路径自身的 600–780 次操作争用同一条 Tauri IPC 通道。明细见 [最小系统验收记录](minimal-system-acceptance.md) §4。

诊断用法：

```bash
VITE_MINDOS_TRACE=1 pnpm --filter tauri-app build
cd apps/tauri-app/src-tauri && cargo build --offline --features tauri/custom-protocol
# 运行后读 <rootDir>/var/log/vfs-trace.log（每 2s 一行 JSON：ops + 按操作类型增量）
```


## 2026-09-14：桌面诊断计量与动作边界

trace 构建在官方 Tauri core invoke 的统一入口计数，覆盖直接导入、event 相对导入、Resource.close、权限查询/申请、插件监听注册/移除及注册失败后的兼容重试；每次提交计数一次，不改写被冻结的宿主对象。入口形状变化会明确阻止构建，避免悄悄漏计。诊断文件追加显式绕过计数。

仅 VITE_MINDOS_TRACE=1 时注册 window.__MINDOS_TRACE__。验收驱动在选定起点调用 begin('send-to-provider') 保存返回 id，在对应终点调用 end(id) 获取同步快照并追加日志。时间使用 performance.now；VFS/sidecar/IPC 分别记差值，不读取命令参数。开始前与结束后的操作不计入动作，重叠动作独立计算，计数重置则拒绝结果；运行时释放时清理活动动作和全局接口。

日志 kind='action' 是指定动作的区间，kind='interval' 是周期区间，二者重叠，禁止相加当作总量。调用方必须把边界接到实际发送与 Provider 接收点；接口本身不证明边界已经正确放置。经过官方 core 的提交数也不等于全部 WebView 内部传输或底层重试。

隔离 app-shell 188 项通过，另有 30 项既有跳过；真实 Vite 配置编译/执行官方模块的 trace 开关回归通过，覆盖失败 fallback 与诊断旁路；Tauri 类型检查、开关两种完整前端构建及文档检查通过。P0-02 的真实窗口动作计量、通道取数/传输覆盖和 ≤2 秒 / ≤100 次目标保持开放。


### 本地工作区 Flow 的使用与人工收尾

在 Flow 设置中选择 `Workspace mode=worktree`。Session 内先通过 `/add-dir` 打开挂载管理，将 Git 仓库挂载为唯一可读写目录并设为工作目录，再发送消息启动该 Flow。尚未授权时执行会拒绝；默认目录设置本身不等于授权。

进入「Workflows → 运行记录」查看 Run；桌面重启后选择原记录并点击「继续运行」，会恢复原工作区。`cleanup=keep` 或失败时的 `cleanup=on-success` 保留工作目录；`merge=manual` 保留分支供人工处理。Run 收尾说明显示具体原生目录、分支和基础仓库，CLI 同样输出说明。

若自动合并因未提交更改或分叉而失败，先在报告的目录检查 `git status` / `git diff` 并决定保留内容，再手动提交及解决合并冲突。不要在仍运行的 Run 中删除工作目录。确认任务终态、工作树干净且满足快进条件后，重开该 Run 并点击「继续运行」可重试收尾；期间原分支与副本保留。完整图形冲突编辑器不属于当前本地 P1。
