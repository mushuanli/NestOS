# 独立库源码工作区与 npm 构建

MindOS 默认消费固定 Git 提交的独立库源码。九个独立库均位于 `libraries/`（包括 mdxeditor、vfs-ui），保留独立仓库和 npm 发布能力。业务包按前端、后端、共享职责位于 `ui/`、`backend/`、`shared/`；`apps/` 保存宿主。所有目录统一由 pnpm workspace 安装、排序和链接。

| 库 | 源码目录 | npm 构建版本 |
|---|---|---|
| @itookit/vfs-core | `libraries/vfs-core` | 5.3.2 |
| @itookit/vfs-ui | `libraries/vfs-ui` | 0.5.10 |
| @itookit/vfsdriver-indexeddb | `libraries/vfsdriver-indexeddb` | 5.3.3 |
| @itookit/vfsdriver-local | `libraries/vfsdriver-local` | 5.3.0 |
| @itookit/piagent-driver | `libraries/piagent-driver` | 0.2.3 |
| @itookit/vfs-sync | `libraries/vfs-sync` | 0.1.0 |
| @itookit/mdxeditor | `libraries/mdxeditor` | 0.5.4 |
| @itookit/driver-llm | `libraries/driver-llm` | 0.4.0 |
| @itookit/llm-ui | `libraries/llm-ui` | 0.2.0 |

## 源码开发

```bash
git submodule update --init --recursive -- libraries tools/pi-agent
pnpm install --frozen-lockfile
pnpm workspace:check --installed
pnpm dev
```

应用和业务包对内部库声明 `workspace:*`。根 `pnpm-workspace.yaml` 同时将独立库保留的 npm 依赖版本覆盖为 workspace，从而保证库间也只有一份实现；各库在自己的独立仓库仍可安装和发布。第三方依赖仍从 npm 安装。

源码入口、契约子路径和 CSS 由各库的 package.json exports 定义；发布入口由 publishConfig 指向 dist。mdxeditor 同样采用源码入口，不需要先构建才能开发。Web/Tauri/HTTP 的 Vite 别名从公开 exports 自动生成，避免漏掉 contracts、mcp-contracts 或编辑器适配包。CLI 构建打包内部 TypeScript，better-sqlite3 和 node-pty 保持原生外部依赖。

安装前的 `scripts/check-workspace.mjs` 检查源码是否齐全及消费方协议；`--installed` 进一步检查实际链接。源码缺失会明确失败。目录存在与否不再触发 npm/source 切换，旧自动改写和反向迁移脚本已删除。

## 可选 npm 构建

```bash
pnpm build:registry --prepare-only
pnpm build:registry
# 也可以选择另一个宿主或检查命令：
pnpm build:registry --filter @itookit/cli build
```

build:registry 先验证 `scripts/npm-libraries.json` 中的版本是否可从注册表取得，再在 `release/registry-*` 创建独立工作区。该目录不包含独立库源码、node_modules、dist 或环境文件；独立库依赖改为明确的 npm 版本，业务包仍使用 workspace。修复随独立库新版本发布，不再复制 patches/ 或生成 patchedDependencies。

默认构建 Web 应用，不部署或发布。日常开发的 package.json、pnpm-lock.yaml 和 node_modules 保持原来的源码模式。首次成功构建保存独立的 `pnpm-lock.registry.yaml`；后续构建冻结此锁文件，升级版本时使用 `--update-lock` 并审查更新。

`--prepare-only` 生成可检查的目录而不查询注册表、安装或构建。缺少已发布版本时，正常 npm 构建明确失败并指出包名；应用依赖新 API 或源码修复时，也必须先发布匹配版本并更新清单。当前清单版本均已发布；driver-llm@0.4.0、piagent-driver@0.1.3 及此前的 vfs-core@5.3.2、vfsdriver-indexeddb@5.3.3 均已从注册表重新下载并核对制品。

## 独立库发布

```bash
pnpm npm:prepare
# 可只准备一个库：
node scripts/release-npm-libraries.mjs prepare ./libraries @itookit/piagent-driver
# 明确决定对外发布时执行：
pnpm npm:publish
```

prepare 默认从 libraries 构建、检查发布 exports，固定库间 npm 版本并保存 tarball 和 SHA-256。 发布时使用 prepare 生成的 tarball；库源码的入口指向 src，publishConfig 指向 dist，直接从源码目录执行 npm publish 可能保留源码入口而不携带 src。应先检查打包后的 package.json 和所有导出目标，并在仓库外验证 ESM/CJS 与声明。源码消费与制品发布使用各自的入口。publish 校验制品未变后发布；已发布版本不可覆盖。发布后更新 npm 构建清单，无需改动日常源码工作区。

升级源码时提交独立库的改动，再在主仓库更新 submodule 指针。新提交需要推送到相应仓库，其他 checkout 才能取得该提交。旁边的 `../pair-x1`、旧 packages 库目录或 priv checkout 不参与当前依赖选择。

## 验证

源码模式验证冻结安装、工作区链接、类型检查、库与宿主构建，以及跨库集成测试。根测试矩阵会运行 libraries 的单元测试，各库仍可单独测试。npm 模式在隔离工作区验证固定发布版本，保留独立锁文件和构建目录用于审查。

发布前额外验证 ESM、CommonJS、CSS 导出、TypeScript 类型解析和 VFS SeqFile 读写。编辑器类型消费使用 moduleResolution: bundler。

### 2026-10-14 源码工作区验收

- 主工作区和仅使用各库已提交内容的干净快照均通过冻结安装、依赖链接检查和全仓类型检查。
- 库构建、Web、Tauri 前端、CLI 和 HTTP 宿主构建通过；Vite 实际请求验证 llm-flow/contracts、tools/mcp-contracts 与 mdx-adapter 的源码解析。
- 包测试 3363 通过、33 跳过；CLI 普通套件串行运行 202 通过，独立故障恢复矩阵 22 通过；Rust 边界 70 通过。CLI 文件并行曾出现恢复失败和超时，矩阵现串行运行这些启动真实进程的文件。
- 工作区与隔离构建新增 7 项回归测试通过；矩阵调度的 3 项检查通过。架构和样式检查通过。
- 隔离工作区用已发布的七个 npm 库及准备好的 piagent-driver tarball 完成安装、全仓类型检查与 Web 构建；该 tarball 尚未对外发布，正常 build:registry 仍明确报告注册表版本不可用。
- 主仓库文档检查仍有 10 处既有应用接口设计链接失效，本次迁移未新增悬空引用。

### MDX 拆分验证（2026-10-05）

- 独立安装、类型检查、37 项单元测试、构建及 tarball 打包通过；tarball 消费验证 ESM、CommonJS、TypeScript bundler 类型与 CSS 导出。
- x1 在 `packages/mdx` 缺席时，冻结锁文件离线安装、全仓类型检查、架构/文档/样式检查、Web 与 Tauri 前端构建通过。
- mdx-adapter 18 项测试及 CLI 原子保存集成测试通过；app-shell 首轮 507 项通过，受沙箱进程/端口限制的三个测试文件在沙箱外复跑 8 项通过。
- Tauri 对发布库使用的无前缀 Node 内置模块也执行 external，避免 Vite 将 LocalFS 的 `fs` 导入解析为浏览器空模块。


### 2026-10-14 补丁替代发布与清理

已使用经过仓库外验证的 tarball 发布 driver-llm@0.2.2 与 vfs-ui@0.5.8；npm publish 均退出码为 0。源码包版本与 scripts/npm-libraries.json 已同步升级，旧 patches/ 目录及 registry 工作区的补丁复制/配置生成逻辑已删除。日常工作区仍消费 libraries/ 的源码入口。

此前实际下载的 driver-llm@0.2.1 tarball（integrity 与注册表一致）声明 src/index.ts、src/chain.ts、src/contracts.ts 为入口，但只携带 dist，没有 src。0.2.2 使用正确的 dist 发布入口，包含原协议修复；0.5.8 包含延迟展开、销毁时取消恢复及折叠竞态修复。已发布的同名同版本不能覆盖，避免直接在源码目录运行 npm publish。

发布前制品在仓库外配合 npm 的 vfs-core@5.3.1 验证：46 项 Anthropic/Responses/thinking/延迟展开回归通过，ESM/CJS、chain、contracts、CSS 和 TypeScript 类型消费通过。测试工具使用本机缓存，三个第一方库均来自 tarball，没有工作区源码链接。vfs-ui 源码 201 项测试、类型检查和构建通过。

发布后两个版本均从注册表重新下载，SHA-256 与获批 tarball 逐字节一致；下载后的包再次通过 46 项回归、ESM/CJS/chain/contracts/CSS 导出与 TypeScript 类型消费验证。无补丁 registry 工作区准备、45 项脚本测试、两库类型检查、工作区链接与冻结锁文件离线安装通过。

### 2026-10-15 v5.4 发布完成

vfs-core@5.3.2 包含按需设备 readiness 和 revision 前置条件校验；vfsdriver-indexeddb@5.3.3 固定依赖该 core 版本；piagent-driver@0.1.0 首次发布统一文件、同步和 harness 接口。已准备 dist 入口 tarball，独立驱动锁文件固定 core 制品的 SHA-512。

三库源码测试共 347 项通过、1 项跳过。仓库外使用 tarball 完成 ESM/CommonJS、根与子路径导出、TypeScript NodeNext 声明解析、Memory/IndexedDB 文件及 SeqFile 读写、pi-agent 生命周期验证；没有源码链接。npm/registry 脚本 5 项通过，工作区链接检查通过。

三个发布命令均退出码为 0；npm 双因素认证已完成。注册表最初返回 202，版本元数据与 tarball 曾分别延迟可见，核验时没有重复提交发布请求。最终三个版本均从公开注册表重新下载，SHA-256 与上述通过仓库外消费验证的原制品逐字节一致。

| 版本 | 发布后 tarball SHA-256 |
|---|---|
| vfs-core@5.3.2 | `c5a4061bebe781444ba9da5e0083e09998c584991a8992811c9f28c02e0fc149` |
| vfsdriver-indexeddb@5.3.3 | `345089bb12e2d44b5758f64adea21d8268ce9a2b58866a0762b54af427475196` |
| piagent-driver@0.1.0 | `121798fadaaaa61bf29cc9bd8a2f3b4983c0f571bca09172eaf350667c03ebfc` |

其余库已发布的代码与当前源码一致；MDX 后续仅修改未打包的开发说明。主仓库位于 v5.4，九个已初始化子模块均已推送各自 main 分支，独立库版本与 Git 指针一并固定。

### 2026-10-15 ChatGPT 订阅类型（待完成 npm 二次验证）

driver-llm@0.3.1 包含 `chatgpt` Provider 与同名 implementation，继续复用 Responses 协议；运行时注入账号绑定的 OAuth session。宿主负责登录、身份验证和凭据存储，前后端配置 DTO 不携带刷新回调或令牌。提供账号模型目录、合并刷新、订阅请求约束和严格的流终态检查。0.3.1 另提供 `ConnectionMeta.credentialsReady` 可选认证状态投影；OAuth 登录装配在 httpd 宿主实现，库不负责登录或私密存储。

独立库 116 项测试、后端适配 244 项测试、全仓类型检查、架构边界检查、文档检查和 Web 构建通过。最终 tarball 在仓库外通过 ESM 推理/目录调用、CommonJS、contracts/chain 入口、TypeScript bundler 与 node16 类型验证；未使用真实 ChatGPT 账号验收。

修复发布暂存目录未清空造成旧声明残留的问题；重复 prepare 的过期文件负例验证通过。0.3.0 制品 SHA-256 为 `027973c95274105f852aedb8063db8d45d585936907c757fabad3d6ad4dba396`；0.3.1 制品 SHA-256 为 `9430b08bad35f0ae799b4a76f31250f967544dd65fe3ed2ba3edf965be990d63`，仓库外 ESM/CJS 与 TypeScript bundler/node16 消费验证通过。npm 发布 0.3.0 与 0.3.1 均被 EOTP 阻止，等待完成注册表二次验证；本节不表示该版本已公开发布。

### 2026-10-16 媒体通信与原生会话用量发布

已通过 npm 浏览器二次认证发布 driver-llm@0.4.0 与 piagent-driver@0.1.3，两个发布命令均退出码为 0。driver-llm 包含独立图片生成和语音合成通信客户端，以及此前 ChatGPT 订阅协议；piagent-driver 包含新建/续写/删除/并发修复和原生会话用量快照。价格策略仍由宿主注入，不进入远程通信库。

两个源码库各有 123 项测试通过（piagent-driver 另有 1 项跳过），类型检查与正式发布构建通过。仓库外 npm 消费者验证了 ESM/CommonJS、根与所有公开子路径、TypeScript bundler/NodeNext 声明，以及注入 fetch 的图片和语音请求；未依赖工作区源码链接。发布制品 exports 均指向实际携带的 dist 文件，运行时依赖无 workspace/link/file 协议。两个新版本已从公开注册表重新下载，SHA-256 与发布前验证的 tarball 一致。

| 版本 | 发布后 tarball SHA-256 |
|---|---|
| driver-llm@0.4.0 | `5f9b54ffe8bc9dfa20d6f4bd811c1f75e1e991ee07fe3ea400a6e0911cff839a` |
| piagent-driver@0.1.3 | `0ae5c9406bcdab7a698d01eef6ed512e8aa25c9adcad6d9ef302c1257de9b73e` |

Rust pi-agent 独立于 npm 发布流程；其启动版本输出、日志与并发隔离更新通过 tools/pi-agent 的 Git 提交和本地二进制交付。

### 2026-10-16 目录授权发布

piagent-driver@0.2.0 已发布并从公开注册表重新下载，SHA-256 为 `e43eef38a227f1daa53904135b5beca9e9b6d52c6f2f27c6af8b93ee8aee27c5`，与正式 prepare 制品一致。128 项源码测试通过、1 项跳过；仓库外 ESM/CommonJS、公开子路径及 TypeScript bundler/NodeNext 消费验证通过。新增匿名目录读取、稳定身份与授权版本校验、项目有效能力投影，价格和目录共享策略仍由宿主控制。

Rust pi-agent@0.2.0 提供目录 grants、稳定 owner 和独立执行权限；共享节点可由多个独立 itookit 实例连接。同一 httpd 的多用户登录与存储隔离不在本次实现范围。

### 2026-10-17 独立仓库审查与发布准备

本轮有改动的独立仓库为 mdxeditor、piagent-driver、vfs-ui 与 Rust pi-agent，均已提交并推送 main；其余五个独立库与远端一致，沿用已发布版本。

- mdxeditor@0.5.3：嵌入布局、原始 HTML 策略、片段解析复用及折叠状态保留。
- piagent-driver@0.2.3：原生消息来源元数据、观察错误分类、profile 隔离与状态恢复。
- vfs-ui@0.5.9：通用目录预加载保留展开状态，显式加载失败向宿主拒绝并允许重试。
- pi-agent@0.3.6：历史投影保留用户内容来源与原生 turn 身份；release 二进制和示例配置位于 `release/native/pi-agent-0.3.6-linux-x86_64.tar.gz`，不部署或替换运行中的服务。

三个 npm 制品均通过 dist 导出存在性、固定库间依赖及 SHA-256 校验；仓库外安装这三个 tarball 与其余五个注册表库后，通过八库 ESM/CommonJS、全部公开子路径、CSS、Memory/IndexedDB/SeqFile 与嵌入 HTML/折叠状态验证。TypeScript bundler 检查覆盖八库，NodeNext 检查覆盖其余七库；MDX 声明继续遵循既有 bundler 消费契约。

源码验证：mdxeditor 55、piagent-driver 155、vfs-ui 203 项通过（另 1 项网络测试跳过）；Rust 完整测试 259 项通过、2 项跳过，格式检查与 release 构建通过。npm/registry 脚本 5 项通过，源码工作区冻结离线安装通过。npm 发布已发起，等待浏览器二次认证；本节不表示新版本已公开可下载。

### 2026-10-18 会话内容搜索发布完成

mdxeditor@0.5.4 提供通用的目标祖先展开入口，由代码块控件保留自身状态；llm-ui@0.2.0 首次发布独立 Chat/Flow 视图及已加载正文搜索，正式制品固定依赖 mdxeditor@0.5.4。

两个正式 prepare tarball 已在仓库外安装，验证 ESM/CommonJS、Chat/Flow/CSS 导出、TypeScript bundler 声明、Vite 构建、搜索高亮、代码块展开与视图生命周期；没有工作区源码链接。相关源码测试 215 项通过；发布脚本 5 项、冻结离线安装与前端公开入口构建通过。完成 npm 重新登录及发布认证后，两个 npm publish 命令均退出码为 0；两个新版本均已从公开注册表下载，SHA-256 与通过上述验证的正式制品逐字节一致。mdxeditor 的元数据和 tarball 曾分别延迟可见，核验期间没有重复提交发布请求。全仓类型检查通过。

| 制品 | SHA-256 |
|---|---|
| @itookit/mdxeditor@0.5.4 | `f1d4a5cf08fd5917fc10ecf48484d809c195711380a99f45a8a54e6092a2cba8` |
| @itookit/llm-ui@0.2.0 | `773b6a6987734de6400534f41d216375d75555444317ab3102d8774ec572881f` |

### 2026-10-18 项目导航刷新修复

vfs-ui@0.5.10 将 `navigationChildren` 开放到单栏入口，并在恢复展开状态时准备投影容器成员；保留旧双栏选项兼容，不读取折叠项目或执行器历史。app-shell 的项目目录与侧栏统一展开后端声明的透明容器，右侧刷新等待缓存失效和侧栏更新。

验证：vfs-ui 206 项测试、工作台 13 项回归、相关类型检查、模块边界、前端公开入口构建、文档、样式及冻结离线安装通过。正式 prepare tarball 在仓库外配合注册表 vfs-core@5.3.2 验证 TypeScript bundler、ESM/CommonJS、CSS/Vite 构建、恢复展开、刷新新增成员和容器折叠状态，没有工作区源码链接。制品 SHA-256 为 `7c423cf67ee4f0279b040c92af578accacf1e86544d5352a8c9266cd31eee425`。npm publish 已退出码 0 完成，公开注册表重新下载的 tarball 与正式制品 SHA-256 一致。
