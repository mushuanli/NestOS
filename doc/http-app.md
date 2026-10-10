# HTTP 存储应用

`apps/http-app` 是独立 Node.js 应用，复用 Web 的完整 MindOS UI。既有 CLI `-d` 仍保持原来的服务端 Runtime/remote UI 模式，详见 [CLI HTTP 模式](http-mode.md)。

```text
Browser: client certificate + MindOS UI → createApplicationRuntime → HttpStorageBackend
                                                                      ↓ HTTPS :2000
Node.js: mandatory mTLS + certificate fingerprint gate → private VFS proxy
                                                                      ↓ process token
         HTTP 127.0.0.1:2001 → StorageApi → LocalFSBackend → files + SQLite
```

浏览器不使用 Tauri IPC，也不装配 LocalFS 的 Node fallback。Node.js 仅管理认证、存储、HTTPS/内部 HTTP 监听和静态文件，不初始化 MindOS Session/Kernel。模型请求、页面状态、Kernel 和数字分身在线调度属于浏览器运行时。

## 强制认证与日志

对外使用双向 TLS，requestCert/rejectUnauthorized 同时启用，并要求 clients.json 明确登记客户端证书 SHA-256 指纹。缺失、不受信任、过期证书在 TLS 层拒绝；不在允许名单中的有效证书在应用响应前关闭连接。每个请求重新读取允许名单，因此撤销也作用于已有连接。不配置证书不能启动，不提供无认证回退。

VFS 独立绑定 127.0.0.1:2001；对外 HTTPS 2000 认证后才向内部转发。内部还要求随机进程凭据，不转发客户端 Authorization，来源 IP 不从 X-Forwarded-For 推断。写请求继续拒绝跨来源 Origin / Sec-Fetch-Site。所有 UI、静态资源、健康检查与数据接口均受保护；静态资源改用 private, no-store，构建仍保留旧哈希文件以供已打开页面延迟加载。

`--init-certs --cert-host <IP or DNS>` 初始化私有 CA、服务器及客户端身份，输出 browser-client.p12 和密码文件位置。浏览器需信任 ca.crt，并导入客户端身份。证书、私钥与日志保存在 VFS 根外；具体步骤见 [app README](../apps/http-app/README.md)。

JSONL 审计记录认证和访问元数据：时间、requestId/parentRequestId、来源 IP、路由、操作、状态、错误码及耗时。禁止记录请求头、查询参数、操作参数、文件正文与 LLM 内容。日志权限 0600，默认 10 MiB 轮转，保留当前及 3 份备份；突发队列上限 1000，后续记录汇总 droppedEvents。TLS 拒绝时没有 HTTP 状态，记录 auth.rejected 与 TLS 错误码。

## 启动与路径

```bash
./apps/http-app/scripts/create-certificates.sh --cert-host 192.168.31.10
pnpm httpd
```

根目录的 `httpd` 脚本调用 HTTP app 的 `dev`，构建静态 UI 后运行 TypeScript 服务端，不提供热更新。发布使用 `build` 后 `start`；完整参数见 [app README](../apps/http-app/README.md)。默认监听 `0.0.0.0:2000`（所有 IPv4 网卡），局域网访问必须提供已登记的有效客户端证书；认证后的浏览器拥有该单用户数据根的访问权限，不引入多用户角色。

UI 构建保留已有哈希静态资源，避免旧页面延迟加载聊天等模块时出现 404；全部静态资源使用 private, no-store，服务器仍在每次请求前认证。服务运行期间可单独执行 `build:ui` 更新页面，不必为 UI 重建停止存储服务。`GET /api/health` 核对存储可访问状态。浏览器连接中断时显示状态条，旧模块缺失时提供显式重新加载操作；不自动重放结果未知的写入。

默认读取 `$XDG_CONFIG_HOME/mindos/mindos.json` 或 `~/.config/mindos/mindos.json`，缺失时创建共享默认配置；证书与日志也使用该配置目录。数据根优先级为 `--root` → `MINDOS_ROOT` → 配置中的 `rootDir` → `<配置目录>/data`，配置中的相对路径按配置目录解析。`--root` 是 VFS 数据根；其相对路径按 `INIT_CWD`（缺失时进程 cwd）解析。存储内部路径 `/home/admin/...` 始终相对于该根，不保存当前服务器机器的绝对路径。SQLite 默认 `<root>/_meta/index.db`；允许显式指定根目录外的 `--sidecar`。已有外部项目的绝对路径仍表示原宿主资源，不能直接改成相对路径推断另一份数据；未装配的来源保留引用并标记不可用。

`/_meta` 和 `/__vfs_namespace_journal__` 不在 HTTP 可访问命名空间。路径拒绝 `..`、反斜杠、控制字符与符号链接；根目录不可删除或重命名。静态文件只来自 `--static` 或构建输出 `dist`，文本资源支持 gzip。跨来源浏览器请求被拒绝，API 不发送 CORS 开放头。

## 存储协议

`POST /api/vfs`，`Content-Type: application/json`：

```json
{"method":"stat","args":["/home/admin/minds/example.md"]}
```

成功返回 `{"result": ...}`；失败返回 `{"error":{"code":"ENOENT","message":"..."}}`，客户端恢复为 `FSError`。文件内容使用 base64，避免数字数组的体积膨胀。API 支持文件 stat/list/mkdir/read/write/delete/rename、元数据与标签，以及 RecordStore 的批量读取、分页、查询和更新。

方法通过白名单分派，不暴露 SQL、SQLite 连接、任意命令执行或 `__tauri/invoke`。`HttpStorageBackend` 不声明后端未实现的搜索、符号链接、通用文件事务或条件 replace 能力。

## 跨 SeqFile 事务

`records.transaction(callback)` 使用乐观并发控制：

1. 读取记录或分页时保存观察结果；批量读取只发一个请求。事务内写入缓存在客户端，后续读取与枚举可见这些写入。
2. 回调成功后，通过一个 `records.commit` 请求提交所有观察及变更。
3. 服务端在 LocalFS 原生 SQLite 事务中重新读取观察，发现记录修改或范围新增/删除就返回 `ECONFLICT`。
4. 校验全部通过后，跨多个 SeqFile 的所有变更在同一个 SQLite 事务中提交。失败不写入其中任何一个文件的记录。

只读事务也执行最终校验。HTTP 读请求之间不持有 SQLite 锁；回调异常时不发送提交。客户端不自动重试回调或提交：网络中断时提交结果可能未知，业务通过自己的持久回执核对。事务操作只有记录，不包括普通文件字节修改或元数据修改。该并发语义适用于通过同一 LocalFS 数据库访问的写入，不协调绕过 VFS 手工修改文件的进程。

默认分页上限与单批记录数上限为 10000，单次请求/JSON 响应上限 32 MiB，超限返回 `EFBIG`。事务中对已修改范围枚举，需要合并原范围与缓存变更，该范围超过 10000 项时拒绝执行；普通有界分页直接调用 LocalFS 的页读取接口。初版仍会为顺序读取产生 HTTP 往返，没有把完整应用启动合成一个远程 RPC；性能需根据实际网络延迟和 profile 规模评估。

## 验证

`apps/http-app/tests/storage.test.ts` 使用真实 Node HTTP、LocalFS 和 SQLite：二进制内容/范围读取、元数据/标签、含记录的文件重命名、null 与缺失值、跨文件提交、回调回滚、并发修订与范围 phantom 冲突、事务内 Unicode 字段排序、目录边界和跨来源请求，以及完整应用 Runtime 启动并重开个人项目。

认证测试使用真实 TLS 和生成的证书，覆盖匿名/不受信任/过期身份拒绝、指纹撤销、已有连接撤销、内部端口凭据、日志脱敏与轮转；完整 Runtime 通过认证 HTTPS → 内部 VFS 启动和重开。前一轮 Chrome 的完整 UI/聊天验证为明文部署，当前浏览器访问必须先导入 CA 与个人证书。
