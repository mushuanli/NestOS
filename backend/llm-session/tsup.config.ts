import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', contracts: 'src/contracts.ts' },
  format: ['cjs', 'esm'],
  dts: {
    compilerOptions: {
      rootDir: '..',
      paths: { '@itookit/kernel-adapters/contracts': ['../kernel-adapters/src/contracts.ts'] },
    },
  },
  // Inline configuration contracts without publishing an adapter runtime dependency.
  noExternal: ['@itookit/kernel-adapters/contracts'],
  clean: true,
  sourcemap: true,
  external: [
    '@itookit/driver-llm', '@itookit/tools', '@itookit/llm-context',
    '@itookit/durable-kernel',
    '@itookit/llm-tasks',
    '@itookit/llm-flow',
    '@itookit/vfs-core',
    'yaml',
  ],
});
