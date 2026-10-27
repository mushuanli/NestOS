# MindOS HTTP app

Node.js 提供受双向 TLS 保护的应用能力服务，持有唯一的 Session/Kernel/LLM Runtime。浏览器仅装配 UI、应用端口适配器与视图状态。Node.js >=22.13；初始化证书需要 OpenSSL。

```text
Browser + client certificate + shared AppShell
  → HTTPS :2000 (mTLS + enrolled certificate fingerprint)
  → ViewApi + application facade → app-core Runtime → LocalFS + SQLite
```

完整复用 Web/Tauri 的工作区和编辑器，包括工具箱、设置、数字分身和 Flow。浏览器不再通过原始存储 API 创建执行 Runtime；详细边界和验收见 [HTTP 应用宿主](../../doc/http-app.md)。

## npm 安装与启动

发布包名为 `mindnest`，首次版本 `0.1.0`，包含完整网页和服务端；无需克隆开发仓库。

```bash
npm install -g mindnest@0.1.0
mindnest init-certs --cert-host 192.168.31.10
mindnest httpd
```

导入生成的 CA 和浏览器个人证书后，打开 `https://192.168.31.10:2000`。
已有可用证书时跳过初始化。`mindnest`、`mindnest start` 与 `mindnest httpd` 等价；`mindnest --help` 查看参数。
配置目录、数据根和 mTLS 规则与源码宿主一致；认证配置使用 release 子目录。
运行信息输出到前台，默认审计写入配置目录 `logs/http/httpd-release-audit.jsonl`，不是仓库脚本的 `/var/log/mindos/`。
详细安装、功能、配置、备份与升级见 [npm 包说明](./npm/README.md)。

开发者用 `pnpm mindnest:pack` 通过既有隔离 HTTP release 流程准备 npm tarball，
再用 `pnpm mindnest:publish` 发布已准备制品。原生依赖由安装目标系统安装，包内不携带宿主 node_modules、证书或用户数据。
该流程不启动或重启现有 httpd，也不改变 `release/httpd/current.json`。

## 源码宿主

首次初始化私有 CA、服务器证书和浏览器身份：

```bash
./apps/http-app/scripts/create-certificates.sh --cert-host 192.168.31.10
```

也可运行 `pnpm --filter @itookit/http-app create:certs --cert-host 192.168.31.10`。脚本可从任意目录调用，`--help` 查看参数；使用 `--cert-dir /path/to/private/certs` 指定输出目录，相对路径按调用目录解析。脚本设置私有文件权限，并复用服务端证书生成逻辑。

默认生成到 `~/.config/mindos/http-certs`，可通过 `mindos.json` 的 `http.certDir` 修改；目录已存在时拒绝覆盖。`--cert-host` 可填写逗号分隔的 IP/DNS 名称，必须覆盖实际访问地址。初始化只打印文件位置，不打印密钥或密码。

如果提示 `Certificate directory already exists`（旧版本为 `EEXIST`），说明目标目录已经存在。已生成的证书覆盖实际访问地址时，跳过初始化，直接用该目录启动服务；需要新证书时通过 `--cert-dir` 指定尚不存在的新目录，并在启动服务时使用同一个目录。新 CA 和浏览器身份需要重新导入浏览器。

浏览器导入：

1. 将 `ca.crt` 导入受信任的证书颁发机构，以验证服务器身份。
2. 将 `browser-client.p12` 导入个人证书，导入密码在 `client-password.txt`。
3. 打开 `https://192.168.31.10:2000`，浏览器请求选择身份时选 `MindOS browser`。

不导入 CA 时浏览器不能信任服务器；不导入客户端身份时无法连接。CA 私钥 `ca.key` 不用于浏览器导入，应妥善保管。客户端私钥和导入包只交给获准访问该个人数据的设备。

从仓库根启动：

```bash
pnpm httpd
```

发布使用根目录的 `pnpm httpd:build` 构建并选择独立 release，再运行 `pnpm httpd`（或 `pnpm --filter @itookit/http-app start`）。`--cert-dir` 指定证书目录，`--audit-file` 指定 JSONL 日志；缺少有效证书或指纹允许名单时拒绝启动。没有匿名或明文降级开关。更新 UI 也需构建新 release，并在重启后生效。

`pnpm httpd` 直接启动已选 release；默认监听 `0.0.0.0:2000`（所有 IPv4 网卡），Runtime 直接使用本地存储，不再监听内部 VFS 端口。默认读取 `~/.config/mindos/mindos.json`，设置了 `XDG_CONFIG_HOME` 时读取其下的 `mindos/mindos.json`；文件缺失时创建与 CLI/桌面端相同的默认配置。证书默认使用该配置目录，可通过下面的 `http` 配置覆盖。可用 `pnpm httpd --host 127.0.0.1 --port 3000 --root /path/to/data` 覆盖启动参数。监听所有网卡不改变证书要求，`--cert-host` 仍需包含浏览器实际访问的 IP/DNS。

可在 `mindos.json` 指定宿主私有目录，证书初始化和启动读取同一配置：

```json
{
  "rootDir": "/home/li/share/prj/pair-x1/mindos",
  "http": {
    "certDir": "/home/li/share/prj/pair-x1/mindos-host/http-certs",
    "authDir": "/home/li/share/prj/pair-x1/mindos-host/http-auth"
  }
}
```

路径优先级：显式 `--cert-dir` / `--auth-dir` → `http.certDir` / `http.authDir` → 原配置目录下的默认位置。
配置内相对路径按 `mindos.json` 所在目录解析，命令行相对路径按调用目录解析；配置请使用绝对路径或相对路径，不使用 `~`。
`http.authDir` 是认证目录基址：`pnpm httpd` 使用其 `release/`，`pnpm httpd:dev` 使用其 `dev/`，
直接启动 standalone 不添加后缀；显式 `--auth-dir` 是最终目录，不添加后缀。
本地 CLI 的 desktop profile 也使用同一 `release/` 认证目录，其他独立 profile 保持隔离。
省略配置保持原有路径，不自动搬迁文件、不生成替代身份。迁移时先停止使用该目录的宿主，完整复制原证书目录和认证目录，
保留目录私有权限后再修改配置并重启；不要删除 SQLite 锁文件绕过正在运行的宿主。
这些目录必须留在数据根和静态 UI 根之外；不要放进可被 VFS 读取的 `<root>/etc` 或尚未隔离的 `<root>/_etc`。

HTTPS 监听队列默认为 4096，可用 `--backlog <正整数>` 调整，例如 `pnpm httpd --backlog 8192`。此参数缓冲等待接收的突发连接，不是 HTTP 并发上限；Linux 实际队列受 `net.core.somaxconn` 限制。重启服务后用 `ss -ltnp` 查看 `Send-Q` 确认生效。

服务端在 Runtime 初始化成功后才监听，启动阶段与错误写入运行日志。如果手机上能看到导航但工作区空白，先查看运行日志及浏览器错误；更新页面需构建新 release、重启服务后重新加载。

移动端在标签栏和空面板初始化期间保留文件列表，活动面板挂载正文后才自动切换到详情。标签切换与关闭会重新检查活动面板；用户返回列表后，正文的后台更新不会把页面强制切回详情。

证书有效期：CA 10 年，服务器及客户端证书 1 年。`clients.json` 保存允许的 SHA-256 指纹；删除对应项后下一次请求立即拒绝，包括已有连接。全部移除可禁止所有访问，重启前需恢复至少一枚有效身份。指纹文件不是私钥，不应填写任意 API Token。

默认排查 release 日志：`/var/log/mindos/httpd.runtime.log`（运行日志）与 `/var/log/mindos/httpd.audit.jsonl`（审计日志）；文件名不含版本。dev 文件名分别为 `httpd.debug.runtime.log` 和 `httpd.debug.audit.jsonl`。运行用户需拥有日志目录的写权限，可用 `MINDOS_HTTPD_LOG_DIR` 覆盖目录；部署准备与 `/api/health` 运行版本查询见 [启动与认证](../../doc/http-app.md#启动与认证)。审计记录认证成功/拒绝、请求 ID、来源 IP、路由、HTTP 状态、错误码及耗时，不记录密码、Authorization/Cookie、查询参数、文件正文或模型消息。文件权限 0600，每份 10 MiB，保留当前及 3 份轮转记录；极端突发时汇总记录丢弃数量。

数据根优先级为 `--root` → `MINDOS_ROOT` → `mindos.json` 的 `rootDir` → `<配置目录>/data`。配置中的相对 `rootDir` 按配置目录解析，`--root` 的相对路径按启动目录 `INIT_CWD` 解析。`--root` 是整个 MindOS 数据根，SQLite 默认 `<root>/_meta/index.db`。证书与审计日志必须在数据根之外，证书不能放在静态 UI 根中。浏览器访问认证后的同源 `/api/application` 与事件订阅；对外 `/api/vfs` 被拒绝。

协议、事务语义与限制见 [HTTP 存储应用](../../doc/http-app.md)。

应用冲突返回 409 / ECONFLICT。应用命令通过持久回执核对结果，不自动重放。内部存储协议的事务冲突诊断记录观察类型、数量与位置哈希，不记录原始路径、字段名、值或凭据；它不等同于所有应用用例的执行日志。
