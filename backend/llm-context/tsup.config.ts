import { defineConfig } from 'tsup';
export default defineConfig({ entry: {index: 'src/index.ts', digest: 'src/contracts/digest.ts'}, format: ['esm', 'cjs'], dts: true, clean: true });
