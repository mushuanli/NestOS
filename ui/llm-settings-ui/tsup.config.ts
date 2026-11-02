import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts', 'src/ocr.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: [
        '@itookit/common',
        '@itookit/ui-common-adapter',
        '@itookit/driver-llm',
        '@itookit/vfs-core',
    ],
});
