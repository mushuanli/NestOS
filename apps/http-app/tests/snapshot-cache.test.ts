import {expect, it} from 'vitest';
import {SnapshotCache} from '@itookit/app-transport/http';
import type {WireValue} from '@itookit/app-transport/rpc';

const data = (name = 'Before'): WireValue => ({$object: {catalog: {$object: {name, models: Array.from({length: 100}, (_, id) => ({$object: {id, label: 'Model'}}))}},
    current: {$capability: {id: 'server:current:1', kind: 'View', fields: {}, snapshots: {}}}}});

it('reuses verified DTOs across new view identities, sends changed data and never caches capabilities', async () => {
    const server = new SnapshotCache(); let stored: string | null = null;
    const storage = {read: () => stored, write: (value: string) => {stored = value;}};
    const first = new SnapshotCache(storage), cold = await server.pack(data(), []);
    expect(await first.unpack(cold)).toEqual(data());
    expect(stored).not.toContain('server:current:1');
    const next = new SnapshotCache(storage); await next.load();
    const warm = await server.pack(data(), next.known());
    expect(Object.keys(warm.cache)).toHaveLength(0);
    expect(JSON.stringify(warm).length).toBeLessThan(JSON.stringify(cold).length / 3);
    expect(await next.unpack(warm)).toEqual(data());
    expect(await next.unpack(await server.pack(data('Updated'), next.known()))).toEqual(data('Updated'));
});

it('does not advertise corrupt persisted data and refuses unavailable snapshot references', async () => {
    const cache = new SnapshotCache({read: () => JSON.stringify({['0'.repeat(64)]: {$object: {forged: true}}}), write() {}});
    await cache.load(); expect(cache.known()).toHaveLength(0);
    await expect(cache.unpack({payload: {$cache: '0'.repeat(64)}, cache: {}})).rejects.toMatchObject({code: 'ENOENT'});
    await expect(cache.unpack({payload: null, cache: {['0'.repeat(64)]: {$ref: 'server:other:1'}}})).rejects.toMatchObject({code: 'EINVAL'});
});
