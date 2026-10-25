import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {Kernel, type EffectExecutionContext, type EffectSessionState, type SharedStateEntry} from '@itookit/durable-kernel';
import type {HarnessExecutionRequest} from '@itookit/kernel-adapters/contracts';
import {HarnessProgram} from '../../kernel-adapters/src/programs/harness-program';
import {HarnessExecutionEffect} from '../../kernel-adapters/src/effects/harness-execution-effect';
import {DurableFlowExecutor} from '../../llm-flow/src/flow/executor';
import {createBuiltinDagPluginRegistry} from '../../llm-flow/src/flow/builtin-plugins';
import {FlowAggregateProgram, FlowValueProgram} from '../../llm-flow/src/flow/programs';
import {createHarnessExecutionProvider} from '../src/projects/harness-execution';
import {harnessExecutionJournalKey} from '../src/projects/harness-execution-journal';
import {complete, fixture as nativeFixture, interaction, request} from './harness-execution-fixture';

const cleanups: Array<() => Promise<unknown> | void> = [];
const unblockers: Array<() => void> = [];
const interactionId = `harness:${encodeURIComponent('string:question-1')}`;
type Hooks = {read?(entry: SharedStateEntry): Promise<void>; admitted?(entry: SharedStateEntry | undefined): Promise<void>};
type Captured = {request?: HarnessExecutionRequest; context?: EffectExecutionContext};
afterEach(async () => {for (const unblock of unblockers.splice(0)) unblock(); for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllGlobals();});
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {resolve = done;});
    unblockers.push(resolve);
    return {promise, resolve};
}
function responseContext(context: EffectExecutionContext, hooks: Hooks): EffectExecutionContext {
    const state = context.sessionState!;
    return {...context, sessionState: {...state,
        get: async key => {
            const entry = await state.get(key);
            if (key.includes('.response.') && entry) await hooks.read?.(entry);
            return entry as never;
        },
        setIfRunning: async (key, value, revision) => {
            const entry = await state.setIfRunning!(key, value, revision);
            await hooks.admitted?.(entry);
            return entry;
        },
    }};
}
async function memoryRuntime(hooks: Hooks) {
    vi.stubGlobal('fetch', vi.fn(async () => {throw new Error('Network is forbidden in the isolated pause fixture');}));
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/harness-pause');
    const kernel = new Kernel({catalog: {fs}, pollMs: 5});
    kernel.registerStorageResolver({kind: 'test', async resolve() {return {fs, rootPath: '/sessions/one'};}});
    await kernel.initialize();
    const session = await kernel.createSession({id: 'one', storage: {kind: 'test', locator: null}});
    const native = nativeFixture(), captured: Captured = {};
    interaction(native);
    vi.mocked(native.client.respond).mockImplementation(async (_profile, _id, _value, options) => {native.committed(options, {}); complete(native);});
    vi.mocked(native.client.interrupt).mockImplementation(async (_profile, _session, _turn, options) => {native.committed(options, {}); complete(native, 'cancelled');});
    const state: EffectSessionState = {get: key => session.getShared(key),
        set: (key, value, expectedVersion) => session.setShared(key, value, {expectedVersion})};
    const provider = createHarnessExecutionProvider(native.connections, {pollMs: 5, cancelTimeoutMs: 500, stateForCleanup: async () => state});
    kernel.registerProgram(new HarnessProgram()); kernel.registerProgram(new FlowAggregateProgram()); kernel.registerProgram(new FlowValueProgram());
    kernel.registerEffect(new HarnessExecutionEffect({...provider,
        execute: (input, context) => {captured.request = input; captured.context = context; return provider.execute(input, responseContext(context, hooks));},
        reconcile: (input, context) => provider.reconcile(input, responseContext(context, hooks)), cancel: provider.cancel.bind(provider),
    }));
    return {kernel, manager, session, native, captured};
}
async function flowFixture(hooks: Hooks = {}) {
    const runtime = await memoryRuntime(hooks), {kernel, session, native, captured} = runtime;
    const executor = new DurableFlowExecutor({kernel, plugins: createBuiltinDagPluginRegistry()});
    const run = await executor.submit(session.id, {nodes: [{id: 'native', name: 'Native', plugin: 'builtin.agent', pluginVersion: '1.0.0',
        config: {execution: {kind: 'harness', connectionId: request.connection.id}, harnessConnection: request.connection, prompt: 'Fixture only'}, inputs: {}}], edges: []});
    await vi.waitFor(() => expect(run.nodes.has('native')).toBe(true));
    const task = run.nodes.get('native')!, root = await session.attachTask(run.root.id);
    await vi.waitFor(async () => expect((await task.snapshot()).task.interactions[interactionId]?.status).toBe('pending'));
    expect((await task.snapshot()).task.parentTaskId).toBe(root.id);
    const responseKey = () => `${captured.request!.notificationKey}.response.${encodeURIComponent('string:question-1')}`;
    const journal = async () => (await session.getShared(harnessExecutionJournalKey(captured.context!)))!.value as any;
    const answer = () => task.respond({interactionId, value: {approved: true}});
    const withdraw = async (target = root, requestId = 'withdraw') => target.withdrawPause({requestId,
        expectedEpoch: (await target.snapshot()).task.control!.epoch});
    cleanups.push(async () => {
        await root.cancel('Fixture cleanup').catch(() => {}); await executor.waitIdle().catch(() => {});
        kernel.dispose(); await kernel.waitIdle(); await runtime.manager.dispose();
    });
    return {...runtime, run, task, root, responseKey, journal, answer, withdraw};
}
function responseSteps(journal: any): string[] {return Object.keys(journal.operations).filter(step => step.startsWith('respond-'));}
async function expectOneTurn(f: Awaited<ReturnType<typeof flowFixture>>) {
    await f.root.wait({timeoutMs: 3000});
    expect(f.native.client.create).toHaveBeenCalledOnce(); expect(f.native.client.turn).toHaveBeenCalledOnce();
    expect(f.native.client.respond).toHaveBeenCalledOnce(); expect(f.native.client.interrupt).not.toHaveBeenCalled();
}

it('saves an answer during a root pause and withdraws it into the original Effect exactly once', async () => {
    const f = await flowFixture(), before = (await f.task.snapshot()).task.effects.harness;
    const control = await f.root.pause({requestId: 'pause'}); expect(control.acknowledged).toBe(false);
    await f.answer();
    expect((await f.task.snapshot()).task.interactions[interactionId].status).toBe('resolved');
    expect(await f.session.getShared(f.responseKey())).toBeUndefined();
    await expect(f.root.resume({requestId: 'not-withdraw'})).rejects.toMatchObject({code: 'CONTROL_NOT_SETTLED'});
    await f.withdraw(); await expectOneTurn(f);
    expect((await f.task.snapshot()).task.effects.harness.attempts[0].id).toBe(before.attempts[0].id);
    expect(responseSteps(await f.journal())).toHaveLength(1);
});

it('holds a shared answer read before pause at the atomic pending-journal admission', async () => {
    const reading = gate(), release = gate(), held = gate();
    const f = await flowFixture({read: async () => {reading.resolve(); await release.promise;},
        admitted: async entry => {if (!entry) held.resolve();}});
    await f.answer(); await reading.promise;
    await f.root.pause({requestId: 'pause'}); release.resolve(); await held.promise;
    expect(responseSteps(await f.journal())).toEqual([]); expect(f.native.client.respond).not.toHaveBeenCalled();
    expect(await f.root.stat()).toMatchObject({stopped: false, control: {acknowledged: false}});
    await f.withdraw(); await expectOneTurn(f);
});

it('does not bypass Session suspension when withdrawing a root pause with a shared answer', async () => {
    const held = gate(), f = await flowFixture({admitted: async entry => {if (!entry) held.resolve();}});
    await f.root.pause({requestId: 'pause'}); await f.session.suspend();
    await f.session.setShared(f.responseKey(), {approved: true}); await held.promise;
    await f.withdraw();
    expect((await f.task.snapshot()).task.sessionPaused).toBe(true);
    expect(responseSteps(await f.journal())).toEqual([]); expect(f.native.client.respond).not.toHaveBeenCalled();
    await f.root.cancel('Stop suspended native execution'); await f.task.waitStopped({timeoutMs: 3000});
    expect(f.native.client.interrupt).toHaveBeenCalledOnce(); expect(f.native.client.respond).not.toHaveBeenCalled();
});

it('preserves an ancestor pause when a child withdraws its own pause', async () => {
    const f = await flowFixture(); await f.root.pause({requestId: 'root-pause'});
    await f.task.pause({requestId: 'child-pause'}); await f.answer(); await f.withdraw(f.task, 'child-withdraw');
    expect((await f.task.snapshot()).task.controlHolds).toContain(f.root.id);
    expect(await f.session.getShared(f.responseKey())).toBeUndefined(); expect(f.native.client.respond).not.toHaveBeenCalled();
    await f.withdraw(); await expectOneTurn(f);
});

it('permits an operation admitted before pause to settle without calling it native suspension', async () => {
    const admitted = gate(), release = gate();
    const f = await flowFixture({admitted: async entry => {if (entry) {admitted.resolve(); await release.promise;}}});
    await f.answer(); await admitted.promise;
    expect(responseSteps(await f.journal())).toHaveLength(1);
    await f.root.pause({requestId: 'pause'});
    expect(f.native.client.respond).not.toHaveBeenCalled(); expect((await f.root.stat()).stopped).toBe(false);
    release.resolve(); await vi.waitFor(() => expect(f.native.client.respond).toHaveBeenCalledOnce());
    await f.root.waitStopped({timeoutMs: 3000});
    await f.root.resume({requestId: 'resume-confirmed'}); await expectOneTurn(f);
});

it('cancels the paused tree without forwarding an answer returned by a late read', async () => {
    const reading = gate(), release = gate();
    const f = await flowFixture({read: async () => {reading.resolve(); await release.promise;}});
    await f.answer(); await reading.promise; await f.root.pause({requestId: 'pause'});
    const cancellation = f.root.cancel('Cancel while answer read is in flight');
    await vi.waitFor(() => expect(f.captured.context!.abortSignal.aborted).toBe(true)); release.resolve(); await cancellation;
    await f.task.waitStopped({timeoutMs: 3000});
    expect(f.native.client.respond).not.toHaveBeenCalled(); expect(f.native.client.interrupt).toHaveBeenCalledOnce();
    expect(f.native.client.turn).toHaveBeenCalledOnce();
    await expect(f.root.withdrawPause({requestId: 'cannot-withdraw-cancel', expectedEpoch: 1})).rejects.toMatchObject({code: 'CONFLICT'});
});

it('refuses withdrawal of an interrupted native Effect and never forwards its saved answer', async () => {
    const f = await flowFixture(); await f.root.interrupt({requestId: 'interrupt'});
    await expect(f.root.withdrawPause({requestId: 'not-a-pause', expectedEpoch: (await f.root.snapshot()).task.control!.epoch}))
        .rejects.toMatchObject({code: 'CONFLICT'});
    await f.root.waitStopped({timeoutMs: 3000});
    expect(f.native.client.interrupt).toHaveBeenCalledOnce(); expect(f.native.client.respond).not.toHaveBeenCalled();
});

it('cannot withdraw a root pause while its interrupted child still owns cleanup', async () => {
    const cleaning = gate(), release = gate(), f = await flowFixture();
    vi.mocked(f.native.client.interrupt).mockImplementation(async (_profile, _session, _turn, options) => {
        cleaning.resolve(); await release.promise; f.native.committed(options, {}); complete(f.native, 'cancelled');
    });
    await f.root.pause({requestId: 'root-pause'}); await f.task.interrupt({requestId: 'interrupt-child'}); await cleaning.promise;
    expect((await f.task.snapshot()).task.effects.harness.cleanupPending).toBe(true);
    await expect(f.withdraw()).rejects.toMatchObject({code: 'CONTROL_NOT_SETTLED'});
    release.resolve(); await f.task.waitStopped({timeoutMs: 3000});
    expect(f.native.client.respond).not.toHaveBeenCalled(); expect(f.native.client.turn).toHaveBeenCalledOnce();
});
