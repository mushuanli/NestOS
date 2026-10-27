# MindOS

**一个由 AI 驱动的个人知识操作系统**

[English Version](README_en.md)

---

### 项目简介

MindOS 以"操作系统"的理念重新定义 AI 应用：所有内容——对话、笔记、Agent 配置、记忆卡片、项目——都存储在一个统一的**虚拟文件系统（VFS）**中。AI Agent 不只是回答问题，它能直接读写你的工作区文件，形成真正的人机协作闭环。

- **当前版本**：v3.1
- **运行方式**：Web（浏览器）+ 桌面（Tauri / macOS · Windows）
- **技术栈**：TypeScript · pnpm monorepo · Vite · Tauri · CodeMirror 6

---

### 通过 npm 运行 HTTP 工作台

```bash
npm install -g mindos@0.1.0
mindos init-certs --cert-host 192.168.31.10
mindos httpd
```

Node.js >=22.13；初始化证书需要 OpenSSL。将示例 IP 换成实际地址，导入生成的 CA 和浏览器个人证书后，
打开 `https://<地址>:2000`。已有证书时无需重新生成。支持聊天、Agent/Flow、Markdown 与文档 AI、附件和项目文件。
配置、启动参数、功能与升级见 [MindOS npm 说明](./apps/http-app/npm/README.md)。

### 工作区

| 图标 | 名称 | 用途 |
|---|---|---|
| 🤖 | **Agents** | 创建、配置、管理 AI Agent；支持多轮工具调用 |
| 💬 | **AI Sessions** | 多会话对话；分支消息历史；持久化上下文 |
| 🔮 | **Minds** | 知识笔记，Markdown + Frontmatter + 富文本渲染 |
| ⚡ | **Skills** | 可复用 AI 技能（prompt / shell / http / MCP 协议）|
| 🃏 | **Anki** | 间隔重复记忆卡片，挖空（Cloze）语法 |
| 📁 | **Projects** | 项目文档管理 |
| ✉️ | **Email Drafts** | AI 辅助邮件草稿 |
| 🔒 | **Private** | 本地加密私有笔记 |

---

### 核心特色

#### 1. 虚拟文件系统（VFS）— `libraries/vfs-core`

VFS 是 MindOS 的底层基础，提供了独特的文件系统抽象：

- **模块隔离（Module Isolation）**：每个工作区（Agents / Minds / Chats …）是一个独立的 VFS 模块，通过 `chroot` 机制相互隔离。模块内路径 `/notes.md` 映射到系统路径 `/module/minds/notes.md`，工作区之间无法直接访问对方的文件。

- **虚拟设备节点（Virtual Device Nodes）**：`/dev/llm/connection/<id>`、`/dev/llm/skills/<id>` 等设备节点以文件方式暴露 LLM 连接和技能资源。AI 工具调用可以像读写文件一样操作 LLM 连接，天然适合 Agent 工具编排。

- **AssetDir（伴生目录）机制**：每个文件 `note.md` 自动拥有一个对应的伴生目录 `_note.md/`，用于存储附件、SRS 记忆数据、会话节点等结构化元数据。伴生目录的生命周期与主文件完全耦合——随主文件重命名/移动/删除而自动同步，无需手动维护。

- **可插拔存储后端**：同一套 VFS 接口，后端可切换为 IndexedDB（Web）、SQLite + LocalFS（Tauri 桌面）或内存（测试），业务代码零修改。

- **与 AI 深度结合**：Agent 的文件读写工具（`file_read` / `file_write` / `glob_search`）直接操作 VFS；会话历史、技能定义、连接配置全部以 VFS 文件方式持久化，Agent 可以用相同的工具接口读取自己的配置文件。

#### 2. MDx 编辑器 — [@itookit/mdxeditor](https://github.com/mushuanli/mdxeditor)

基于 **CodeMirror 6** 构建的下一代 Markdown 编辑器，兼顾书写体验与强大的扩展能力：

- **GFM 全支持**：表格（含排序/筛选）、任务列表、删除线、代码块语法高亮
- **Frontmatter**：YAML 元数据解析，支持标签、SRS 调度参数等结构化数据
- **图表渲染**：Mermaid 流程图、PlantUML、Vega 可视化图表、MathJax 数学公式、SVG
- **富媒体**：图片 / 视频 / 音频内联，拖拽上传自动存入 AssetDir
- **挖空（Cloze）**：`{{答案}}` 语法，与 Anki 工作区联动，支持间隔重复记忆
- **`@` 文件引用**：输入 `@` 触发文件选择器，插入跨模块文件链接；AI Agent 发送消息时自动附加文件内容
- **可折叠块**：长文档节点折叠/展开，保持阅读焦点
- **插件架构**：基于 `PluginManager` + `EventBus` + `ServiceContainer` 的微内核，所有功能均为插件，业务代码可按需组合

#### 3. 对话分支系统 — `ui/llm-ui-adapter`

Chat 工作区支持**消息树状分支**，让你在同一个会话中探索多条不同的对话路径：

- **从任意节点创建分支**：在消息气泡上右键选择「从此处分支」，生成一条独立的对话路径，原有对话不受影响
- **命名分支**：每条分支可以自定义名称（如 `main` / `approach-A` / `approach-B`），方便管理多轮探索
- **切换分支**：在分支间自由切换，查看不同路径的对话历史；`/branchprev` / `/branchnext` 快速循环
- **分支列表**：`/branches` 命令列出当前会话的所有分支及其起始节点
- **持久化存储**：分支结构以消息有向图的形式存入 VFS AssetDir（`.chat` 格式），完整保留每条路径
- **适用场景**：A/B 测试不同 prompt 策略、在不破坏现有上下文的前提下"回退重试"、并行探索多个方向

```
main ──→ Q1 ──→ A1 ──→ Q2 ──→ A2 (main branch)
                  └──→ Q2' ──→ A2' (approach-B branch, different question)
```

#### 4. LLM 三层配置架构（v3.1）

```
Provider   ──  云提供商（apiKey + 模型目录）
    ↓
Connection ──  命名连接（引用 Provider + ModelTier 映射）
    ↓
Agent      ──  个性化定制（system prompt + tier 偏好）
```

**ModelTier 成本分级**：同一 API Key 可配置三档模型，预算超限时自动降级：

| Tier | 用途 | 示例 |
|---|---|---|
| `optimal` | 复杂推理、规划 | claude-opus-4.6 / gemini-3.1-pro |
| `standard` | 日常工作 | claude-sonnet-4.6 |
| `fast` | 简单/廉价任务 | claude-haiku-4.5 |

同一 Provider 可创建多个 Connection（如 `deepseek-reasoner` / `deepseek-chat`），灵活应对多模型混用场景。

#### 5. 多轮 Agent 循环 — `backend/llm-tasks`

- 工具调用（file_read / file_write / shell_exec / glob_search / grep_search）
- 四层渐进式上下文压缩（history_snip → cache_prune → llm_summarize → sliding_window）
- 预算控制（turns / tokens / cost / duration / tool_calls 六维监控）
- 计划确认（Q1）/ 崩溃恢复（Q2）/ 执行中注入（Q3）
- MCP 协议支持（Model Context Protocol）
- TTY 交互式 Shell 会话（Python REPL / psql / ssh 等）

#### 6. 技能系统 — `backend/kernel-adapters`

技能（Skill）让 Agent 具备可复用的专项能力：

| 类型 | 运行方式 |
|---|---|
| `prompt` | 注入 system prompt，无需 function-calling |
| `shell` | 执行本地 Shell 命令，`{{参数}}` 模板 |
| `http` | 调用 REST API，结果返回 Agent |
| `mcp` | 通过 MCP 协议连接外部工具服务器 |

---

### 快速开始

```bash
# 克隆项目
git clone <repo-url>
cd itookit

# 安装依赖
pnpm install

# Web 开发
pnpm dev

# Tauri 桌面应用开发
pnpm tau

# 构建所有包
pnpm build:libs

# 运行测试
pnpm --filter @itookit/vfs-core test
```

---

### 包结构

```
libraries/               # 独立 Git 库，统一源码工作区
├── driver-llm/ # 模型通信
├── mdxeditor/ # 独立 Markdown 编辑器
├── mindos-node-driver/ # mindos-node 文件、同步和执行客户端
├── vfs-core/ # VFS 引擎与协议
├── vfs-sync/ # 多端文件同步核心
├── vfs-ui/ # 文件与资源浏览 UI
├── vfsdriver-indexeddb/ # IndexedDB 存储后端
└── vfsdriver-local/ # 本地 FS 与 SQLite 后端
ui/                      # MindOS 业务 UI
├── app-shell/
├── app-settings/
├── llm-ui/
├── llm-settings-ui/
├── mdx-adapter/
└── ui-common/
backend/                 # 应用用例、执行与持久化
├── app-core/
├── durable-kernel/
├── llm-session/
└── ...
shared/                  # 共享应用契约与基础工具
├── app-contracts/
└── common/
apps/
├── web-app/
├── tauri-app/
├── cli/
├── http-app/
└── demo/
```

---

### License

[GNU General Public License v3.0](LICENSE)
