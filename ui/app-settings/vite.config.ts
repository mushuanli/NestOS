import { defineConfig } from 'vite';
import { createLibConfig } from '../../scripts/vite-lib.config';

export default defineConfig(
  createLibConfig({
    name: 'AppSettings',
    fileName: 'app-settings',
    rootDir: __dirname,
    external: [
      '@itookit/mdx-adapter',
      '@itookit/common',
      '@itookit/vfs',
      '@itookit/llm-ui'
    ],
    globals: {
      '@itookit/mdx-adapter': 'MDxAdapter',
      '@itookit/common': 'ItookitCommon',
      '@itookit/vfs': 'VFSCore',
      '@itookit/llm-ui': 'LLMUI'
    }
  })
);
