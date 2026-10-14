import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, clean: true,
    external: ['@itookit/mdxeditor', '@itookit/common', '@itookit/ui-common', '@itookit/vfs-core'], sourcemap: true });
