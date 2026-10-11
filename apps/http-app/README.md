# MindOS HTTP app

Node.js 提供受双向 TLS 保护的完整 MindOS UI 和独立 VFS 存储服务，浏览器继续运行聊天、Kernel 和数字分身调度。Node.js >=22.13；初始化证书需要 OpenSSL。

```text
Browser + client certificate
  → HTTPS :2000 (mTLS + enrolled certificate fingerprint)
  → HTTP 127.0.0.1:2001 (ephemeral internal credential)
  → LocalFS + SQLite
```

首次初始化私有 CA、服务器证书和浏览器身份：

```bash
./apps/http-app/scripts/create-certificates.sh --cert-host 192.168.31.10
```

也可运行 `pnpm --filter @itookit/http-app create:certs --cert-host 192.168.31.10`。脚本可从任意目录调用，`--help` 查看参数；使用 `--cert-dir /path/to/private/certs` 指定输出目录，相对路径按调用目录解析。脚本设置私有文件权限，并复用服务端证书生成逻辑。

默认生成到 `~/.config/mindos/http-certs`；目录已存在时拒绝覆盖。`--cert-host` 可填写逗号分隔的 IP/DNS 名称，必须覆盖实际访问地址。初始化只打印文件位置，不打印密钥或密码。

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

发布使用 `pnpm --filter @itookit/http-app build`，再以同样参数运行 `pnpm --filter @itookit/http-app start`。`--cert-dir` 指定证书目录，`--audit-file` 指定 JSONL 日志；缺少有效证书或指纹允许名单时拒绝启动。没有匿名或明文降级开关。仅修改 UI 可在服务运行期间执行 `build:ui`，保留旧哈希资源，不必停止存储服务。

`pnpm httpd` 会先构建 UI，再启动服务；默认监听 `0.0.0.0:2000`（所有 IPv4 网卡），内部 VFS 仍为 `127.0.0.1:2001`。默认读取 `~/.config/mindos/mindos.json`，设置了 `XDG_CONFIG_HOME` 时读取其下的 `mindos/mindos.json`；文件缺失时创建与 CLI/桌面端相同的默认配置。证书和审计日志也使用该配置目录。可用 `pnpm httpd --host 127.0.0.1 --port 3000 --root /path/to/data` 覆盖启动参数。监听所有网卡不改变证书要求，`--cert-host` 仍需包含浏览器实际访问的 IP/DNS。

对外 HTTPS 与内部 VFS 的监听队列默认均为 4096（原 Node.js 默认值为 511），可用 `--backlog <正整数>` 调整，例如 `pnpm httpd --backlog 8192`。此参数缓冲等待接收的突发连接，不是 HTTP 并发上限；Linux 实际队列受 `net.core.somaxconn` 限制。重启服务后用 `ss -ltnp` 查看 `Send-Q` 确认生效。

页面在 Runtime 和工作区初始化期间显示当前启动阶段；成功后移除提示，失败时显示错误信息和重新加载按钮。如果手机上能看到导航但工作区空白，先查看启动提示，确认卡住的阶段或错误；仅更新页面可执行 `pnpm --filter @itookit/http-app build:ui` 后重新加载。

移动端在标签栏和空面板初始化期间保留文件列表，活动面板挂载正文后才自动切换到详情。标签切换与关闭会重新检查活动面板；用户返回列表后，正文的后台更新不会把页面强制切回详情。

证书有效期：CA 10 年，服务器及客户端证书 1 年。`clients.json` 保存允许的 SHA-256 指纹；删除对应项后下一次请求立即拒绝，包括已有连接。全部移除可禁止所有访问，重启前需恢复至少一枚有效身份。指纹文件不是私钥，不应填写任意 API Token。

默认日志：`~/.config/mindos/logs/http/audit.jsonl`。记录认证成功/拒绝、请求 ID、来源 IP、路由、VFS 操作、HTTP 状态、错误码及耗时；通过 parentRequestId 关联对外和内部请求。不记录密码、Authorization/Cookie、查询参数、文件正文或模型消息。文件权限 0600，每份 10 MiB，保留当前及 3 份轮转记录；极端突发时汇总记录丢弃数量。

数据根优先级为 `--root` → `MINDOS_ROOT` → `mindos.json` 的 `rootDir` → `<配置目录>/data`。配置中的相对 `rootDir` 按配置目录解析，`--root` 的相对路径按启动目录 `INIT_CWD` 解析。`--root` 是整个 MindOS 数据根，SQLite 默认 `<root>/_meta/index.db`。证书与审计日志必须在数据根之外，证书不能放在静态 UI 根中。浏览器只调用认证后的同源 `/api/vfs` 和 `/api/health`；内部端口不对局域网开放，直接本机访问还需内部凭据。

协议、事务语义与限制见 [HTTP 存储应用](../../doc/http-app.md)。

事务冲突返回 409 / ECONFLICT，浏览器错误附带对外 `requestId`。审计中的 `request.complete.parentRequestId` 将对外请求关联到内部请求，再以内部 `requestId` 查找 `records.conflict`；该事件记录观察类型/序号、观察与变更数量、冲突位置的 SHA-256 `recordId`，范围观察另记录预期/实际总数，不记录路径、字段名或值。`recordId` 为 `SHA256(JSON.stringify([虚拟路径, 字段名]))`，范围观察用前缀代替字段名，便于从已知位置核对同一热点；日志不直接确定竞争写入方。数字分身进度读取对明确的 ECONFLICT 最多重读三次，保留游标并退避；写事务和结果未知的提交不自动重放。
