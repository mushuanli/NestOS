import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLocalFSBackend, type LocalFSBackend } from '@itookit/vfsdriver-local';
import { bindingToken, randomId, sha256, type FileAction, type SyncState } from '@itookit/vfs-sync';
import { LocalSyncStore, LocalFileLocal, LocalSyncCoordinator } from '../src/local';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'local-sync-'));
    closes.push(() => rm(directory, { recursive: true, force: true }));
    const options = { rootDir: directory, sidecarDir: join(directory, '.meta'), durability: 'full' as const };
    const backend = await openLocalFSBackend(options); closes.push(() => backend.close()); await backend.mkdir('/work');
    const storage = backend.storageAccess(), store = new LocalSyncStore(storage, 'b');
    const state: SyncState = { schemaVersion: 1, binding: { bindingId: 'b', bindingRevision: '1', locatorRevision: '1', policyRevision: '1', scopeRevision: '1',
        state: 'active', authorityId: 'a', namespaceId: 'personal', historyEpoch: 'e', projectId: 'p', localProjectId: 'l',
        replicaId: 'r', sourceId: storage.identity, root: '/work', datasetId: 'files', direction: 'both' }, nextSeq: '1', baseline: [], history: [] };
    await store.initialize(state); return { directory, options, backend, store, state, local: new LocalFileLocal(store) };
}
async function action(store: LocalSyncStore, path: string, content: string, side: FileAction['side'] = 'download'): Promise<FileAction> {
    const bytes = new TextEncoder().encode(content), hash = await store.putObject(bytes);
    return { path, side, output: { kind: 'file', path, hash, size: String(bytes.length), executable: false } };
}
it('uses portable SeqFile state and applies files, directories and baselines with durable evidence', async () => {
    const f = await setup(); await f.backend.write('/work/a', new TextEncoder().encode('old'));
    const capture = await f.local.capture(), changes: FileAction[] = [await action(f.store, 'a', 'new'),
        { path: 'dir', side: 'download', output: { kind: 'directory', path: 'dir' } }, await action(f.store, 'dir/b', 'child')];
    await f.local.apply(bindingToken(f.state.binding), capture.handle, changes, 'apply');
    expect(await readFile(join(f.directory, 'work/a'), 'utf8')).toBe('new');
    expect(await readFile(join(f.directory, 'work/dir/b'), 'utf8')).toBe('child');
    expect((await f.store.read()).baseline).toHaveLength(3);
    expect(await LocalSyncStore.list(f.backend.storageAccess())).toEqual([await f.store.read()]);
    await writeFile(join(f.directory, 'work/a'), 'P2'); await f.local.apply(bindingToken(f.state.binding), capture.handle, changes, 'apply');
    expect(await readFile(join(f.directory, 'work/a'), 'utf8')).toBe('P2');
});
it('rejects changed inputs before applying any download and retains uploaded P with later P2', async () => {
    const f = await setup(); await f.backend.write('/work/a', new TextEncoder().encode('P'));
    const captured = await f.local.capture(), uploaded = await action(f.store, 'a', 'P', 'upload');
    await writeFile(join(f.directory, 'work/a'), 'P2');
    await f.local.apply(bindingToken(f.state.binding), captured.handle, [uploaded], 'upload');
    expect((await f.store.read()).baseline).toEqual([uploaded.output]);
    const next = await f.local.capture(), changes = [await action(f.store, 'a', 'cloud'), await action(f.store, 'b', 'B')];
    await writeFile(join(f.directory, 'work/a'), 'user');
    await expect(f.local.apply(bindingToken(f.state.binding), next.handle, changes, 'changed')).rejects.toThrow('LOCAL_CHANGED');
    expect(await f.backend.stat('/work/b')).toBeNull(); expect(await readFile(join(f.directory, 'work/a'), 'utf8')).toBe('user');
});
it('protects excluded children and record-backed files and does not infer deletion from unsupported paths', async () => {
    const f = await setup(); await mkdir(join(f.directory, 'work/dir')); await writeFile(join(f.directory, 'work/dir/secret'), 'keep');
    await symlink(join(f.directory, 'work/dir/secret'), join(f.directory, 'work/link'));
    await f.backend.write('/work/state.seq', new Uint8Array()); await f.backend.records.setRecordField('/work/state.seq', 'state', 'domain');
    const captured = await f.local.capture(); expect(captured.scan.entries.link.state).toBe('unknown'); expect(captured.scan.entries['state.seq'].state).toBe('unsupported');
    await expect(f.local.apply(bindingToken(f.state.binding), captured.handle, [{ path: 'dir', side: 'download' }], 'delete')).rejects.toThrow('DIRECTORY_GROUP_BLOCKED');
    expect(await readFile(join(f.directory, 'work/dir/secret'), 'utf8')).toBe('keep');
});
it('captures executable bits and preserves their declared output', async () => {
    const f = await setup(); await writeFile(join(f.directory, 'work/run'), 'old'); await chmod(join(f.directory, 'work/run'), 0o755);
    const captured = await f.local.capture(); expect(captured.scan.entries.run).toMatchObject({ executable: 'known', entry: { executable: true } });
    const download = await action(f.store, 'run', 'new'); if (download.output?.kind === 'file') download.output.executable = true;
    await f.local.apply(bindingToken(f.state.binding), captured.handle, [download], 'exec');
    expect((await f.local.capture()).scan.entries.run).toMatchObject({ entry: { executable: true } });
});
it('recovers replacement evidence after SQL result persistence fails and preserves a subsequent edit', async () => {
    const f = await setup(); await writeFile(join(f.directory, 'work/a'), 'old');
    const captured = await f.local.capture(), download = await action(f.store, 'a', 'new');
    const save = vi.spyOn(f.store, 'save');
    save.mockImplementationOnce(async () => { throw new Error('injected finalization failure'); });
    await expect(f.local.apply(bindingToken(f.state.binding), captured.handle, [download], 'recover')).rejects.toThrow('injected finalization failure');
    // The published-confirm phase writes first; fail the actual baseline phase below instead.
    save.mockRestore();
    const saves = vi.spyOn(f.store, 'save');
    saves.mockImplementationOnce((db, state) => LocalSyncStore.prototype.save.call(f.store, db, state));
    saves.mockImplementationOnce(async () => { throw new Error('after replace'); });
    await expect(f.local.apply(bindingToken(f.state.binding), captured.handle, [download], 'recover')).rejects.toThrow('after replace');
    saves.mockRestore(); expect(await readFile(join(f.directory, 'work/a'), 'utf8')).toBe('new');
    await writeFile(join(f.directory, 'work/a'), 'new user edit');
    await f.backend.close(); const backend = await openLocalFSBackend(f.options); closes.push(() => backend.close());
    const store = new LocalSyncStore(backend.storageAccess(), 'b'); await new LocalFileLocal(store).apply(bindingToken(f.state.binding), captured.handle, [download], 'recover');
    expect((await store.read()).baseline).toEqual([download.output]); expect(await readFile(join(f.directory, 'work/a'), 'utf8')).toBe('new user edit');
});
it('coordinates independent SQLite connections and fences stale owners inside native transactions', async () => {
    const f = await setup(), other = await openLocalFSBackend(f.options); closes.push(() => other.close()); let now = 0;
    const options = { now: () => now, leaseMs: 20000, heartbeatMs: 10000, retryMs: 1 };
    const a = new LocalSyncCoordinator(f.backend.storageAccess(), options), b = new LocalSyncCoordinator(other.storageAccess(), options);
    let release!: () => void, enter!: (guard: import('@itookit/vfs-sync').CoordinationGuard) => void;
    const entered = new Promise<import('@itookit/vfs-sync').CoordinationGuard>(resolve => { enter = resolve; });
    const first = a.exclusive('b', async guard => { enter(guard!); await new Promise<void>(resolve => { release = resolve; }); });
    const rejected = expect(first).rejects.toThrow('SYNC_COORDINATION_LOST'), guard = await entered; now = 20001;
    await b.exclusive('b', async current => {
        await expect(f.store.scoped(guard).update(s => ({ ...s, nextSeq: '100' }))).rejects.toThrow('SYNC_COORDINATION_LOST');
        await new LocalSyncStore(other.storageAccess(), 'b').scoped(current!).update(s => ({ ...s, nextSeq: '2' }));
        release(); await rejected; await current!.check();
    });
    expect((await f.store.read()).nextSeq).toBe('2');
});
it('rejects non-durable sidecars before claiming safe synchronization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'normal-sync-')); closes.push(() => rm(directory, { recursive: true, force: true }));
    const backend = await openLocalFSBackend({ rootDir: directory, sidecarDir: join(directory, '.meta') }); closes.push(() => backend.close());
    expect(() => new LocalSyncStore(backend.storageAccess(), 'b')).toThrow('LOCAL_SYNC_DURABILITY_REQUIRED');
});
it('recovers a SIGKILL between native replacement and SQLite baseline commit', async () => {
    const f = await setup(); await writeFile(join(f.directory, 'work/a'), 'before');
    const captured = await f.local.capture(), actions = [await action(f.store, 'a', 'after')], token = bindingToken(f.state.binding);
    await f.store.persistPlan('crash-input', { token, handle: captured.handle, actions });
    const { spawn } = await import('node:child_process'), { once } = await import('node:events');
    // Ignore the tsx loader deprecation while retaining actual fixture errors on stderr.
    const child = spawn(process.execPath, ['--disable-warning=DEP0205', '--import', 'tsx', 'tests/fixtures/local-sync-crash.ts', JSON.stringify(f.options)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', bytes => { error += bytes; });
    const [code, signal] = await once(child, 'exit'); expect({ code, signal, error }).toEqual({ code: null, signal: 'SIGKILL', error: '' });
    expect((await f.store.read()).baseline).toEqual([]); expect(await readFile(join(f.directory, 'work/a'), 'utf8')).toBe('after');
    await writeFile(join(f.directory, 'work/a'), 'after-user-edit');
    const coordinator = new LocalSyncCoordinator(f.backend.storageAccess(), { now: () => Date.now() + 60000 });
    await coordinator.exclusive('b', guard => new LocalFileLocal(f.store.scoped(guard!)).apply(token, captured.handle, actions, 'crash'));
    expect((await f.store.read()).baseline).toEqual([actions[0].output]);
    expect(await readFile(join(f.directory, 'work/a'), 'utf8')).toBe('after-user-edit');
});
it('retains ambiguous replacement evidence without overwriting an atomic external edit', async () => {
    const f = await setup(); await writeFile(join(f.directory, 'work/a'), 'old');
    const captured = await f.local.capture(), actions = [await action(f.store, 'a', 'cloud')];
    const save = vi.spyOn(f.store, 'save');
    save.mockImplementationOnce((db, state) => LocalSyncStore.prototype.save.call(f.store, db, state));
    save.mockImplementationOnce(async () => { throw new Error('after replace'); });
    await expect(f.local.apply(bindingToken(f.state.binding), captured.handle, actions, 'ambiguous')).rejects.toThrow('after replace'); save.mockRestore();
    const { rename } = await import('node:fs/promises');
    await writeFile(join(f.directory, 'work/edited'), 'external'); await rename(join(f.directory, 'work/edited'), join(f.directory, 'work/a'));
    await expect(f.local.apply(bindingToken(f.state.binding), captured.handle, actions, 'ambiguous')).rejects.toThrow('LOCAL_APPLY_AMBIGUOUS');
    expect(await readFile(join(f.directory, 'work/a'), 'utf8')).toBe('external'); expect((await f.store.read()).baseline).toEqual([]);
    expect(await readFile(join(f.directory, 'var/lib/sync/b/journal/ambiguous-downloaded/0-before'), 'utf8')).toBe('old');
});
it('removes a complete directory group and safely applies both kinds of type conversion', async () => {
    const f = await setup(); await f.backend.mkdir('/work/dir'); await f.backend.write('/work/dir/a', new TextEncoder().encode('A'));
    let capture = await f.local.capture();
    await f.local.apply(bindingToken(f.state.binding), capture.handle, [{ path: 'dir', side: 'download' }, { path: 'dir/a', side: 'download' }], 'remove');
    expect(await f.backend.stat('/work/dir')).toBeNull();
    await f.backend.mkdir('/work/dir'); capture = await f.local.capture();
    await f.local.apply(bindingToken(f.state.binding), capture.handle, [await action(f.store, 'dir', 'file')], 'dir-file');
    expect(await readFile(join(f.directory, 'work/dir'), 'utf8')).toBe('file');
    capture = await f.local.capture();
    await f.local.apply(bindingToken(f.state.binding), capture.handle, [{ path: 'dir', side: 'download', output: { kind: 'directory', path: 'dir' } }, await action(f.store, 'dir/child', 'child')], 'file-dir');
    expect(await readFile(join(f.directory, 'work/dir/child'), 'utf8')).toBe('child');
});
it('refuses an old plan when the bound directory was replaced by a new empty directory', async () => {
    const f = await setup(), captured = await f.local.capture(), actions = [await action(f.store, 'a', 'download')];
    const { rename } = await import('node:fs/promises');
    await rename(join(f.directory, 'work'), join(f.directory, 'previous')); await mkdir(join(f.directory, 'work'));
    await expect(f.local.apply(bindingToken(f.state.binding), captured.handle, actions, 'old-root')).rejects.toThrow('SYNC_ROOT_CHANGED');
    expect(await f.backend.stat('/work/a')).toBeNull(); expect((await f.store.read()).baseline).toEqual([]);
});
