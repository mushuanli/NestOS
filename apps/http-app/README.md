# MindOS HTTP app

Node.js 提供静态 UI 和 VFS 存储 API；浏览器装配完整 MindOS 应用运行时。服务端使用 `@itookit/vfsdriver-local`，文件、元数据、标签和 SeqFile 记录落盘，浏览器不依赖 Tauri。Node.js 需要 >=22.13。

从仓库根启动：

```bash
pnpm --filter @itookit/http-app dev --host 192.168.31.10 --port 2000 --root ./mindos-data
```

打开 `http://192.168.31.10:2000`。`dev` 先构建 UI，再运行服务端；修改源码后重新执行。默认地址为 `127.0.0.1:2000`，默认数据根是启动目录下 `.mindos-http`。相对 `--root`、`--sidecar`、`--static` 按命令启动目录 `INIT_CWD` 解析，不按 pnpm 切换后的 app 目录解析。

生产启动：

```bash
pnpm --filter @itookit/http-app build
pnpm --filter @itookit/http-app start --host 192.168.31.10 --port 2000 --root ./mindos-data
```

复用已有数据根时，把 `--root` 指向原 profile 的实际数据目录。例如：

```bash
pnpm --filter @itookit/http-app start --host 192.168.31.10 --root /home/li/share/prj/pair-x1/mindos
```

`--root` 是整个 MindOS VFS 数据根，不是会话工作目录。默认 SQLite 位于 `<root>/_meta/index.db`，与 CLI/Tauri 布局一致。`--sidecar` 可指定根目录外的元数据目录；搬迁时需要一起保留文件树与 sidecar。UI 只能访问该 VFS 根内的逻辑路径，不直接打开宿主绝对目录。旧 profile 中其他机器的外部项目目录引用保留，当前宿主未提供目录挂载时显示不可用。

UI 的 HTML、样式、工作区配置和编辑器工厂通过 `mind-os` 的公开入口复用。HTTP app 不启用 Web 的 IndexedDB/PWA 和受管项目同步。模型调用及 Kernel 运行仍在浏览器；关闭页面会停止运行。桌面的本机 Bash、Git worktree 和 MCP stdio 能力需要相应宿主，不由本 app 提供。

协议、事务语义与限制见 [HTTP 存储应用](../../doc/http-app.md)。
