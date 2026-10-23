import {defineConfig} from 'tsup';

export default defineConfig({
    entry: {index: 'src/index.ts', contracts: 'src/contracts.ts'},
    format: ['esm', 'cjs'], dts: true, splitting: true, clean: true, sourcemap: true,
    external: ['@itookit/driver-llm'],
});
