import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', contracts: 'src/contracts.ts', 'mcp-contracts': 'src/mcp-contracts.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@itookit/llm-context', '@itookit/vfs-core', /^node:/],
});
