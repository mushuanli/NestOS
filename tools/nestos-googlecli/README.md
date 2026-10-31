# nestos-googlecli：Google 邮件与日历采集

此独立工具包以 `google.collect`（版本 `1`）为统一入口，通过 `resource: "mail" | "calendar"` 区分采集。为已有发布 Flow 保留 `google.gmail.collect` / `google.calendar.collect` 两个兼容入口。Google API 只读；本地通过已有授权工作区端口保存来源。平台核心不包含 Google 业务执行代码，不读取全局账号或用户传入的凭据路径。

本包的 `guide.yaml` 提供工具箱内的常驻使用指南，已注册后仍可查看注册、认证和参数步骤。指南独立于运行代码，可单独更新。`toolbox.yaml` 声明预装与可保存为个人默认值的普通参数，宿主从 Tool Schema 生成表单。

## 本地授权：三步完成

1. 打开 [Google OAuth 客户端页面](https://console.cloud.google.com/auth/clients)，选择项目，创建 **桌面应用** 客户端并下载 JSON。首次使用按需启用 [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) / [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)；应用处于测试状态时，在 [目标对象](https://console.cloud.google.com/auth/audience) 添加自己的账号为测试用户。
2. 在有项目源码和浏览器的电脑上，进入项目根目录运行下面命令（Node 22+），按提示粘贴或拖入下载文件的实际路径，选择邮件、日历或两者，再用这台电脑的浏览器打开授权链接：

   ```bash
   node tools/nestos-googlecli/node/authorize.mjs
   ```

3. 命令会显示授权结果文件的位置。用这台电脑的浏览器打开 NestOS，在“工具包 → 我的数据连接 → 本机授权后导入（无需域名）”导入该文件并保存，名称和标识自动填写。随后为自己启用工具，在扫描器中选择这个连接。

**httpd 可以在另一台机器。** 浏览器读取本机文件内容，通过已登录的 API 保存到 httpd 的当前用户私密目录；不会把本机文件路径交给 httpd 读取。后续令牌刷新、Google 采集和工作区写入都由 httpd 执行，本机无需保持在线。运行助手与打开授权链接必须是同一台电脑；通过 SSH 在远程运行却在手机/本机浏览器打开链接时，127.0.0.1 回调会到错误机器。

浏览器显示“已收到授权”后，终端仍需访问 `oauth2.googleapis.com` 换取令牌，只有显示“文件已保存”才完成。助手在 Node 24.14+ / 25.4+ 自动使用终端的 `HTTPS_PROXY` / `https_proxy`、`HTTP_PROXY` / `http_proxy` 和 `NO_PROXY` 配置；不会读取浏览器扩展代理，也不会更改 httpd 的网络设置。旧的支持环境代理的 Node 版本可用 `node --use-env-proxy tools/nestos-googlecli/node/authorize.mjs` 启动。网络失败会给出 DNS、连接拒绝、超时或 TLS 等具体原因；修复后需重新运行并打开新授权链接。

已由管理员配置网页授权的部署可以直接点击“连接账号”，无需运行本地助手。

## 管理员统一配置网页授权（可选）

1. 管理员注册本可信工具包；工具代码可以共享，安装不自动访问 Google。
2. 管理员在 Google Cloud 创建 **Web application** OAuth 客户端，启用 Gmail API / Calendar API，并登记完整回调，例如 `https://nestos.example.com:2000/api/tool-connections/callback`。测试模式需添加测试用户，所需只读权限由本包声明。
3. 管理员进入“工具箱 → 工具包 → 我的数据连接 → 网页连接 → 网页授权设置（管理员）”，保存 Client ID、Client Secret 和回调地址。只需配置一次，Secret 不回显；修改时留空保留。也可用 `http.publicOrigin` 预填地址，界面保存应用回调后无需修改 profile 或重启各用户运行时。
4. 各用户在自己的“我的数据连接”中选择邮件和日历权限，点击“连接账号”，在自动打开的 Google 页面选择自己的账号并同意。若浏览器拦截新页，点击面板的“继续授权”链接。账号名称可修改，连接 ID 自动生成并在保存后显示，供采集器绑定。每个账号独立建立连接，无需运行脚本或填写 token。
5. 宿主自动刷新访问令牌。邮件与日历可一次同意并复用同一连接；用户可以重新授权或撤销。管理员变更应用客户端或回调后，旧授权需重新连接；停用应用会停止所有绑定用户获取令牌，但不会声称已撤销 Google 侧历史授权。

Google [回调验证规则](https://developers.google.com/identity/protocols/oauth2/web-server#redirect-uri-validation) 不接受非 localhost 的 IP 字面量，因此当前 `https://192.168.31.10:2000` 访问方式需要管理员配置符合规则、浏览器可达的 HTTPS 域名。回调仍由用户浏览器访问并携带 NestOS 客户端证书；Google 不负责 NestOS 登录。回调由用户浏览器跳转发起，并非 Google 服务器主动连接 httpd；真实域名可以在内网解析到 httpd，使用浏览器信任的 HTTPS，无需因此把 httpd 暴露到公网。没有域名时可使用上面的 Desktop 本地助手授权并导入；Desktop 客户端不要填入管理员的网页授权应用配置。

## 兼容已有个人客户端

已有连接继续使用原客户端及私有凭据，不会自动迁移到共享应用。保留本地 Desktop 授权助手，供旧客户端或暂时没有网页回调的部署使用（Node 22+）：

```bash
node tools/nestos-googlecli/node/authorize.mjs --client "$HOME/Downloads/实际下载的客户端.json" --services gmail,calendar
```

命令不带参数会启动交互引导；`--help` 显示完整参数。`--client` 必须指向真实下载文件，示例名称 `desktop-client.json` 不会自动生成；相对路径基于执行命令时的当前目录。默认授权结果位于 `~/.config/nestos/private-exports/google-<UUID>.json`，也可用 `--output` 指定新文件，已有文件不会覆盖。

助手监听 `127.0.0.1` 临时端口，验证 state 和 PKCE，生成的文件按 0600 保存；在旧个人连接或“本机授权后导入（无需域名）”表单中导入该文件即可。此方式是兼容入口，网页授权使用 Web application 客户端，两种客户端类型不可混用。授权文件含私密信息，不能提交 Git。

包原目录和清单 ID `google-workspace` 已改为 `nestos-googlecli`。`google.collect`、两个兼容 Tool ID 和内部连接类型 `google-workspace` 保留，已有连接无需改名。本包直接使用 Google HTTP API，不依赖 `gws` CLI，也不启动常驻 MCP 服务；旧包不会因改名自动升级。

## 创建扫描器

在数字分身添加扫描器：

- 采集动作选择“邮件与日历采集”（`google.collect`），选择“邮件”或“日历”，再选择自己的账号连接。唯一连接会预选，多个连接由用户选择；旧的兼容工具只在编辑已有扫描器时显示。无需添加或发布采集 Flow。
- 新选择采集动作后默认“仅采集并保存材料”，不需要模型、知识范围或 token 预算。保存目录留空沿用账号设置，未设置时分别使用 `imports/mail`、`imports/calendar`；目录、数量上限和来源标识在高级参数中。
- 邮件默认保存到 `imports/mail/<连接>/mail/<来源标识>/*.email`，日程默认保存到 `imports/calendar/<连接>/calendar/<来源标识>-<摘要>/*.md`。路径受当前工作区授权约束；这尚不是“选择邮件导航即自动获得写入权限”的资源目标绑定。
- Gmail：默认查询 `newer_than:30d -in:trash -in:spam`。可用 Gmail 搜索语法调整日期、标签或联系人。
- Calendar：默认日历为 `primary`，回看 7 天、未来 30 天；支持显式指定有读取权限的日历 ID。工具另接受 ISO `timeMin/timeMax`，用于固定日期范围的自定义 Flow。全天事件保留 date，带时间事件保留原时区信息，重复事件展开为实例，取消事件保存为取消状态。
- “每批处理条数”默认 100，可设为 1–500，表示单轮工作量，不限制整个查询的总量。达到条数、4 MiB 批次材料或约 45 秒处理预算后保存进度，下批继续；单条材料仍最多 128 KiB。无需为数量超限反复缩小查询。
- 更新频率：先“保存并运行”检查结果，再选择定时（例如每 30 分钟）。有未完成批次时，定时计划提前到约 15 秒后继续；完成一轮后恢复设置的间隔。手动或应用事件规则不会自行开启定时，可点击继续或等待下一次事件。远程采集不支持“来源变化”触发。
- 可选知识处理：需要同步提取知识时，主动切换为“提取知识（可先采集）”，填写本地文件范围（邮件如 `file:**/imports/mail/**/*.email`），选择内置提取或已发布 Agent/Flow，并设置模型连接和预算。也可以为已保存材料建立独立规则，按变化处理；应用事件触发目前需要宿主显式调用授权接口，尚未自动接线到新邮件事件。

点击“保存并运行”，在运行记录检查结果、来源及错误。范围预览只列出已存在文件，不访问 Google。直接采集工具无模型调用，采集阶段不消耗平台模型 token；知识提取阶段仍计量。工具自身或 Google 的服务限额不属于 token 账本。0.2.2 起不再向工具包面板提供两个单节点采集 Flow；源码模板、兼容 Tool ID 和用户已经安装的 Flow 保留，升级不删除用户定义。

## 升级与 OAuth 复用

升级 NestOS CLI、httpd 或 Google 工具包时，保留同一用户的数据目录、账号连接和 OAuth 客户端即可沿用授权；连接类型仍为 `google-workspace`，不按软件或工具包版本保存凭据。访问令牌到期后，宿主使用已保存的 refresh token 刷新。工具包升级仍需按宿主提示切换版本并重启，不能把旧运行实例当成新版。

0.3.0 将数量上限改为每批预算，并加入续传与增量同步；已有 Tool ID、参数 Schema 和连接类型不变，OAuth 无需新增权限。宿主与前端也需更新，才能显示待续传状态并提前调度下一批。仅升级工具包时仍可按原计划间隔续传，但旧界面无法区分单批成功与整轮完成。

已有连接可先点击“验证连接”，该操作使用现有凭据刷新令牌，不打开新的 Google 同意页，也不要求重新导入文件。验证成功只说明令牌可刷新，不能代替邮件或日历 API 权限验证；首次采集结果仍需检查。

增加读取权限、更换 OAuth 客户端、授权被撤销或失效时才需要重新连接；迁移机器或更换 profile 后需要继续使用或迁移原用户私有连接，不能只复制程序。Google 外部应用处于 Testing 状态时，邮件/日历授权的 refresh token 会在 7 天后过期，详情见 [Google refresh token 有效期](https://developers.google.com/identity/protocols/oauth2#expiration)；这一限制与软件升级无关。

## 隔离与存储

HTTP 每个用户的连接文件位于该用户 `.nestos/private/tool-connections/connections.json`（以宿主实际 `authDir` 为准），目录 `0700`、文件 `0600`，不在 VFS、导出和静态目录中。`ToolConnectionAccess` 由 Node 宿主绑定当前用户，`resolve` 不属于 RPC 服务图。相同 `personal` 标识在两个用户下分别解析；模型、Flow 和 RPC 参数均不能选择用户目录。共享组织空间不共享凭据，运行时仍使用当前认证主体的连接。

工具使用连接标识、资源类型、来源标识 `sourceKey` 与日历身份生成稳定命名空间；同账号多个独立范围须设置不同来源标识（默认 `default`）。同一用户的本包采集在进程内串行。邮件首次按查询范围分页，随后使用 Gmail history 获取变更；新邮件由 Google 查询继续核对范围，已归档邮件允许更新，不因相对时间窗口移动、查询变更或远端删除而清除本地历史。日历使用 sync token 接收变更与已归档事件的取消；滚动未来窗口新增部分单独补查。游标过期时自动重新分页核对，已有文件保留。当前仍是归档采集，不是具有删除镜像策略的完整邮箱客户端。

隐藏的 `.sync.json` 保存版本化游标、待处理 ID 与上一操作回执；`.items/` 仅保存已归档身份；`.operations/` 保存按稳定操作 ID 摘要隔离的回执。它们不保存正文或 OAuth 凭据，也不进入知识扫描。先保存稳定 ID 文件及其身份，再复验连接并提交单文件游标；失败不会越过未提交的数据，同一操作重试返回原批次结果。下一个操作替换提交前先封存上一个回执，以恢复“文件已提交但调用方未收到响应”的情况。跨用户连接、跨来源目录与不同 sourceKey 不共用进度。旧 `.sources.json` 保留但不再用于清理归档；旧版已被清空的正文只能通过新的全量核对重新取得。

支持 Task 资产端口的宿主在首次调用时冻结实际保存目录，后续核对不采用后来修改的连接默认目录。Gmail 还将邮箱身份摘要绑定到进度；同一个连接标识换成另一邮箱时明确拒绝复用游标，应建立独立连接或来源标识。

新邮件的查询匹配使用 RFC Message-ID 和 Gmail 搜索；缺少可用 Message-ID 时明确返回 `GOOGLE_MAIL_QUERY_ID_REQUIRED`，不会跳过用户范围校验或悄悄推进游标。检查点损坏、保存失败、API 未启用、权限和网络错误仍按具体阶段失败；达到批次预算属于“本批已保存，等待继续采集”。

单个材料最多 128 KiB，单批总材料最多 4 MiB，每个 HTTP JSON 响应最多 2 MiB；单次 API 请求最多等待 30 秒，采集总超时仍为 120 秒。邮件只采集 MIME 文本，跳过附件；HTML 转成文本后作为本地证据快照。不支持的字符编码明确失败，不把 snippet 当成完整邮件。未变化正文文件不重复写入，沿用来源 hash 避免重复调用提取模型。阶段诊断直接写宿主日志，并向可用的进度回调发送相同非敏感元数据；不依赖模型调用入口才记录错误。

本包要求宿主提供用户连接服务与可写授权工作区。未注入服务的宿主（包括独立 CLI 执行运行时）明确报告 `GOOGLE_USER_CONNECTIONS_UNAVAILABLE`；不会退回共享环境变量账号。Node 应用宿主与多用户 HTTP 提供连接配置，浏览器独立宿主不保存 Google 私钥。

## 验证

```bash
node --test tools/nestos-googlecli/tests/*.test.mjs
pnpm --filter @itookit/cli exec vitest run --root ../node-host --config ../http-app/vitest.config.ts tests/tool-connections.test.ts tests/tool-packages.test.ts
pnpm --filter @itookit/app-core exec vitest run tests/digital-twin-published-scanner.test.ts tests/digital-twin-scanner-authority.test.ts
```

测试使用模拟 Google API，覆盖分页、数量超限、权限拒绝、文本编码、日程取消、稳定文件、范围移除与日志脱敏；宿主测试覆盖同标识用户隔离、秘密不回传、私有权限、删除及重开。真实账号需按上述流程授权后验收，不以模拟测试代替。

Google 官方契约：[Gmail 列表](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[Gmail 服务端授权](https://developers.google.com/workspace/gmail/api/auth/web-server)、[Calendar 事件列表](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)。

增量与查询：[Gmail history 同步](https://developers.google.com/workspace/gmail/api/guides/sync)、[Gmail 搜索](https://developers.google.com/workspace/gmail/api/guides/filtering)、[Calendar 增量同步](https://developers.google.com/workspace/calendar/api/guides/sync)。

统一接入边界见 [外部功能扩展](../../doc/design/function-extensions.md)。当前文件输出仍受原工作区授权约束；若将邮件目标改到邮件工作区，需要已有文件授权，不会自动扩大执行范围。统一 OAuth 已由宿主提供；完整的 ResourceTarget 绑定和邮箱模型仍待实现。包 0.2.0 不会静默覆盖已注册的 0.1.0，升级仍受宿主现有版本冲突策略约束。
