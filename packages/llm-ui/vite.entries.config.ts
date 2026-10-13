import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    build: {
        lib: { entry: { chat: resolve(__dirname, 'src/chat.ts'), settings: resolve(__dirname, 'src/settings.ts'), conversation: resolve(__dirname, 'src/conversation.ts') },
            formats: ['es'], fileName: (_format, entry) => `${entry}.js` },
        outDir: 'dist', emptyOutDir: false,
        rollupOptions: { external: id => id !== '@itookit/llm-tasks/contracts' && !id.startsWith('.') && !id.startsWith('/') },
    },
});
