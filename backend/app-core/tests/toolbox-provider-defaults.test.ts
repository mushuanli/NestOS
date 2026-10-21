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

it('projects safe connection readiness and preserves missing chat models as null across serialization', async () => {
    const provider = {id: 'p', name: 'Provider', enabled: true, implementation: 'openai-compatible', models: [{id: 'image', category: 'image'}, {id: 'chat', name: 'Chat model', category: 'chat'}]};
    const service = {getProviders: () => [provider], getProviderDefaults: () => ({}), getFullProvider: async () => ({apiKey: 'never expose'}),
        getDefaultConnection: async () => null, getConnections: async () => [
            {id: 'chat', providerId: 'p', model: 'chat', hasApiKey: false, credentialsReady: true},
            {id: 'image', providerId: 'p', model: 'image', hasApiKey: true, credentialsReady: false},
        ]};
    const inventory = new ToolboxInventory(async () => [], {listTools: () => [], getToolDefinitions: () => []}, service as never);
    try {
        await inventory.init();
        expect(inventory.connections.get('chat')).toMatchObject({credentialsReady: true, model: 'Chat model'});
        expect(JSON.parse(JSON.stringify(inventory.connections.get('image')))).toMatchObject({credentialsReady: false, model: null});
        expect(inventory.connections.get('chat')?.capabilityTags).toEqual(['chat']);
        expect(inventory.connections.get('image')?.capabilityTags).toEqual([]);
        expect(JSON.stringify([...inventory.connections])).not.toContain('never expose');
    } finally { await inventory.dispose(); }
});

it.each([
    {model: 'chat', tiers: {optimal: 'image', standard: 'chat'}, expected: 'Chat model'},
    {model: 'image', tiers: {fast: 'chat'}, expected: 'Chat model'},
    {model: 'chat', tiers: {optimal: 'removed'}, expected: null},
    {model: '', tiers: {standard: 'removed'}, expected: null},
    {model: '', tiers: {}, expected: null},
])('projects configured chat tiers without treating unknown models as ready: %j', async ({model, tiers, expected}) => {
    const provider = {id: 'p', name: 'Provider', enabled: true, models: [
        {id: 'image', name: 'Image model', category: 'image'}, {id: 'chat', name: 'Chat model', category: 'chat'},
    ]};
    const service = {getProviders: () => [provider], getProviderDefaults: () => ({}), getDefaultConnection: async () => null, getConnections: async () => [
        {id: 'c', providerId: 'p', model, tiers, hasApiKey: true},
    ], getFullProvider: async () => ({apiKey: 'fixture'})};
    const inventory = new ToolboxInventory(async () => [], {listTools: () => [], getToolDefinitions: () => []}, service as never);
    try {
        await inventory.init();
        expect(JSON.parse(JSON.stringify(inventory.connections.get('c')))).toMatchObject({model: expected, credentialsReady: true});
    } finally {await inventory.dispose();}
});
