# 独立 npm 库接入

itookit 通过 npm 注册表安装独立库。新增统一接入包 piagent-driver 正准备首次发布，当前以 workspace 参与开发；发布后可按下述流程迁移为固定注册表版本。

| npm 包 | 固定版本 | 源码仓库 |
|---|---|---|
| @itookit/vfs-core | 5.3.1 | [vfs-core](https://github.com/mushuanli/vfs-core) |
| @itookit/vfs-ui | 0.5.7 | [vfs-ui](https://github.com/mushuanli/vfs-ui) |
| @itookit/vfsdriver-indexeddb | 5.3.1 | [vfsdriver-indexeddb](https://github.com/mushuanli/vfsdriver-indexeddb) |
| @itookit/vfsdriver-local | 5.3.0 | [vfsdriver-local](https://github.com/mushuanli/vfsdriver-local) |
| @itookit/piagent-driver | 0.1.0（发布目标） | [piagent-driver](https://github.com/mushuanli/piagent-driver) |
| @itookit/vfs-sync | 0.1.0 | [vfs-sync](https://github.com/mushuanli/vfs-sync) |
| @itookit/mdxeditor | 0.5.2 | [mdxeditor](https://github.com/mushuanli/mdxeditor) |
| @itookit/driver-llm | 0.2.0 | [driver-llm](https://github.com/mushuanli/driver-llm) |

## 安装与开发

首次 checkout 先执行 `git submodule update --init packages/piagent-driver tools/pi-agent`，取得发布前的驱动源码及端点服务，再执行 `pnpm install --frozen-lockfile` 开发与构建。Vite、TypeScript 和测试统一解析独立库的公开 exports；piagent-driver 发布前使用工作区源码映射，发布清单以 `workspace: true` 标记这项例外。测试替身由宿主测试目录维护，不导入独立仓库的私有测试文件。vfs-ui CSS 使用 `@itookit/vfs-ui/style.css`，MDX CSS 使用 `@itookit/mdxeditor/style.css`。

Web/Tauri 共用 `REGISTRY_PREBUNDLES` 显式预构建 vfs-ui：它的消费方位于被扫描排除的 workspace 源码中，启动时预构建可避免页面加载过程中才发现该依赖。升级库后退出旧 Vite/Tauri 进程再启动；必要时在对应 app 目录运行 `pnpm exec vite optimize --force` 重建开发缓存。应用仍通过 npm 包 exports 解析，不映射独立库源码。

独立仓库通常位于 `../pair-x1/<仓库名>`。`.pnpmfile.cjs` 根据 `scripts/npm-libraries.json` 统一判断：`packages/<库目录>/package.json` 存在且包名匹配时，通过本地依赖接入（源码入口使用 `link:`，构建入口使用 `file:`）；缺席时沿用应用声明的 npm 版本。覆盖 mdxeditor、driver-llm、vfs-core、vfs-ui、vfsdriver-indexeddb、vfsdriver-local 和 vfs-sync；工作区包不重复覆盖。

本地库先独立安装依赖并构建，再在主仓库运行 `pnpm install --no-frozen-lockfile` 更新解析与锁文件。增加或移除目录后同样运行此命令，使本地/npm 选择重新生效；构建和测试通过该库自己的公开 exports 解析；Vitest 的 VFS 根入口别名由 `import.meta.resolve` 取得，不硬编码独立库源码位置。本地 mdxeditor 使用 dist 构建产物，修改后重新构建并重新安装主仓库，刷新 Web/Tauri 的 Vite 预构建缓存。锁文件可能因本地目录存在而包含 file/link 依赖，应与使用的目录集合一致。旁边的 `../pair-x1` 或 `priv/` checkout 不自动接入。

## 发布流程

`scripts/npm-libraries.json` 固定发布集合与版本。先更新其中的版本，再执行：

```bash
pnpm npm:prepare
# 或 node scripts/release-npm-libraries.mjs prepare /其他源码父目录
pnpm npm:publish
pnpm npm:migrate
pnpm install
```

prepare 从独立仓库构建，检查导出文件，固定库间依赖，并保存 tarball 与 SHA-256。publish 校验 tarball 未被修改后发布；npm 版本不可覆盖，已发布版本不得再次发布。迁移前核对注册表中全部版本已可用，避免半数版本不可安装时改动应用依赖。

piagent-driver 将旧 vfsdriver-agent 文件/进程层与项目、同步及 harness 客户端合并，发布目标是 `@itookit/piagent-driver@0.1.0`，不再发布或依赖旧包。仓库、issues、homepage 和 tarball 名称均使用 piagent-driver。当前 checkout 位于 `packages/piagent-driver`，独立配置不依赖主仓库 tsconfig；构建产物包含根、`/harness`、`/sync` 的 ESM/CJS 与类型入口。已发布的新版本可用后，再运行迁移并移除 workspace 标记和源码映射。

可单独准备该包：`node scripts/release-npm-libraries.mjs prepare ./packages @itookit/piagent-driver`。单包准备保留其他仍在发布清单中的产物，替换目标包并剔除已移出的旧包索引；不执行 npm publish。默认全量准备在独立 checkout 缺席时可读取标有 workspace 的当前源码。

首次迁移使用 `scripts/relocate-npm-libraries.mjs` 保存原子模块到独立仓库；该脚本拒绝覆盖已有目录。原工作目录保留在被忽略的 `release/source-checkouts/` 作为临时备份，不参加安装、构建或测试。

## 验证边界

独立库的单元测试在各自仓库运行；应用保留跨库集成测试。根目录提供七个已接入注册表库的开发依赖，供公共契约测试与边界检查读取实际安装包的 exports；piagent-driver 暂时通过工作区接入。独立库在工作区排除同名源码目录；自动本地接入由 `.pnpmfile.cjs` 管理，保留独立 Git 身份。

发布前验证 ESM、CommonJS、CSS 导出及各库适用的 TypeScript 类型解析；VFS 库额外验证 SeqFile 读写。MDX 的类型消费使用 `moduleResolution: bundler`。应用迁移后须在八个源码目录缺席时通过类型检查、公共接口边界检查、文档检查、样式检查、应用构建与集成测试。

MDX 核心已拆分至独立仓库并保留历史，本地独立 checkout 在 `../pair-x1/mdxeditor/`，x1 仅保留 npm 包引用。MindOS 的 VFS、Session、附件管理与会话打印继续由工作区内的 `@itookit/mdx-adapter` 适配。宿主测试只使用编辑器公开接口，文档策略与链接解析单元测试由独立仓库维护。

### MDX 拆分验证（2026-10-05）

- 独立安装、类型检查、37 项单元测试、构建及 tarball 打包通过；tarball 消费验证 ESM、CommonJS、TypeScript bundler 类型与 CSS 导出。
- x1 在 `packages/mdx` 缺席时，冻结锁文件离线安装、全仓类型检查、架构/文档/样式检查、Web 与 Tauri 前端构建通过。
- mdx-adapter 18 项测试及 CLI 原子保存集成测试通过；app-shell 首轮 507 项通过，受沙箱进程/端口限制的三个测试文件在沙箱外复跑 8 项通过。
- Tauri 对发布库使用的无前缀 Node 内置模块也执行 external，避免 Vite 将 LocalFS 的 `fs` 导入解析为浏览器空模块。
