// Real SQLite sidecar measurements; these are not Tauri IPC or browser paint timings.
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVFS } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { SessionRepository } from '@itookit/llm-session';
import { SessionRegistry } from '../../../backend/llm-session/src/session/session-registry';
import { Kernel } from '@itookit/durable-kernel';
import { NodeFsOps } from '@itookit/vfsdriver-local/node';

it('measures cold history loading on LocalFS without reading each round twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-load-cost-'));
    const backend = await openLocalFSBackend({ rootDir: join(root, 'data'), sidecarDir: join(root, 'db') });
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const repository = new SessionRepository(fs); await repository.init();
    try {
        const id = await repository.createSession('100 rounds');
        for (let index = 0; index < 100; index++) await repository.writeDocument(id, `round-r${index}.json`, JSON.stringify({
            id: `r${index}`, sessionId: id, kind: 'chat', status: 'completed', createdAt: index,
            historyParentIds: index ? [`r${index - 1}`] : [],
            input: [{ role: 'user', content: `question ${index}` }], output: [{ role: 'assistant', content: `answer ${index}` }],
        }));
        const children = Object.fromEntries(Array.from({ length: 99 }, (_, index) => [`r${index}`, [`r${index + 1}`]]));
        await repository.updateManifest(id, { rootRoundId: 'r0', currentHead: 'r99', branches: { main: 'r99' }, children });
        const samples = [];
        for (let trial = 0; trial < 5; trial++) {
            backend.resetSidecarStats();
            const registry = new SessionRegistry(repository), start = performance.now();
            const snapshot = await registry.bindSession(id);
            samples.push({ ms: Math.round(performance.now() - start), sidecar: { ...backend.sidecarStats } });
            // Projection and history chain share this one transaction (one journal probe), and a
            // manifest read is no longer repeated by a second editor-side load.
            expect(backend.sidecarStats.begin).toBe(1);
            expect(backend.sidecarStats.commit).toBe(1);
            expect(backend.sidecarStats.getRecordField).toBe(2);
            // Canonical storage/moving identity, session/settings, then history chain.
            expect(backend.sidecarStats.getRecordFields).toBe(3);
            expect(backend.sidecarStats.getMetaExt).toBe(0);
            expect(backend.sidecarStats.setRecordField).toBe(0);
            expect(snapshot.sessions.filter(message => message.role === 'user').map(message => message.content))
                .toEqual(Array.from({ length: 100 }, (_, index) => `question ${index}`));
        }
        console.info('session-load-localfs', JSON.stringify(samples));
    } finally {
        await repository.dispose(); await manager.dispose(); await rm(root, { recursive: true, force: true });
    }
}, 30_000);

it('reduces existing Session binding I/O compared with repeating creation checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-bind-cost-'));
    const ops = new NodeFsOps();
    const backend = await openLocalFSBackend({ rootDir: join(root, 'data'), sidecarDir: join(root, 'db'), createFs: () => ops });
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0, maxConcurrent: 0 });
    const storage = { kind: 'local', locator: '/session' };
    kernel.registerStorageResolver({ kind: 'local', async resolve() { return { fs, rootPath: '/session' }; } });
    vi.useFakeTimers();
    try {
        await kernel.initialize(); await kernel.createSession({ id: 's', storage });
        const stat = vi.spyOn(ops, 'stat'), statMany = vi.spyOn(ops, 'statMany');
        const sample = async (open: () => Promise<unknown>) => {
            backend.resetSidecarStats(); stat.mockClear(); statMany.mockClear();
            await open();
            return { sidecar: { ...backend.sidecarStats }, stat: stat.mock.calls.length, statMany: statMany.mock.calls.length };
        };
        const creation = await sample(() => kernel.createSession({ id: 's', storage }));
        const opened = await sample(() => kernel.openSession('s', storage));
        console.info('session-bind-localfs', JSON.stringify({ creation, opened }));
        expect(opened.statMany).toBeLessThan(creation.statMany);
        expect(opened.sidecar.upsertMetaExt).toBe(0);
        expect(opened.sidecar.setRecordField).toBe(0);
        expect(opened.sidecar.begin).toBeLessThanOrEqual(creation.sidecar.begin);
    } finally {
        vi.useRealTimers(); kernel.dispose(); await kernel.waitIdle(); vi.restoreAllMocks();
        await manager.dispose(); await rm(root, { recursive: true, force: true });
    }
}, 30_000);

it('lists 65 Sessions in bounded snapshots without directory metadata or writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-list-cost-'));
    const backend = await openLocalFSBackend({ rootDir: join(root, 'data'), sidecarDir: join(root, 'db') });
    const { manager } = await createVFS({ rootBackend: backend });
    const repository = new SessionRepository(await manager.openFileSystem('/')); await repository.init();
    try {
        const ids: string[] = [];
        for (let index = 0; index < 65; index++) ids.push(await repository.createSession(`Session ${index}`));
        backend.resetSidecarStats();
        const listed = await repository.list();
        expect(listed.map(item => item.id).sort()).toEqual(ids.sort());
        // The persistent identity index adds four bounded index/journal reads;
        // the 65 manifests still use only two batches, not 65 transactions.
        expect(backend.sidecarStats.begin).toBe(6);
        // The storage and moving prefix scans each read the index metadata once.
        expect(backend.sidecarStats.getMetaExt).toBe(2);
        expect(backend.sidecarStats.setRecordField).toBe(0);
        console.info('session-list-localfs', JSON.stringify(backend.sidecarStats));
    } finally {
        await repository.dispose(); await manager.dispose(); await rm(root, { recursive: true, force: true });
    }
}, 30_000);
