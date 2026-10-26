import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {Kernel} from '@itookit/durable-kernel';
import {CommandBus} from '../src/core/command-bus';
import {SessionRepository} from '../src/persistence/session-repository';
import {sessionDirectoryStorage, SessionDirectoryStorageResolver} from '../src/persistence/session-directory-storage';
import {ContentTransferService} from '../src/session/content-transfers';
import type {CreateChildInput} from '../src/contracts/content-transfer';
let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, repository: SessionRepository;
let service: ContentTransferService, parent: string, commands: CommandBus;
const query = (input: CreateChildInput) => commands.execute('session.content.child-receipt', input);
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()}));
    const fs = await manager.openFileSystem('/'); kernel = new Kernel({catalog: {fs}});
    kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs)); await kernel.initialize();
    repository = new SessionRepository(fs, async id => {await kernel.createSession({id, storage: sessionDirectoryStorage(id)});});
    await repository.init(); parent = await repository.createSession('Parent'); commands = new CommandBus();
    service = new ContentTransferService({kernel, repository, commands}); service.register();
});
afterEach(async () => {
    vi.restoreAllMocks(); kernel.dispose(); await kernel.waitIdle(); await repository.dispose(); await manager.dispose();
});
const input = (): CreateChildInput => ({sessionId: parent, requestId: 'original', title: 'Child'});
it('reads a frozen creation receipt after reopening without invoking a write or execution gate', async () => {
    const request = input(), child = await service.createChild(request);
    const canWrite = vi.fn(async () => false), prepareExecution = vi.fn(); commands = new CommandBus();
    new ContentTransferService({kernel, repository, commands, canWrite, prepareExecution}).register();
    const open = vi.spyOn(kernel, 'openSession'), ensure = vi.spyOn(repository, 'ensureSession');
    expect(await query(request)).toEqual({parentSessionId: parent, requestId: 'original', status: 'created', sessionId: child.sessionId});
    expect(canWrite).not.toHaveBeenCalled(); expect(prepareExecution).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled();
});
it('reports unknown for an uninitialized parent Kernel without creating its storage', async () => {
    const raw = new SessionRepository(await manager.openFileSystem('/')); await raw.init();
    try {
        const id = await raw.createSession('Metadata only'), open = vi.spyOn(kernel, 'openSession'), create = vi.spyOn(kernel, 'createSession');
        expect(await query({...input(), sessionId: id})).toEqual({parentSessionId: id, requestId: 'original', status: 'unknown'});
        expect(open).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    } finally {await raw.dispose();}
});
it('distinguishes a reserved identity from completed child preparation', async () => {
    const prepareExecution = vi.fn(async () => {throw Object.assign(new Error('Private lease failure'), {code: 'LEASE_REFUSED'});});
    const partial = new ContentTransferService({kernel, repository, commands, prepareExecution});
    await expect(partial.createChild(input())).rejects.toMatchObject({code: 'LEASE_REFUSED'});
    const receipt = await query(input()) as {status: string; sessionId: string}; expect(receipt.status).toBe('reserved');
    const complete = await service.createChild(input()); expect(complete.sessionId).toBe(receipt.sessionId);
    expect(await query(input())).toMatchObject({status: 'created', sessionId: receipt.sessionId});
});
it('keeps the creation fact after deletion and never recreates a completed child on the old request', async () => {
    const request = input(), child = await service.createChild(request);
    await kernel.closeSession(child.sessionId, true); await kernel.removeSession(child.sessionId, {force: true});
    await repository.deleteSession(child.sessionId);
    const ensure = vi.spyOn(repository, 'ensureSession');
    expect(await service.createChild(request)).toEqual(child); expect(ensure).not.toHaveBeenCalled();
    expect(await query(request)).toMatchObject({status: 'created', sessionId: child.sessionId});
    await expect(repository.getManifest(child.sessionId)).rejects.toMatchObject({code: 'ENOENT'});
});
it('checks all frozen arguments and isolates another parent with the same request ID', async () => {
    await service.createChild(input());
    await expect(query({...input(), title: 'Changed'})).rejects.toMatchObject({code: 'CONTENT_CHILD_REQUEST_CONFLICT'});
    const other = await repository.createSession('Other');
    expect(await query({...input(), sessionId: other})).toEqual({parentSessionId: other, requestId: 'original', status: 'unknown'});
});
it('converges concurrent completion writes onto one original creation receipt', async () => {
    const second = new ContentTransferService({kernel, repository, commands});
    const results = await Promise.all([service.createChild(input()), second.createChild(input())]);
    expect(results[0]).toEqual(results[1]); expect(await repository.list()).toHaveLength(2);
    expect(await query(input())).toMatchObject({status: 'created', sessionId: results[0].sessionId});
});
it('does not downgrade storage failures to an unknown request or expose malformed reservation records', async () => {
    const shared = await kernel.openSession(parent);
    await shared.setShared('content.child.original', {input: input(), sessionId: '../foreign', created: true});
    await expect(query(input())).rejects.toMatchObject({code: 'CONTENT_CHILD_RECORD_INVALID'});
    vi.spyOn(kernel, 'inspectSession').mockRejectedValue(Object.assign(new Error('PRIVATE STORAGE DETAILS'), {code: 'EACCES'}));
    await expect(query(input())).rejects.toMatchObject({code: 'EACCES'});
});
it('rejects caller-supplied completion facts before looking up a request', async () => {
    const inspect = vi.spyOn(kernel, 'inspectSession');
    await expect(query({...input(), created: true} as CreateChildInput)).rejects.toMatchObject({code: 'CONTENT_CHILD_ARGUMENTS_INVALID'});
    expect(inspect).not.toHaveBeenCalled();
});
it.each([false, true])('retains one child identity when completion persistence fails (committed=%s)', async committed => {
    const open = kernel.openSession.bind(kernel); let fail = true;
    vi.spyOn(kernel, 'openSession').mockImplementation(async (...args) => {
        const handle = await open(...args); if (args[0] !== parent) return handle;
        return new Proxy(handle, {get(target, key) {
            if (key !== 'setShared') {const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;}
            return async (...values: Parameters<typeof handle.setShared>) => {
                if ((values[1] as {created?: boolean}).created && fail) {
                    if (committed) await target.setShared(...values);
                    throw new Error('PRIVATE COMPLETION STORAGE');
                }
                return target.setShared(...values);
            };
        }});
    });
    if (committed) await service.createChild(input());
    else await expect(service.createChild(input())).rejects.toThrow('PRIVATE COMPLETION STORAGE');
    const first = await query(input()) as {sessionId: string; status: string};
    expect(first.status).toBe(committed ? 'created' : 'reserved'); fail = false;
    expect((await service.createChild(input())).sessionId).toBe(first.sessionId);
    expect(await repository.list()).toHaveLength(2);
    expect(await query(input())).toMatchObject({sessionId: first.sessionId, status: 'created'});
});
it('isolates receipt diagnostics from durable facts and original read failures', async () => {
    const child = await service.createChild(input()); commands = new CommandBus();
    const logger = {info: () => {throw new Error('PRIVATE LOG');}, error: () => {throw new Error('PRIVATE LOG');}};
    new ContentTransferService({kernel, repository, commands, hostPorts: {logger: logger as never}}).register();
    expect(await query(input())).toMatchObject({status: 'created', sessionId: child.sessionId});
    vi.spyOn(kernel, 'inspectSession').mockRejectedValue(Object.assign(new Error('PRIVATE READ'), {code: 'EACCES'}));
    await expect(query(input())).rejects.toMatchObject({code: 'EACCES'});
});
it('reports metadata and execution failures separately without logging material or title', async () => {
    const logger = {info: vi.fn(), error: vi.fn()}, request = {...input(), title: 'PRIVATE TITLE'};
    const failing = new ContentTransferService({kernel, repository, commands, hostPorts: {logger: logger as never},
        prepareExecution: async () => {throw Object.assign(new Error('PRIVATE LEASE'), {code: 'LEASE_REFUSED'});}});
    vi.spyOn(repository, 'ensureSession').mockRejectedValueOnce(Object.assign(new Error('PRIVATE STORAGE'), {code: 'EACCES'}));
    await expect(failing.createChild(request)).rejects.toMatchObject({code: 'EACCES'});
    expect(logger.error).toHaveBeenLastCalledWith('Child creation', expect.objectContaining({stage: 'metadata', code: 'EACCES', operationId: 'original'}));
    await expect(failing.createChild(request)).rejects.toMatchObject({code: 'LEASE_REFUSED'});
    expect(logger.error).toHaveBeenLastCalledWith('Child creation', expect.objectContaining({stage: 'execution', code: 'LEASE_REFUSED'}));
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/PRIVATE/);
});
