# NestOS 命名与兼容迁移

## 仓库与包名

| 原名称 | 新名称 |
| --- | --- |
| `mushuanli/itookit` | `mushuanli/NestOS` |
| `mushuanli/mindos-node` | `mushuanli/nestos-node` |
| `mushuanli/mindos-node-driver` | `mushuanli/nestos-node-driver` |
| `tools/mindos-node` | `tools/nestos-node` |
| `libraries/mindos-node-driver` | `libraries/nestos-node-driver` |
| `@itookit/mindos-node-driver` | `@itookit/nestos-node-driver` |
| Web 工作区 `mind-os` | `nestos-web` |
| 主仓库私有工作区 `itookit` | `nestos-workspace` |
| Node Rust crate `mindos_node` | `nestos_node` |
| 远程服务命令 `mindos-node` | `nestos-node` |
| CLI 命令 `mindos` | `nestos` |

产品显示名、Web/PWA 标题、桌面 productName、证书新生成时的显示名统一为 NestOS。
通用独立库的 repo 名称不改：mdxeditor、vfs-core、llm-ui 等仍保持独立身份。
`@itookit` 是现有 npm 发布组织，不是产品显示名，本次不迁移 npm scope。
HTTP 发行包已使用 `nestos`，命令为 `nestos httpd`；完整 CLI 仍是源码中的独立入口，不额外安装另一份同名全局命令。

旧库快照包含旧包名时不会直接用于新构建；下一次 `pnpm lib:build` 会因目录清单变化准备完整的新快照。

新 Pages 地址为 <https://mushuanli.github.io/NestOS/>。仓库链接、子模块、文档和包清单同步更新；本地 checkout 的物理目录不必随 repo 改名。

## 配置和既有数据

新安装默认读取 `$XDG_CONFIG_HOME/nestos/nestos.json`，未设置 XDG 时是 `~/.config/nestos/nestos.json`。
Node CLI/httpd 与桌面端采用相同选择规则：有新配置时使用新配置；否则已有旧 `mindos/mindos.json` 时继续使用旧目录和原文件。
不会为了改名新建另一份空数据根，不自动搬迁证书、OAuth 凭据或正在使用的 SQLite。

环境变量以 `NESTOS_*` 为新名称；Node 宿主、启动脚本及相关 Rust 环境读取保留 `MINDOS_*` 回退，新名称优先。
`NESTOS_ROOT` 指定数据根；httpd 常用变量包括 `NESTOS_HTTPD_LOG_DIR`、`NESTOS_HTTPD_MODE` 和 `NESTOS_HTTPD_VERSION`。
旧配置中的 `http.certDir`、`http.authDir` 等显式路径继续按配置文件目录解析，不因产品改名修改实际文件路径。

历史会话 UUID、branch、serverId、授权身份、数据库 schema/application ID、文档 AI metadata 键、UI 持久化键和普通草稿数据库保留。
桌面 `identifier` 保留既有安装身份，只修改显示名；改变安装身份是另一项迁移，不能靠替换字符串处理。
已生成的 CA、浏览器身份和允许指纹不重新生成；旧证书的 CN 显示旧名不会使证书失效。

驱动主入口为 `createNestOSNodeDriver` / `NestOSNodeDriver` / `NestOSNodeDescriptor`，旧 MindOS 工厂和类型名保留为弃用别名。
新 MCP 发现名为 `itookit/nestos-node`，兼容读取旧的 `itookit/mindos-node` 和历史 extension key；保存过的授权不会因此失效。
HTTP View 的新响应头使用 NestOS 名称，同时兼容旧头名。

远程 export 新 metadata 使用 `.nestos/meta.sqlite`；已有 `.mindos` 继续原地使用，不自动产生第二份库。
两个目录同时存在时明确报 `METADATA_NAMESPACE_CONFLICT`，需人工确认正确归属；两种目录都从文件 API/目录同步入口隐藏或拒绝。

## 笔记模板

- `readme.md`：功能说明、文档 AI、HTML Live 和 nestos-node 集成示例。
- `person-agent-demo.md`：独立的虚构人物笔记，供人物 Agent/数字分析使用，保持原来的正文。

恢复入口按缺失文件创建，保留已有修改。旧用户的 `demo.md` 不在普通启动时自动改写或删除；显式文件改名走 VFS。

## httpd 编辑 swap

```json
{
  "http": {
    "editorSwap": true,
    "swapDir": "~/swap"
  }
}
```

默认关闭，配置在 httpd 启动时读取，修改后重启生效。只有 httpd 显式开启时才装配服务端 swap 能力，前端才显示查看入口。
目录在应用 VFS 和静态网页根之外，默认 `~/swap`；`swapDir` 支持 `~/`，其他相对路径按配置目录解析。
每个编辑器使用 `.nestos-<数据根作用域>-<随机UUID>.swap`，权限 0600；文件夹首次创建使用 0700。
文档修改后防抖写入当前文本，达到或超过 512 KiB 不写；由小变大时删除该编辑器旧的小副本。
查看时显示文本和服务端记录的备份时间。正常关闭编辑器时等已提交写入结束再删除自己的 swap，不删除其他编辑器的文件。
断线、崩溃或服务重启不会把残留文件当成正常关闭删除；httpd 启动时及每小时清理最后更新超过 48 小时的本作用域文件。
关闭开关不创建、扫描或清理 swap；普通 Web、Tauri 不启动这个服务，菜单入口隐藏。
普通未保存草稿的浏览器本地恢复机制独立保留；不再把刷新前副本写入 IndexedDB。

本轮改动按用户要求不运行测试、类型检查或构建。npm 已发布版本不可覆盖，代码改名不等于重新发布新制品；后续发布需准备新版本。
