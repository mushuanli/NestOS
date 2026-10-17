import { expect, it, vi } from 'vitest';
import { acquireConnectionOptions } from './connection-options-cache';
import { buildConnectionOptions } from './AgentProvider';

function fixture() {
    const listeners = new Set<() => void>();
    const provider = { id: 'p', enabled: true, models: [{ id: 'm', name: 'Model' }] };
    const connections = [{ id: 'c', name: 'Connection', providerId: 'p', model: 'm', hasApiKey: true }];
    const getConnections = vi.fn(async () => connections);
    const off = vi.fn();
    const service = { getConnections, getDefaultConnection: async () => null, getProvider: () => provider,
        onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); off(); }; } };
    return { service: service as never, provider, connections, getConnections, off,
        fire: () => listeners.forEach(listener => listener()) };
}

it('shares reads across editors and invalidates on provider/connection notifications', async () => {
    const fixtureData = fixture();
    const { service, provider, connections, getConnections, fire, off } = fixtureData;
    const first = acquireConnectionOptions(service), second = acquireConnectionOptions(service);
    const [a, b] = await Promise.all([first.read(), second.read()]);
    expect(getConnections).toHaveBeenCalledOnce();
    a[0].name = 'local mutation'; expect(b[0].name).toBe('Connection');
    provider.enabled = false; fire(); expect(await second.read()).toMatchObject([{id: 'c', enabled: false}]);
    provider.enabled = true; connections.push({ ...connections[0], id: 'new' }); fire();
    expect((await first.read()).map(item => item.id)).toEqual(['c', 'new']);
    expect(getConnections).toHaveBeenCalledTimes(3);
    first.dispose(); expect(off).not.toHaveBeenCalled();
    second.dispose(); second.dispose(); expect(off).toHaveBeenCalledOnce();
});

it('discards an in-flight snapshot invalidated by a newer event and retries failed reads', async () => {
    const { service, getConnections, connections, fire } = fixture();
    let complete!: (value: typeof connections) => void;
    getConnections.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const cache = acquireConnectionOptions(service);
    const pending = cache.read(); fire(); complete([]);
    expect((await pending)[0].id).toBe('c'); expect(getConnections).toHaveBeenCalledTimes(2);
    fire(); getConnections.mockRejectedValueOnce(new Error('temporary'));
    await expect(cache.read()).rejects.toThrow('temporary');
    expect((await cache.read())[0].id).toBe('c'); cache.dispose();
});

it('releases only the disposed handle listeners while another editor keeps the source alive', async () => {
    const {service, connections, fire, off} = fixture();
    const first = acquireConnectionOptions(service), second = acquireConnectionOptions(service);
    const closed = vi.fn(), shared = vi.fn();
    first.subscribe(closed);
    const stopFirst = first.subscribe(shared);
    second.subscribe(shared);
    fire(); expect(shared).toHaveBeenCalledTimes(2);
    first.dispose(); first.dispose(); stopFirst();
    first.subscribe(closed);
    connections[0].name = 'Updated'; fire();
    expect(closed).toHaveBeenCalledOnce(); expect(shared).toHaveBeenCalledTimes(3);
    expect(off).not.toHaveBeenCalled();
    expect((await second.read())[0].name).toBe('Updated');
    second.dispose(); fire();
    expect(shared).toHaveBeenCalledTimes(3); expect(off).toHaveBeenCalledOnce();
});

it('does not remove a newer registration when an old unsubscribe is called again', () => {
    const {service, fire} = fixture(), cache = acquireConnectionOptions(service), changed = vi.fn();
    const stop = cache.subscribe(changed);
    stop(); cache.subscribe(changed); stop(); fire();
    expect(changed).toHaveBeenCalledOnce();
    cache.dispose();
});

it('offers known chat tiers while excluding media and removed catalog models', async () => {
    const provider = {id: 'p', enabled: true, models: [
        {id: 'chat', name: 'Chat', category: 'chat'}, {id: 'image', name: 'Image', category: 'image'},
    ]};
    const service = {getProvider: () => provider, getDefaultConnection: async () => null, getConnections: async () => [
        {id: 'mixed', name: 'Mixed', providerId: 'p', model: 'image', tiers: {optimal: 'image', standard: 'chat', fast: 'removed'}, hasApiKey: true},
        {id: 'removed', name: 'Removed', providerId: 'p', model: 'chat', tiers: {optimal: 'removed'}, hasApiKey: true},
    ]};
    const [mixed, removed] = await buildConnectionOptions(service as never);
    expect(mixed).toMatchObject({id: 'mixed', hasTiers: true, tiers: {standard: 'Chat'}});
    expect(mixed.tiers).toEqual({standard: 'Chat'});
    expect(removed.tiers).toEqual({});
    expect(JSON.parse(JSON.stringify(mixed.resolvedTiers))).toEqual({optimal: null, standard: 'Chat', fast: null});
    expect(removed.resolvedTiers).toEqual({optimal: null, standard: null, fast: null});
});

it('shares the injected configuration subscription and reads current snapshots without RPC selectors', async () => {
    const f = fixture(), listeners = new Set<() => void>();
    let snapshot = {agents: [], promptPresets: {}, connections: f.connections, providers: [f.provider], defaultConnectionId: 'c'};
    const configuration = {getConfigurationSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};}, dispose: async () => {}};
    const first = acquireConnectionOptions(f.service, configuration as never), second = acquireConnectionOptions(f.service, configuration as never);
    const changed = vi.fn(), stop = first.subscribe(changed);
    expect(await first.read()).toMatchObject([{id: 'c', isDefault: true}]);
    snapshot = {...snapshot, connections: [{...f.connections[0], name: 'Updated'}]};
    for (const listener of listeners) listener();
    expect(changed).toHaveBeenCalledOnce(); expect((await second.read())[0].name).toBe('Updated');
    expect(f.getConnections).not.toHaveBeenCalled(); expect(listeners.size).toBe(1);
    stop(); first.dispose(); second.dispose(); expect(listeners.size).toBe(0);
});
