import { defineConfig } from 'vite';
import { createLibConfig } from '../../scripts/vite-lib.config';

export default defineConfig(
  createLibConfig({
    name: 'LLMUI',
    fileName: 'llm-ui',
    rootDir: __dirname,
    external: [
      '@itookit/mdx-adapter',
      '@itookit/common',
      '@itookit/vfs-core',
      '@itookit/llm-session',
      '@itookit/mdxeditor',
      'marked',
      'js-yaml'
    ],
    globals: {
      '@itookit/mdx-adapter': 'MDxAdapter',
      '@itookit/common': 'ItookitCommon',
      '@itookit/vfs-core': 'ItookitStdio',
      '@itookit/llm-session': 'LLMConversation',
      '@itookit/mdxeditor': 'MDxEditor',
      'marked': 'marked',
      'js-yaml': 'jsyaml'
    }
  })
);
