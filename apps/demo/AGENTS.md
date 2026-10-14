# @itookit/demo

私有**演示沙盒**：一组独立的 HTML + 原生 JS 页面，用于手动试跑 VFS、MDx 编辑器、LLM 驱动、设置编辑器等能力。它不参与产物发布，也不在任何验证矩阵里——`pnpm --filter @itookit/demo dev` 手动打开页面观察。

## 定位

- **纯手工 playground**：没有测试、没有 typecheck 脚本；不要把它当作能力的验收证据（验收以各包测试与 `doc/minimal-system-acceptance.md` 为准）。
- **legacy 容器**：`src/` 下的脚本跨越多个时代，部分 import 指向已不存在的包名（例如 `@itookit/vfs`、`@itookit/configmanager`），`vite.config.js` 的 alias 也保留历史映射。新增演示请用当前包名（`@itookit/vfs-core`、`@itookit/mdx` 等）；不要为了让旧脚本跑起来而修改正式包。
- `private: true`：不发布、不被其他包依赖。

## 结构

```
apps/demo/
├── index.html                   演示索引页（链接到下方各页面）
├── vite.config.js               源码 alias（指向各工作区的 src）+ 样式 alias
└── src/
    ├── vfs.html / vfs.js        MDxEditor + vfs-ui 组合演示
    ├── vfscore-demo.js          VFSManager 文件操作示例（legacy 包名）
    ├── editor.html / editor.js  插件化编辑器演示
    ├── mdx.html / mdx.js        MDxEditor 完整演示
    ├── memory-manager.html/.js  记忆管理演示（模拟导入）
    ├── llmdriver-demo.js        driver-llm 驱动/连接演示
    └── configmanager-demo.js    ConfigManager 演示（legacy 包名）
```

## 运行

```bash
pnpm --filter @itookit/demo dev        # vite dev，浏览器打开 index.html 的链接
pnpm --filter @itookit/demo build      # vite build（只打包 index.html 可达入口）
```

## 约定

- 新增演示页面：在 `src/` 加 HTML + 入口 JS，并从 `index.html` 链接过去；只依赖已存在的包或 Vite alias。
- 演示代码可以直白、可以重复，不要求生产级抽象；但不得被 `src/` 以外的正式代码 import。
- 发现与当前 API 脱节的旧脚本时，**删除或标注**优于让它静默失效；不需要为 demo 补测试。
