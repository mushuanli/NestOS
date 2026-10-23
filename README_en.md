# MindOS

**An AI-powered personal knowledge operating system**

[中文版本](README.md)

---

### Overview

MindOS reimagines AI applications with an "operating system" philosophy: all content—conversations, notes, agent configs, flashcards, projects—is stored in a unified **Virtual File System (VFS)**. AI Agents don't just answer questions; they can read and write your workspace files directly, creating a true human-AI collaboration loop.

- **Current version**: v3.1
- **Platforms**: Web (browser) + Desktop (Tauri / macOS · Windows)
- **Tech stack**: TypeScript · pnpm monorepo · Vite · Tauri · CodeMirror 6

---

### Workspaces

| Icon | Name | Purpose |
|---|---|---|
| 🤖 | **Agents** | Create, configure, manage AI Agents with multi-turn tool calling |
| 💬 | **AI Sessions** | Multi-session conversations; branching message history; persistent context |
| 🔮 | **Minds** | Knowledge notes with Markdown + Frontmatter + rich rendering |
| ⚡ | **Skills** | Reusable AI skills (prompt / shell / http / MCP protocol) |
| 🃏 | **Anki** | Spaced-repetition flashcards with Cloze syntax |
| 📁 | **Projects** | Project document management |
| ✉️ | **Email Drafts** | AI-assisted email drafting |
| 🔒 | **Private** | Locally encrypted private notes |

---

### Key Features

#### 1. Virtual File System (VFS) — `libraries/vfs-core`

VFS is the foundation of MindOS, providing a unique filesystem abstraction:

- **Module Isolation**: Each workspace (Agents / Minds / Chats …) is an isolated VFS module with a `chroot`-like boundary. The path `/notes.md` inside the Minds module maps to `/module/minds/notes.md` in the system tree—modules cannot access each other's files directly.

- **Virtual Device Nodes**: Resources like LLM connections and skills are exposed as device files at paths such as `/dev/llm/connection/<id>` and `/dev/llm/skills/<id>`. AI tools can operate on LLM connections as if reading/writing files—naturally suited for agent tool orchestration.

- **AssetDir (Companion Directory)**: Every file `note.md` automatically gets a companion directory `_note.md/` for storing attachments, SRS scheduling data, session nodes, and other structured metadata. The companion directory lifecycle is fully coupled to its owner file—it is automatically renamed, moved, or deleted in sync, requiring zero manual maintenance.

- **Pluggable Storage Backends**: The same VFS interface works over IndexedDB (Web), SQLite + LocalFS (Tauri desktop), or in-memory (tests)—no changes to business logic required.

- **Deep AI Integration**: Agent file tools (`file_read` / `file_write` / `glob_search`) operate directly on VFS. Session history, skill definitions, and connection configs are all persisted as VFS files, letting Agents read their own configuration with the same tool interface.

#### 2. MDx Editor — [@itookit/mdxeditor](https://github.com/mushuanli/mdxeditor)

A next-generation Markdown editor built on **CodeMirror 6**, balancing writing experience with powerful extensibility:

- **Full GFM support**: Tables (with sort/filter), task lists, strikethrough, syntax-highlighted code blocks
- **Frontmatter**: YAML metadata parsing for tags, SRS scheduling parameters, and other structured data
- **Diagram rendering**: Mermaid flowcharts, PlantUML, Vega visualizations, MathJax math, SVG
- **Rich media**: Inline images/video/audio; drag-and-drop upload automatically stored in AssetDir
- **Cloze notation**: `{{answer}}` syntax integrated with the Anki workspace for spaced-repetition learning
- **`@` file references**: Type `@` to open a cross-module file picker; AI Agent messages automatically attach file contents when referenced
- **Foldable blocks**: Fold/unfold long document sections to maintain reading focus
- **Plugin architecture**: Micro-kernel built on `PluginManager` + `EventBus` + `ServiceContainer`—all features are plugins, combinable on demand

#### 3. Conversation Branch System — `ui/llm-ui-adapter`

The Chat workspace supports a **message tree branching system**, letting you explore multiple distinct conversation paths within the same session:

- **Branch from any node**: Right-click a message bubble and choose "Branch from here" to create an independent conversation path without affecting the original
- **Named branches**: Each branch has a custom name (e.g. `main` / `approach-A` / `approach-B`) for easy management of parallel explorations
- **Branch switching**: Switch freely between branches to review different conversation histories; use `/branchprev` / `/branchnext` for quick cycling
- **Branch listing**: `/branches` command lists all branches in the current session with their origin nodes
- **Persistent storage**: The branch structure is stored as a message directed graph in the VFS AssetDir (`.chat` format), preserving every path completely
- **Use cases**: A/B testing different prompt strategies, "rewind and retry" without losing existing context, exploring multiple directions in parallel

```
main ──→ Q1 ──→ A1 ──→ Q2 ──→ A2 (main branch)
                  └──→ Q2' ──→ A2' (approach-B branch, different question)
```

#### 4. Three-Tier LLM Configuration (v3.1)

```
Provider   ── Cloud vendor (apiKey + model catalog)
    ↓
Connection ── Named config (references Provider + ModelTier mapping)
    ↓
Agent      ── Functional customization (system prompt + tier preference)
```

**ModelTier cost scaling**: A single API key supports three model tiers with automatic budget-triggered downgrade:

| Tier | Use case | Example |
|---|---|---|
| `optimal` | Complex reasoning, planning | claude-opus-4.6 / gemini-3.1-pro |
| `standard` | Most daily work | claude-sonnet-4.6 |
| `fast` | Simple / low-cost tasks | claude-haiku-4.5 |

A single Provider can have multiple Connections (e.g., `deepseek-reasoner` / `deepseek-chat`), enabling flexible multi-model setups.

#### 5. Multi-turn Agent Loop — `backend/llm-tasks`

- Tool calling (file_read / file_write / shell_exec / glob_search / grep_search)
- Four-layer progressive context compression (history_snip → cache_prune → llm_summarize → sliding_window)
- Six-dimensional budget control (turns / tokens / cost / duration / tool_calls)
- Plan confirmation (Q1) / crash recovery (Q2) / mid-run injection (Q3)
- MCP Protocol support (Model Context Protocol)
- TTY interactive shell sessions (Python REPL / psql / ssh, etc.)

#### 6. Skill System — `backend/kernel-adapters`

Skills give Agents reusable specialized capabilities:

| Type | Execution |
|---|---|
| `prompt` | Injected into system prompt—no function-calling required |
| `shell` | Runs local shell commands with `{{parameter}}` templates |
| `http` | Calls a REST API endpoint and returns the result to the Agent |
| `mcp` | Connects to external tool servers via the MCP protocol |

---

### Getting Started

```bash
# Clone
git clone <repo-url>
cd itookit

# Install dependencies
pnpm install

# Web development
pnpm dev

# Tauri desktop development
pnpm tau

# Build all packages
pnpm build:libs

# Run tests
pnpm --filter @itookit/vfs-core test
```

---

### Package Structure

```
libraries/               # Independent Git libraries in the source workspace
├── driver-llm/ # LLM transport
├── mdxeditor/ # Standalone Markdown editor
├── mindos-node-driver/ # mindos-node files, sync and execution client
├── vfs-core/ # VFS engine and contracts
├── vfs-sync/ # Multi-device file sync
├── vfs-ui/ # File and resource browsing UI
├── vfsdriver-indexeddb/ # IndexedDB storage backend
└── vfsdriver-local/ # Local FS and SQLite backend
ui/                      # MindOS business UI
├── app-shell/
├── app-settings/
├── llm-ui/
├── llm-settings-ui/
├── mdx-adapter/
└── ui-common/
backend/                 # Application use cases, execution and persistence
├── app-core/
├── durable-kernel/
├── llm-session/
└── ...
shared/                  # Shared application contracts and utilities
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
