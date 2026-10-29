import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { 'llm-config': 'src/llm-management/config.ts', 'llm-mcp-host': 'src/llm-management/mcp-host.ts', 'llm-core': 'src/llm-management/core.ts', 'llm-presets': 'src/llm-management/presets.ts', contracts: 'src/contracts.ts', index: 'src/index.ts', 'mcp-stdio': 'src/llm-management/skills/mcp-stdio.ts', 'mcp-stdio-browser': 'src/llm-management/skills/mcp-stdio-browser.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: true,
    clean: true,
    sourcemap: true,
    external: [
        '@itookit/driver-llm',
        '@itookit/durable-kernel',
        '@itookit/vfs-core',
        '@itookit/tools',
    ],
});
