import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionLeaseStore } from '@itookit/app-core';
import { createVFS } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(run => run())); });

async function leaseStore() {
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-lease-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const backend = await openLocalFSBackend({ rootDir: `${root}/data`, sidecarDir: `${root}/meta` });
    const { manager } = await createVFS({ rootBackend: backend });
    cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    return new SessionLeaseStore(fs, { ttlMs: 1_000 });
}

it('grants a single owner per Session and rejects concurrent owners', async () => {
    const leases = await leaseStore();
    await leases.init();
    const first = await leases.acquire('session-a', { id: 'cli-1', kind: 'cli' });
    expect(first?.fencingToken).toBe(1);
    expect(await leases.acquire('session-a', { id: 'tauri-1', kind: 'tauri' })).toBeNull();
    expect(await leases.acquire('session-b', { id: 'tauri-1', kind: 'tauri' })).toMatchObject({ sessionId: 'session-b' });
    expect(await leases.renew(first!)).toMatchObject({ fencingToken: 1 });
    expect(await leases.release(first!)).toBe(true);
    const second = await leases.acquire('session-a', { id: 'tauri-1', kind: 'tauri' });
    expect(second?.fencingToken).toBe(2);
});

it('expires stale leases and fences the next owner', async () => {
    const leases = await leaseStore();
    const first = await leases.acquire('session-a', { id: 'cli-1', kind: 'cli' });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const second = await leases.acquire('session-a', { id: 'tauri-1', kind: 'tauri' });
    expect(second?.fencingToken).toBe(2);
    expect(await leases.release(first!)).toBe(false);
});
