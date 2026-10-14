import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { Kernel } from '@itookit/durable-kernel';
import { SessionDirectoryStorageResolver, SessionRepository, sessionDirectoryStorage } from '@itookit/llm-session';
import { SessionLifecycleService } from '../src/session/session-lifecycle';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; });

async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    const repository = new SessionRepository(fs); await repository.init(); cleanup.push(() => repository.dispose());
    const startKernel = async () => {
        const kernel = new Kernel({ catalog: { fs, rootPath: '/var/lib/kernel' } });
        kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs));
        await kernel.initialize();
        cleanup.push(async () => { kernel.dispose(); await kernel.waitIdle(); });
        return kernel;
    };
    const kernel = await startKernel();
    return {
        fs, repository, kernel,
        lifecycle: new SessionLifecycleService({ repository, kernel }),
        boundedLifecycle: new SessionLifecycleService({ repository, kernel }, { closeTimeoutMs: 80, closePollMs: 10 }),
        async restart() {
            kernel.dispose(); await kernel.waitIdle();
            const next = await startKernel();
            return { kernel: next, lifecycle: new SessionLifecycleService({ repository, kernel: next }) };
        },
    };
}


/** A running Task whose external Effect confirms its stop only when `release()` is called. */
async function withInFlightEffect(f: Awaited<ReturnType<typeof setup>>, id: string) {
    let begun!: () => void, stopped!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { begun = resolve; });
    const stopping = new Promise<void>(resolve => { stopped = resolve; });
    let inFlight: Promise<unknown> | undefined;
    f.kernel.registerEffect({
        kind: 'slow', version: '1',
        execute(_request, context) {
            begun();
            const execution = new Promise<never>((_, reject) => {
                context.abortSignal.addEventListener('abort', () => { stopped(); release = () => reject(new Error('aborted')); }, { once: true });
            });
            inFlight = execution.catch(() => undefined);
            return execution;
        },
        async cancel() { await inFlight; },
    });
    f.kernel.registerProgram({
        manifest: { kind: 'test.slow-effect', version: '1' },
        init: () => ({ state: null, actions: [{ type: 'effect', effect: { id: 'e', kind: 'slow', version: '1', request: null, idempotencyKey: 'slow' } }],
            next: { type: 'wait', on: { type: 'effect', id: 'e' } } }),
        reduce() { throw new Error('unexpected event'); },
    } as never);
    const session = await f.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });
    const task = await session.submit({ program: { kind: 'test.slow-effect', version: '1' }, input: null });
    await started;
    return { task, stopping, release: () => release() };
}

it('keeps every record when the Kernel layout still blocks the physical delete', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Guarded');
    await f.repository.writeDocument(id, 'round-r1.json', JSON.stringify({ id: 'r1', input: [], output: [] }));
    await f.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });

    await expect(f.repository.deleteSession(id)).rejects.toMatchObject({ code: 'EBUSY' });
    expect((await f.repository.getManifest(id)).id).toBe(id);
    expect(await f.repository.readDocument(id, 'round-r1.json')).toContain('r1');
});

it('deletes through the lifecycle service: close, remove Kernel state, then records', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Disposable');
    await f.repository.writeDocument(id, 'round-r1.json', JSON.stringify({ id: 'r1', input: [], output: [] }));
    await f.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });

    await f.lifecycle.deleteSession(id);
    await expect(f.repository.getManifest(id)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.fs.driver.exists(`/var/lib/sessions/${id}`)).toBe(false);
    const ids: string[] = []; for await (const record of f.kernel.listSessions()) ids.push(record.id);
    expect(ids).not.toContain(id);
});

it('deletes a Session that never reached the Kernel', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Never ran');
    await f.lifecycle.deleteSession(id);
    await expect(f.repository.getManifest(id)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('resumes an interrupted deletion after a Kernel restart', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Interrupted');
    await f.repository.writeDocument(id, 'round-r1.json', JSON.stringify({ id: 'r1', input: [], output: [] }));
    const session = await f.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });
    await session.setShared('stale', 'value');
    await f.kernel.closeSession(id, true);
    // Interrupted removal: Kernel storage gone, records and catalog entry remain.
    await f.fs.driver.updateMetadata(`/var/lib/sessions/${id}/kernel`, { vfsFixedLayout: false });
    await f.fs.driver.delete([`/var/lib/sessions/${id}/kernel`], { recursive: true });

    const restarted = await f.restart();
    await restarted.lifecycle.deleteSession(id);

    await expect(f.repository.getManifest(id)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.fs.driver.exists(`/var/lib/sessions/${id}`)).toBe(false);
    const ids: string[] = []; for await (const record of restarted.kernel.listSessions()) ids.push(record.id);
    expect(ids).not.toContain(id);
});

it('cancels a running Task while deleting and removes storage, catalog and records', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Running');
    const { task, stopping, release } = await withInFlightEffect(f, id);

    // The Task record is removed with the Session, so observe its terminal state while closing.
    let statusDuringClose: string | undefined;
    const close = f.kernel.closeSession.bind(f.kernel);
    vi.spyOn(f.kernel, 'closeSession').mockImplementation(async (sessionId: string, cancelRunning?: boolean) => {
        const result = await close(sessionId, cancelRunning);
        statusDuringClose = (await task.status()).task.status;
        return result;
    });
    const deleting = f.lifecycle.deleteSession(id);
    await stopping; // the Kernel has signalled the stop; the adapter now confirms it
    release();
    await deleting;

    expect(statusDuringClose).toBe('cancelled');
    await expect(f.repository.getManifest(id)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.fs.driver.exists(`/var/lib/sessions/${id}`)).toBe(false);
    const ids: string[] = []; for await (const record of f.kernel.listSessions()) ids.push(record.id);
    expect(ids).not.toContain(id);
});

it('closes a running Session and keeps every record', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Closable');
    await f.repository.writeDocument(id, 'round-r1.json', JSON.stringify({ id: 'r1', input: [], output: [] }));
    const { task, stopping, release } = await withInFlightEffect(f, id);

    const closing = f.lifecycle.closeSession(id);
    await stopping; // the Kernel has signalled the stop; the adapter now confirms it
    release();
    await closing;

    expect((await task.status()).task.status).toBe('cancelled');
    expect((await f.kernel.sessionStat(id)).phase).toBe('closed');
    // Closing is not deleting: manifest, documents and Kernel storage all survive.
    expect((await f.repository.getManifest(id)).id).toBe(id);
    expect(await f.repository.readDocument(id, 'round-r1.json')).toContain('r1');
    expect(await f.fs.driver.exists(`/var/lib/sessions/${id}`)).toBe(true);
    const ids: string[] = []; for await (const record of f.kernel.listSessions()) ids.push(record.id);
    expect(ids).toContain(id);
});

it('bounds a close that never confirms and reports that records were kept', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Stuck close');
    const { stopping, release } = await withInFlightEffect(f, id);

    await expect(f.boundedLifecycle.closeSession(id))
        .rejects.toMatchObject({ code: 'EBUSY', message: expect.stringContaining('records were kept') });
    expect((await f.repository.getManifest(id)).id).toBe(id);
    expect(await f.fs.driver.exists(`/var/lib/sessions/${id}`)).toBe(true);

    // Once the device confirms, the close succeeds and still keeps the records.
    await stopping; release();
    await f.lifecycle.closeSession(id);
    expect((await f.kernel.sessionStat(id)).phase).toBe('closed');
    expect((await f.repository.getManifest(id)).id).toBe(id);
});

it('reports a bounded failure and deletes nothing while the in-flight Effect never confirms', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Stuck');
    const { task, stopping, release } = await withInFlightEffect(f, id);

    // The bridge suite stands in for a process that ignores the stop request. Without a
    // bound on the close call itself the delete would hang forever instead of reporting.
    await expect(f.boundedLifecycle.deleteSession(id))
        .rejects.toMatchObject({ code: 'EBUSY', message: expect.stringContaining('nothing was deleted') });
    expect((await f.repository.getManifest(id)).id).toBe(id);
    expect(await f.fs.driver.exists(`/var/lib/sessions/${id}`)).toBe(true);
    const ids: string[] = []; for await (const record of f.kernel.listSessions()) ids.push(record.id);
    expect(ids).toContain(id);
    expect((await task.status()).task.status).not.toBe('succeeded');

    // The failed attempt deleted nothing, so once the device confirms, a retry succeeds.
    await stopping; release();
    await f.lifecycle.deleteSession(id);
    await expect(f.repository.getManifest(id)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bounds a stalled status read and never deletes on its late completion', async () => {
    const f = await setup();
    const id = await f.repository.createSession('Stalled status');
    await f.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const stat = f.kernel.sessionStat.bind(f.kernel);
    vi.spyOn(f.kernel, 'sessionStat').mockImplementationOnce(async sessionId => {
        await blocked;
        return stat(sessionId);
    });
    const remove = vi.spyOn(f.kernel, 'removeSession');
    try {
        await expect(f.boundedLifecycle.deleteSession(id)).rejects.toMatchObject({ code: 'EBUSY' });
        expect(remove).not.toHaveBeenCalled();
        release();
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(remove).not.toHaveBeenCalled();
        expect((await f.repository.getManifest(id)).id).toBe(id);
        await f.lifecycle.deleteSession(id);
        await expect(f.repository.getManifest(id)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release(); }
});
