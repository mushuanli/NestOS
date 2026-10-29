# Google 邮件与日历采集

此独立 Tool 包提供 `google.gmail.collect` 和 `google.calendar.collect`（版本 `1`）。Google API 只读；本地通过已有授权工作区端口保存来源。平台核心不包含 Google 业务执行代码，不读取全局账号或用户传入的凭据路径。

## 安装与每个用户的配置

1. 管理员在工具箱的工具包目录注册 `google-workspace`。默认可信目录是仓库的 `tools/`；发布宿主可用 `NESTOS_TOOL_PACKAGE_DIRS` 指定包含本包的可信目录。注册不自动发起网络访问。多用户 httpd 的已安装工具代码可以共享。
2. 在 Google Cloud 创建自己的 Desktop OAuth 客户端，下载客户端 JSON，按需启用 Gmail API 和 Google Calendar API。OAuth 应用仍在测试状态时，将要授权的账号加入测试用户。所需权限分别为 `gmail.readonly` 和 `calendar.events.readonly`；只授权邮件不会自动取得日历权限。
3. 在用户自己的电脑运行授权助手（需 Node 22+，无需安装依赖）：

   ```bash
   node tools/google-workspace/node/authorize.mjs --client desktop-client.json --output private-connection.json --services gmail,calendar
   ```

   在浏览器打开助手显示的 Google 授权 URL。助手只监听 `127.0.0.1` 临时端口，校验 state 并使用 PKCE；五分钟超时。生成文件以 `0600` 写入，已有文件不会覆盖。只需要邮件或日历时，将 `--services` 改为 `gmail` 或 `calendar`。Google OAuth 测试模式的令牌有效期受 Google 策略约束，失效后须重新授权。
4. 以自己的身份进入 NestOS → 数字分身 → 扫描器 → 我的数据连接。添加 Google 连接，设置标识（例如 `personal`）和名称，导入刚生成的 `private-connection.json`，保存。也可以逐项填写 Client ID、Client Secret、Refresh Token。已保存密钥不会回传，编辑时留空保留；删除连接移除本地凭据记录；如需撤销 Google 侧授权，可在 Google 账号后台移除应用。授权文件包含密钥，应保留在私有目录，使用后自行妥善处理，不能加入项目或 Git。
5. 单用户宿主自行从 Flow 产品目录恢复并发布；多用户宿主由管理员在共享 Flow 中恢复并发布 `Gmail 邮件采集`、`Google Calendar 日程采集`。每个用户在自己的扫描器绑定参数，不修改共享 Flow 默认值。已安装流程和修订按既有机制保留；缺工具会由依赖准备流程报告。

## 创建扫描器

在数字分身添加扫描器：

- 来源与范围：选择对应采集 Flow，将“我的 Google 连接”设为 `personal`；默认保存目录为 `imports/google`。匹配范围显式填写 `file:**/imports/google/**/*.md`。需要缩小到某项目时再增加适当的范围约束。
- Gmail：默认查询 `newer_than:30d -in:trash -in:spam`。可用 Gmail 搜索语法调整日期、标签或联系人。
- Calendar：默认日历为 `primary`，回看 7 天、未来 30 天；支持显式指定有读取权限的日历 ID。工具另接受 ISO `timeMin/timeMax`，用于固定日期范围的自定义 Flow。全天事件保留 date，带时间事件保留原时区信息，重复事件展开为实例，取消事件保存为取消状态。
- 默认最多 100 条，可设为 1–500。超过上限或分页未完成时整次采集失败，不将已有材料错误标记为移除；请缩小采集范围后重试。
- 提取哪些知识：选择内置提取或已发布 Agent/Flow；默认先审核再接纳。
- 更新与预算：先用手动执行检查结果，再切换定时检查。远程采集不支持“来源变化”触发，在线宿主按间隔运行。设置单次 token 上限，并在通用设置限制累计和月度用量。

点击“保存并运行”，在运行记录检查结果、来源及错误。范围预览只列出已存在文件，不访问 Google。采集 Flow 没有模型节点，采集阶段不消耗平台模型 token；知识提取阶段仍计量。工具自身或 Google 的服务限额不属于 token 账本。

## 隔离与存储

HTTP 每个用户的连接文件位于该用户 `.nestos/private/tool-connections/connections.json`（以宿主实际 `authDir` 为准），目录 `0700`、文件 `0600`，不在 VFS、导出和静态目录中。`ToolConnectionAccess` 由 Node 宿主绑定当前用户，`resolve` 不属于 RPC 服务图。相同 `personal` 标识在两个用户下分别解析；模型、Flow 和 RPC 参数均不能选择用户目录。共享组织空间不共享凭据，运行时仍使用当前认证主体的连接。

工具使用连接标识、服务类型、来源标识 `sourceKey` 与日历身份生成稳定命名空间；同账号多个独立范围须设置不同来源标识（默认 `default`）。同一用户的本包采集在进程内串行，避免同一来源交错写入；邮件查询改变时仍更新同一邮件来源集合。完整查询结果先在内存中通过数量和大小校验，写入前复验当前用户的连接仍存在且凭据未变，再保存稳定 ID 文件。上次存在但本次不再属于采集范围的文件被替换为不含旧正文的失效材料；这表示“不在当前采集范围”，不声称远端已物理删除。来源 hash 改变后沿用数字分身现有失效与重新提取机制。隐藏的 `.sources.json` 只保存文件身份，不作为知识来源。

单个材料最多 128 KiB，单次总材料最多 4 MiB，每个 HTTP JSON 响应最多 2 MiB。邮件只采集 MIME 文本，跳过附件；HTML 转成文本后作为本地证据快照。附件正文读取或不支持的字符编码明确失败，不把 snippet 当成完整邮件。每次按有界范围完整核对，复用稳定文件避免对未变材料反复调用模型；当前未实现 Gmail history / Calendar syncToken 的网络增量同步。

本包要求宿主提供用户连接服务与可写授权工作区。未注入服务的宿主（包括独立 CLI 执行运行时）明确报告 `GOOGLE_USER_CONNECTIONS_UNAVAILABLE`；不会退回共享环境变量账号。Node 应用宿主与多用户 HTTP 提供连接配置，浏览器独立宿主不保存 Google 私钥。

## 验证

```bash
node --test tools/google-workspace/tests/*.test.mjs
pnpm --filter @itookit/cli exec vitest run --root ../node-host --config ../http-app/vitest.config.ts tests/tool-connections.test.ts tests/tool-packages.test.ts
pnpm --filter @itookit/app-core exec vitest run tests/digital-twin-published-scanner.test.ts tests/digital-twin-scanner-authority.test.ts
```

测试使用模拟 Google API，覆盖分页、数量超限、权限拒绝、文本编码、日程取消、稳定文件、范围移除与日志脱敏；宿主测试覆盖同标识用户隔离、秘密不回传、私有权限、删除及重开。真实账号需按上述流程授权后验收，不以模拟测试代替。

Google 官方契约：[Gmail 列表](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[Gmail 服务端授权](https://developers.google.com/workspace/gmail/api/auth/web-server)、[Calendar 事件列表](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)。
