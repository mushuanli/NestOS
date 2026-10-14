# @itookit/sanbox

为 Linux Bubblewrap 和 macOS Seatbelt 生成进程启动计划。TypeScript 入口零运行时依赖，默认关闭网络，宿主显式授予目录读取/写入权限；不可用时拒绝执行。

根入口适用于纯策略计算；`@itookit/sanbox/node` 提供真实路径解析、可执行文件检查和实际启动探测。

```ts
import { spawn } from 'node:child_process';
import { prepareSandbox, probeSandbox } from '@itookit/sanbox/node';

const sandbox = prepareSandbox({
    readOnlyPaths: ['/absolute/path/to/input'],
    writablePaths: ['/absolute/path/to/workspace'],
    network: 'deny',
});
probeSandbox(sandbox, '/absolute/path/to/workspace');
const plan = sandbox.wrap({
    command: '/bin/sh',
    args: ['-c', 'echo hello > output.txt'],
    cwd: '/absolute/path/to/workspace',
});
const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ['pipe', 'pipe', 'pipe'],
});
// The host owns stream handling, process-tree cancellation and close confirmation.
child.on('error', error => console.error(error));
```

目录必须已存在。Node 入口通过 realpath 固定授权目录并逐次核验 cwd；未声明的主目录不会自动开放。`readOnlyPaths` 表示可读范围，`writablePaths` 同时授予读写。可在只读父目录内授予可写子目录；反向的只读子目录与可写父目录组合会拒绝，避免两种后端产生不同权限语义。

`createSandboxLaunchPlan(backend, policy, request, executable?)` 和 `createSeatbeltProfile(policy)` 是纯编译器；调用方必须先验证、规范化原生路径。`executable` 仅供可信宿主指定安装位置，不能取自模型参数。纯入口不会检测操作系统或授权真实性。

启动时必须以 argv 执行，并以 `plan.env` **替换**宿主环境；不要合并 `process.env`，也不要设置 `shell: true`。请求的 `env` 在沙箱内部由 `/usr/bin/env -i` 设置，不会影响沙箱启动器。Node 的 `probeSandbox` 实际运行受限 shell，验证系统是否允许启动；探测成功不是任意工具兼容性的保证。

Linux 提供私有 `/tmp`、`/proc`、最小 `/dev` 与基础系统只读目录。macOS 无 mount namespace，使用真实路径过滤；未自动开放共享临时目录，需要临时写入时由宿主创建专用目录、加入 `writablePaths` 并通过 `env.TMPDIR` 传入。两端均可能需要宿主为特定工具增加明确的只读依赖目录。

桌面应用已接入：Tauri 的 `session_shell_exec` 调用本目录 `native/` 下的 Rust crate `itookit-sanbox`，Linux 使用 Bubblewrap、macOS 使用 Seatbelt，网络策略由宿主固定为 deny。TypeScript 与 Rust 共用 `src/runtime-policy.json`，不接收前端生成的可执行文件、profile 或沙箱 argv。原有 Rust runner 继续负责输出、超时与取消；目录授权仍在宿主解析。

Rust 入口 `session_command(script, cwd, mounts, NetworkAccess)` 接受宿主授权来源与 VFS 挂载目标：Linux 保留 `/workspace` 等虚拟挂载；macOS 将 cwd 解析为原生目录，脚本应使用相对路径或真实路径，不会把脚本内 `/workspace/...` 字面量改写为原生路径。缺少隔离程序时拒绝执行。

当前桌面接线覆盖 Session/Flow 的 Bash；桌面未提供持久 TTY 驱动，CLI 保留原有 native/OCI 配置。模块不实现进程树管理、资源限额、域名级网络白名单或 MCP 服务隔离。完整职责和验证方式见 [系统沙箱设计](../../doc/design/system-sandbox.md)。

```bash
# Tests the Rust package as well as the Tauri host boundaries.
pnpm --filter tauri-app test:rust
```
