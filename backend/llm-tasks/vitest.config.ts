import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        testTimeout: 30_000,
        hookTimeout: 10_000,
        include: ['__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    },
});
