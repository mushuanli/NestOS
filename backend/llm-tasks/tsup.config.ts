import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', contracts: 'src/contracts.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@itookit/driver-llm/contracts', '@itookit/tools/contracts', '@itookit/llm-context', '@itookit/durable-kernel'],
});
