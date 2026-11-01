import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend, FSError, createFileSystemSource, type OperationOptions} from '@itookit/vfs-core';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {DiagnosticJournal} from '../src/diagnostics/journal';
import {diagnosticFailure} from '../src/diagnostics/failure';
import type {RemoteFileSourceProvider} from '../src/projects/remote-mounts';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';
import {RemoteMountStore} from '../src/projects/remote-mount-store';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
const input = {module: 'cells' as const, operation: 'project.connection', stage: 'root-probe', level: 'error' as const,
    result: 'failure' as const, code: 'EACCES', projectId: 'project-a', connectionId: 'office'};

it('persists safe events across views, bounds queries and isolates runtime journals', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web'});
    cleanup.push(() => runtime.dispose());
    const fs = await runtime.vfs.openFileSystem('/'), first = new DiagnosticJournal(), other = new DiagnosticJournal();
    await first.attach(fs);
    first.record({...input, secret: 'PRIVATE_TOKEN', stack: 'PRIVATE_BODY'} as typeof input);
    first.record({...input, projectId: 'project-b', code: 'ENOTDIR'});
    await first.dispose();
    const restored = new DiagnosticJournal(); await restored.attach(fs); cleanup.push(() => restored.dispose());
    const page = await restored.query({projectId: 'project-a'});
    expect(page.persistence).toBe('ready'); expect(page.events).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('PRIVATE');
    expect((await other.query()).events).toEqual([]);
    const latest = await restored.query({limit: 1}); expect(latest.events[0].code).toBe('ENOTDIR'); expect(latest.truncated).toBe(true);
    expect((await restored.query({search: 'EACCES'})).events).toHaveLength(1);
});

it('keeps a bounded journal and exposes storage failures without losing in-memory events', async () => {
    const journal = new DiagnosticJournal();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let index = 0; index < 510; index++) journal.record({...input, code: 'EVENT_' + index, result: 'success', level: 'info'});
    const page = await journal.query({limit: 999});
    expect(page.retained).toBeLessThanOrEqual(500); expect(page.retained).toBeGreaterThan(200);
    expect(page).toMatchObject({limit: 200, truncated: true});
    await journal.attach({driver: {exists: async () => {throw new Error('PRIVATE_STORAGE');}}} as never);
    expect((await journal.query()).persistence).toBe('unavailable');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_STORAGE'); await journal.dispose();
});

it('classifies nested network and grant failures without copying exception text', () => {
    const error = Object.assign(new Error('PRIVATE_RESPONSE https://private.test', {cause: Object.assign(new Error('PRIVATE_TOKEN'), {code: 'ECONNREFUSED'})}), {code: 'ERA_NEGOTIATION_FAILED', requestId: 'request-1'});
    expect(diagnosticFailure(error)).toEqual({code: 'ERA_NEGOTIATION_FAILED', causeCodes: ['ECONNREFUSED'], reason: 'network', requestId: 'request-1'});
    expect(diagnosticFailure(new FSError('EACCES', 'Remote authorization changed; refresh the project binding')).reason).toBe('authorization-changed');
});

async function remoteFixture(open: (options?: OperationOptions) => ReturnType<typeof createFileSystemSource>, projects?: RemoteFileSourceProvider['projects']) {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web'}); cleanup.push(() => runtime.dispose());
    const fs = await runtime.vfs.openFileSystem('/'), store = new RemoteMountStore(fs); await store.load();
    await store.save({version: 1, revision: 0, connections: [{id: 'office', name: 'Office', endpoint: 'https://private.test', username: 'user', credentialRef: 'PRIVATE_REF'}],
        projects: {'project-a': [{serverProjectId: projects ? 'server-a' : undefined, serverProjectRevision: projects ? 1 : undefined, mountId: 'mount-a', at: '/', root: '/', alias: 'docs', access: 'ro', connectionId: 'office', endpoint: 'https://private.test', credentialRef: 'PRIVATE_REF'}]}});
    const remote = new ProjectRemoteMountService(fs, {setCredential() {}, dispose: async () => {}, projects, open: (_connection, options) => open(options)},
        async () => {}, async () => {}, undefined, runtime.diagnostics);
    await remote.init(); cleanup.push(() => remote.dispose());
    return {remote, journal: runtime.diagnostics};
}

it('records a failed root probe, exposes project state, and retains the event after recovery', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    let failing = true;
    const {remote, journal} = await remoteFixture(async () => {
        if (failing) throw new FSError('EACCES', 'Remote authorization changed; PRIVATE_BODY');
        return createFileSystemSource({backend: new MemoryBackend(), viewId: 'remote', access: 'ro'});
    });
    expect((await remote.projectStatus('project-a')).status).toBe('unknown');
    await remote.checkConnections('project-a');
    expect(await remote.projectStatus('project-a')).toMatchObject({status: 'offline', mounts: [{failure: {code: 'EACCES', reason: 'authorization-changed'}}]});
    expect(JSON.stringify(await journal.query())).not.toContain('PRIVATE');
    failing = false; await remote.checkConnections('project-a');
    expect(await remote.projectStatus('project-a')).toMatchObject({status: 'online', mounts: [{lastSuccessAt: expect.any(Number)}]});
    expect((await remote.projectStatus('project-a')).mounts[0].failure).toBeUndefined();
    expect((await journal.query({projectId: 'project-a'})).events.map(event => event.result)).toEqual(['success', 'failure']);
});

it('keeps busy file gates reachable, clears stale offline state and retains precise diagnostics', async () => {
    let failure: 'EBUSY' | 'ECONNREFUSED' | undefined = 'EBUSY';
    const {remote, journal} = await remoteFixture(async () => {
        const owner = await createFileSystemSource({backend: new MemoryBackend(), viewId: 'busy-remote', access: 'ro'});
        const stat = owner.fs.driver.getNode.bind(owner.fs.driver);
        owner.fs.driver.getNode = (path, options) => failure ? Promise.reject(new FSError(failure, 'PRIVATE_REMOTE_BODY')) : stat(path, options);
        return owner;
    });
    const checkBusy = async () => {
        await remote.checkConnections('project-a');
        expect(remote.projectOffline('project-a')).toBe(false);
        expect(await remote.projectStatus('project-a')).toMatchObject({status: 'degraded', problem: 'files-busy',
            mounts: [{status: 'online', failure: {code: 'EBUSY', reason: 'busy'}}]});
    };
    await checkBusy();
    expect((await remote.projectStatus('project-a')).mounts[0].lastSuccessAt).toBeUndefined();
    failure = 'ECONNREFUSED'; await remote.checkConnections('project-a');
    expect(remote.projectOffline('project-a')).toBe(true);
    failure = 'EBUSY'; await checkBusy();
    failure = undefined; await remote.checkConnections('project-a');
    expect(await remote.projectStatus('project-a')).toMatchObject({status: 'online', mounts: [{lastSuccessAt: expect.any(Number)}]});
    expect((await remote.projectStatus('project-a')).mounts[0].failure).toBeUndefined();
    const events = (await journal.query({projectId: 'project-a'})).events;
    expect(events).toContainEqual(expect.objectContaining({stage: 'root-probe', code: 'EBUSY', reason: 'busy', operationId: expect.any(String), durationMs: expect.any(Number)}));
    expect(JSON.stringify(events)).not.toContain('PRIVATE_REMOTE_BODY');
});

it('reports timeout as offline while an explicit cancellation restores the previous state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    const {remote, journal} = await remoteFixture(options => new Promise((_resolve, reject) => {if (options?.signal?.aborted) reject(options.signal.reason); else options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), {once: true});}));
    const controller = new AbortController();
    const checking = remote.checkConnections('project-a', {signal: controller.signal}); controller.abort(); await checking;
    expect((await remote.projectStatus('project-a')).status).toBe('unknown'); expect((await journal.query({module: 'cells'})).events).toHaveLength(0);
    await remote.checkConnections('project-a', {timeoutMs: 10});
    expect(await remote.projectStatus('project-a')).toMatchObject({status: 'offline', mounts: [{failure: {code: 'ETIMEDOUT', reason: 'timeout'}}]});
});

it('keeps explicit authorization denial offline even when the file interface is reachable or busy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = vi.fn(async () => {throw new FSError('EBUSY', 'PRIVATE_BODY');});
    const {remote} = await remoteFixture(open, () => ({roots: async () => ({roots: []}), close: async () => {}}) as never);
    await remote.checkConnections('project-a');
    expect(open).not.toHaveBeenCalled(); expect(remote.projectOffline('project-a')).toBe(true);
    expect(await remote.projectStatus('project-a')).toMatchObject({status: 'offline', problem: 'authorization-denied',
        mounts: [{authorization: {exportAccess: 'none'}, failure: {code: 'EACCES'}}]});
});


it('shows partial availability for native discovery and keeps failures isolated by profile until recovery', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    const profiles = vi.fn().mockRejectedValueOnce(new FSError('EIO', 'PRIVATE_NATIVE_FAILURE')).mockResolvedValue({profiles: []});
    const list = vi.fn().mockRejectedValueOnce(new FSError('EACCES', 'PRIVATE_A')).mockRejectedValueOnce(new FSError('EACCES', 'PRIVATE_B')).mockResolvedValue({sessions: []});
    const api = {read: async () => ({id: 'server-a', alias: 'docs', path: '', mounts: []}), close: async () => {},
        harness: () => ({profiles, list, close: async () => {}})};
    const {remote, journal} = await remoteFixture(() => createFileSystemSource({backend: new MemoryBackend(), viewId: 'remote', access: 'ro'}), () => api as never);
    await remote.checkConnections('project-a');
    const client = await remote.projectHarness('project-a');
    await expect(client.profiles()).rejects.toMatchObject({code: 'EIO'});
    expect(await remote.projectStatus('project-a')).toMatchObject({status: 'degraded', issue: {stage: 'harness.profiles', code: 'EIO'}});
    await client.profiles(); expect((await remote.projectStatus('project-a')).status).toBe('online');
    await expect(client.list('a')).rejects.toMatchObject({code: 'EACCES'});
    await expect(client.list('b')).rejects.toMatchObject({code: 'EACCES'});
    await client.list('a');
    expect(await remote.projectStatus('project-a')).toMatchObject({status: 'degraded', issues: [{profileId: 'b'}]});
    await client.list('b'); expect((await remote.projectStatus('project-a')).status).toBe('online');
    expect((await journal.query({projectId: 'project-a'})).events.some(event => event.operation === 'remote.operation.recovered')).toBe(true);
    await client.close();
});


it('publishes an unchanged harness failure only once so navigation cannot trigger a refresh loop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    const {remote} = await remoteFixture(() => createFileSystemSource({backend: new MemoryBackend(), viewId: 'remote', access: 'ro'}));
    const changed = vi.fn(), stop = remote.onChange(changed);
    try {
        await expect(remote.projectHarness('project-a')).rejects.toMatchObject({code: 'ECAPABILITY'});
        await expect(remote.projectHarness('project-a')).rejects.toMatchObject({code: 'ECAPABILITY'});
        expect(changed).toHaveBeenCalledOnce();
        expect(await remote.projectStatus('project-a')).toMatchObject({status: 'degraded', issue: {code: 'ECAPABILITY'}});
    } finally {stop();}
});
