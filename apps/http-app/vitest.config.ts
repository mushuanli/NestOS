import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    resolve: { alias: [{ find: /^@itookit\/vfs-core$/, replacement: fileURLToPath(import.meta.resolve('@itookit/vfs-core')) }] },
    test: { server: { deps: { inline: [/itookit/] } } },
});
