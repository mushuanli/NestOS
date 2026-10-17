import { defineConfig } from 'vite';
import { resolve } from 'path';

const bundledContracts = new Set([
    '@itookit/llm-tasks/contracts', '@itookit/kernel-adapters/contracts',
    '@itookit/driver-llm/contracts', '@itookit/tools/mcp-contracts',
]);

export default defineConfig({
    build: {
        lib: { entry: { chat: resolve(__dirname, 'src/chat.ts'), settings: resolve(__dirname, 'src/settings.ts'), conversation: resolve(__dirname, 'src/conversation.ts') },
            formats: ['es'], fileName: (_format, entry) => `${entry}.js` },
        outDir: 'dist', emptyOutDir: false,
        rollupOptions: { external: id => !bundledContracts.has(id) && !id.startsWith('.') && !id.startsWith('/') },
    },
});
