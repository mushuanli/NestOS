# 独立库源码工作区与 npm 构建

MindOS 默认消费固定 Git 提交的独立库源码。八个独立库均位于 `libraries/`（包括 mdxeditor、vfs-ui），保留独立仓库和 npm 发布能力。业务包按前端、后端、共享职责位于 `ui/`、`backend/`、`shared/`；`apps/` 保存宿主。所有目录统一由 pnpm workspace 安装、排序和链接。

| 库 | 源码目录 | npm 构建版本 |
|---|---|---|
| @itookit/vfs-core | `libraries/vfs-core` | 5.3.2 |
| @itookit/vfs-ui | `libraries/vfs-ui` | 0.5.8 |
| @itookit/vfsdriver-indexeddb | `libraries/vfsdriver-indexeddb` | 5.3.3 |
| @itookit/vfsdriver-local | `libraries/vfsdriver-local` | 5.3.0 |
| @itookit/piagent-driver | `libraries/piagent-driver` | 0.1.0 |
| @itookit/vfs-sync | `libraries/vfs-sync` | 0.1.0 |
| @itookit/mdxeditor | `libraries/mdxeditor` | 0.5.2 |
| @itookit/driver-llm | `libraries/driver-llm` | 0.3.0 |

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

`--prepare-only` 生成可检查的目录而不查询注册表、安装或构建。缺少已发布版本时，正常 npm 构建明确失败并指出包名；应用依赖新 API 或源码修复时，也必须先发布匹配版本并更新清单。当前 v5.4 清单中的版本均已发布；vfs-core@5.3.2、vfsdriver-indexeddb@5.3.3 和 piagent-driver@0.1.0 均已从注册表重新下载并核对制品。

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

driver-llm@0.3.0 新增 `chatgpt` Provider 与同名 implementation，继续复用 Responses 协议；运行时注入账号绑定的 OAuth session。宿主负责登录、身份验证和凭据存储，前后端配置 DTO 不携带刷新回调或令牌。提供账号模型目录、合并刷新、订阅请求约束和严格的流终态检查。应用设置页的 OAuth 登录装配不在本次独立库改动范围。

独立库 116 项测试、后端适配 244 项测试、全仓类型检查、架构边界检查、文档检查和 Web 构建通过。最终 tarball 在仓库外通过 ESM 推理/目录调用、CommonJS、contracts/chain 入口、TypeScript bundler 与 node16 类型验证；未使用真实 ChatGPT 账号验收。

修复发布暂存目录未清空造成旧声明残留的问题；重复 prepare 的过期文件负例验证通过。最终制品 SHA-256 为 `027973c95274105f852aedb8063db8d45d585936907c757fabad3d6ad4dba396`。源码已推送独立仓库 main，npm 首次发布被 EOTP 阻止，等待完成注册表二次验证；本节不表示该版本已公开发布。
