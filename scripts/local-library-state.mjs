import { createRequire } from 'node:module';

// Keep the pnpm hook's CommonJS implementation external when Vite bundles its ESM config.
const require = createRequire(import.meta.url);
export default require('./local-library-state.cjs');
