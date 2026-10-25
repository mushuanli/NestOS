import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Kernel, type SessionHandle, type TaskHandle} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend, type IFileSystem, type IVFSManager} from '@itookit/vfs-core';
import type {DagRunSpec, HarnessHookRunner} from '../src/contracts';
import {createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms} from '../src/flow';
import {DagCommandService} from '../src/flow/commands';
import {FlowCommand} from '../src/flow/command-names';
import {FlowTaskFactory} from '../src/flow/task-factory';
import {readFlowSchedulerCheckpoint} from '../src/flow/checkpoint-store';
import {retryFlowTask} from '../src/flow/retry-task';
import {prepareFlowTaskRetry} from '../src/flow/run-members';
import {hasFlowControlTree} from '../src/contracts';

let manager: IVFSManager, fs: IFileSystem, kernel: Kernel, session: SessionHandle;
let handlers: Map<string, (args: any) => Promise<any>>;
const runners: DurableFlowExecutor[] = [];
const plugins = createBuiltinDagPluginRegistry();
const tick = () => new Promise(resolve => setTimeout(resolve, 45));
const value = (id: string): DagRunSpec['nodes'][number] => ({id, name: id, plugin: 'builtin.transform', pluginVersion: '1.0.0',
    config: {operation: 'identity', outputName: 'result', type: 'text', value: 'done'}, inputs: {}});
const human = (id: string): DagRunSpec['nodes'][number] => ({...value(id), plugin: 'builtin.human', config: {requestId: 'answer', prompt: 'Wait'}});
const humanFlow = (): DagRunSpec => ({nodes: [human('gate'), value('after')], edges: [{id: 'next', from: 'gate', to: 'after', kind: 'control'}]});

async function boot(): Promise<void> {
    kernel = new Kernel({catalog: {fs}, pollMs: 5});
    kernel.registerStorageResolver({kind: 'test', resolve: async () => ({fs, rootPath: '/session'})});
    registerDurablePrograms(kernel);
    await kernel.initialize();
    handlers = new Map();
    new DagCommandService({kernel, plugins, flowStore: {} as never}).register({register: (name, handler) => handlers.set(name, handler)});
}
function runner(hooks?: HarnessHookRunner): DurableFlowExecutor {
    const executor = new DurableFlowExecutor({kernel, plugins, hooks}); runners.push(executor); return executor;
}
async function observe(run: {root: TaskHandle}): Promise<void> {
    await handlers.get(FlowCommand.RunGet)!({taskId: run.root.id, sessionId: session.id});
}
async function pending(handle: TaskHandle): Promise<void> {
    await vi.waitFor(async () => expect((await handle.status()).task.interactions?.answer?.status).toBe('pending'));
}
async function start(spec = humanFlow()) {
    const run = await runner().submit('s', spec);
    await vi.waitFor(() => expect(run.nodes.has('gate')).toBe(true));
    await pending(run.nodes.get('gate')!); await observe(run); return run;
}
async function goal(run: {root: TaskHandle}, status: 'active' | 'paused', requestId?: string, expectedEpoch?: number) {
    return handlers.get(FlowCommand.RunGoalUpdate)!({taskId: run.root.id, goal: {status}, requestId, expectedEpoch});
}
function latch() {
    let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;}); return {promise, release};
}
async function externalChild(root: TaskHandle) {
    const blocked = latch(), entered = latch(), execute = vi.fn(async () => {entered.release(); await blocked.promise; return 'done';});
    const manifest = {kind: 'test.external', version: '1'};
    kernel.registerProgram({manifest, init: () => ({state: null, actions: [{type: 'effect', effect: {
        id: 'work', kind: 'test.external', version: '1', idempotencyKey: 'work', request: null}}], next: {type: 'wait', on: {type: 'effect', id: 'work'}}}),
    reduce: () => ({state: null, next: {type: 'complete', output: 'done'}})});
    kernel.registerEffect({kind: 'test.external', version: '1', execute,
        async cancel() {blocked.release(); await Promise.all(execute.mock.results.map(result => result.value));}});
    const child = await session.submit({program: manifest, input: null, parent: root.id}); await entered.promise;
    return {child, blocked, execute};
}
function failGoalWrite(rootId: string) {
    const original = session.setShared.bind(session);
    return vi.spyOn(kernel, 'openSession').mockImplementation(async () => Object.assign(Object.create(session), {
        setShared: async (...args: Parameters<SessionHandle['setShared']>) => {
            if (args[0] === `flow.run.${rootId}.goal`) throw new Error('Injected goal persistence failure');
            return original(...args);
        },
    }));
}
function detachedFlow(): DagRunSpec {
    kernel.registerEffect({kind: 'llm.chat', version: '1', async execute() {
        return {choices: [{index: 0, message: {role: 'assistant', content: '[{}]'}, finish_reason: 'stop'}]};
    }});
    return {nodes: [{...value('owner'), plugin: 'builtin.agent', config: {connectionId: 'test', approval: 'none',
        messages: [{role: 'user', content: 'Declare work'}], delegation: {enabled: true, execution: {mode: 'detached'},
            wait: {timeoutMs: 60000}, template: {plugin: 'builtin.human', pluginVersion: '1.0.0', config: {requestId: 'answer', prompt: 'Wait'}}}}}], edges: []};
}
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()})); fs = await manager.openFileSystem('/'); await boot();
    session = await kernel.createSession({id: 's', storage: {kind: 'test', locator: null}});
});
afterEach(async () => {
    kernel.dispose(); await Promise.all(runners.splice(0).map(executor => executor.waitIdle()));
    await kernel.waitIdle(); await manager.dispose(); vi.restoreAllMocks();
});

it('keeps a child resumed and answered during root pause blocked by its ancestor', async () => {
    const run = await start(), child = run.nodes.get('gate')!;
    await goal(run, 'paused'); await child.resume({requestId: 'child-resume'});
    await child.respond({interactionId: 'answer', value: 'saved'}); await tick();
    const task = (await child.status()).task;
    expect(task).toMatchObject({parentTaskId: run.root.id, controlHolds: [run.root.id], interactions: {answer: {status: 'resolved'}}});
    expect(await child.poll()).toBeUndefined(); expect(run.nodes.has('after')).toBe(false);
    await goal(run, 'active'); expect((await run.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
});

it('preserves independent child and Session holds when the root resumes', async () => {
    const run = await start(), child = run.nodes.get('gate')!;
    await child.pause({requestId: 'independent'}); await goal(run, 'paused'); await session.suspend();
    await child.respond({interactionId: 'answer', value: 'saved'}); await goal(run, 'active'); await tick();
    expect((await child.status()).task).toMatchObject({sessionPaused: true, control: {mode: 'pause', requestId: 'independent'}});
    await child.resume({requestId: 'child-resume'}); await tick(); expect(await child.poll()).toBeUndefined();
    await session.resume(); expect((await run.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
});

it('waits after a suspended node hook instead of creating a node after pause confirmation', async () => {
    const entered = latch(), blocked = latch();
    const executor = runner({descriptor: {trusted: true, source: 'test', contentHash: 'test'}, async emit(context) {
        if (context.event === 'task.started') {entered.release(); await blocked.promise;}
    }});
    const run = await executor.submit('s', {nodes: [value('late')], edges: []}); await observe(run); await entered.promise;
    await goal(run, 'paused'); blocked.release(); await tick();
    expect((await run.root.stat()).control.acknowledged).toBe(true); expect(run.nodes.size).toBe(0);
    expect((await session.listTasks()).filter(task => task.parentTaskId === run.root.id)).toEqual([]);
    await goal(run, 'active'); expect((await run.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
    expect((await run.nodes.get('late')!.status()).task.parentTaskId).toBe(run.root.id);
});

it('retries a parent admission pause with the same frozen request without failing the Run', async () => {
    const original = kernel.submit.bind(kernel), requests: string[] = [];
    let injected = false;
    vi.spyOn(kernel, 'submit').mockImplementation(async (id, spec, options) => {
        if (spec.labels?.flowNodeId === 'late') {
            requests.push(spec.requestId!);
            if (!injected) {injected = true; await (await session.attachTask(spec.parent!)).pause({requestId: 'admission-pause'});}
        }
        return original(id, spec, options);
    });
    const run = await runner().submit('s', {nodes: [value('late')], edges: []}); await observe(run);
    await vi.waitFor(() => expect(injected).toBe(true)); await tick(); expect(await run.root.poll()).toBeUndefined();
    await goal(run, 'active'); expect((await run.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
    expect(requests).toHaveLength(2); expect(new Set(requests).size).toBe(1);
    expect((await session.listTasks()).filter(task => task.parentTaskId === run.root.id)).toHaveLength(1);
});

it('leaves a second Run in the same Session active while the first is paused', async () => {
    const first = await start(), second = await start(); await goal(first, 'paused');
    await second.nodes.get('gate')!.respond({interactionId: 'answer', value: 'yes'});
    expect((await second.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
    expect(await first.root.poll()).toBeUndefined();
    await goal(first, 'active'); await first.nodes.get('gate')!.respond({interactionId: 'answer', value: 'yes'});
    expect((await first.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
});

it('restores the same paused tree and saved interaction after a host restart', async () => {
    const run = await start(), childId = run.nodes.get('gate')!.id;
    await goal(run, 'paused'); await run.nodes.get('gate')!.respond({interactionId: 'answer', value: 'saved'});
    kernel.dispose(); await Promise.all(runners.map(executor => executor.waitIdle())); await kernel.waitIdle();
    await boot(); await kernel.recover({takeover: true}); session = await kernel.openSession('s');
    const restored = await runner().resume('s', run.root.id); await observe(restored); await tick();
    expect(restored.nodes.get('gate')!.id).toBe(childId); expect(await restored.nodes.get('gate')!.poll()).toBeUndefined();
    const checkpoint = await readFlowSchedulerCheckpoint(session, run.root.id);
    expect(checkpoint?.controlTreeVersion).toBe(1);
    await goal(restored, 'active'); expect((await restored.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
});

it('holds Kernel-spawned dispatch instances and prevents the next round until root resume', async () => {
    const run = await runner().submit('s', {nodes: [{...value('route'), plugin: 'builtin.route', pluginVersion: '2.0.0', config: {
        mode: 'exclusive', maxRounds: 2, until: {kind: 'literal', value: false}, context: {history: 'none'},
        branches: [{key: 'worker', target: human('worker'), input: {}, outputFormat: 'value'}],
    }}], edges: []}); await observe(run);
    await vi.waitFor(async () => expect((await session.listTasks()).some(task => task.labels?.dispatchRound === '1')).toBe(true));
    const first = (await session.listTasks()).find(task => task.labels?.dispatchRound === '1')!;
    const worker = await session.attachTask(first.id); await pending(worker); await goal(run, 'paused');
    await worker.resume({requestId: 'worker-resume'}); await worker.respond({interactionId: 'answer', value: 'saved'}); await tick();
    expect((await worker.status()).task.controlHolds).toContain(run.root.id);
    expect((await session.listTasks()).some(task => task.labels?.dispatchRound === '2')).toBe(false);
    await goal(run, 'active');
    await vi.waitFor(async () => expect((await session.listTasks()).some(task => task.labels?.dispatchRound === '2')).toBe(true));
    const next = (await session.listTasks()).find(task => task.labels?.dispatchRound === '2')!;
    expect(next.rootTaskId).toBe(run.root.id); const nextWorker = await session.attachTask(next.id); await pending(nextWorker);
    await nextWorker.respond({interactionId: 'answer', value: 'done'});
    expect((await run.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
});

it('keeps manual retry identity, ancestry and pause barriers without replaying an accepted retry', async () => {
    const run = await start({nodes: [human('gate'), human('hold')], edges: []}), source = run.nodes.get('gate')!;
    await source.cancel('test retry'); await tick();
    const retry = await retryFlowTask(session, run.root.id, source.id, 'retry-one'); await pending(retry);
    expect((await retry.status()).task).toMatchObject({parentTaskId: run.root.id, retryOfTaskId: source.id});
    await goal(run, 'paused');
    expect((await prepareFlowTaskRetry(session, run.root.id, source.id, 'retry-one')).id).toBe(retry.id);
    await expect(prepareFlowTaskRetry(session, run.root.id, source.id, 'retry-two')).rejects.toMatchObject({code: 'FLOW_RUN_PAUSED'});
    await retry.resume({requestId: 'retry-resume'}); await retry.respond({interactionId: 'answer', value: 'saved'}); await tick();
    expect(await retry.poll()).toBeUndefined(); await goal(run, 'active');
    expect((await retry.wait({timeoutMs: 2000})).status).toBe('succeeded');
    await run.nodes.get('hold')!.respond({interactionId: 'answer', value: 'done'}); await run.root.wait({timeoutMs: 2000});
    expect((await session.listTasks()).filter(task => task.retryOfTaskId === source.id)).toHaveLength(1);
});

async function legacyRun() {
    const seed = await start(), initial = structuredClone((await seed.root.status()).task.input) as any;
    delete initial.initialScheduler.controlTreeVersion;
    const root = await session.submit({program: {kind: 'flow.aggregate', version: '1'}, input: initial, labels: {kind: 'flow-root'}});
    const node = initial.initialScheduler.nodes.find((entry: {id: string}) => entry.id === 'gate');
    const runtime = await plugins.loadRuntime(node.plugin, node.pluginVersion);
    const definition = runtime.createTask({sessionId: 's', nodeRunId: 'gate', config: node.config, inputs: {}, dependencies: []});
    const factory = new FlowTaskFactory({sessionId: 's', plugins, contextProgramVersion: '1'});
    const child = await session.submit(await factory.create(node, definition, [], {}, `flow:${root.id}:gate#1@0`)); await pending(child);
    await session.setShared(`flow.run.${root.id}.members`, [{taskId: child.id, nodeId: 'gate', iteration: 1, detached: false}]);
    const run = {root}; await observe(run); return {root, child};
}

it('rejects new legacy scoped pauses without changing the persisted goal', async () => {
    const run = await legacyRun();
    await expect(goal(run, 'paused')).rejects.toMatchObject({code: 'FLOW_CONTROL_TREE_UNAVAILABLE'});
    expect((await run.root.status()).task.control).toBeUndefined();
    expect(await session.getShared(`flow.run.${run.root.id}.goal`)).toBeUndefined();
});

it('releases a proved legacy batch pause while preserving the original accepted fingerprint', async () => {
    const run = await legacyRun(); await run.root.pause({requestId: 'legacy-batch'}); await run.child.pause({requestId: 'legacy-batch'});
    await session.setShared(`flow.run.${run.root.id}.goal`, {objective: '', status: 'paused'});
    const result = await goal(run, 'active'); expect(result).toMatchObject({limitedRecovery: true, retainedTaskIds: []});
    const restored = await runner().resume('s', run.root.id);
    await run.child.respond({interactionId: 'answer', value: 'done'});
    expect((await restored.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
    expect(restored.nodes.get('gate')!.id).toBe(run.child.id);
    expect((await run.child.status()).task.parentTaskId).toBeUndefined();
});

it('retains an independent pause during limited legacy recovery', async () => {
    const run = await legacyRun(); await run.child.pause({requestId: 'independent'});
    await run.root.pause({requestId: 'legacy-batch'}); await run.child.pause({requestId: 'legacy-batch'});
    const result = await goal(run, 'active'); expect(result.retainedTaskIds).toEqual([run.child.id]);
    await run.child.respond({interactionId: 'answer', value: 'saved'}); await tick(); expect(await run.child.poll()).toBeUndefined();
    expect((await run.root.status()).task.control?.mode).toBe('run');
});

it('does not persist an active goal when resume is rejected, and retries a lost goal write safely', async () => {
    const run = await start(); await goal(run, 'paused', 'pause', 0);
    const write = failGoalWrite(run.root.id);
    await expect(goal(run, 'active', 'resume', 1)).rejects.toThrow('Injected goal persistence failure'); write.mockRestore();
    expect((await session.getShared(`flow.run.${run.root.id}.goal`))?.value).toMatchObject({status: 'paused'});
    expect((await run.root.status()).task.control).toMatchObject({mode: 'run', requestId: 'resume'});
    await goal(run, 'active', 'resume', 1);
    expect((await session.getShared(`flow.run.${run.root.id}.goal`))?.value).toMatchObject({status: 'active'});
    await run.root.pause({requestId: 'newer-pause'});
    await expect(goal(run, 'active', 'resume', 1)).rejects.toMatchObject({code: 'FLOW_CONTROL_SUPERSEDED'});
});

it('does not change goal status when an in-flight child prevents resume acknowledgement', async () => {
    const run = await start(), external = await externalChild(run.root);
    try {
        await goal(run, 'paused', 'pause', 0);
        expect((await run.root.stat()).control.acknowledged).toBe(false);
        await expect(goal(run, 'active', 'too-early', 1)).rejects.toMatchObject({code: 'CONTROL_NOT_SETTLED'});
        expect((await session.getShared(`flow.run.${run.root.id}.goal`))?.value).toMatchObject({status: 'paused'});
        expect(external.execute).toHaveBeenCalledOnce();
    } finally {external.blocked.release();}
});

it('withdraws only a pending root pause without resuming an independent member or replaying its Effect', async () => {
    const run = await start(), humanTask = run.nodes.get('gate')!;
    await humanTask.pause({requestId: 'independent'}); const external = await externalChild(run.root);
    try {
        await goal(run, 'paused', 'pause', 0);
        const result = await handlers.get(FlowCommand.RunPauseWithdraw)!({taskId: run.root.id, expectedEpoch: 1, requestId: 'withdraw'});
        expect(result.control).toMatchObject({mode: 'run', epoch: 2}); expect(result.goal.status).toBe('active');
        expect((await humanTask.status()).task.control).toMatchObject({mode: 'pause', requestId: 'independent'});
        expect((await external.child.status()).task.controlHolds).toEqual([]);
        expect(external.execute).toHaveBeenCalledOnce(); expect(await external.child.poll()).toBeUndefined();
    } finally {external.blocked.release();}
});

it('repairs a lost withdrawal goal write with the same receipt and rejects superseded replay', async () => {
    const run = await start(), external = await externalChild(run.root);
    const input = {taskId: run.root.id, expectedEpoch: 1, requestId: 'withdraw'};
    try {
        await goal(run, 'paused', 'pause', 0); const write = failGoalWrite(run.root.id);
        await expect(handlers.get(FlowCommand.RunPauseWithdraw)!(input)).rejects.toThrow('Injected goal persistence failure'); write.mockRestore();
        expect((await run.root.status()).task.control).toMatchObject({mode: 'run', epoch: 2, requestId: 'withdraw'});
        expect((await session.getShared(`flow.run.${run.root.id}.goal`))?.value).toMatchObject({status: 'paused'});
        await handlers.get(FlowCommand.RunPauseWithdraw)!(input);
        expect((await run.root.status()).task.control?.epoch).toBe(2); expect(external.execute).toHaveBeenCalledOnce();
        await run.root.pause({requestId: 'newer-pause'});
        await expect(handlers.get(FlowCommand.RunPauseWithdraw)!(input)).rejects.toMatchObject({code: 'FLOW_CONTROL_SUPERSEDED'});
    } finally {external.blocked.release();}
});

it('requires a valid frozen tree and observed control identity for withdrawal', async () => {
    const run = await start();
    expect(hasFlowControlTree((await run.root.status()).task)).toBe(true);
    for (const input of [null, [], {initialScheduler: []}, {initialScheduler: {controlTreeVersion: 2}}])
        expect(hasFlowControlTree({input})).toBe(false);
    await expect(handlers.get(FlowCommand.RunPauseWithdraw)!({taskId: run.root.id, requestId: 'bad'}))
        .rejects.toMatchObject({code: 'FLOW_CONTROL_REQUEST_INVALID'});
    const legacy = await legacyRun();
    await expect(handlers.get(FlowCommand.RunPauseWithdraw)!({taskId: legacy.root.id, requestId: 'old', expectedEpoch: 0}))
        .rejects.toMatchObject({code: 'FLOW_CONTROL_TREE_UNAVAILABLE'});
});

it('leaves an unprovable legacy member paused when the original history was compacted', async () => {
    const run = await legacyRun(); await run.root.pause({requestId: 'legacy-batch'}); await run.child.pause({requestId: 'legacy-batch'});
    await kernel.compactTaskHistory('s', run.child.id, {keepVersions: 1});
    expect((await goal(run, 'active')).retainedTaskIds).toEqual([run.child.id]);
    expect((await run.root.status()).task.control?.mode).toBe('run');
    expect((await run.child.status()).task.control?.mode).toBe('pause');
});

it('checks legacy expectedEpoch before touching members and replays its persisted root receipt after a lost goal write', async () => {
    const run = await legacyRun(); await run.root.pause({requestId: 'legacy-batch'}); await run.child.pause({requestId: 'legacy-batch'});
    await expect(goal(run, 'active', 'legacy-resume', 0)).rejects.toMatchObject({code: 'CONFLICT'});
    expect((await run.child.status()).task.control?.mode).toBe('pause');
    const write = failGoalWrite(run.root.id);
    await expect(goal(run, 'active', 'legacy-resume', 1)).rejects.toThrow('Injected goal persistence failure'); write.mockRestore();
    expect((await run.root.status()).task.control).toMatchObject({epoch: 2, requestId: 'legacy-resume', mode: 'run'});
    await goal(run, 'active', 'legacy-resume', 1); expect((await run.root.status()).task.control?.epoch).toBe(2);
    await run.root.pause({requestId: 'newer-pause'});
    await expect(goal(run, 'active', 'legacy-resume', 1)).rejects.toMatchObject({code: 'CONFLICT'});
});

it('keeps dynamically materialized detached work in the owning Run control tree', async () => {
    const spec = detachedFlow(); spec.nodes.push(human('gate'));
    const run = await start(spec);
    await vi.waitFor(() => expect(run.nodes.has('owner:delegate:1:0')).toBe(true));
    const child = run.nodes.get('owner:delegate:1:0')!; await pending(child);
    expect(run.detachedNodes.has('owner:delegate:1:0')).toBe(true);
    expect((await child.status()).task.parentTaskId).toBe(run.root.id);
    await goal(run, 'paused'); await child.resume({requestId: 'detached-resume'});
    await child.respond({interactionId: 'answer', value: 'saved'}); await tick(); expect(await child.poll()).toBeUndefined();
    await goal(run, 'active'); expect((await child.wait({timeoutMs: 2000})).status).toBe('succeeded');
    await run.nodes.get('gate')!.respond({interactionId: 'answer', value: 'done'}); await run.root.wait({timeoutMs: 2000});
});

it('allows join-detached work to finish under its persisted ownership after the root succeeds', async () => {
    const run = await runner().submit('s', detachedFlow());
    expect((await run.root.wait({timeoutMs: 2000})).status).toBe('succeeded');
    const child = run.nodes.get('owner:delegate:1:0')!; await pending(child);
    expect((await child.status()).task).toMatchObject({parentTaskId: run.root.id, rootTaskId: run.root.id});
    await child.respond({interactionId: 'answer', value: 'done'});
    expect((await child.wait({timeoutMs: 2000})).status).toBe('succeeded');
});

it('rejects a resumed checkpoint that would downgrade its frozen control tree', async () => {
    const run = await start(); await goal(run, 'paused');
    const checkpoint = (await readFlowSchedulerCheckpoint(session, run.root.id))!;
    delete checkpoint.controlTreeVersion;
    await session.setShared(`flow.run.${run.root.id}.scheduler`, checkpoint as never);
    kernel.dispose(); await Promise.all(runners.map(executor => executor.waitIdle())); await kernel.waitIdle();
    await boot(); await kernel.recover({takeover: true}); session = await kernel.openSession('s');
    await expect(runner().resume('s', run.root.id)).rejects.toMatchObject({code: 'FLOW_CONTROL_TREE_MISMATCH'});
    expect((await session.listTasks()).filter(task => task.parentTaskId === run.root.id)).toHaveLength(1);
});

it('cancels the root and authoritative members without targeting a replaced historical attempt', async () => {
    const run = await start(), old = run.nodes.get('gate')!;
    const replacement = await session.submit({program: {kind: 'flow.human', version: '1'},
        input: (await old.status()).task.input, parent: run.root.id});
    await session.setShared(`flow.run.${run.root.id}.members`, [{taskId: replacement.id, nodeId: 'gate', iteration: 1, detached: false}]);
    const attached: string[] = [], originalOpen = kernel.openSession.bind(kernel);
    vi.spyOn(kernel, 'openSession').mockImplementation(async (...args) => {
        const opened = await originalOpen(...args);
        return Object.assign(Object.create(opened), {attachTask: async (id: string) => {
            const task = await opened.attachTask(id);
            return Object.assign(Object.create(task), {cancel: async (...values: Parameters<TaskHandle['cancel']>) => {
                attached.push(id); return task.cancel(...values);
            }});
        }});
    });
    await handlers.get(FlowCommand.RunCancel)!({taskId: run.root.id});
    expect(attached).toContain(run.root.id);
    expect(attached).toContain(replacement.id);
    expect(attached).not.toContain(old.id);
    expect((await old.wait({timeoutMs: 2000})).status).toBe('cancelled');
});
