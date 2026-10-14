import { defineConfig } from 'tsup';

// Bundle neutral contracts while retaining the identity of public Kernel and UI classes.
const contractPaths = {
    '@itookit/tools/contracts': ['../../backend/tools/src/contracts.ts'],
    '@itookit/tools/mcp-contracts': ['../../backend/tools/src/mcp-contracts.ts'],
    '@itookit/kernel-adapters/contracts': ['../../backend/kernel-adapters/src/contracts.ts'],
    '@itookit/llm-tasks/contracts': ['../../backend/llm-tasks/src/contracts.ts'],
};
// Resolve standalone contracts through package exports instead of assuming a local checkout.
const bundledContracts = ['@itookit/driver-llm/contracts', ...Object.keys(contractPaths)];

export default defineConfig({
    entry: { index: 'src/index.ts', chat: 'src/chat.ts', startup: 'src/startup.ts', settings: 'src/settings.ts', conversation: 'src/conversation.ts' },
    format: ['esm'],
    dts: { only: true, resolve: bundledContracts, compilerOptions: { rootDir: '../..', paths: contractPaths } },
    noExternal: bundledContracts,
    clean: false,
});
