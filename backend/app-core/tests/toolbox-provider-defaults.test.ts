import { expect, it } from 'vitest';
import { ToolboxInventory } from '../src/configuration/toolbox-catalog';

it('uses the supplied service catalog when presenting provider defaults', async () => {
    const provider = { id: 'custom', name: 'Custom', icon: 'host-icon', enabled: true, implementation: 'openai-compatible' };
    const service = { getProviders: () => [provider], getProviderDefaults: () => ({ custom: provider }),
        getConnections: async () => [], getDefaultConnection: async () => null, getFullProvider: () => ({ apiKey: 'key' }) };
    const inventory = new ToolboxInventory(async () => [], { listTools: () => [], getToolDefinitions: () => [] }, service as never);
    try {
        await inventory.init();
        expect(inventory.providers.get('custom')).toMatchObject({ icon: undefined, configured: true });
    } finally { await inventory.dispose(); }
});

it('does not emit catalog file changes when configuration is unchanged', async () => {
    const inventory = new ToolboxInventory(async () => [], { listTools: () => [{ id: 'tool', name: 'Tool', description: '', type: 'builtin', enabled: true }], getToolDefinitions: () => [] } as never);
    await inventory.init(); let events = 0;
    const stop = inventory.sources.tools.onAny(() => { events++; });
    try { await inventory.refresh(); expect(events).toBe(0); }
    finally { stop(); await inventory.dispose(); }
});
