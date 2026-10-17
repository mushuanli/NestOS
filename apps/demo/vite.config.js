import { defineConfig, searchForWorkspaceRoot } from 'vite';
import path from 'path';

export default defineConfig({
  base: './',

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),

      // ========== CSS 别名 ==========
      '@itookit/llm-ui-adapter/style.css': path.resolve(__dirname, '../../ui/llm-ui-adapter/src/styles/index.css'),
      '@itookit/app-settings/style.css': path.resolve(__dirname, '../../ui/app-settings/src/styles/styles.css'),

      // ========== 包别名（指向源码）==========
      '@itookit/common': path.resolve(__dirname, '../../shared/common/src/index.ts'),
      '@itookit/vfs': path.resolve(__dirname, '../../packages/vfs/src/index.ts'),
      '@itookit/llm-ui-adapter': path.resolve(__dirname, '../../ui/llm-ui-adapter/src/index.ts'),
      '@itookit/app-settings': path.resolve(__dirname, '../../ui/app-settings/src/index.ts'),
    },
    dedupe: ['react', 'react-dom', 'dexie', 'mermaid', '@codemirror/state', '@codemirror/view']
  },

  server: {
    port: 3000,
    open: true,
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd())]
    }
  },

  optimizeDeps: {
    // 排除 workspace 包，让 Vite 直接处理源码
    exclude: [
      '@itookit/common',
      '@itookit/vfs',
      '@itookit/llm-ui-adapter',
      '@itookit/app-settings'
    ],
    // 预构建第三方依赖
    include: ['mermaid', 'dexie', 'marked', 'immer']
  },

  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) return 'vendor';
        }
      }
    }
  }
});
