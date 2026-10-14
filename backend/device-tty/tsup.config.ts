import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: ['@itookit/tools/contracts', 'node-pty'],
    splitting: false,
    treeshake: true,
    platform: 'node',
    target: 'es2022',
});
