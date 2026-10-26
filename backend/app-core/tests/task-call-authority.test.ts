import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend, type IDeviceDriver} from '@itookit/vfs-core';
import {taskStat, type Kernel, type TaskCallPlan} from '@itookit/durable-kernel';
import {getLogger} from '@itookit/common';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {createSessionTaskCallAuthority} from '../src/session/task-call-authority';
import {createKernelRuntime} from '../src/runtime/create-kernel-runtime';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {SessionLeaseStore} from '../src/kernel/session-lease';

const releases: Array<() => Promise<unknown>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of releases.splice(0).reverse()) await close();});
const startable = {isDeleting: async () => false, isMoving: async () => false};
const owner = {sessionId: 'source', taskId: 'task', effectId: 'call'};
const plan = (targetSessionId = 'target'): TaskCallPlan => ({targetSessionId, maxDepth: 3,
    task: {program: {kind: 'echo', version: '1'}, input: {answer: 42}}});
const echo = {manifest: {kind: 'echo', version: '1'}, init: (input: unknown) => ({state: null,
    next: {type: 'complete' as const, output: input}}), reduce: () => {throw Error('Unexpected echo event');}};
async function submit(kernel: Kernel, sessionId: string, input: TaskCallPlan) {
    const call = await kernel.submit(sessionId, {program: {kind: 'kernel.call', version: '1'}, input, deferStart: true});
    await kernel.bindTaskCall({sessionId, taskId: call.id}, input); return call;
}
const awaitingInput = {manifest: {kind: 'await-input', version: '1'}, init: () => ({state: null,
    next: {type: 'wait' as const, on: {type: 'signal' as const, id: 'continue'}}}),
    reduce: () => ({state: null, next: {type: 'complete' as const, output: {done: true}}})};
const programs = {configure: (runtime: Awaited<ReturnType<typeof createKernelRuntime>>) => {runtime.kernel.registerProgram(echo); runtime.kernel.registerProgram(awaitingInput);}};
async function application() {
    const backend = new MemoryBackend();
    const runtime = await createApplicationRuntime({backend, ownerKind: 'tauri', digitalTwinAutoStart: false, kernelPlatform: programs});
    releases.push(() => runtime.dispose());
    const source = await runtime.sessionRepository.createSession('Caller'), target = await runtime.sessionRepository.createSession('Worker');
    for (const sessionId of [target, source]) await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    expect(await runtime.prepareSession!(source)).toBe(true); expect(await runtime.prepareSession!(target)).toBe(true);
    return {runtime, source, target, kernel: runtime.kernel.kernel, backend};
}

async function headless(options: Partial<Parameters<typeof createKernelRuntime>[0]>) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/'); releases.push(() => manager.dispose());
    const runtime = await createKernelRuntime({systemFS: fs, recover: false, contextGc: false, llmDriver: {} as IDeviceDriver,
        storageResolver: {kind: 'test', resolve: async ref => ({fs, rootPath: String(ref.locator)})}, ...options});
    releases.push(async () => {runtime.kernel.dispose(); await runtime.kernel.waitIdle(); await runtime.dispose();});
    for (const id of ['source', 'target']) await runtime.kernel.createSession({id, storage: {kind: 'test', locator: `/${id}`}});
    return runtime;
}

it('checks both prepared Session owners and distinguishes deletion from move barriers', async () => {
    const assertOwned = vi.fn(async (_id: string) => {}), isDeleting = vi.fn(async (id: string) => id === 'target');
    const isMoving = vi.fn(async () => false), authorize = createSessionTaskCallAuthority({assertOwned, isDeleting, isMoving});
    await expect(authorize(plan(), owner, 'execute')).rejects.toHaveProperty('code', 'TASK_CALL_SESSION_DELETING');
    expect(assertOwned.mock.calls).toEqual([['source'], ['target']]); expect(isDeleting.mock.calls).toEqual([['source'], ['target']]);
    isDeleting.mockImplementation(async () => false); isMoving.mockImplementation(async () => true); assertOwned.mockClear();
    await expect(authorize(plan(), owner, 'execute')).rejects.toHaveProperty('code', 'TASK_CALL_SESSION_MOVING');
    expect(assertOwned.mock.calls).toEqual([['source']]);
});
it('permits cleanup of unavailable Sessions only while both original write leases remain held', async () => {
    const assertOwned = vi.fn(async (_id: string) => {}), isDeleting = vi.fn(async () => true), isMoving = vi.fn(async () => true);
    const authorize = createSessionTaskCallAuthority({assertOwned, isDeleting, isMoving});
    await authorize(plan(), owner, 'cleanup');
    expect(assertOwned.mock.calls).toEqual([['source'], ['target']]); expect(isDeleting).not.toHaveBeenCalled(); expect(isMoving).not.toHaveBeenCalled();
    const lost = Object.assign(new Error('Private lease failure'), {code: 'EACCES'});
    assertOwned.mockImplementation(async id => {if (id === 'target') throw lost;});
    await expect(authorize(plan(), owner, 'cleanup')).rejects.toBe(lost);
});
it('checks a same-Session call once and keeps diagnostic failures separate from authorization', async () => {
    const assertOwned = vi.fn(async () => {}), isDeleting = vi.fn(async () => false);
    const authorize = createSessionTaskCallAuthority({assertOwned, ...startable, isDeleting});
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {throw Error('Logger unavailable');});
    await expect(authorize(plan('source'), owner, 'execute')).resolves.toBeUndefined();
    expect(assertOwned).toHaveBeenCalledOnce(); expect(isDeleting).toHaveBeenCalledOnce();
    const lost = Object.assign(new Error('Private lease failure'), {code: 'EACCES'}); assertOwned.mockRejectedValue(lost);
    await expect(authorize(plan('source'), owner, 'execute')).rejects.toBe(lost);
});
it('logs the failing side and phase without recording the plan or original error text', async () => {
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    const authorize = createSessionTaskCallAuthority({assertOwned: async id => {if (id === 'target') throw Error('PRIVATE ERROR');}, ...startable});
    const input = plan(); input.task.input = 'PRIVATE INPUT';
    await expect(authorize(input, owner, 'execute')).rejects.toThrow('PRIVATE ERROR');
    expect(info).toHaveBeenCalledWith('session-execution', 'session.task-call.authorize', expect.objectContaining({side: 'target', stage: 'ownership',
        phase: 'execute', result: 'failure', code: 'TASK_CALL_OWNERSHIP_FAILED', operationId: 'call', durationMs: expect.any(Number)}));
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/PRIVATE ERROR|PRIVATE INPUT/);
});
it('forwards the host authority into the headless Kernel and refuses dispatch before target creation', async () => {
    const authorizeTaskCall = vi.fn(async () => {throw Object.assign(new Error('Denied'), {code: 'EACCES'});});
    const {kernel} = await headless({authorizeTaskCall});
    kernel.registerProgram(echo); const call = await submit(kernel, 'source', plan());
    expect(await call.wait({timeoutMs: 3000})).toMatchObject({status: 'failed', error: {code: 'EACCES'}});
    expect(await kernel.listSessionTasks('target')).toEqual([]); expect(authorizeTaskCall).toHaveBeenCalledOnce();
});
it('executes an owned call through the full application while preserving both original Session leases', async () => {
    const {runtime, source, target, kernel} = await application(), store = new SessionLeaseStore(await runtime.vfs.openFileSystem('/'));
    const before = await Promise.all([store.inspect(source), store.inspect(target)]), call = await submit(kernel, source, plan(target));
    expect(await call.wait({until: 'settled', timeoutMs: 5000})).toMatchObject({status: 'succeeded', output: {task: {sessionId: target}, exit: {output: {answer: 42}}}});
    const after = await Promise.all([store.inspect(source), store.inspect(target)]);
    expect(after.map(lease => lease?.fencingToken)).toEqual(before.map(lease => lease?.fencingToken));
    expect(after.map(lease => lease?.ownerId)).toEqual(before.map(lease => lease?.ownerId));
});
it.each(['source', 'target'].flatMap(side => ['expired', 'other-owner'].map(state => ({side, state}))))(
    'refuses a call with $state ownership on the $side without reacquiring it', async ({side, state}) => {
    const {runtime, source, target, kernel} = await application(), store = new SessionLeaseStore(await runtime.vfs.openFileSystem('/'));
    const id = side === 'source' ? source : target, held = (await store.inspect(id))!; expect(await store.release(held)).toBe(true);
    if (state === 'other-owner') expect(await store.acquire(id, {id: 'other-host', kind: 'cli'})).toBeTruthy();
    const before = await store.inspect(id), call = await submit(kernel, source, plan(target));
    expect(await call.wait({timeoutMs: 5000})).toMatchObject({status: 'failed', error: {code: 'EACCES'}});
    expect(await kernel.listSessionTasks(target)).toEqual([]); expect(await store.inspect(id)).toEqual(before);
});
it('retains cleanup responsibility when target ownership is lost and stops the original target after explicit recovery', async () => {
    const {runtime, source, target, kernel} = await application(), store = new SessionLeaseStore(await runtime.vfs.openFileSystem('/'));
    const input = plan(target); input.task.program = {kind: 'await-input', version: '1'};
    const call = await submit(kernel, source, input);
    await vi.waitFor(async () => expect(await kernel.listSessionTasks(target)).toHaveLength(1));
    const child = (await kernel.listSessionTasks(target))[0], held = (await store.inspect(target))!; expect(await store.release(held)).toBe(true);
    const foreign = (await store.acquire(target, {id: 'other-host', kind: 'cli'}))!;
    await expect(call.cancel()).rejects.toBeInstanceOf(AggregateError);
    expect(taskStat((await call.status()).task).settled).toBe(false);
    expect((await kernel.task(target, child.id)).exit).toBeUndefined();
    expect(await runtime.prepareSession!(target)).toBe(false); expect(await store.inspect(target)).toEqual(foreign);
    expect(await store.release(foreign)).toBe(true); expect(await runtime.prepareSession!(target)).toBe(true);
    await vi.waitFor(async () => expect(taskStat((await call.status()).task).settled).toBe(true), {timeout: 5000});
    expect((await kernel.task(target, child.id)).status).toBe('cancelled'); expect(await kernel.listSessionTasks(target)).toHaveLength(1);
});

it('runs a real Agent Program in the owned Session with one Effect slot and its own approval and tool scope', async () => {
    const invoked: string[] = [], scopes: string[] = [], assertOwned = vi.fn(async () => {});
    const definition = {type: 'function' as const, function: {name: 'write_result', description: 'Write', parameters: {type: 'object', properties: {}}}};
    const messages = [{role: 'assistant', content: '', tool_calls: [{id: 'write', type: 'function', function: {name: 'write_result', arguments: '{}'}}]},
        {role: 'assistant', content: 'done'}];
    const {kernel} = await headless({maxConcurrentEffects: 1, authorizeTaskCall: createSessionTaskCallAuthority({assertOwned, ...startable}),
        llmDriver: {ioctl: async () => ({id: 'response', choices: [{index: 0, message: messages.shift(), finish_reason: 'stop'}], usage: {total_tokens: 2}})} as unknown as IDeviceDriver,
        configureSession: (id, {toolDriver}) => {scopes.push(id); toolDriver.registerTool({id: 'write_result', name: 'Write', description: 'Write',
            enabled: true, type: 'builtin', timeoutMs: 1000, sideEffect: 'external'}, definition, async () => {invoked.push(id); return 'written';});}});
    const input: TaskCallPlan = {targetSessionId: 'target', maxDepth: 2, task: {program: {kind: 'llm.agent', version: '2'}, input: {
        sessionId: 'target', roundId: 'round', connectionId: 'model', stream: false, messages: [{role: 'user', content: 'Complete the work'}],
        tools: [definition], allowedToolIds: ['write_result'], externalToolIds: ['write_result'], approval: 'external'}}, bindings: [
        {kind: 'llm', uri: 'llm://model', rights: ['execute', 'write'], signalKey: 'llmHandleId'},
        {kind: 'tool', uri: 'tool://session', rights: ['execute'], signalKey: 'toolHandleId'}]};
    const call = await submit(kernel, 'source', input);
    await vi.waitFor(async () => {
        const child = (await kernel.listSessionTasks('target'))[0];
        expect(child?.interactions['approval:1:write']).toMatchObject({status: 'pending'});
    }, {timeout: 5000});
    expect(invoked).toEqual([]); const child = (await kernel.listSessionTasks('target'))[0];
    await (await kernel.attachTask('target', child.id)).respond({interactionId: 'approval:1:write', value: true});
    expect(await call.wait({until: 'settled', timeoutMs: 5000})).toMatchObject({status: 'succeeded',
        output: {task: {sessionId: 'target', taskId: child.id}, exit: {output: {message: {content: 'done'}}}}});
    expect(invoked).toEqual(['target']); expect(scopes).toEqual(['target']); expect(messages).toEqual([]);
});

it('reconciles the original owned call after application restart and the previous worker lease expires', async () => {
    const {runtime, source, target, kernel, backend} = await application(), input = plan(target);
    input.task.program = awaitingInput.manifest; input.timeoutMs = 120_000; const call = await submit(kernel, source, input);
    await vi.waitFor(async () => expect((await kernel.listSessionTasks(target))[0]?.status).toBe('waiting'));
    const child = (await kernel.listSessionTasks(target))[0], originalWorker = (await kernel.task(source, call.id)).effects.call.currentAttempt?.workerId;
    vi.spyOn(backend, 'close').mockResolvedValue(undefined); await runtime.dispose();
    const recoveredAt = Date.now() + 31_000; vi.spyOn(Date, 'now').mockImplementation(() => recoveredAt);
    const restored = await createApplicationRuntime({backend, ownerKind: 'tauri', digitalTwinAutoStart: false, kernelPlatform: programs});
    releases.push(() => restored.dispose()); const next = restored.kernel.kernel;
    await vi.waitFor(async () => {
        const effect = (await next.task(source, call.id)).effects.call;
        expect(effect.status).toBe('leased'); expect(effect.currentAttempt?.workerId).toBeTruthy();
        expect(effect.currentAttempt?.workerId).not.toBe(originalWorker);
    }, {timeout: 1500});
    await next.signal(target, child.id, {type: 'continue'});
    expect(await (await next.attachTask(source, call.id)).wait({until: 'settled', timeoutMs: 5000})).toMatchObject({status: 'succeeded',
        output: {task: {sessionId: target, taskId: child.id}, exit: {output: {done: true}}}});
    expect(await next.listSessionTasks(target)).toHaveLength(1);
});
