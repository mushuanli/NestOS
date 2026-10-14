import { expect, it, vi } from 'vitest';
import { acquireConnectionOptions } from './connection-options-cache';

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
    provider.enabled = false; fire(); expect(await second.read()).toEqual([]);
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
