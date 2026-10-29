import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    resolve: { alias: [{ find: /^@itookit\/vfs-core$/, replacement: fileURLToPath(import.meta.resolve('@itookit/vfs-core')) }] },
    test: {
        globals: true,
        // Integration fixtures own kernels and LocalFS stores; bound workers to avoid I/O contention.
        maxWorkers: 4, minWorkers: 1,
        server: { deps: { inline: [/itookit/] } },
        environment: 'node',
        // LLM network calls need longer timeout
        testTimeout: 60_000,
        hookTimeout: 15_000,
        include: ['tests/**/*.test.ts'],
    },
});
