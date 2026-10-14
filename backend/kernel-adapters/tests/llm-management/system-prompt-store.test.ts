import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SystemPromptStore } from '../../src/llm-management/device/system-prompt-store';
import { DEFAULT_AGENTS } from '../../src/llm-management/constants/agents';

it('checks defaults in one transaction and preserves existing user prompts on warm startup', async () => {
    const backend = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    try {
        const fs = await manager.openFileSystem('/etc');
        const store = new SystemPromptStore(fs, DEFAULT_AGENTS); await store.ensureFile();
        const custom = JSON.stringify({ id: DEFAULT_AGENTS[0].id, content: ['User edited prompt'] });
        await fs.meta.seq!.setEntry('/llm/systemprompt', DEFAULT_AGENTS[0].id, custom);
        const transaction = vi.spyOn(backend.records, 'transaction');
        await store.seedDefaults();
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(await fs.meta.seq!.getEntry('/llm/systemprompt', DEFAULT_AGENTS[0].id)).toBe(custom);
        for (const agent of DEFAULT_AGENTS) expect(await store.getSystemPrompt(agent.id)).not.toBeNull();
        transaction.mockClear();
        await store.seedDefaults();
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(await fs.meta.seq!.getEntry('/llm/systemprompt', DEFAULT_AGENTS[0].id)).toBe(custom);
    } finally { await manager.dispose(); }
});
