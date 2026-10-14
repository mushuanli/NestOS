import 'fake-indexeddb/auto';
import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { FileSync, type SyncState } from '@itookit/vfs-sync';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { LocalFSBackend } from '@itookit/vfsdriver-local';
import { LocalSyncStore, createLocalSyncSession } from '../src/local';
import { SerialCoordinator } from '../../../tests/helpers/sync';
import { HttpSyncClient } from '../src';
import { IndexedDBFileLocal, IndexedDBSyncStore } from '../src';
import { prepareProjectSync } from '@itookit/app-core';

it('roundtrips IndexedDB and local clients against pi-agent without overwriting offline edits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'itookit-sync-'));
    const config = join(directory, 'server.toml');
    await writeFile(config, `listen = "127.0.0.1:0"\nexecution = false\nusername = "owner"\npassword_env = "SYNC_TEST_PASSWORD"\n[sync]\nenabled = true\nroot = ${JSON.stringify(join(directory, 'store'))}\n`);
    const child = spawn('cargo', ['run', '--quiet', '--offline', '--manifest-path', resolve('../../tools/pi-agent/Cargo.toml'), '--', config],
        { env: { ...process.env, SYNC_TEST_PASSWORD: 'sync-secret' }, stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(child, 'exit'); const backends: Array<IndexedDBBackend | LocalFSBackend> = [], clients: HttpSyncClient[] = [];
    try {
        const endpoint = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('server startup timeout')), 60000); let output = '';
            child.stderr.on('data', bytes => { output += bytes; const match = output.match(/listening on (127\.0\.0\.1:\d+)/);
                if (match) { clearTimeout(timer); resolve('http://' + match[1]); } });
            child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error('server exited ' + code + ': ' + output)); });
        });
        const seed = new HttpSyncClient({ endpoint, username: 'owner', credential: () => 'sync-secret' }, '');
        clients.push(seed); const caps = await seed.capabilities(); let dropAResponse = false; let id = 0; const newId = () => 'op-' + (++id);
        const make = async (device: string) => {
            const backend = device === 'B' ? new LocalFSBackend({ rootDir: join(directory, 'B'), sidecarDir: join(directory, 'B-sidecar'), durability: 'full' })
                : new IndexedDBBackend({ dbName: directory + device });
            backends.push(backend); await backend.init(); await backend.mkdir('/work');
            const store = backend instanceof LocalFSBackend ? new LocalSyncStore(backend.storageAccess(), device) : new IndexedDBSyncStore(backend.storageAccess(), device);
            const coordinator = new SerialCoordinator();
            const state: SyncState = { schemaVersion: 1, binding: { bindingId: device, bindingRevision: '1', locatorRevision: '1', scopeRevision: '1', policyRevision: '1',
                state: 'active', authorityId: caps.authorityId, historyEpoch: caps.historyEpoch, namespaceId: caps.namespaceId,
                projectId: 'project', localProjectId: device, replicaId: device, datasetId: 'files', sourceId: device, root: '/work', direction: 'both' },
                nextSeq: '1', baseline: [], history: [] };
            await store.initialize(state);
            const remote = new HttpSyncClient({ endpoint, username: 'owner', credential: () => 'sync-secret', fetch: async (url, init) => {
                const reply = await fetch(url, init);
                if (device === 'A' && dropAResponse && String(url).endsWith('/publish')) { dropAResponse = false; await reply.arrayBuffer(); throw new Error('lost response'); }
                return reply;
            } }, caps.historyEpoch); clients.push(remote);
            await prepareProjectSync(store, remote, coordinator, newId, device === 'A');
            const scope = { includes: [''], excludes: ['.mindos'], propagateDeletes: true };
            const sync = backend instanceof LocalFSBackend ? createLocalSyncSession(backend, device, remote, { scope, newId })
                : new FileSync(store, new IndexedDBFileLocal(store as IndexedDBSyncStore), remote, coordinator, newId, scope);
            return { backend, store, sync };
        };
        const a = await make('A'); await a.backend.write('/work/file', new TextEncoder().encode('original'));
        await a.sync.execute((await a.sync.preview()).id);
        const b = await make('B'); await b.sync.execute((await b.sync.preview()).id);
        expect(new TextDecoder().decode(await b.backend.read('/work/file'))).toBe('original');
        await a.backend.write('/work/a-only', new TextEncoder().encode('A'));
        await b.backend.write('/work/b-only', new TextEncoder().encode('B'));
        const stale = await b.sync.preview(); await a.sync.execute((await a.sync.preview()).id);
        await expect(b.sync.execute(stale.id)).rejects.toThrow('PLAN_CLOUD_CHANGED');
        expect((await b.store.read()).activePlanId).toBeUndefined();
        await b.sync.execute((await b.sync.preview()).id);
        await a.sync.execute((await a.sync.preview()).id);
        expect(new TextDecoder().decode(await a.backend.read('/work/b-only'))).toBe('B');
        expect(new TextDecoder().decode(await b.backend.read('/work/a-only'))).toBe('A');
        await a.backend.write('/work/file', new TextEncoder().encode('A edit'));
        await b.backend.write('/work/file', new TextEncoder().encode('B edit'));
        await a.sync.execute((await a.sync.preview()).id);
        const conflict = await b.sync.preview(); expect(conflict.plan.conflicts.some(c => c.path === 'file')).toBe(true);
        await b.sync.execute(conflict.id); expect(new TextDecoder().decode(await b.backend.read('/work/file'))).toBe('B edit');
        const chosen = await b.sync.resolve((await b.sync.preview()).id, { file: 'local' });
        await b.sync.execute(chosen.id); await a.sync.execute((await a.sync.preview()).id);
        expect(new TextDecoder().decode(await a.backend.read('/work/file'))).toBe('B edit');
        await a.backend.write('/work/file', new TextEncoder().encode('P1'));
        const publish = await a.sync.preview(); dropAResponse = true;
        await expect(a.sync.execute(publish.id)).rejects.toThrow();
        expect((await a.store.read()).pending).toBeDefined();
        await a.backend.write('/work/file', new TextEncoder().encode('P2'));
        await a.backend.close(); await a.backend.init(); await a.sync.recover();
        expect((await a.store.read()).pending).toBeUndefined();
        expect(new TextDecoder().decode(await a.backend.read('/work/file'))).toBe('P2');
        const c = await make('C'); await c.sync.execute((await c.sync.preview()).id);
        expect(new TextDecoder().decode(await c.backend.read('/work/file'))).toBe('P1');
        await a.sync.execute((await a.sync.preview()).id); await c.sync.execute((await c.sync.preview()).id);
        expect(new TextDecoder().decode(await c.backend.read('/work/file'))).toBe('P2');
        await a.backend.write('/work/text', new TextEncoder().encode('a\nb\nc\n'));
        await a.sync.execute((await a.sync.preview()).id); await c.sync.execute((await c.sync.preview()).id);
        await a.backend.write('/work/text', new TextEncoder().encode('A\nb\nc\n'));
        await c.backend.write('/work/text', new TextEncoder().encode('a\nb\nC\n'));
        await a.sync.execute((await a.sync.preview()).id);
        const textPlan = await c.sync.mergeText((await c.sync.preview()).id, ['text']);
        await c.sync.execute(textPlan.id);
        expect(new TextDecoder().decode(await c.backend.read('/work/text'))).toBe('A\nb\nC\n');
        await a.sync.execute((await a.sync.preview()).id);
        expect(new TextDecoder().decode(await a.backend.read('/work/text'))).toBe('A\nb\nC\n');
    } finally {
        clients.forEach(c => c.close()); await Promise.all(backends.map(b => b.close()));
        child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true });
    }
}, 90000);
