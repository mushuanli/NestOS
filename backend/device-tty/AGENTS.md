# @itookit/device-tty 开发说明

TTY 设备驱动 — Node.js 交互式 shell 会话，实现 `ITTYDriver` / `ITTYSession` / `ITTYSessionManager`（定义在 `@itookit/tools/contracts`，本包也转发这些类型）。

Node-only：`node:child_process` / `node-pty` 通过模块级异步 IIFE 预加载，浏览器环境不会被打包进静态依赖，此时 `spawn()` 抛出明确错误。

## 目录结构

```
src/
├── index.ts              ← 公共 API
├── node-tty-driver.ts    ← NodeTTYDriver + NodeTTYSession（pipe I/O，supportsPty = false）
├── node-pty-driver.ts    ← NodePtyDriver + NodePtySession（node-pty 真实 PTY，supportsPty = true）
└── session-manager.ts    ← TTYSessionManager + collectOutput
```

## Usage

驱动实例由宿主通过 `createKernelAdaptersRuntime()` 的 `fileContextForSession().ttyDriver` 槽位注入：

```typescript
import { NodePtyDriver } from '@itookit/device-tty';
// fileContextForSession 同时提供 vfs / cwd / nativeShell / ttyDriver / release
await createKernelAdaptersRuntime({
  llmDriver,
  fileContextForSession: async () => ({ vfs, cwd, ttyDriver: new NodePtyDriver(), release: async () => {} }),
});
```

参考实现：`apps/cli/src/runtime.ts`（native → `NodePtyDriver`，OCI 沙箱 → `OciTtyDriver`）、`apps/cli/src/shell.ts`（`OciTtyDriver` 复用 `NodeTTYDriver` 的 I/O）。

## 命令

```bash
pnpm --filter @itookit/device-tty build       # tsup
pnpm --filter @itookit/device-tty test        # vitest run
pnpm --filter @itookit/device-tty typecheck
```

相关文档：[架构设计](../../doc/architecture.md)、[事件流](../../doc/event-flows.md)
