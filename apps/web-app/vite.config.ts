import { defineConfig, searchForWorkspaceRoot } from 'vite';
import path from 'path';
import { workspaceAliases, workspaceExcludes } from '../../scripts/workspace-sources.mjs';

export default defineConfig({
    // ✅ 关键 1: 相对路径，确保在非根目录或通过简单 server 启动时能找到 assets
    base: './',

    resolve: {
        alias: [
            { find: '@', replacement: path.resolve(__dirname, './src') },

            // ✅ 映射所有 workspace 包到源码：dev 图里每包只有一份副本，HMR 生效。
            // 列表与 CSS 子路径入口由 scripts/workspace-sources.mjs 统一提供，
            // 避免桌面端与 Web 端再次各自漂移。
            ...workspaceAliases(__dirname),
        ],
        // ✅ 建议: 防止 React/Vue 等库在 Monorepo 中被打包两次 (双重实例问题)
        dedupe: ['react', 'react-dom', 'dexie', 'mermaid', '@codemirror/state', '@codemirror/view']
    },
    server: {
        port: 3000,
        open: true,
        // ✅ 关键 2: Monorepo 必须配置文件系统权限
        // 因为你的依赖代码在 ../../packages/ 目录下，超出了当前项目根目录
        fs: {
            allow: [
                // 自动搜索 workspace 根目录并允许访问
                searchForWorkspaceRoot(process.cwd()),
            ],
        },
    },
    build: {
        target: 'esnext',
    },

    // 关于 optimizeDeps 的说明见下方解释
    optimizeDeps: {
        // Workspace 包一律按源码处理（已在 resolve.alias 中映射），不进入预打包。
        exclude: workspaceExcludes(),
        include: [
            // Workspace 包不要放这里：它们的 main 指向 .ts 源码，已由上面的 exclude 与
            // scripts/workspace-sources.mjs 统一处理（见 doc/dev-patterns.md）。
            // 这里只保留第三方纯 JS 库的预构建。
            'mermaid',
            'dexie',
            'marked'
        ]
    }
});
