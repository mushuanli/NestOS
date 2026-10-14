import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts', node: 'src/node.ts' },
    format: ['cjs', 'esm'], dts: true, clean: true, sourcemap: true,
    splitting: false, treeshake: true, platform: 'neutral', target: 'es2022',
    external: ['node:fs', 'node:child_process'],
});
