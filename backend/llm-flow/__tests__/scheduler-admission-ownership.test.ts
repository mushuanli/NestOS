import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Kernel, type SessionHandle} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend, type IFileSystem, type IVFSManager} from '@itookit/vfs-core';
import type {DagRunSpec} from '../src/contracts';
import {createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms} from '../src/flow';

let manager: IVFSManager, fs: IFileSystem, kernel: Kernel, session: SessionHandle;
const runners: DurableFlowExecutor[] = [];
function latch() {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;}); return {promise, release};}
function workspace() {
    const lease = {directory: '/isolated', record: {version: 1, directory: '/isolated'}, finish: vi.fn(async () => {})};
    return {lease, manager: {prepare: vi.fn(async () => lease), restore: vi.fn(async () => {
        if (lease.finish.mock.calls.length) throw new Error('Workspace was already finished');
        return lease;
    })}};
}
function spec(): DagRunSpec {
    return {nodes: [{id: 'ask', name: 'Ask', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {}, config: {requestId: 'answer', prompt: 'Wait'}}], edges: [],
        invocation: {requestId: 'same-request', flowId: 'wait' as never, revision: 1, digest: 'published', name: 'Wait', createdAt: 1},
        runPolicy: {workspace: {mode: 'worktree'}}};
}
function runner(options: Partial<ConstructorParameters<typeof DurableFlowExecutor>[0]> = {}) {
    const executor = new DurableFlowExecutor({kernel, plugins: createBuiltinDagPluginRegistry(), ...options}); runners.push(executor); return executor;
}
async function answer(run: Awaited<ReturnType<DurableFlowExecutor['submit']>>) {
    await vi.waitFor(() => expect(run.nodes.has('ask')).toBe(true)); const human = run.nodes.get('ask')!;
    await vi.waitFor(async () => expect((await human.status()).task.interactions.answer?.status).toBe('pending'));
    await human.respond({interactionId: 'answer', value: 'Done'});
    expect((await run.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
}
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()})); fs = await manager.openFileSystem('/');
    kernel = new Kernel({catalog: {fs}, pollMs: 5});
    kernel.registerStorageResolver({kind: 'test', resolve: async () => ({fs, rootPath: '/session'})});
    registerDurablePrograms(kernel); await kernel.initialize(); session = await kernel.createSession({id: 's', storage: {kind: 'test', locator: null}});
});
afterEach(async () => {
    vi.restoreAllMocks(); kernel.dispose(); await Promise.all(runners.splice(0).map(executor => executor.waitIdle()));
    await kernel.waitIdle(); await manager.dispose();
});

it('does not fail or clean a shared durable root when a duplicate Executor loses scheduler admission', async () => {
    const entered = latch(), held = latch(), rootRequested = latch(), own = workspace(), original = kernel.submit.bind(kernel);
    let roots = 0; const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    vi.spyOn(kernel, 'submit').mockImplementation(async (id, input, options) => {
        const ordinal = input.program.kind === 'flow.aggregate' ? ++roots : 0;
        if (ordinal === 1) rootRequested.release();
        const task = await original(id, input, options);
        if (ordinal === 2) await entered.promise;
        return task;
    });
    const first = runner({workspaceManager: own.manager, hooks: {descriptor: {trusted: true, source: 'test', contentHash: 'test'}, async emit(event) {
        if (event.event === 'task.started') {entered.release(); await held.promise;}
    }}}), second = runner({workspaceManager: own.manager});
    const winner = first.submit('s', spec()); await rootRequested.promise;
    const loser = second.submit('s', spec()).then(() => undefined, error => error);
    const run = await winner;
    try {
        await entered.promise; const failure = await loser;
        expect(failure).toBeInstanceOf(Error); expect(failure.message).toMatch(/Run is scheduled by/);
        expect(failure.code).toBe('FLOW_SCHEDULER_BUSY');
        expect(await run.root.poll()).toBeUndefined(); expect(own.lease.finish).not.toHaveBeenCalled();
        expect((await session.listTasks()).filter(task => task.labels?.kind === 'flow-root')).toHaveLength(1);
    } finally {now.mockRestore(); held.release();}
    await answer(run); await first.waitIdle(); expect(own.lease.finish).toHaveBeenCalledTimes(1);
    expect(own.lease.finish).toHaveBeenCalledWith('succeeded');
});

it('keeps a root and its referenced workspace recoverable after storage rejects the first lease write', async () => {
    const own = workspace(), open = kernel.openSession.bind(kernel), unavailable = new Error('Injected scheduler storage failure');
    const report = vi.fn(() => {throw new Error('Diagnostic unavailable');});
    const broken = vi.spyOn(kernel, 'openSession').mockImplementation(async (...args) => {
        const current = await open(...args), copy = Object.create(current) as SessionHandle;
        copy.setShared = async (key, value, options) => {
            if (key.endsWith('.scheduler-owner')) throw unavailable;
            return current.setShared(key, value, options);
        };
        return copy;
    });
    await expect(runner({workspaceManager: own.manager, onControlDiagnostic: report}).submit('s', spec())).rejects.toBe(unavailable);
    const root = (await session.listTasks()).find(task => task.labels?.kind === 'flow-root')!;
    expect(root.exit).toBeUndefined(); expect(own.lease.finish).not.toHaveBeenCalled(); broken.mockRestore();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({operation: 'flow.scheduler.admit', stage: 'lease',
        outcome: 'error', code: 'FLOW_SCHEDULER_ADMISSION_FAILED', rootTaskId: root.id, operationId: 'same-request'}));
    expect(JSON.stringify(report.mock.calls)).not.toContain(unavailable.message);
    const restored = runner({workspaceManager: own.manager}), run = await restored.resume('s', root.id);
    expect(own.manager.prepare).toHaveBeenCalledOnce(); expect(own.manager.restore).toHaveBeenCalledOnce();
    await answer(run); await restored.waitIdle(); expect(own.lease.finish).toHaveBeenCalledWith('succeeded');
});

it('still fails and cleans a Run for a genuine node error after its scheduler lease was acquired', async () => {
    const own = workspace(), executor = runner({workspaceManager: own.manager,
        hooks: {descriptor: {trusted: true, source: 'test', contentHash: 'test'}, async emit(event) {
            if (event.event === 'task.started') throw new Error('Injected node preparation failure');
        }}});
    const run = await executor.submit('s', spec());
    expect((await run.root.wait({timeoutMs: 2000})).status).toBe('failed'); await executor.waitIdle();
    expect(own.lease.finish).toHaveBeenCalledOnce(); expect(own.lease.finish).toHaveBeenCalledWith('failed');
});

it('preserves a truly committed root and its initial workspace when the submission reply is lost', async () => {
    const own = workspace(), original = kernel.submit.bind(kernel), lost = Object.assign(new Error('Injected lost root reply'), {code: 'EIO'});
    const report = vi.fn(); let first = true;
    vi.spyOn(kernel, 'submit').mockImplementation(async (id, input, options) => {
        const task = await original(id, input, options);
        if (first && input.program.kind === 'flow.aggregate') {first = false; throw lost;}
        return task;
    });
    await expect(runner({workspaceManager: own.manager, onControlDiagnostic: report}).submit('s', spec())).rejects.toBe(lost);
    const root = (await session.listTasks()).find(task => task.labels?.kind === 'flow-root')!;
    expect(root.exit).toBeUndefined(); expect(own.lease.finish).not.toHaveBeenCalled();
    expect(root.input).toMatchObject({initialWorkspace: own.lease.record});
    expect(report).toHaveBeenCalledWith(expect.objectContaining({stage: 'root-admission', operationId: 'same-request', rootTaskId: undefined, code: 'EIO'}));
    const restored = runner({workspaceManager: own.manager}), run = await restored.resume('s', root.id);
    expect(own.manager.prepare).toHaveBeenCalledOnce(); expect(own.manager.restore).toHaveBeenCalledWith('s', expect.anything(), own.lease.record, undefined);
    await answer(run); await restored.waitIdle(); expect(own.lease.finish).toHaveBeenCalledTimes(1);
    expect(own.lease.finish).toHaveBeenCalledWith('succeeded');
});

it('does not infer cleanup ownership from an explicit root fingerprint conflict', async () => {
    const own = workspace(), entered = latch(), held = latch();
    const first = runner({workspaceManager: own.manager, hooks: {descriptor: {trusted: true, source: 'test', contentHash: 'test'}, async emit(event) {
        if (event.event === 'task.started') {entered.release(); await held.promise;}
    }}});
    const run = await first.submit('s', spec()); await entered.promise;
    try {
        const changed = spec(); changed.nodes[0].config = {requestId: 'other', prompt: 'Changed'};
        await expect(runner({workspaceManager: own.manager}).submit('s', changed)).rejects.toMatchObject({code: 'CONFLICT'});
        expect(own.lease.finish).not.toHaveBeenCalled(); expect(await run.root.poll()).toBeUndefined();
    } finally {held.release();}
    await answer(run); await first.waitIdle(); expect(own.lease.finish).toHaveBeenCalledTimes(1);
});

it('still cleans its private workspace when initial serialization fails before root submission', async () => {
    const own = workspace(), submit = vi.spyOn(kernel, 'submit');
    const workspaceManager = {prepare: async () => ({...own.lease, record: {invalid: 1n} as never})};
    await expect(runner({workspaceManager}).submit('s', spec())).rejects.toThrow(/BigInt/);
    expect(submit).not.toHaveBeenCalled(); expect(await session.listTasks()).toEqual([]);
    expect(own.lease.finish).toHaveBeenCalledOnce(); expect(own.lease.finish).toHaveBeenCalledWith('failed');
});
