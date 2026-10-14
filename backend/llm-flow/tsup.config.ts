import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts', contracts: 'src/contracts.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: [
        '@itookit/llm-context',
        '@itookit/durable-kernel',
        '@itookit/llm-tasks',
    ],
});
