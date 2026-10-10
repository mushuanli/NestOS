# CLI HTTP 模式

独立 Node.js 存储宿主与完整浏览器 UI 使用 `apps/http-app`，见 [HTTP 存储应用](http-app.md)；本文描述既有 CLI `-d` 模式。

CLI 的 `-d` / `--http` 让同一个 headless 进程直接提供浏览器可访问的 MindOS UI。

```bash
mindos -d 127.0.0.1:8080
mindos -d 0.0.0.0:8080
mindos -d 8080
```

## 架构

```text
Browser
  → 静态 Tauri UI (apps/tauri-app/dist)
  → window.__TAURI_INTERNALS__.invoke shim
  → POST /__tauri/invoke
  → CLI HTTP bridge
      ├── profile VFS rootDir
      ├── Node fs (fs_* / directory_*)
      └── node:sqlite (sidecar_*；兼容旧构建的 plugin:sql|*)
```

CLI HTTP 模式会先启动共享的 MindOS runtime，再开始监听 HTTP：

```text
CLI -d
  → resolve profile
  → open LocalFS backend
  → createApplicationRuntime()
  → runtime ready
  → start HTTP listener
```

因此 VFS / LLM / Kernel / Session / Flow 在 CLI 启动阶段就已完成初始化，不再等浏览器连接。

`-d` 注入：

```html
<script>
  window.__MINDOS_MODE__ = 'remote';
  window.__MINDOS_API__ = '/api';
</script>
```

Tauri UI 入口检测到 remote 模式后不会再执行 `initApp()`，因此不会在浏览器里创建第二套 VFS / LLM / Kernel / SQLite。

当前 remote UI 先提供：

- runtime 状态；
- Session 列表；
- Run 列表；
- 每 5 秒刷新。

完整 Tauri UI 组件复用是后续工作。

## 数据与权限

- 数据根：`--profile desktop` 或显式 `--profile <path>`；
- 文件访问限制在 `rootDir` 与 `--set-home <dir>` 内；
- `directory_open` 返回受限目录句柄，`directory_io` 不能越出该目录；
- SQLite 文件相对路径按 profile `rootDir` 解析。
- 浏览器页面以 `sidecar_open_scope` 建立代次；刷新复用已打开连接，旧页面迟到的事务与 close 被拒绝。

## 能力边界

HTTP 模式不提供：

- `session_shell_exec` / `shell_exec`
- `codex_*`
- 原生 ripgrep / fd

这些命令返回明确错误，UI 应显示“能力不可用”，不能降级为宿主执行。


## Status API

```text
GET /api/status
```

返回：

```json
{
  "ready": true,
  "profile": "/home/li/.config/mindos/data",
  "workspace": "/home/li/share/prj/x1",
  "sessions": 0
}
```
