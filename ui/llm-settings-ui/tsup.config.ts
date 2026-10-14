import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: [
        '@itookit/common',
        '@itookit/ui-common',
        '@itookit/driver-llm',
        '@itookit/vfs-core',
    ],
});
