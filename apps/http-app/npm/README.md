# NestOS

NestOS 是 MindOS AI 工作台的 npm 发行版，可运行在自己的电脑或服务器上。`nestos` npm 包包含完整网页和 HTTPS 服务端，浏览器连接后使用聊天、Agent、Flow、Markdown 笔记及项目文件。无需克隆源码或单独构建网页。

服务端持有文件、SQLite、会话和模型执行；浏览器负责展示与交互。网页通过双向 TLS（mTLS）连接，只有持有已登记客户端证书的设备能访问。

## 安装与启动

需要 Node.js >= 22.13.0。首次生成证书还需要系统安装 OpenSSL。SQLite、PTY 和图片处理依赖包含原生模块；安装器会选择当前系统的预编译依赖，缺少对应制品时需要系统编译工具。仅使用版本号不表示所有操作系统已经实机验证。

```bash
npm install -g nestos@0.1.0
nestos --version
nestos --help
```

首次生成私有 CA、服务器证书和浏览器身份。把示例 IP 换成浏览器实际访问的地址；多个 IP/DNS 用逗号分隔：

```bash
nestos init-certs --cert-host 192.168.31.10
# 等价于 nestos --init-certs --cert-host 192.168.31.10
```

也可首次直接运行 `nestos httpd`：交互终端发现证书目录不存在时，会询问是否生成，默认不生成；
确认后填写实际访问 IP/DNS，生成身份、打印浏览器导入文件位置并继续启动。
已有目录不会被覆盖，包括内容不完整的目录。systemd、管道等非交互启动缺少证书时立即提示初始化命令，不等待输入。
自动生成仍需要 OpenSSL，不会使用自签服务器证书绕过客户端认证。

默认写入 `~/.config/mindos/http-certs`；已存在时拒绝覆盖。已有证书覆盖实际访问地址时跳过初始化，避免更换浏览器身份。初始化只打印文件位置，不打印私钥和密码。

在浏览器/系统证书设置中导入：

1. `ca.crt`：受信任的证书颁发机构，用来验证服务器。
2. `browser-client.p12`：个人证书，导入密码见同目录 `client-password.txt`。

启动服务：

```bash
nestos httpd
# 也可以直接 nestos，或 nestos start
```

默认监听 HTTPS `0.0.0.0:2000`。打开 `https://192.168.31.10:2000`，选择导入的客户端证书。没有客户端身份的普通浏览器不能连接；不提供匿名或明文降级。

前台进程使用 Ctrl+C 停止。长期运行请交给系统进程管理器，启动命令为 `nestos httpd`，不需要 root 权限（目录须由运行用户可写）。不要同时让多个宿主写同一数据根或认证目录；锁文件由操作系统持锁，不通过删除文件绕过运行实例。

## 配置与数据

配置文件为 `$XDG_CONFIG_HOME/mindos/mindos.json`，未设置 XDG 时是 `~/.config/mindos/mindos.json`。首次使用自动补齐缺失的默认配置，保留已有文件。

```json
{
  "rootDir": "/home/li/share/prj/pair-x1/mindos",
  "http": {
    "certDir": "/home/li/.config/mindos/http-certs",
    "authDir": "/home/li/.config/mindos/http-auth"
  }
}
```

- `rootDir`：应用数据根，不配置时为配置目录下的 `data/`。SQLite 默认位于 `<rootDir>/_meta/index.db`。
- `http.certDir`：证书、密钥、浏览器导入包及 `clients.json` 允许名单；默认 `http-certs/`。
- `http.authDir`：宿主私有认证目录基址，npm 包按 release 模式读取其 `release/` 子目录；默认 `http-auth/`。
- 配置内相对路径按配置文件所在目录解析；请使用绝对路径或普通相对路径，不使用 `~`。
- 私有证书和认证目录必须在数据根及静态网页根之外，不放进可由应用 VFS 读取的 `etc/`、`_etc/`。

数据根优先级为 `--root` → `MINDOS_ROOT` → `rootDir` → 默认值。`--cert-dir`、`--auth-dir` 优先于配置；命令行相对路径按调用目录解析，`--auth-dir` 指向最终目录，不再追加 `release/`。

```bash
nestos httpd --host 127.0.0.1 --port 3000
nestos httpd --root /srv/mindos/data --cert-dir /srv/mindos-private/certs \
  --auth-dir /srv/mindos-private/auth --audit-file /srv/mindos-private/audit.jsonl
```

修改目录不会自动搬迁证书、凭据或应用数据。迁移前停止宿主，完整备份并复制原目录，保留私有权限，再修改配置并启动。更新 npm 包也不会重建证书或删除数据。

## 功能

- **聊天与分支**：多会话、Agent/已发布 Flow 选择、文件和图片附件、消息历史与分支导航。
- **文档中的 AI**：Markdown 渲染模式选中文字插入 AI 输入，粘贴图片，发送后展开回复，后续请求追加原分支，并可跳转完整会话。
- **Markdown/MDX 编辑**：编辑与只读渲染、代码高亮、图表和公式、附件、复制、打印、保存；文件菜单提供信息、自动换行和显式刷新。刷新有差异时先比较，覆盖未保存文本前保留本地副本，启动时清理超过两天的刷新前副本。
- **智能体与 Flow**：智能体管理、模型服务商/连接设置、工具箱及工作流配置；实际模型调用需要先配置连接和可用目标。
- **项目与文件**：工作台导航、项目文件与会话、VFS 挂载；可连接独立的 mindos-node 来访问获准的远程项目，权限和元数据能力由远端协商。
- **后台执行与恢复**：执行由服务端管理，SSE 推送界面变化；短暂断连尝试恢复，过期视图保留可恢复的编辑状态，不自动重放业务写入。

本包发布的是 HTTP 工作台，不包含开发仓库的全部 CLI 子命令，也不是独立的 Rust `mindos-node` 远程文件服务。项目介绍与实现文档见 [GitHub](https://github.com/mushuanli/itookit/tree/main) 和 [HTTP 宿主文档](https://github.com/mushuanli/itookit/blob/main/doc/http-app.md)。

## 日志与升级

npm 方式启动将运行信息写到前台 stdout/stderr；默认审计文件在配置目录的 `logs/http/httpd-release-audit.jsonl`，可用 `--audit-file` 指定。仓库 `pnpm httpd` 的运行/审计日志另由其启动脚本管理，默认位于 `/var/log/mindos/`。

审计只包含认证和操作元数据，不记录文档正文、消息、密钥或密码。证书允许名单 `clients.json` 变更在后续请求重新核对。可使用已登记客户端身份请求 `/api/health` 查询实际运行版本。

```bash
npm install -g nestos@latest
# 停止旧进程后重新运行 nestos httpd
```

浏览器重新加载以获取新网页。升级前备份数据根和私有配置；npm 安装包不携带你的证书、凭据或数据。
