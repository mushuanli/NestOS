import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {Kernel, type DurableTaskProgram} from '@itookit/durable-kernel';
import {CommandBus} from '../src/core/command-bus';
import {SessionRepository} from '../src/persistence/session-repository';
import {sessionDirectoryStorage, SessionDirectoryStorageResolver} from '../src/persistence/session-directory-storage';
import {InstructionQueueStore} from '../src/persistence/instruction-queue-store';
import {IndependentCallService} from '../src/session/independent-calls';
import {ContentTransferService} from '../src/session/content-transfers';
import {submissionInstruction} from '../src/session/submission-input';
import {instructionDigest, prepareInstruction} from '../src/session/instruction-queue-rules';
import type {IndependentCallInput} from '../src/contracts/independent-calls';
import type {SubmissionRequest} from '../src/contracts/submission';

let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, repository: SessionRepository;
let service: IndependentCallService, transfers: ContentTransferService, parent: string;
let submit: ReturnType<typeof vi.fn<[SubmissionRequest], Promise<string>>>;
const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
const input = (): IndependentCallInput => ({title: 'PRIVATE TITLE', request: {expectedSessionId: parent, expectedBranch: 'main',
    target: {kind: 'agent', id: 'agent'}, expectedTarget: {kind: 'agent', id: 'agent', version: 'v1', digest: 'digest'},
    source: {kind: 'composer', text: 'PRIVATE INPUT', attachments: [], values: {}},
    submission: {id: 'managed-call', source: {kind: 'conversation', ownerId: parent, id: 'managed-call'}}}});

beforeEach(async () => {
    vi.resetAllMocks(); ({manager} = await createVFS({rootBackend: new MemoryBackend()}));
    const fs = await manager.openFileSystem('/'); kernel = new Kernel({catalog: {fs}, onDiagnostic: () => {}});
    kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs)); await kernel.initialize();
    repository = new SessionRepository(fs, async id => {await kernel.createSession({id, storage: sessionDirectoryStorage(id)});});
    await repository.init(); parent = await repository.createSession('Parent');
    transfers = new ContentTransferService({kernel, repository, commands: new CommandBus()});
    submit = vi.fn(accept); service = createService();
});
afterEach(async () => {
    vi.restoreAllMocks(); kernel.dispose(); await kernel.waitIdle(); await repository.dispose(); await manager.dispose();
});
function createService() {return new IndependentCallService({kernel, repository, transfers, submit, hostPorts: {logger}});}
async function accept(request: SubmissionRequest): Promise<string> {
    const store = new InstructionQueueStore(kernel), queue = await store.read(request.expectedSessionId!);
    const item = prepareInstruction(submissionInstruction(request), request.expectedSessionId!, 'main');
    await store.write({...queue, accepted: [{id: item.id, digest: await instructionDigest(item)}]});
    return item.id;
}
function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};
}
it('holds submission after preparation and reuses the same child when its owner resumes', async () => {
    const guard = vi.fn(async (_request: SubmissionRequest) => false), held = await service.submitManaged(input(), guard);
    expect(held).toMatchObject({status: 'held', callerSessionId: parent, operationId: 'managed-call'});
    expect(submit).not.toHaveBeenCalled(); expect(guard).toHaveBeenCalledOnce();
    expect(guard.mock.calls[0][0]).toMatchObject({expectedSessionId: held.executionSessionId,
        submission: {id: 'managed-call', source: {kind: 'independent-call', ownerId: parent}}});
    expect(await service.inspect(input())).toMatchObject({status: 'unknown', executionSessionId: held.executionSessionId});
    guard.mockResolvedValueOnce(true);
    expect(await service.submitManaged(input(), guard)).toMatchObject({status: 'accepted', executionSessionId: held.executionSessionId});
    expect(await repository.list()).toHaveLength(2); expect(submit).toHaveBeenCalledOnce();
});
it('lets only a literal guard confirmation forward the original request', async () => {
    for (const result of [undefined, null, 1, 'true', {}]) {
        expect(await service.submitManaged(input(), async () => result as never)).toMatchObject({status: 'held'});
    }
    await expect(service.submitManaged(input(), undefined as never)).rejects.toHaveProperty('code', 'CALL_ADMISSION_GUARD_REQUIRED');
    expect(submit).not.toHaveBeenCalled();
});
it('keeps the frozen request even if the caller or admission observer mutates its copy', async () => {
    const request = input(), gate = deferred(), arrived = deferred();
    const pending = service.submitManaged(request, async frozen => {
        arrived.resolve(); await gate.promise; frozen.target.id = 'foreign'; frozen.expectedSessionId = 'foreign';
        return true;
    });
    request.title = 'Changed'; request.request.target.id = 'Changed'; await arrived.promise; gate.resolve();
    expect(await pending).toMatchObject({status: 'accepted'});
    expect(submit.mock.calls[0][0]).toMatchObject({target: {id: 'agent'}, source: {text: 'PRIVATE INPUT'}});
    expect(submit.mock.calls[0][0].expectedSessionId).not.toBe('foreign');
    expect((await repository.list()).find(entry => entry.id !== parent)?.title).toBe('PRIVATE TITLE');
});
it('reads accepted admission after reopening without asking the guard or submitting again', async () => {
    const first = await service.submitManaged(input(), async () => true), guard = vi.fn(async () => false);
    const reopened = createService();
    expect(await reopened.submitManaged(input(), guard)).toEqual(first);
    expect(guard).not.toHaveBeenCalled(); expect(submit).toHaveBeenCalledOnce();
});
it('rechecks admission when the guard holds while the original request is accepted elsewhere', async () => {
    const result = await service.submitManaged(input(), async request => {await accept(request); return false;});
    expect(result).toMatchObject({status: 'accepted', evidence: 'queue'}); expect(submit).not.toHaveBeenCalled();
});
it('preserves an accepted receipt after its submit response is lost', async () => {
    submit.mockImplementationOnce(async request => {await accept(request); throw new Error('PRIVATE LOST REPLY');});
    expect(await service.submitManaged(input(), async () => true)).toMatchObject({status: 'accepted'});
    expect(submit).toHaveBeenCalledOnce();
});
it('does not call an uncertain submission not-started when a later owner is held', async () => {
    submit.mockRejectedValueOnce(Object.assign(new Error('PRIVATE LOST REPLY'), {code: 'ETIMEDOUT'}));
    await expect(service.submitManaged(input(), async () => true)).rejects.toHaveProperty('code', 'ETIMEDOUT');
    expect(await createService().submitManaged(input(), async () => false)).toMatchObject({status: 'held'});
    expect(await service.inspect(input())).toMatchObject({status: 'unknown'}); expect(submit).toHaveBeenCalledOnce();
});
it('keeps guard failures separate from dispatch and logs no request content', async () => {
    const error = Object.assign(new Error('PRIVATE JOURNAL STORAGE'), {code: 'JOURNAL_WRITE_FAILED'});
    await expect(service.submitManaged(input(), async () => {throw error;})).rejects.toBe(error);
    expect(submit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Independent call observation', expect.objectContaining({
        stage: 'admission-guard', outcome: 'failure', code: 'JOURNAL_WRITE_FAILED', operationId: 'managed-call'}));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE');
});
it('finishes attachment preparation before asking its owner to admit dispatch', async () => {
    await repository.writeAttachment(parent, 'document.txt', new TextEncoder().encode('PRIVATE FILE').buffer);
    const request = input(); request.request.attachments = [{name: 'document.txt', type: 'text/plain'}];
    const write = repository.writeAttachment.bind(repository), guard = vi.fn(async () => true);
    vi.spyOn(repository, 'writeAttachment').mockImplementation(async (id, ...args) => {
        if (id !== parent) throw Object.assign(new Error('PRIVATE CHILD STORAGE'), {code: 'EACCES'});
        return write(id, ...args);
    });
    await expect(service.submitManaged(request, guard)).rejects.toHaveProperty('code', 'ATTACHMENT_WRITE_UNCONFIRMED');
    expect(guard).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Independent call observation', expect.objectContaining({stage: 'attachments'}));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE');
});
it('never converts a receipt read failure into a held or successful result', async () => {
    const error = Object.assign(new Error('PRIVATE READ'), {code: 'EACCES'});
    await expect(service.submitManaged(input(), async () => {
        vi.spyOn(kernel, 'inspectSession').mockRejectedValue(error); return false;
    })).rejects.toBe(error);
    expect(submit).not.toHaveBeenCalled();
});
it('preserves both durable admission and the original rejection when diagnostics throw', async () => {
    logger.info.mockImplementation(() => {throw new Error('PRIVATE LOGGER');});
    logger.warn.mockImplementation(() => {throw new Error('PRIVATE LOGGER');});
    expect(await service.submitManaged(input(), async () => true)).toMatchObject({status: 'accepted'});
    const error = Object.assign(new Error('PRIVATE GUARD'), {code: 'JOURNAL_WRITE_FAILED'});
    const request = input(); request.request.submission!.id = 'second';
    await expect(service.submitManaged(request, async () => {throw error;})).rejects.toBe(error);
});
it('does not accept a caller-supplied guard through the public command', async () => {
    const commands = new CommandBus(); service.register(commands);
    await expect(commands.execute('session.call.submit', {...input(), guard: true})).rejects.toHaveProperty('code', 'CALL_INPUT_INVALID');
    expect(submit).not.toHaveBeenCalled();
});

const caller: DurableTaskProgram<null, null> = {manifest: {kind: 'managed-caller-fixture', version: '1'},
    init: () => ({state: null, actions: [{type: 'effect', effect: {id: 'call', kind: 'managed-call-fixture', version: '1',
        request: null, idempotencyKey: 'call'}}], next: {type: 'wait', on: {type: 'effect', id: 'call'}}}),
    reduce: state => ({state, next: {type: 'complete', output: null}})};
it.each(['pause', 'cancel'] as const)('fences a real parent Effect after %s while child preparation is in flight', async control => {
    const preparing = deferred(), prepared = deferred(), observed = deferred<unknown>();
    const original = transfers.createChild.bind(transfers);
    vi.spyOn(transfers, 'createChild').mockImplementation(async request => {
        const child = await original(request); preparing.resolve(); await prepared.promise; return child;
    });
    kernel.registerProgram(caller);
    kernel.registerEffect({kind: 'managed-call-fixture', version: '1', execute: async (_request, context) => {
        try {
            const result = await service.submitManaged(input(), async request => !!await context.sessionState!.setIfRunning!(
                'managed-test-dispatch', {sessionId: request.expectedSessionId!}, null));
            observed.resolve(result); return null;
        } catch (error) {observed.resolve(error); throw error;}
    }, cancel: async () => {}});
    const handle = await (await kernel.openSession(parent)).submit({program: caller.manifest, input: null});
    await preparing.promise;
    try {
        if (control === 'pause') await handle.pause({requestId: 'pause-parent', expectedEpoch: 0});
        else await handle.cancel('Cancelled owner');
    } finally {prepared.resolve();}
    await observed.promise;
    expect(submit).not.toHaveBeenCalled();
    expect(await (await kernel.inspectSession(parent)).getShared('managed-test-dispatch')).toBeUndefined();
    expect(await service.inspect(input())).toMatchObject({status: 'unknown'});
});
it('retains cleanup responsibility when cancellation follows the durable dispatch intent', async () => {
    const admitted = deferred(), dispatch = deferred(), observed = deferred<unknown>(); kernel.registerProgram(caller);
    kernel.registerEffect({kind: 'managed-call-fixture', version: '1', execute: async (_request, context) => {
        const result = await service.submitManaged(input(), async request => {
            const saved = await context.sessionState!.setIfRunning!('managed-test-dispatch', {sessionId: request.expectedSessionId!}, null);
            admitted.resolve(); await dispatch.promise; return !!saved;
        });
        observed.resolve(result); return null;
    }, cancel: async () => {throw Object.assign(new Error('Cleanup unconfirmed'), {code: 'CALL_CLEANUP_UNCONFIRMED'});}});
    const handle = await (await kernel.openSession(parent)).submit({program: caller.manifest, input: null}); await admitted.promise;
    try {
        const cancellation = await Promise.allSettled([handle.cancel('Cancelled owner')]);
        expect(cancellation[0].status).toBe('rejected');
        expect((await handle.status()).task.effects.call.cleanupPending).toBe(true);
    } finally {dispatch.resolve();}
    expect(await observed.promise).toMatchObject({status: 'accepted'}); expect(submit).toHaveBeenCalledOnce();
    expect(await (await kernel.inspectSession(parent)).getShared('managed-test-dispatch')).toBeDefined();
    expect((await handle.status()).task.effects.call.cleanupPending).toBe(true);
});
