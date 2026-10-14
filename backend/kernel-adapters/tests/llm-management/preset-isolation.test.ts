import { describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { LLMDeviceDriver } from '../../src/llm-management/core';
import { ConnectionManager } from '../../src/llm-management/device/connection-manager';
import { SystemPromptStore } from '../../src/llm-management/device/system-prompt-store';
import { createMindosLlmPresets } from '../../src/llm-management/presets';

describe('host-owned model policies', () => {
    it('starts without product catalogs and seeds only explicitly supplied prompts', async () => {
        const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
        const driver = new LLMDeviceDriver(manager);
        try {
            await driver.init();
            expect(driver.getProviders()).toEqual([]);
            expect(await driver.getConnections()).toEqual([]);
            expect(driver.getDefaultAgents()).toEqual([]);
            expect(driver.getDefaultConnections()).toEqual([]);
            const store = new SystemPromptStore(await manager.openFileSystem('/etc'));
            expect(await store.getSystemPrompt('default')).toBeNull();
        } finally { await driver.dispose(); await manager.dispose(); }
    });

    it('snapshots catalogs at construction and does not expose mutable defaults', () => {
        const presets = createMindosLlmPresets();
        const first = new LLMDeviceDriver({} as never, { presets });
        const expected = structuredClone(presets.agents);
        presets.agents[0].name = 'Changed by host';
        const second = new LLMDeviceDriver({} as never, { presets });
        expect(first.getDefaultAgents()).toEqual(expected);
        expect(second.getDefaultAgents()[0].name).toBe('Changed by host');
        first.getDefaultAgents()[0].name = 'Changed by consumer';
        expect(first.getDefaultAgents()).toEqual(expected);
        expect(new LLMDeviceDriver({} as never).getDefaultAgents()).toEqual([]);
    });

    it('does not create connections when no host policy is supplied', async () => {
        const engineUpsert = vi.fn();
        const manager = new ConnectionManager({ engineUpsert } as never, {} as never, {} as never, vi.fn());
        await manager.ensureProviderConnection({ id: 'p', name: 'P', enabled: true, models: [{ id: 'm', name: 'M' }] });
        expect(manager.getRawConnections()).toEqual([]);
        expect(engineUpsert).not.toHaveBeenCalled();
    });
});
