import { withFlowControl } from '../src/flow/control-session';
import { acquireSchedulerLease, schedulerOwnerKey } from '../src/flow/scheduler-lease';
import { resolveFlowRunForTask } from '../src/flow/task-run';
import { prepareFlowTaskRetry, readFlowRunMembers } from '../src/flow/run-members';
import { workspaceFinalizationKey } from '../src/flow/workspace-finalization';
import { requestFlowGraphRetry } from '../src/flow/graph-retry';
import { restoreFlowHandle } from '../src/flow/restore-handle';
import { readFlowTaskTranscript } from '../src/flow/transcript';
import { flowToDag } from '../src/flow/to-dag';
import { DagCommandService } from '../src/flow/commands';
import { FlowCommand } from '../src/flow/command-names';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DagRunSpec } from '../src/contracts';
import type { ChatCompletionResponse } from '@itookit/driver-llm/contracts';
import {
    Kernel,
    type EffectAdapter,
} from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import { DurableAgentProgram, DurableChatProgram } from '@itookit/llm-tasks';
import { createBuiltinDagPluginRegistry } from '../src/flow/builtin-plugins';
import { DurableFlowExecutor, upstreamOf, workspaceLeaseKey } from '../src/flow/executor';
import { FlowAggregateProgram, FlowHumanProgram, FlowValueProgram } from '../src/flow/programs';

describe('DurableFlowExecutor', () => {
    let manager: IVFSManager;
    let fs: IFileSystem;
    let kernel: Kernel;
    let model: ReturnType<typeof llmEffect>;

    it.each([-1, 0.5, NaN, Infinity])('rejects invalid scheduler skew allowance %s', async schedulerLeaseSkewMs => {
        const run = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), schedulerLeaseSkewMs });
        await expect(run.submit('session-one', valueFlow())).rejects.toThrow('skewMs');
    });

    beforeEach(async () => {
        ({ manager } = await createVFS({ rootBackend: new MemoryBackend(),}));
        fs = await manager.openFileSystem('/data/test');
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({
            kind: 'test',
            async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; },
        });
        registerPrograms(kernel);
        model = llmEffect();
        kernel.registerEffect(model);
        await kernel.initialize();
        await kernel.createSession({ id: 'session-one', storage: { kind: 'test', locator: null } });
    });

    afterEach(async () => { kernel.dispose(); await manager.dispose(); });

    /**
     * `submit` resolves as soon as the durable root exists, before the scheduler
     * dispatches nodes, so the returned handle is live but its node map fills in
     * later. Final-state assertions wait for the Run to exit first.
     */
    const runToEnd = (handle: { root: { wait: (options?: { timeoutMs?: number }) =>
        Promise<{ status: string; error?: { message?: string } }> } }, timeoutMs = 5_000) =>
        handle.root.wait({ timeoutMs });
    /** For Runs that park on an interaction and can never exit: wait for a dispatched node. */
    const waitForNode = (handle: { nodes: ReadonlyMap<string, unknown> }, nodeId: string): Promise<void> =>
        vi.waitFor(() => expect(handle.nodes.has(nodeId)).toBe(true));

    it('freezes context program versions per Run and keeps legacy checkpoints on v1', async () => {
        const first = executor(kernel);
        const original = await first.submit('session-one', agentFlow());
        await runToEnd(original); await first.waitIdle();
        const initial = structuredClone((await original.root.status()).task.input) as any;
        delete initial.initialScheduler.contextProgramVersion;
        const agent = new DurableAgentProgram(); agent.manifest.version = '2';
        const chat = new DurableChatProgram(); chat.manifest.version = '2';
        kernel.registerProgram(agent); kernel.registerProgram(chat);
        const session = await kernel.openSession('session-one');
        const root = await session.submit({ program: { kind: 'flow.aggregate', version: '1' }, input: initial, labels: { kind: 'flow-root' } });
        const restored = await first.resume('session-one', root.id);
        expect((await runToEnd(restored)).status).toBe('succeeded'); await first.waitIdle();
        expect((await restored.nodes.get('agent')!.status()).task.program.version).toBe('1');
        const fresh = await first.submit('session-one', agentFlow());
        expect((await runToEnd(fresh)).status).toBe('succeeded'); await first.waitIdle();
        expect((await fresh.nodes.get('agent')!.status()).task.program.version).toBe('2');
        expect(((await fresh.root.status()).task.input as any).initialScheduler.contextProgramVersion).toBe('2');
    });

    it('restores the initial root snapshot and workspace before a first shared checkpoint exists', async () => {
        const workspaceManager = {
            prepare: vi.fn(async () => ({ directory: '/copy', record: { directory: '/copy' }, finish: vi.fn() })),
            restore: vi.fn(async () => ({ directory: '/copy', finish: vi.fn() })),
        };
        const first = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), workspaceManager });
        const original = await first.submit('session-one', { ...valueFlow(), runPolicy: { workspace: { mode: 'worktree', cleanup: 'keep' } } });
        await runToEnd(original); await first.waitIdle();
        const input = (await original.root.status()).task.input;
        const session = await kernel.openSession('session-one');
        // Recreate precisely the only committed record at the root-submit crash boundary.
        const root = await session.submit({ program: { kind: 'flow.aggregate', version: '1' }, input, labels: { kind: 'flow-root' } });
        expect(await session.getShared(`flow.run.${root.id}.scheduler`)).toBeUndefined();
        const resumed = await first.resume('session-one', root.id);
        expect((await runToEnd(resumed)).status).toBe('succeeded');
        await first.waitIdle();
        expect(workspaceManager.prepare).toHaveBeenCalledTimes(1);
        expect(workspaceManager.restore).toHaveBeenCalledWith('session-one', { mode: 'worktree', cleanup: 'keep' }, { directory: '/copy' }, undefined);
        expect((await session.getShared(workspaceLeaseKey(root.id)))?.value).toEqual({ directory: '/copy' });
    });

    it('finishes a terminal workspace even when the pending finalization write was interrupted', async () => {
        const finish = vi.fn(async () => undefined);
        const workspaceManager = { prepare: async () => ({ directory: '/copy', record: { directory: '/copy' }, finish }),
            restore: async () => ({ directory: '/copy', finish }) };
        const runner = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), workspaceManager });
        const original = await runner.submit('session-one', { ...valueFlow(), runPolicy: { workspace: { mode: 'worktree' } } });
        await runToEnd(original); await runner.waitIdle();
        const session = await kernel.openSession('session-one');
        const input = (await original.root.status()).task.input as any;
        const root = await session.submit({ program: { kind: 'flow.aggregate', version: '1' },
            input: { ...input, awaitingSchedule: false }, labels: { kind: 'flow-root' } });
        await root.wait({ timeoutMs: 2000 });
        finish.mockClear();
        await runner.resume('session-one', root.id);
        expect(finish).toHaveBeenCalledWith('succeeded');
        expect((await session.getShared(workspaceFinalizationKey(root.id)))?.value).toMatchObject({ status: 'succeeded' });
        await runner.resume('session-one', root.id);
        expect(finish).toHaveBeenCalledTimes(1);
    });

    it('rejects every DAG mutation on a read-only host while retaining inspection', async () => {
        const flow = { nodes: [{ ...valueNode('gate', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Wait' } }], edges: [] };
        const run = await executor(kernel).submit('session-one', flow); await waitForNode(run, 'gate');
        const handlers = new Map<string, (args: any) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never,
            canWriteSession: async () => false }).register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        await handlers.get(FlowCommand.RunGet)!({ taskId: run.root.id, sessionId: 'session-one' });
        const args = { taskId: run.root.id, sessionId: 'session-one', targetTaskId: run.nodes.get('gate')!.id,
            requestId: 'answer', value: 'yes', signal: { type: 'hello' }, goal: { status: 'paused' }, flow: {} };
        for (const name of [FlowCommand.RunResume, FlowCommand.RunStart, FlowCommand.RunCancel, FlowCommand.RunRespond, FlowCommand.RunSignal,
            FlowCommand.RunTaskRetry, FlowCommand.RunTaskCancel, FlowCommand.RunGoalUpdate]) {
            await expect(handlers.get(name)!(args)).rejects.toThrow('read-only');
        }
        expect((await run.root.status()).task.control).toBeUndefined();
    });

    it('rejects a delayed control callback after scheduler takeover', async () => {
        const run = await executor(kernel).submit('session-one', { nodes: [{ ...valueNode('gate', null),
            plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Wait' } }], edges: [] });
        await waitForNode(run, 'gate');
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const delayed = withFlowControl(kernel, 'session-one', run.root.id, undefined, async session => {
            const task = await session.attachTask(run.nodes.get('gate')!.id); entered(); await gate;
            await task.cancel('late control');
        });
        const rejection = expect(delayed).rejects.toMatchObject({ code: 'STALE_SHARED_LEASE' });
        await started;
        const session = await kernel.openSession('session-one');
        const owner = (await session.getShared(schedulerOwnerKey(run.root.id)))!.value as any;
        const next = await acquireSchedulerLease(session, run.root.id, { ownerId: owner.ownerId });
        release(); await rejection;
        expect((await run.nodes.get('gate')!.status()).task.status).not.toBe('cancelled');
        await next.release();
    });

    it('does not borrow a live scheduler lease from a different Kernel host', async () => {
        const run = await executor(kernel).submit('session-one', { nodes: [{ ...valueNode('gate', null),
            plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Wait' } }], edges: [] });
        await waitForNode(run, 'gate');
        const other = new Kernel({ catalog: { fs }, pollMs: 5 });
        other.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        const operation = vi.fn();
        try {
            await expect(withFlowControl(other, 'session-one', run.root.id, async () => true, operation)).rejects.toThrow('Run is scheduled by');
            expect(operation).not.toHaveBeenCalled();
        } finally { other.dispose(); await other.waitIdle(); }
    });

    it('pauses one Run without suspending another Run in the same Session', async () => {
        const flow = { nodes: [{ ...valueNode('gate', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Wait' } },
            valueNode('after', 'done')], edges: [{ id: 'next', from: 'gate', to: 'after', kind: 'control' as const }] };
        const first = await executor(kernel).submit('session-one', flow), second = await executor(kernel).submit('session-one', flow);
        await waitForNode(first, 'gate'); await waitForNode(second, 'gate');
        const handlers = new Map<string, (args: any) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        await handlers.get(FlowCommand.RunGet)!({ taskId: first.root.id, sessionId: 'session-one' });
        await handlers.get(FlowCommand.RunGoalUpdate)!({ taskId: first.root.id, goal: { status: 'paused' } });
        expect((await first.root.status()).task.control?.mode).toBe('pause');
        await second.nodes.get('gate')!.respond({ interactionId: 'answer', value: 'yes' });
        expect((await runToEnd(second)).status).toBe('succeeded');
        expect(first.nodes.has('after')).toBe(false);
        await handlers.get(FlowCommand.RunGoalUpdate)!({ taskId: first.root.id, goal: { status: 'active' } });
        await first.nodes.get('gate')!.respond({ interactionId: 'answer', value: 'yes' });
        expect((await runToEnd(first)).status).toBe('succeeded');
    });

    it('lists persisted Runs without activation and resumes graph retry from the command surface', async () => {
        const first = executor(kernel);
        const run = await first.submit('session-one', { nodes: [valueNode('source', 'original'),
            { ...valueNode('gate', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Wait' } }],
            edges: [{ id: 'edge', from: 'source', to: 'gate', kind: 'control' }] });
        await waitForNode(run, 'gate');
        const sourceId = run.nodes.get('source')!.id, oldGate = run.nodes.get('gate')!.id;
        kernel.dispose(); await first.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel); await kernel.initialize();
        const handlers = new Map<string, (args: any) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        const open = vi.spyOn(kernel, 'openSession');
        expect(await handlers.get(FlowCommand.RunList)!({})).toContainEqual(expect.objectContaining({ taskId: run.root.id, sessionId: 'session-one' }));
        const inspected = await handlers.get(FlowCommand.RunGet)!({ taskId: run.root.id, sessionId: 'session-one' });
        await handlers.get(FlowCommand.RunTranscript)!({ taskId: run.root.id, sessionId: 'session-one', targetTaskId: sourceId,
            query: { version: inspected.nodes.find((node: any) => node.nodeId === 'source').snapshot.task.version } });
        expect(open).not.toHaveBeenCalled();
        await handlers.get(FlowCommand.RunTaskRetry)!({ taskId: run.root.id, sessionId: 'session-one', targetTaskId: sourceId, requestId: 'ui-recompute', downstream: true });
        await vi.waitFor(async () => {
            const tasks = await kernel.listSessionTasks('session-one');
            expect(tasks.some(task => task.labels?.flowNodeId === 'gate' && task.id !== oldGate && task.interactions?.answer?.status === 'pending')).toBe(true);
        });
        const observer = new Map<string, (args: any) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => observer.set(name, handler) } as never);
        await observer.get(FlowCommand.RunGet)!({ taskId: run.root.id, sessionId: 'session-one' });
        await handlers.get(FlowCommand.RunRespond)!({ taskId: run.root.id, requestId: 'answer', value: 'done' });
        expect((await (await kernel.openTask(run.root.id)).wait({ timeoutMs: 2000 })).status).toBe('succeeded');
        const snapshot = await observer.get(FlowCommand.RunGet)!({ taskId: run.root.id });
        const metadata = (await (await kernel.inspectSession('session-one')).getShared(`flow.run.${run.root.id}.metadata`))!.value as any;
        expect(snapshot.usage).toEqual(metadata.usage);
        expect(snapshot.usage.elapsedMs).toBeGreaterThan(0);
    });

    it('resolves independent Run nodes, descendants and persisted retry membership', async () => {
        const flow: DagRunSpec = { nodes: [{ ...valueNode('gate', null), plugin: 'builtin.human',
            config: { requestId: 'continue', prompt: 'Continue' } }], edges: [] };
        const first = await executor(kernel).submit('session-one', flow);
        const second = await executor(kernel).submit('session-one', flow);
        await waitForNode(first, 'gate'); await waitForNode(second, 'gate');
        const session = await kernel.openSession('session-one');
        const firstNode = first.nodes.get('gate')!;
        const task = (await firstNode.status()).task;
        expect(task.rootTaskId).toBe(firstNode.id);
        expect((await resolveFlowRunForTask(session, firstNode.id))?.id).toBe(first.root.id);
        expect((await resolveFlowRunForTask(session, second.nodes.get('gate')!.id))?.id).toBe(second.root.id);
        const child = await session.submit({ program: { kind: 'flow.value', version: '1' },
            input: {}, parent: firstNode.id, deferStart: true });
        expect((await resolveFlowRunForTask(session, child.id))?.id).toBe(first.root.id);
        await firstNode.cancel('retry test');
        const retry = await prepareFlowTaskRetry(session, first.root.id, firstNode.id, 'scope-test');
        expect((await resolveFlowRunForTask(await kernel.openSession('session-one'), retry.id))?.id).toBe(first.root.id);
        await first.root.cancel('test done'); await second.root.cancel('test done');
    });

    it.each([false, true])('returns a resumed handle while downstream is pending (cancel: %s)', async cancel => {
        const flow = agentFlow();
        flow.nodes.unshift({ ...valueNode('answer', null), plugin: 'builtin.human',
            config: { requestId: 'answer', prompt: 'Continue' } });
        flow.edges.push({ id: 'answer-agent', from: 'answer', to: 'agent', input: 'input', output: 'response' });
        const initialExecutor = executor(kernel);
        const original = await initialExecutor.submit('session-one', flow);
        // The handle is published before dispatch; wait until the human node exists.
        await waitForNode(original, 'answer');
        kernel.dispose();
        await initialExecutor.waitIdle();
        await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const execute = vi.fn(async (...args: Parameters<typeof model.execute>) => {
            await blocked;
            return model.execute(...args);
        });
        kernel.registerEffect({ ...model, execute });
        await kernel.initialize();
        await kernel.recover({ takeover: true });
        const session = await kernel.openSession('session-one');
        await (await session.attachTask(original.nodes.get('answer')!.id)).respond({ interactionId: 'answer', value: 'yes' });
        let resumed: Awaited<ReturnType<DurableFlowExecutor['resume']>> | undefined;
        const resolveNewRunContext = vi.fn(async () => { throw new Error('Resume must not rebuild context'); });
        const resumedExecutor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), resolveNewRunContext });
        const pending = resumedExecutor.resume('session-one', original.root.id).then(handle => { resumed = handle; });
        let idle = false;
        try {
            await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(resumed?.root.id).toBe(original.root.id), { timeout: 500 });
            expect(await resumed!.root.poll()).toBeUndefined();
            void resumedExecutor.waitIdle().then(() => { idle = true; });
            await new Promise(resolve => setTimeout(resolve, 25));
            expect(idle).toBe(false);
            if (cancel) {
                await resumed!.root.cancel('Cancelled after resume');
                await vi.waitFor(async () => expect((await resumed!.nodes.get('agent')!.status()).task.status).toBe('cancelled'));
            }
        } finally { release(); await pending; await resumedExecutor.waitIdle(); }
        expect(idle).toBe(true);
        expect(resolveNewRunContext).not.toHaveBeenCalled();
        expect((await resumed!.root.wait({ timeoutMs: 2000 })).status).toBe(cancel ? 'cancelled' : 'succeeded');
        if (!cancel) {
            expect(resumed!.usage.tokens).toBe(2);
            kernel.dispose();
            await kernel.waitIdle();
            kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
            kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
            await kernel.initialize();
            const reattached = await restoreFlowHandle(await kernel.openSession('session-one'), original.root.id);
            expect(reattached.usage).toEqual(resumed!.usage);
        }
    });

    it.each([true, false])('validates registered edge content before downstream execution (valid: %s)', async valid => {
        const plugins = createBuiltinDagPluginRegistry();
        const ref = { id: 'report', version: '1' };
        plugins.registerSchema(ref, { type: 'object', required: ['count'], additionalProperties: false,
            properties: { count: { type: 'integer' } } });
        const manifest = plugins.getManifest('builtin.transform', '1.0.0')!;
        const runtime = await plugins.loadRuntime('builtin.transform', '1.0.0');
        plugins.register({ manifest: { ...manifest, id: 'typed',
            inputs: manifest.inputs.map(port => ({ ...port, schema: ref })),
            outputs: manifest.outputs.map(port => ({ ...port, schema: ref })) }, runtime: async () => runtime });
        const source = { ...valueNode('source', null), plugin: 'typed', config: { outputName: 'result', type: 'json', value: { count: valid ? 2 : 'wrong' } } };
        const target = { ...valueNode('target', null), plugin: 'typed' };
        const submission = new DurableFlowExecutor({ kernel, plugins }).submit('session-one', { nodes: [source, target],
            edges: [{ id: 'typed-edge', from: 'source', to: 'target', input: 'input', output: 'result' }] });
        const run = await submission;
        const exit = await runToEnd(run, 2_000);
        if (valid) {
            expect(exit.status).toBe('succeeded');
            expect((await run.nodes.get('target')!.status()).task.output).toMatchObject({ outputs: { result: { content: { count: 2 } } } });
        } else {
            // The edge contract is checked when the source output is applied, after the
            // root is published, so the failure surfaces on the Run instead of `submit`.
            expect(exit.status).toBe('failed');
            expect(exit.error?.message).toContain('Invalid output source.result: $.count: expected integer');
            expect((await kernel.listSessionTasks('session-one')).some(task => task.labels?.flowNodeId === 'target')).toBe(false);
        }
    });

    it.each([false, true])('enforces the producer contract with a wider consumer (typed: %s)', async typed => {
        const plugins = createBuiltinDagPluginRegistry();
        const narrow = { id: 'count', version: '1' }, wide = { id: 'count', version: '2' };
        plugins.registerSchema(narrow, { type: 'integer' });
        plugins.registerSchema(wide, { type: 'number' });
        const manifest = plugins.getManifest('builtin.transform', '1.0.0')!;
        const runtime = await plugins.loadRuntime('builtin.transform', '1.0.0');
        plugins.register({ manifest: { ...manifest, id: 'producer',
            outputs: manifest.outputs.map(port => ({ ...port, schema: narrow })) }, runtime: async () => runtime });
        plugins.register({ manifest: { ...manifest, id: 'consumer',
            inputs: manifest.inputs.map(port => ({ ...port, schema: wide })) }, runtime: async () => runtime });
        const source = { ...valueNode('source', null), plugin: 'producer',
            config: { outputName: 'result', type: 'json', value: 1.5 } };
        const target = { ...valueNode('target', null), plugin: typed ? 'consumer' : 'builtin.transform' };
        const run = await new DurableFlowExecutor({ kernel, plugins }).submit('session-one', {
            nodes: [source, target], edges: [{ id: 'edge', from: 'source', to: 'target', input: 'input', output: 'result' }],
        });
        const exit = await runToEnd(run);
        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('Invalid output source.result: $: expected integer');
        expect((await kernel.listSessionTasks('session-one')).some(task => task.labels?.flowNodeId === 'target')).toBe(false);
    });

    it.each([[true, false], [false, false], [true, true], [false, true]])('validates an output without data consumers (valid: %s, control: %s)', async (valid, control) => {
        const plugins = createBuiltinDagPluginRegistry();
        const ref = { id: 'report', version: '1' };
        plugins.registerSchema(ref, { type: 'object', required: ['count'], additionalProperties: false,
            properties: { count: { type: 'integer' } } });
        const manifest = plugins.getManifest('builtin.transform', '1.0.0')!;
        const runtime = await plugins.loadRuntime('builtin.transform', '1.0.0');
        plugins.register({ manifest: { ...manifest, id: 'typed',
            outputs: manifest.outputs.map(port => ({ ...port, schema: ref })) }, runtime: async () => runtime });
        // A terminal node with no outgoing edge: only its own declared port can catch this.
        const only = { ...valueNode('only', null), plugin: 'typed',
            config: { outputName: 'result', type: 'json', value: { count: valid ? 2 : 'wrong' } } };
        const run = await new DurableFlowExecutor({ kernel, plugins }).submit('session-one', { nodes: control ? [only, valueNode('target', null)] : [only],
            edges: control ? [{ id: 'control', from: 'only', to: 'target', kind: 'control' }] : [] });
        const exit = await runToEnd(run, 2_000);
        if (valid) {
            expect(exit.status).toBe('succeeded');
        } else {
            expect(exit.status).toBe('failed');
            expect(exit.error?.message).toContain('Invalid output only.result: $.count: expected integer');
        }
    });

    it('rejects changed host contracts on resume without changing durable tasks', async () => {
        const plugins = createBuiltinDagPluginRegistry();
        const first = new DurableFlowExecutor({ kernel, plugins });
        const run = await first.submit('session-one', { nodes: [{ ...valueNode('human', null),
            plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Choose' } }], edges: [] });
        await waitForNode(run, 'human');
        await first.waitForCheckpoint('session-one', run.root.id, [run.nodes.get('human')!.id]);
        kernel.dispose();
        await first.waitIdle(); await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel); await kernel.initialize();
        const before = await kernel.listSessionTasks('session-one');
        const original = plugins.getManifest.bind(plugins);
        vi.spyOn(plugins, 'getManifest').mockImplementation((id, version) => {
            const manifest = original(id, version);
            if (manifest) manifest.outputs = [];
            return manifest;
        });
        await expect(new DurableFlowExecutor({ kernel, plugins }).resume('session-one', run.root.id))
            .rejects.toThrow('Flow plugin contract drift');
        expect(await kernel.listSessionTasks('session-one')).toEqual(before);
    });

    it('resumes the Run definition frozen at submit instead of a later host definition', async () => {
        const frozenNode = (instruction: string): DagRunSpec['nodes'][number] => ({
            id: 'agent', name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: { sessionId: 'session-one', roundId: 'round-one', connectionId: 'default', approval: 'none',
                messages: [{ role: 'user', content: instruction }] },
            inputs: {}, capabilities: [],
        });
        const submission: DagRunSpec = {
            nodes: [{ ...valueNode('answer', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Continue' } },
                frozenNode('DEFINITION-V1')],
            edges: [{ id: 'answer-agent', from: 'answer', to: 'agent', input: 'input', output: 'response' }],
        };
        const initialExecutor = executor(kernel);
        const original = await initialExecutor.submit('session-one', submission);
        await waitForNode(original, 'answer');
        // Read the persisted definition before the host restarts.
        const persisted = (await (await kernel.openSession('session-one'))
            .getShared(`flow.run.${original.root.id}.scheduler`))?.value as { spec: DagRunSpec };
        expect(persisted.spec.nodes.map(node => node.id)).toEqual(['answer', 'agent']);
        expect(JSON.stringify(persisted.spec.nodes)).toContain('DEFINITION-V1');

        // Disposing the kernel stops the first scheduler, whose release makes the Run
        // immediately resumable by another host (no TTL wait).
        kernel.dispose();
        await initialExecutor.waitIdle();
        await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        const prompts: string[] = [];
        const execute = vi.fn(async (...args: Parameters<typeof model.execute>) => {
            prompts.push(JSON.stringify(args[0]));
            return model.execute(...args);
        });
        kernel.registerEffect({ ...model, execute });
        await kernel.initialize();
        await kernel.recover({ takeover: true });

        // A host that meanwhile compiles a different definition must not affect the Run:
        // `resume` takes no spec, and the checkpoint's own graph/instructions win.
        const edited = await flowToDag({ id: 'flow', revision: 2, name: 'Edited', digest: '', createdAt: 0,
            nodes: [{ ...frozenNode('DEFINITION-V2'), id: 'renamed' }], edges: [] } as never, undefined, undefined);
        expect(edited.nodes.map(node => node.id)).toEqual(['renamed']);

        const session = await kernel.openSession('session-one');
        await (await session.attachTask(original.nodes.get('answer')!.id)).respond({ interactionId: 'answer', value: 'yes' });
        const resumedExecutor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
        const resumed = await resumedExecutor.resume('session-one', original.root.id);
        expect((await resumed.root.wait({ timeoutMs: 2_000 })).status).toBe('succeeded');
        await resumedExecutor.waitIdle();
        // Both frozen nodes are attached; the edited definition's node never appears.
        expect([...resumed.nodes.keys()].sort()).toEqual(['agent', 'answer']);
        expect(prompts.join('\n')).toContain('DEFINITION-V1');
        expect(prompts.join('\n')).not.toContain('DEFINITION-V2');
    });

    it('persists each node memory policy without granting it to sibling nodes', async () => {
        const memoryPolicy = { namespaceId: 'node', readScopes: ['project'], writeScopes: [] as string[] };
        const selected = { ...agentFlow().nodes[0], config: { ...agentFlow().nodes[0].config, memoryPolicy } };
        const plain = { ...agentFlow().nodes[0], id: 'plain', name: 'Plain' };
        const run = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() })
            .submit('session-one', { nodes: [selected, plain], edges: [] });
        expect((await run.root.wait({ timeoutMs: 5_000 })).status).toBe('succeeded');
        memoryPolicy.writeScopes.push('later');
        const tasks = await kernel.listSessionTasks('session-one');
        expect((tasks.find(task => task.labels?.flowNodeId === 'agent')!.input as any).memoryPolicy)
            .toEqual({ namespaceId: 'node', readScopes: ['project'], writeScopes: [] });
        expect(tasks.find(task => task.labels?.flowNodeId === 'plain')!.input).not.toHaveProperty('memoryPolicy');
    });

    it('activates a node\'s initially selected Skills through the host port', async () => {
        const withSkill = { ...agentFlow().nodes[0], config: { ...agentFlow().nodes[0].config, skillIds: ['review', 7] } };
        const withoutSkill = { ...agentFlow().nodes[0], id: 'plain', name: 'Plain' };
        const resolveSkillContexts = vi.fn(async (_session: string, skillIds: string[], allowed: string[]) =>
            skillIds.map(skillId => ({ skillId, compactInstructions: 'critical rules',
                tools: allowed.map(toolId => ({ toolId, definition: { name: toolId }, external: false })) })));
        const run = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), resolveSkillContexts })
            .submit('session-one', { nodes: [withSkill, withoutSkill], edges: [] });
        expect((await run.root.wait({ timeoutMs: 5_000 })).status).toBe('succeeded');
        // Only the node that declares Skills asks for snapshots, and never with a non-string id.
        expect(resolveSkillContexts).toHaveBeenCalledTimes(1);
        expect(resolveSkillContexts).toHaveBeenCalledWith('session-one', ['review'], []);
        const tasks = await kernel.listSessionTasks('session-one');
        const skilled = tasks.find(task => task.labels?.flowNodeId === 'agent')!;
        expect((skilled.input as { skillContexts?: unknown }).skillContexts).toEqual([
            { skillId: 'review', compactInstructions: 'critical rules', tools: [] },
        ]);
        expect((tasks.find(task => task.labels?.flowNodeId === 'plain')!.input as { skillContexts?: unknown }).skillContexts)
            .toBeUndefined();
    });

    it('accumulates every dispatched worker result across supervisor rounds', async () => {
        const leadInputs: string[][] = [];
        vi.spyOn(model, 'execute').mockImplementation(async request => {
            const inner = request.request && typeof request.request === 'object'
                ? request.request as Record<string, unknown> : request;
            const messages = Array.isArray(inner.messages) ? inner.messages as Array<{ role?: string; content?: unknown }> : [];
            leadInputs.push(messages.filter(message => message.role === 'user').map(message => String(message.content)));
            const text = JSON.stringify(messages);
            const content = text.includes('A RESULT') && text.includes('B RESULT') ? 'DONE'
                : text.includes('A RESULT') ? 'B' : 'A';
            return { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                usage: { total_tokens: 2 } };
        });

        const execution = await executor(kernel).submit('session-one', supervisorFlow());
        const exit = await execution.root.wait({ timeoutMs: 5_000 });
        expect(exit.status).toBe('succeeded');
        expect(JSON.stringify(exit.output)).toContain('DONE');
        // 每轮只派发一个 worker；第三轮必须同时看到两轮累积的结果。
        expect(leadInputs).toHaveLength(3);
        expect(leadInputs[1].join('\n')).toContain('A RESULT');
        expect(leadInputs[2].join('\n')).toContain('A RESULT');
        expect(leadInputs[2].join('\n')).toContain('B RESULT');
    });

    it('freezes the run graph and schema before asynchronous host hooks can mutate them', async () => {
        const plugins = createBuiltinDagPluginRegistry();
        const schema = { type: 'string' };
        vi.spyOn(plugins, 'getSchema').mockImplementation(() => schema);
        const manifest = plugins.getManifest('builtin.transform', '1.0.0')!;
        const runtime = await plugins.loadRuntime('builtin.transform', '1.0.0');
        plugins.register({ manifest: { ...manifest, id: 'typed',
            inputs: manifest.inputs.map(port => ({ ...port, schema: { id: 'value' } })),
            outputs: manifest.outputs.map(port => ({ ...port, schema: { id: 'value' } })) }, runtime: async () => runtime });
        const flow: DagRunSpec = { nodes: [{ ...valueNode('source', 'original'), plugin: 'typed' },
            { ...valueNode('target', null), plugin: 'typed' }],
            edges: [{ id: 'edge', from: 'source', to: 'target', input: 'input', output: 'result' }] };
        const run = await new DurableFlowExecutor({ kernel, plugins,
            hooks: { descriptor: { trusted: true, source: 'test', contentHash: 'test' }, emit: async event => {
                if (event.event !== 'run.started') return;
                schema.type = 'number';
                (flow.nodes[0].config as any).value = 123;
                flow.edges.length = 0;
            } } }).submit('session-one', flow);
        expect((await run.root.wait({ timeoutMs: 2000 })).status).toBe('succeeded');
        expect((await run.nodes.get('target')!.status()).task.output).toMatchObject({ outputs: { result: { content: 'original' } } });
    });

    it('fails closed when a non-shared workspace mode has no host workspace manager', async () => {
        // Web/Tauri hosts deliberately inject no manager for now (no host-side git channel), so this
        // contract is what keeps a worktree Flow from silently running in the shared workspace.
        const run = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
        await expect(run.submit('session-one', { ...valueFlow(),
            runPolicy: { workspace: { mode: 'worktree' } } } as DagRunSpec))
            .rejects.toThrow('requires a configured workspace manager');
        expect(await kernel.listSessionTasks('session-one')).toEqual([]);
    });

    it('rejects oversized initial graphs before acquiring workspaces or running hooks', async () => {
        const prepare = vi.fn(), emit = vi.fn();
        const run = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            workspaceManager: { prepare }, hooks: { descriptor: { trusted: true, source: 'test', contentHash: 'test' }, emit } });
        await expect(run.submit('session-one', { ...valueFlow(), maxNodes: 1,
            runPolicy: { workspace: { mode: 'worktree' } } } as DagRunSpec)).rejects.toThrow('node limit');
        expect(prepare).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(await kernel.listSessionTasks('session-one')).toEqual([]);
    });

    it('retains the workspace and reports failure when node cancellation is not confirmed', async () => {
        const finish = vi.fn(async () => {}), releaseCapabilities = vi.fn(async () => {});
        const cancel = vi.spyOn(kernel, 'cancel').mockRejectedValue(new Error('cancel denied'));
        const run = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            workspaceManager: { prepare: async () => ({ directory: '/isolated', finish, releaseCapabilities }) },
            hooks: { descriptor: { trusted: true, source: 'test', contentHash: 'test' },
                emit: async event => {
                    if (event.event === 'task.started' && (event.payload as { nodeId?: string })?.nodeId === 'right') {
                        throw new Error('hook failed');
                    }
                } },
        });
        try {
            const execution = await run.submit('session-one', { ...valueFlow(),
                runPolicy: { workspace: { mode: 'worktree' } } } as DagRunSpec);
            const exit = await runToEnd(execution, 2_000);
            await run.waitIdle();
            expect(exit.status).toBe('failed');
            expect(exit.error?.message).toContain('hook failed');
            expect(exit.error?.message).toContain('cancel denied');
            expect(cancel).toHaveBeenCalled();
            expect(releaseCapabilities).not.toHaveBeenCalled();
            expect(finish).not.toHaveBeenCalled();
        } finally { cancel.mockRestore(); }
    });

    it.each([false, true])('cleans up submitted tasks and workspace on scheduler failure (cleanup error: %s)', async cleanupFails => {
        const finish = vi.fn(async () => { if (cleanupFails) throw new Error('cleanup failed'); });
        const run = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            workspaceManager: { prepare: async () => ({ directory: '/isolated', finish }) },
            hooks: { descriptor: { trusted: true, source: 'test', contentHash: 'test' },
                emit: async event => { if (event.event === 'task.started' && (event.payload as { nodeId?: string })?.nodeId === 'right') throw new Error('hook failed'); } },
        });
        const execution = await run.submit('session-one', { ...valueFlow(), runPolicy: { workspace: { mode: 'worktree' } } } as DagRunSpec);
        const exit = await runToEnd(execution, 2_000);
        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('hook failed');
        // A cleanup failure must stay visible even though `submit` already resolved.
        if (cleanupFails) expect(exit.error?.message).toContain('cleanup failed');
        expect(finish).toHaveBeenCalledTimes(1);
        expect(finish).toHaveBeenCalledWith('failed');
        // The aggregate root exists from submission time; every *node* task must be
        // cleaned up (no live task left behind) and the root must not stay live either.
        const tasks = await kernel.listSessionTasks('session-one');
        const nodes = tasks.filter(task => task.labels?.kind !== 'flow-root');
        expect(nodes).toHaveLength(1);
        expect(['succeeded', 'failed', 'cancelled']).toContain(nodes[0].status);
        expect(tasks.filter(task => task.labels?.kind === 'flow-root')).toHaveLength(1);
    });

    it('exposes post-run workspace cleanup failure without invoking cleanup twice', async () => {
        const finish = vi.fn(async () => { throw new Error('cleanup failed'); });
        const run = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            workspaceManager: { prepare: async () => ({ directory: '/isolated', finish }) },
        });
        const execution = await run.submit('session-one', { ...valueFlow(), runPolicy: { workspace: { mode: 'worktree' } } } as DagRunSpec);
        expect((await runToEnd(execution)).status).toBe('succeeded');
        // Workspace finalization starts after the root exits, so its promise is attached later.
        await vi.waitFor(() => expect(execution.workspaceCompletion).toBeDefined());
        await expect(execution.workspaceCompletion).rejects.toThrow('cleanup failed');
        expect(finish).toHaveBeenCalledTimes(1);
        expect(finish).toHaveBeenCalledWith('succeeded');
        expect((await execution.root.wait()).status).toBe('succeeded');
    });

    it('reattaches pending and failed workspace finalization independently of the successful root', async () => {
        let reject!: (error: Error) => void;
        const cleanup = new Promise<void>((_, fail) => { reject = fail; });
        const execution = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            workspaceManager: { prepare: async () => ({ directory: '/isolated', finish: () => cleanup }) },
        }).submit('session-one', { ...valueFlow(), runPolicy: { workspace: { mode: 'worktree' } } } as DagRunSpec);
        await execution.root.wait({ timeoutMs: 2000 });
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        const args = { taskId: execution.root.id, sessionId: 'session-one' };
        expect(await handlers.get(FlowCommand.RunGet)!(args)).toMatchObject({ workspaceFinalization: { status: 'pending' } });
        await vi.waitFor(() => expect(execution.workspaceCompletion).toBeDefined());
        reject(new Error('unable to remove worktree'));
        await expect(execution.workspaceCompletion).rejects.toThrow('unable to remove worktree');
        expect(await handlers.get(FlowCommand.RunGet)!(args)).toMatchObject({
            root: { task: { status: 'succeeded' } }, workspaceFinalization: { status: 'failed', message: 'unable to remove worktree' },
        });
    });

    it('restores an isolated workspace lease instead of preparing a second one', async () => {
        const prepared: string[] = [], restored: string[] = [];
        const manager = {
            prepare: async (sessionId: string) => {
                prepared.push(sessionId);
                return { directory: '/isolated', record: { version: 1, directory: '/isolated' },
                    finish: async () => undefined };
            },
            restore: async (_sessionId: string, _policy: unknown, record: unknown) => {
                restored.push(JSON.stringify(record));
                return { directory: '/isolated', record: record as never, finish: async () => undefined };
            },
        };
        const flow = { nodes: [{ ...valueNode('human', null), plugin: 'builtin.human',
            config: { requestId: 'answer', prompt: 'Choose' } }], edges: [] };
        const first = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            workspaceManager: manager });
        const submission = first.submit('session-one', { ...flow, runPolicy: { workspace: { mode: 'worktree' } } } as DagRunSpec);
        let nodeTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending');
            expect(task).toBeDefined();
            nodeTaskId = task!.id;
        });
        const execution = await submission;
        // The lease record is persisted with the Run, so a new host can re-attach it.
        const session = await kernel.openSession('session-one');
        expect((await session.getShared(workspaceLeaseKey(execution.root.id)))?.value)
            .toEqual({ version: 1, directory: '/isolated' });
        kernel.dispose();
        // Graceful shutdown releases the scheduler lease, so the new host can take over.
        await first.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        await kernel.initialize();

        const resumed = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            workspaceManager: manager }).resume('session-one', execution.root.id);
        expect(prepared).toEqual(['session-one']);
        expect(restored).toEqual([JSON.stringify({ version: 1, directory: '/isolated' })]);
        await (await kernel.openSession('session-one')).attachTask(nodeTaskId)
            .then(task => task.respond({ interactionId: 'answer', value: 'done' }));
        expect((await resumed.root.wait({ timeoutMs: 2_000 })).status).toBe('succeeded');
    });

    it('completes a workspace finalization left pending by a crashed host', async () => {
        const finishes: string[] = [];
        const manager = {
            prepare: async () => ({ directory: '/isolated', record: { version: 1, directory: '/isolated' },
                finish: async (status: string) => { finishes.push(status); } }),
            restore: async (_sessionId: string, _policy: unknown, record: unknown, options?: { forFinalization?: boolean }) => {
                expect(options).toEqual({ forFinalization: true });
                return ({
                directory: '/isolated', record: record as never,
                finish: async (status: string) => { finishes.push(`restored:${status}`); },
            }); },
        };
        const first = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            workspaceManager: manager });
        const execution = await first.submit('session-one', { ...valueFlow(), runPolicy: { workspace: { mode: 'worktree' } } } as DagRunSpec);
        await execution.root.wait({ timeoutMs: 2_000 });
        await execution.workspaceCompletion;
        expect(finishes).toEqual(['succeeded']);

        // Simulate a crash between cleanup and persisting its status.
        const session = await kernel.openSession('session-one');
        await session.setShared(workspaceFinalizationKey(execution.root.id), { status: 'pending' });
        kernel.dispose();
        await first.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        await kernel.initialize();

        await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            workspaceManager: manager }).resume('session-one', execution.root.id);
        expect(finishes).toEqual(['succeeded', 'restored:succeeded']);
        const saved = await (await kernel.openSession('session-one'))
            .getShared(workspaceFinalizationKey(execution.root.id));
        expect(saved?.value).toMatchObject({ status: 'succeeded' });
    });

    it.each(['inherit', 'replace', 'none'])('snapshots Session context for standalone runs with %s prompt policy', async policy => {
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        const resolveSessionContext = vi.fn(async () => ({ projectInstructions: 'project rules', skillInstructions: 'loaded rules', skillIndex: 'available metadata' }));
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never, resolveSessionContext })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        const flow = { ...agentFlow(), id: 'flow', name: 'Flow', revision: 1, createdAt: 1, digest: '', systemPrompt: ['flow rules'] };
        flow.nodes[0].config = { instruction: 'review', systemPrompt: ['node rules'], systemPromptPolicy: policy, approval: 'none' };
        const result = await handlers.get(FlowCommand.RunStart)!({ sessionId: 'session-one', flow });
        expect(result.taskId).toBeTruthy();
        expect(resolveSessionContext).toHaveBeenCalledWith('session-one', '');
        let task!: Awaited<ReturnType<typeof kernel.listSessionTasks>>[number];
        await vi.waitFor(async () => {
            task = (await kernel.listSessionTasks('session-one')).find(item => item.program.kind === 'llm.agent')!;
            expect(task).toBeDefined();
        });
        const content = (task.input as { messages: Array<{ content: string }> }).messages.map(message => message.content);
        expect(content).toEqual(policy === 'none' ? ['review'] : [
            'project rules', 'loaded rules', 'available metadata', ...(policy === 'inherit' ? ['flow rules'] : []), 'node rules', 'review',
        ]);
        expect(task.input).toMatchObject({ allowedToolIds: [] });
    });

    it.each(['inherit', 'none'])('applies a frozen run context to dynamically patched Agent nodes (%s)', async policy => {
        const sessionContext = { projectInstructions: 'original project', skillInstructions: 'loaded rules', skillIndex: 'index' };
        const flow = spawnFlow();
        const config = flow.nodes[0].config as any;
        config.spawn.nodes = [{ id: 'spawned', name: 'child', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: { instruction: 'child request', systemPromptPolicy: policy, approval: 'none' }, inputs: {}, capabilities: [] }];
        const resolveNewRunContext = vi.fn(async () => sessionContext);
        const execution = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), resolveNewRunContext,
            hooks: { descriptor: { source: 'test', trusted: true, contentHash: 'test' },
                emit: async () => { sessionContext.projectInstructions = 'late edit'; } },
        }).submit('session-one', flow);
        expect(resolveNewRunContext).toHaveBeenCalledOnce();
        expect(resolveNewRunContext).toHaveBeenCalledWith('session-one');
        await waitForNode(execution, 'spawned');
        const task = (await execution.nodes.get('spawned')!.status()).task;
        const messages = (task.input as { messages: Array<{ role: string; content: string }> }).messages;
        expect(messages.map(message => message.content)).toEqual(policy === 'none'
            ? ['child request'] : ['original project', 'loaded rules', 'index', 'child request']);
        expect(task.input).toMatchObject({ allowedToolIds: [] });
    });

    it('binds dynamic identities before submission without expanding declared grants', async () => {
        const flow = spawnFlow();
        (flow.nodes[0].config as any).spawn.nodes = [{ id: 'spawned', name: 'child', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: { agentId: 'reviewer', approval: 'none' }, inputs: {}, capabilities: [], budget: { tokens: 10 } }];
        const bindPatchNode = vi.fn(async (_sessionId, node) => {
            await Promise.resolve();
            node.capabilities.push('mutated-tool');
            return { config: { messages: [{ role: 'system', content: 'identity rules' }, { role: 'user', content: 'review' }],
                modelName: 'identity-model', approval: 'none', toolIds: ['identity-tool'],
                delegation: { enabled: true, template: { capabilities: ['identity-tool'] } } },
                capabilities: ['identity-tool'], budget: { tokens: 999 } };
        });
        const execution = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), bindPatchNode })
            .submit('session-one', flow);
        await waitForNode(execution, 'spawned');
        const input = (await execution.nodes.get('spawned')!.status()).task.input;
        expect(bindPatchNode).toHaveBeenCalledTimes(1);
        expect(input).toMatchObject({ model: 'identity-model', allowedToolIds: [], tools: [],
            messages: [{ role: 'system', content: 'identity rules' }, { role: 'user', content: 'review' }] });
    });

    it('executes a dynamically bound delegation identity with the declared child grants', async () => {
        const flow = spawnFlow();
        flow.nodeConnections = { source: { connections: [{ name: 'child-slot', connectionId: 'delegated-connection' }] } };
        const parent = delegationFlow().nodes[0];
        (parent.config as any).delegation.template = { agentId: 'child-agent', capabilities: [] };
        delete (parent.config as any).delegation.resolvedTemplate;
        (flow.nodes[0].config as any).spawn.nodes = [parent];
        (flow.nodes[0].config as any).spawn.edges = [];
        const bindPatchNode = vi.fn(async (_sessionId, node) => ({ config: { ...node.config,
            delegation: { ...node.config.delegation, fanout: { maxTasks: 3 }, resolvedTemplate: {
                plugin: 'builtin.agent', pluginVersion: '1.0.0', capabilities: ['extra-tool'],
                config: { approval: 'none', modelName: 'child-model', connectionId: 'child-slot', toolIds: ['extra-tool'],
                    messages: [{ role: 'system', content: 'resolved child identity' }] },
            } },
        } }));
        const execution = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), bindPatchNode })
            .submit('session-one', flow);
        expect((await runToEnd(execution)).status).toBe('succeeded');
        const input = (await execution.nodes.get('parent:delegate:1:0')!.status()).task.input;
        expect(input).toMatchObject({ model: 'child-model', connectionId: 'delegated-connection', allowedToolIds: [], tools: [] });
        expect(JSON.stringify(input)).toContain('resolved child identity');
        expect(execution.nodes.has('parent:delegate:1:2')).toBe(false);
    });

    it.each(['inherit', 'none'].flatMap(policy => [undefined, 'premium', 'global-id'].map(connectionId => ({ policy, connectionId }))))
    ('inherits Composite defaults and connections in dynamic Agent nodes ($policy, $connectionId)', async ({ policy, connectionId }) => {
        const child = { ...spawnFlow(), id: 'child', name: 'Child', revision: 1, createdAt: 1, digest: '',
            systemPrompt: ['child rules'], toolIds: ['ungranted'],
            connections: [{ name: 'normal', connectionId: 'child-default' }, { name: 'premium', connectionId: 'child-premium' }],
            defaultConnection: 'normal' } as any;
        child.nodes[0].config.spawn.nodes = [{ id: 'spawned', name: 'child agent', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: { systemPromptPolicy: policy, instruction: 'review', approval: 'none', connectionId }, inputs: {}, capabilities: [] }];
        child.nodes[0].config.spawn.edges[0].from = '$parent';
        const outer = { ...child, id: 'outer', systemPrompt: ['outer rules'], connections: [{ name: 'premium', connectionId: 'outer-premium' }], edges: [], nodes: [{ id: 'nested', name: 'Nested',
            plugin: 'builtin.flow', pluginVersion: '1.0.0', config: { flowId: 'child' }, inputs: {} }] };
        const spec = await flowToDag(outer, undefined, undefined, async () => child);
        expect(spec.nodeDefaults?.['nested/source'].systemPrompt).toEqual(['child rules']);
        expect(spec.nodeDefaults).not.toHaveProperty('nested');
        const execution = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            hooks: { descriptor: { trusted: true, source: 'test', contentHash: 'test' }, emit: async () => {
                spec.nodeDefaults!['nested/source'].systemPrompt = ['late edit'];
            } },
        }).submit('session-one', spec);
        await waitForNode(execution, 'spawned');
        const input = (await execution.nodes.get('spawned')!.status()).task.input as any;
        expect(input.messages.map((message: any) => message.content)).toEqual(policy === 'none' ? ['review'] : ['child rules', 'review']);
        expect(input.allowedToolIds).toEqual([]);
        expect(input.connectionId).toBe(connectionId === 'premium' ? 'child-premium' : connectionId ?? 'child-default');
    });

    it('does not submit any patch nodes when a later identity binding fails', async () => {
        const flow = spawnFlow();
        const spawn = (flow.nodes[0].config as any).spawn;
        spawn.nodes.push({ ...spawn.nodes[0], id: 'second' });
        const bindPatchNode = vi.fn(async (_sessionId, node) => {
            if (node.id === 'second') throw new Error('identity unavailable');
            return {};
        });
        const execution = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), bindPatchNode })
            .submit('session-one', flow);
        const exit = await runToEnd(execution, 2_000);
        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('identity unavailable');
        const tasks = await kernel.listSessionTasks('session-one');
        expect(tasks.some(task => ['spawned', 'second'].includes(String(task.labels?.flowNodeId)))).toBe(false);
        expect(bindPatchNode).toHaveBeenCalledTimes(2);
    });

    it('does not duplicate Session context already present in bound Agent messages', async () => {
        const flow = agentFlow();
        (flow.nodes[0].config as any).messages.unshift({ role: 'system', content: 'project rules' });
        const execution = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            sessionContext: { projectInstructions: 'project rules', skillInstructions: '', skillIndex: '' },
        }).submit('session-one', flow);
        await waitForNode(execution, 'agent');
        const input = (await execution.nodes.get('agent')!.status()).task.input as { messages: Array<{ content: string }> };
        expect(input.messages.map(message => message.content)).toEqual(['project rules', 'hello']);
    });

    it('applies host identity binding before standalone node submission', async () => {
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        const bindNode = vi.fn(async (_sessionId, node, defaults) => ({ config: { ...defaults, ...node.config,
            messages: [{ role: 'system', content: 'resolved identity' }, { role: 'user', content: 'task' }], modelName: 'bound-model' } }));
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never, bindNode })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        const flow = { ...agentFlow(), id: 'flow', name: 'Flow', revision: 1, createdAt: 1, digest: '', systemPrompt: ['flow rules'] };
        await handlers.get(FlowCommand.RunStart)!({ sessionId: 'session-one', flow });
        expect(bindNode).toHaveBeenCalledWith('session-one', expect.objectContaining({ id: 'agent' }), expect.objectContaining({ systemPrompt: ['flow rules'] }));
        let task!: Awaited<ReturnType<typeof kernel.listSessionTasks>>[number];
        await vi.waitFor(async () => {
            task = (await kernel.listSessionTasks('session-one')).find(item => item.program.kind === 'llm.agent')!;
            expect(task).toBeDefined();
        });
        expect(task.input).toMatchObject({ model: 'bound-model', messages: [{ role: 'system', content: 'resolved identity' }, { role: 'user', content: 'task' }] });
    });

    it('returns a live handle for a fresh Run before it finishes, giving hosts a monitor window', async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const originalExecute = model.execute;
        model.execute = vi.fn(async (...args: Parameters<typeof model.execute>) => {
            await blocked;
            return originalExecute(...args);
        });
        try {
            // Before the early publish this await would only settle after the whole graph
            // finished, so a non-interactive host could never time out, cancel or follow
            // the Run it just submitted.
            const execution = await executor(kernel).submit('session-one', agentFlow());
            await waitForNode(execution, 'agent');
            expect(await execution.root.poll()).toBeUndefined();
            release();
            expect((await runToEnd(execution)).status).toBe('succeeded');
        } finally {
            release();
            model.execute = originalExecute;
        }
    });

    it('persists fan-in DAG nodes and aggregates every output', async () => {
        const execution = await executor(kernel).submit('session-one', valueFlow());
        const exit = await execution.root.wait({ timeoutMs: 2_000 });
        const nodes = (exit.output as { nodes: Record<string, unknown> }).nodes;

        expect(exit.status).toBe('succeeded');
        expect(Object.keys(nodes)).toEqual(['left', 'right', 'join']);
        expect(JSON.stringify(nodes.join)).toContain('left');
        expect(JSON.stringify(nodes.join)).toContain('right');
    });

    it('runs an Agent node through a granted durable LLM Effect', async () => {
        const execution = await executor(kernel).submit('session-one', agentFlow());
        const exit = await execution.root.wait({ timeoutMs: 2_000 });

        expect(exit.status).toBe('succeeded');
        expect(JSON.stringify(exit.output)).toContain('durable answer');
        expect((await execution.nodes.get('agent')!.status()).task.effects).not.toEqual({});
    });

    it('fails the run when a required Agent node fails', async () => {
        const flow = agentFlow();
        (flow.nodes[0].config as Record<string, unknown>).messages = [{ role: 'user', content: 'fail child' }];
        const execution = await executor(kernel).submit('session-one', flow);
        const exit = await execution.root.wait({ timeoutMs: 2_000 });

        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('child failed');
    });

    it('fails the run when a persistOutput:false node fails', async () => {
        const flow = agentFlow();
        (flow.nodes[0].config as Record<string, unknown>).messages = [{ role: 'user', content: 'fail child' }];
        (flow.nodes[0].config as Record<string, unknown>).persistOutput = false;
        const execution = await executor(kernel).submit('session-one', flow);
        const exit = await execution.root.wait({ timeoutMs: 2_000 });

        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('child failed');
    });

    it('tolerates a failed node when its outgoing edge explicitly continues', async () => {
        const flow = agentFlow();
        (flow.nodes[0].config as Record<string, unknown>).messages = [{ role: 'user', content: 'fail child' }];
        flow.nodes.push(valueNode('after', 'AFTER'));
        flow.edges.push({ id: 'agent-after', from: 'agent', to: 'after', input: 'input', output: 'result', onFailure: 'continue' });

        const execution = await executor(kernel).submit('session-one', flow);
        const exit = await execution.root.wait({ timeoutMs: 2_000 });

        expect(exit.status).toBe('succeeded');
        expect((exit.output as { failures?: Record<string, string> }).failures?.agent).toContain('child failed');
        expect(JSON.stringify(exit.output)).toContain('AFTER');
    });

    it('persists the scheduler checkpoint immediately after a node task is submitted', async () => {
        const flow = agentFlow();
        flow.nodes.unshift({ ...valueNode('answer', null), plugin: 'builtin.human',
            config: { requestId: 'answer', prompt: 'Continue' } });
        flow.edges.push({ id: 'answer-agent', from: 'answer', to: 'agent', input: 'input', output: 'response' });

        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const originalExecute = model.execute;
        model.execute = vi.fn(async (...args: Parameters<typeof model.execute>) => {
            await blocked;
            return originalExecute(...args);
        });
        const submit = vi.spyOn(kernel, 'submit');
        try {
            const run = executor(kernel);
            const original = await run.submit('session-one', flow);
            await waitForNode(original, 'answer');
            const session = await kernel.openSession('session-one');
            await (await session.attachTask(original.nodes.get('answer')!.id))
                .respond({ interactionId: 'answer', value: 'yes' });
            await vi.waitFor(() => expect(original.nodes.has('agent')).toBe(true));
            await run.waitForCheckpoint('session-one', original.root.id, [original.nodes.get('agent')!.id], 1_000);
            const agentSpec = submit.mock.calls
                .map(([, spec]) => spec as { labels?: Record<string, string>; requestId?: string })
                .find(spec => spec.labels?.flowNodeId === 'agent');
            // The generation suffix (@0) keeps crash-recovery dedup stable while letting a
            // graph retry re-submit the same node with a distinct requestId.
            expect(agentSpec?.requestId).toBe(`flow:${original.root.id}:agent#1@0`);
            release();
            expect((await original.root.wait({ timeoutMs: 2_000 })).status).toBe('succeeded');
        } finally {
            release();
            model.execute = originalExecute;
            submit.mockRestore();
        }
    });

    it('routes to the active branch and skips the disabled branch', async () => {
        const execution = await executor(kernel).submit('session-one', routeFlow('go-right'));
        const exit = await execution.root.wait({ timeoutMs: 2_000 });
        const nodes = (exit.output as { nodes: Record<string, unknown> }).nodes;

        expect(exit.status).toBe('succeeded');
        expect(Object.keys(nodes)).toEqual(['source', 'router', 'right']);
        expect(JSON.stringify(nodes.right)).toContain('RIGHT');
        expect(execution.nodes.has('left')).toBe(false);
    });

    it('activates the fallback branch when no rule matches', async () => {
        const execution = await executor(kernel).submit('session-one', routeFlow('unknown'));
        const exit = await execution.root.wait({ timeoutMs: 2_000 });
        const nodes = (exit.output as { nodes: Record<string, unknown> }).nodes;

        expect(exit.status).toBe('succeeded');
        expect(Object.keys(nodes)).toEqual(['source', 'router', 'left']);
        expect(execution.nodes.has('right')).toBe(false);
    });

    it('re-executes loop body nodes up to their iteration limit', async () => {
        const execution = await executor(kernel).submit('session-one', loopFlow(3));
        const exit = await execution.root.wait({ timeoutMs: 3_000 });

        expect(exit.status).toBe('succeeded');
        expect(execution.iterations.get('entry')).toBe(3);
        expect(execution.iterations.get('body')).toBe(3);
        expect(Object.keys((exit.output as { nodes: Record<string, unknown> }).nodes)).toEqual(['entry', 'body']);
    });

    it('does not dispatch the next loop iteration before the previous one completes', async () => {
        const entry = { ...valueNode('entry', 'A'), config: { ...valueNode('entry', 'A').config, maxIterations: 3 } };
        const body = { id: 'body', name: 'body', plugin: 'builtin.human', pluginVersion: '1.0.0',
            config: { requestId: 'body', prompt: 'Continue' }, inputs: {}, capabilities: [] };
        const execution = await executor(kernel).submit('session-one', {
            nodes: [entry, body],
            edges: [
                { id: 'entry-body', from: 'entry', to: 'body', output: 'result', input: 'input' },
                { id: 'body-entry', from: 'body', to: 'entry', output: 'result', input: 'input' },
            ],
        });

        const bodyTasks = async () => (await kernel.listSessionTasks('session-one'))
            .filter(task => task.labels?.flowNodeId === 'body');
        await vi.waitFor(async () => expect(await bodyTasks()).toHaveLength(1));
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(await bodyTasks()).toHaveLength(1);
        expect(execution.iterations.get('body')).toBe(1);

        const session = await kernel.openSession('session-one');
        const respondBody = async () => {
            let pending: Awaited<ReturnType<typeof kernel.listSessionTasks>>[number] | undefined;
            await vi.waitFor(async () => {
                pending = (await bodyTasks()).find(task => task.interactions?.body?.status === 'pending');
                expect(pending).toBeDefined();
            });
            await (await session.attachTask(pending!.id)).respond({ interactionId: 'body', value: 'continue' });
        };
        await respondBody();
        await vi.waitFor(async () => expect(await bodyTasks()).toHaveLength(2));
        await respondBody();
        await vi.waitFor(async () => expect(await bodyTasks()).toHaveLength(3));
        await respondBody();
        expect((await execution.root.wait({ timeoutMs: 3_000 })).status).toBe('succeeded');
        expect(execution.iterations.get('body')).toBe(3);
    });

    it('runs repeated compacted model exchanges as distinct durable Effects', async () => {
        const requests: any[][] = [];
        model.execute = async (raw: any) => {
            requests.push(raw.request.messages);
            const iteration = requests.length;
            return { choices: [{ index: 0, finish_reason: iteration < 5 ? 'tool_calls' : 'stop',
                message: iteration < 5 ? { role: 'assistant', content: null,
                    tool_calls: [{ id: `inspect-${iteration}`, type: 'function', function: { name: 'inspect', arguments: '{}' } }] }
                    : { role: 'assistant', content: 'finished after five distinct requests' } }] };
        };
        kernel.registerEffect({ kind: 'tool.call', version: '1', async execute() {
            return { toolId: 'inspect', success: true, output: 'inspected', durationMs: 1 };
        } });
        const flow = agentFlow();
        flow.nodes[0].capabilities = ['inspect'];
        Object.assign(flow.nodes[0].config as object, {
            contextCompaction: { maxMessages: 4, keepRecent: 1 },
            messages: [{ role: 'system', content: 'Preserve this policy' }, { role: 'user', content: 'Inspect repeatedly' }],
        });
        const execution = await executor(kernel).submit('session-one', flow);
        expect((await execution.root.wait({ timeoutMs: 3_000 })).status).toBe('succeeded');
        expect(requests.map(messages => messages.length)).toEqual([2, 4, 4, 4, 4]);
        expect(requests.every(messages => messages[0].content === 'Preserve this policy')).toBe(true);
        const snapshot = await execution.nodes.get('agent')!.status();
        const effects = Object.values(snapshot.task.effects).filter(effect => effect.request.kind === 'llm.chat');
        expect(effects).toHaveLength(5);
        expect(effects.every(effect => effect.status === 'succeeded')).toBe(true);
        expect(new Set(effects.map(effect => effect.request.idempotencyKey)).size).toBe(5);
        kernel.dispose();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        await kernel.initialize();
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        const transcript = await handlers.get(FlowCommand.RunTranscript)!({ sessionId: 'session-one', taskId: execution.root.id,
            targetTaskId: execution.nodes.get('agent')!.id });
        expect(transcript.effects.filter((effect: any) => effect.request.kind === 'llm.chat')).toHaveLength(5);
        expect(JSON.stringify(transcript.effects)).toContain('inspect-1');
        expect(JSON.stringify(transcript.effects)).toContain('finished after five distinct requests');
        const taskId = execution.nodes.get('agent')!.id;
        const history = await (await (await kernel.openSession('session-one')).attachTask(taskId)).history();
        const early = history.find(task => Object.keys(task.effects).length >= 2 && Object.keys(task.effects).length < 5)!;
        let page = await readFlowTaskTranscript(kernel, 'session-one', execution.root.id, taskId, { version: early.version, limit: 1 });
        const collected = [...page.effects];
        while (page.nextOffset !== undefined) {
            page = await readFlowTaskTranscript(kernel, 'session-one', execution.root.id, taskId,
                { version: page.version, offset: page.nextOffset, limit: 1 });
            collected.push(...page.effects);
        }
        expect(collected.map(effect => effect.effectId)).toEqual(Object.keys(early.effects).sort());
        expect(JSON.stringify(collected)).not.toContain('finished after five distinct requests');
        expect(page.version).toBe(early.version);
        await expect(readFlowTaskTranscript(kernel, 'session-one', execution.root.id, taskId, { offset: 1 }))
            .rejects.toThrow('Invalid transcript page');
    });

    it('executes a command retry with fresh capabilities, preserved budgets and persistent membership', async () => {
        const flow = agentFlow(); flow.nodes[0].budget = { tokens: 3 };
        const execution = await executor(kernel).submit('session-one', flow);
        await execution.root.wait({ timeoutMs: 2000 });
        const rootBefore = (await execution.root.status()).task.output;
        const source = execution.nodes.get('agent')!.id;
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        const budget = vi.spyOn(kernel, 'setBudget');
        const args = { sessionId: 'session-one', taskId: execution.root.id, targetTaskId: source, requestId: 'retry-one' };
        const [first, same] = await Promise.all([handlers.get(FlowCommand.RunTaskRetry)!(args), handlers.get(FlowCommand.RunTaskRetry)!(args)]);
        expect(first.targetTaskId).toBe(same.targetTaskId);
        const task = await (await kernel.openSession('session-one')).attachTask(first.targetTaskId);
        expect((await task.wait({ timeoutMs: 2000 })).status).toBe('succeeded');
        expect(budget).toHaveBeenCalledWith('session-one', expect.any(String), 'tokens', 3, undefined, expect.objectContaining({ lease: expect.objectContaining({ key: schedulerOwnerKey(execution.root.id) }) }));
        const record = (await task.status()).task;
        expect(record).toMatchObject({ retryOfTaskId: source, input: { allowedToolIds: [] } });
        const events = (await kernel.taskEventPage('session-one', task.id)).items;
        expect(events.filter(event => event.type === 'resource.created')).toHaveLength(1);
        expect(events.filter(event => event.type === 'task.started')).toHaveLength(1);
        const snapshot = await handlers.get(FlowCommand.RunGet)!({ taskId: execution.root.id });
        expect(snapshot.taskTree.some((item: any) => item.id === task.id)).toBe(true);
        expect((await execution.root.status()).task.output).toEqual(rootBefore);
        expect((await readFlowTaskTranscript(kernel, 'session-one', execution.root.id, task.id)).effects).not.toHaveLength(0);
        expect((await handlers.get(FlowCommand.RunTaskRetry)!(args)).targetTaskId).toBe(task.id);
    });

    it('targets pending interactions across concurrent retries without selecting an ambiguous request', async () => {
        const session = await kernel.openSession('session-one');
        const submission = executor(kernel).submit('session-one', { nodes: [{ ...valueNode('human', null),
            plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Choose' } }], edges: [] });
        let source = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one')).find(task => task.interactions?.answer?.status === 'pending');
            expect(task).toBeDefined(); source = task!.id;
        });
        await (await session.attachTask(source)).respond({ interactionId: 'answer', value: 'initial' });
        const execution = await submission;
        await execution.root.wait({ timeoutMs: 2000 });
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        await handlers.get(FlowCommand.RunGet)!({ taskId: execution.root.id, sessionId: 'session-one' });
        const retries = await Promise.all(['one', 'two'].map(request => prepareFlowTaskRetry(session, execution.root.id, source, request)));
        await Promise.all(retries.map(task => task.start()));
        await vi.waitFor(async () => {
            for (const task of retries) expect((await task.status()).task.interactions?.answer?.status).toBe('pending');
        });
        const args = { taskId: execution.root.id, requestId: 'answer', value: 'first' };
        await expect(handlers.get(FlowCommand.RunRespond)!(args)).rejects.toThrow('Ambiguous interaction');
        await expect(handlers.get(FlowCommand.RunRespond)!({ ...args, targetTaskId: 'outside' })).rejects.toThrow('outside this run');
        await handlers.get(FlowCommand.RunRespond)!({ ...args, targetTaskId: retries[0].id });
        expect((await retries[0].wait({ timeoutMs: 2000 })).status).toBe('succeeded');
        await expect(handlers.get(FlowCommand.RunRespond)!({ ...args, targetTaskId: retries[0].id })).resolves.toMatchObject({ responded: true });
        await expect(handlers.get(FlowCommand.RunRespond)!({ ...args, targetTaskId: retries[0].id, value: 'different' })).rejects.toThrow('conflict');
        expect((await retries[1].status()).task.interactions?.answer?.status).toBe('pending');
        await handlers.get(FlowCommand.RunRespond)!(args);
        expect((await retries[1].wait({ timeoutMs: 2000 })).status).toBe('succeeded');
    });

    it('re-arms a detached delegation deadline after the scheduling host restarts', async () => {
        const first = executor(kernel);
        const submission = first.submit('session-one', { nodes: [{ ...valueNode('child', null),
            plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Keep waiting' } }], edges: [] });
        let childTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending');
            expect(task).toBeDefined();
            childTaskId = task!.id;
        });
        const execution = await submission;

        // Persist a detached group whose deadline timer lives in the (about to die) host.
        const session = await kernel.openSession('session-one');
        const key = `flow.run.${execution.root.id}.scheduler`;
        const saved = await session.getShared(key);
        const checkpoint = saved!.value as any;
        await session.setShared(key, {
            ...checkpoint,
            detachedNodes: ['child'],
            delegationGroups: [['group-1', { policy: 'continue', children: ['child'], completed: [], succeeded: [],
                waitMode: 'all', quorum: 1, detached: true, deadline: Date.now() + 60, resultOrder: 'declared' }]],
            delegationGroupByChild: [['child', 'group-1']],
        }, { expectedVersion: saved!.version });
        kernel.dispose();
        await first.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        await kernel.initialize();

        await executor(kernel).resume('session-one', execution.root.id);
        // The restored scheduler must cancel the straggler when the persisted deadline passes.
        await vi.waitFor(async () => {
            expect((await kernel.listSessionTasks('session-one')).find(task => task.id === childTaskId)?.status)
                .toBe('cancelled');
        }, { timeout: 2_000 });
    });

    it('resumes a delegation group after a host restart without duplicating child tasks', async () => {
        let firstChild!: () => void, releaseChildren!: () => void;
        const childStarted = new Promise<void>(resolve => { firstChild = resolve; });
        const blocked = new Promise<void>(resolve => { releaseChildren = resolve; });
        const originalExecute = model.execute;
        model.execute = vi.fn(async (...args: Parameters<typeof model.execute>) => {
            const inner = args[0]?.request && typeof args[0].request === 'object'
                ? args[0].request as Record<string, unknown> : args[0];
            if (JSON.stringify(inner.messages ?? '').includes('Handle one payload')) {
                firstChild();
                await blocked;
            }
            return originalExecute(...args);
        });

        const first = executor(kernel);
        const execution = await first.submit('session-one', delegationFlow());
        await childStarted;
        // The child's model call is in flight: the crash loses its outcome while the
        // delegation group and the dispatched child stay committed in the checkpoint.
        kernel.dispose();
        await first.waitIdle();
        await kernel.waitIdle();

        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        kernel.registerEffect(model);
        await kernel.initialize();
        await kernel.recover({ takeover: true });

        const resumedExecutor = executor(kernel);
        const resumed = await resumedExecutor.resume('session-one', execution.root.id);
        // The lost Effect is indeterminate; the host authorizes replaying the same logical
        // Effect, which must reuse the committed child instead of fanning out again.
        await vi.waitFor(async () => {
            const blockedEffects = (await kernel.listSessionTasks('session-one')).flatMap(task =>
                Object.entries(task.effects).filter(([, effect]) => effect.status === 'indeterminate')
                    .map(([effectId]) => ({ taskId: task.id, effectId })));
            expect(blockedEffects.length).toBeGreaterThan(0);
            for (const item of blockedEffects) {
                await (await kernel.openTask(item.taskId)).resolveEffect({
                    requestId: `resolve:${item.effectId}:retry`, effectId: item.effectId, outcome: { type: 'retry' },
                });
            }
        });
        releaseChildren();
        expect((await resumed.root.wait({ timeoutMs: 5_000 })).status).toBe('succeeded');
        // Exactly the two fan-out children, no second delegation round.
        expect([...resumed.nodes.keys()].filter(id => id.startsWith('parent:delegate')).sort())
            .toEqual(['parent:delegate:1:0', 'parent:delegate:1:1']);
        await resumedExecutor.waitIdle();
    });

    it('reuses a submitted node Task when the scheduler checkpoint missed the instance', async () => {
        const first = executor(kernel);
        const execution = await first.submit('session-one', { nodes: [{ ...valueNode('human', null),
            plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Choose' } }], edges: [] });
        const session = await kernel.openSession('session-one');
        let nodeTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending');
            expect(task).toBeDefined();
            nodeTaskId = task!.id;
        });
        // The scheduler checkpoints every submitted instance, so a crash can resume from
        // the committed schedule instead of re-creating nodes.
        const key = `flow.run.${execution.root.id}.scheduler`;
        const saved = await session.getShared(key);
        const checkpoint = saved!.value as { instances: unknown[] };
        expect(checkpoint.instances).toContainEqual(['human', [nodeTaskId]]);

        // Simulate a crash between session.submit and the checkpoint write: the durable
        // checkpoint has no record of the submitted instance.
        await session.setShared(key, { ...checkpoint, instances: [] }, { expectedVersion: saved!.version });
        kernel.dispose();
        await first.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        await kernel.initialize();

        const resumed = await executor(kernel).resume('session-one', execution.root.id);
        // The node submission carries a Run-stable requestId, so the Kernel returns the
        // existing Task instead of creating a duplicate instance.
        await (await kernel.openSession('session-one')).attachTask(nodeTaskId)
            .then(task => task.respond({ interactionId: 'answer', value: 'done' }));
        const exit = await resumed.root.wait({ timeoutMs: 2_000 });
        expect(exit.status).toBe('succeeded');
        const nodes = (await kernel.listSessionTasks('session-one'))
            .filter(task => task.labels?.kind !== 'flow-root');
        expect(nodes.map(task => task.id)).toEqual([nodeTaskId]);
        expect(resumed.nodes.get('human')!.id).toBe(nodeTaskId);
    });

    it('recomputes downstream nodes after a graph retry of an upstream node', async () => {
        const flow: DagRunSpec = {
            nodes: [
                { ...valueNode('human', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'First' } },
                valueNode('after', null),
                valueNode('last', null),
                { ...valueNode('human2', null), plugin: 'builtin.human', config: { requestId: 'answer2', prompt: 'Second' } },
            ],
            edges: [
                { id: 'human-after', from: 'human', to: 'after', output: 'response', input: 'input' },
                { id: 'after-last', from: 'after', to: 'last', output: 'result', input: 'input' },
                { id: 'last-human2', from: 'last', to: 'human2', output: 'result', input: 'input' },
            ],
        };
        const first = executor(kernel);
        const submission = first.submit('session-one', flow);
        let humanTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending');
            expect(task).toBeDefined();
            humanTaskId = task!.id;
        });
        const execution = await submission;
        const session = await kernel.openSession('session-one');
        await (await session.attachTask(humanTaskId)).respond({ interactionId: 'answer', value: 'FIRST-VALUE' });
        // The Run pauses at the second human node with committed downstream work.
        let staleAfter = '', staleHuman2 = '';
        await vi.waitFor(async () => {
            const tasks = await kernel.listSessionTasks('session-one');
            expect(tasks.some(task => task.interactions?.answer2?.status === 'pending')).toBe(true);
            staleAfter = tasks.find(task => task.labels?.flowNodeId === 'after')!.id;
            staleHuman2 = tasks.find(task => task.interactions?.answer2?.status === 'pending')!.id;
        });

        const request = await requestFlowGraphRetry(session, execution.root.id, humanTaskId, 'retry-1');
        expect(request).toMatchObject({ sourceNodeId: 'human', downstream: ['after', 'human2', 'last'] });

        kernel.dispose();
        await first.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        await kernel.initialize();

        const resumed = await executor(kernel).resume('session-one', execution.root.id);
        await (await kernel.openSession('session-one')).attachTask(request.retryTaskId)
            .then(task => task.respond({ interactionId: 'answer', value: 'RETRY-VALUE' }));
        // The recomputed downstream chain asks for the second input again, as a new Task.
        let secondTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer2?.status === 'pending' && item.id !== staleHuman2);
            expect(task).toBeDefined();
            secondTaskId = task!.id;
        });
        await (await kernel.openSession('session-one')).attachTask(secondTaskId)
            .then(task => task.respond({ interactionId: 'answer2', value: 'done' }));
        const exit = await resumed.root.wait({ timeoutMs: 5_000 });
        expect(exit.status).toBe('succeeded');
        const nodes = (exit.output as { nodes: Record<string, { outputs: Record<string, { content: unknown }> }> }).nodes;
        expect(nodes.last.outputs.result.content).toBe('RETRY-VALUE');
        // The stale downstream instance was replaced, not kept alongside the new one.
        expect(resumed.nodes.get('after')!.id).not.toBe(staleAfter);
    });

    it('refunds discarded downstream tokens so a graph retry is not double-charged', async () => {
        const agentNode = (id: string) => ({ ...agentFlow().nodes[0], id, name: id,
            config: { ...agentFlow().nodes[0].config, roundId: `round-${id}` } });
        const flow: DagRunSpec = {
            nodes: [
                { ...valueNode('human', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'First' } },
                agentNode('after'),
                agentNode('last'),
                { ...valueNode('human2', null), plugin: 'builtin.human', config: { requestId: 'answer2', prompt: 'Second' } },
            ],
            edges: [
                { id: 'human-after', from: 'human', to: 'after', output: 'response', input: 'input' },
                { id: 'after-last', from: 'after', to: 'last', output: 'result', input: 'input' },
                { id: 'last-human2', from: 'last', to: 'human2', output: 'result', input: 'input' },
            ],
            // Each agent answer reports 2 tokens: after + last cost 4, and the recomputation
            // after the retry must cost another 4 without exceeding the budget.
            maxTokens: 6,
        };
        const first = executor(kernel);
        const submission = first.submit('session-one', flow);
        let humanTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending');
            expect(task).toBeDefined();
            humanTaskId = task!.id;
        });
        const execution = await submission;
        const session = await kernel.openSession('session-one');
        await (await session.attachTask(humanTaskId)).respond({ interactionId: 'answer', value: 'FIRST' });

        // after + last commit (4 tokens) and the Run pauses at the second human node.
        let staleHuman2 = '';
        await vi.waitFor(async () => {
            const tasks = await kernel.listSessionTasks('session-one');
            expect(tasks.some(task => task.interactions?.answer2?.status === 'pending')).toBe(true);
            staleHuman2 = tasks.find(task => task.interactions?.answer2?.status === 'pending')!.id;
        });

        const request = await requestFlowGraphRetry(session, execution.root.id, humanTaskId, 'retry-budget');
        kernel.dispose();
        await first.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        kernel.registerEffect(model);
        await kernel.initialize();

        const resumed = await executor(kernel).resume('session-one', execution.root.id);
        await (await kernel.openSession('session-one')).attachTask(request.retryTaskId)
            .then(task => task.respond({ interactionId: 'answer', value: 'RETRY' }));
        let secondTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer2?.status === 'pending' && item.id !== staleHuman2);
            expect(task).toBeDefined();
            secondTaskId = task!.id;
        });
        await (await kernel.openSession('session-one')).attachTask(secondTaskId)
            .then(task => task.respond({ interactionId: 'answer2', value: 'done' }));

        // Without the refund the recomputation would bill 8/6 and fail the Run.
        const exit = await resumed.root.wait({ timeoutMs: 5_000 });
        expect(exit.status).toBe('succeeded');
        expect(resumed.usage.tokens).toBe(4);
    });

    it.each([false, true])('recomputes a delegation group after an upstream retry (nested: %s)', async nested => {
        const flow = delegationFlow();
        if (nested) {
            const declaration = (flow.nodes[0].config as any).delegation;
            const childDeclaration = structuredClone(declaration);
            childDeclaration.fanout.maxDepth = 2;
            declaration.resolvedTemplate.config.delegation = childDeclaration;
            declaration.resolvedTemplate.config.messages = [{ role: 'user', content: 'delegate now' }];
        }
        flow.nodes.unshift(valueNode('source', 'delegate now'));
        flow.edges.push({ id: 'source-parent', from: 'source', to: 'parent', output: 'result', input: 'request', kind: 'data' });
        flow.nodes.push({ ...valueNode('human', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Done?' } });
        flow.edges.push({ id: 'parent-human', from: 'parent', to: 'human', output: 'result', input: 'input' });

        const first = executor(kernel);
        const submission = first.submit('session-one', flow);
        let humanTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending');
            expect(task).toBeDefined();
            humanTaskId = task!.id;
        });
        const execution = await submission;
        // The parent's delegation materialized a group whose children are committed.
        expect(execution.nodes.has('parent:delegate:1:0')).toBe(true);
        const staleChildId = execution.nodes.get('parent:delegate:1:0')!.id;
        const nestedNodeId = 'parent:delegate:1:0:delegate:1:0';
        if (nested) await vi.waitFor(() => expect(execution.nodes.has(nestedNodeId)).toBe(true));
        const staleNestedId = execution.nodes.get(nestedNodeId)?.id;
        const session = await kernel.openSession('session-one');

        // A delegated child has no declared node to recompute, so it is still refused.
        await expect(requestFlowGraphRetry(session, execution.root.id, execution.nodes.get('parent:delegate:1:0')!.id, 'retry-child'))
            .rejects.toThrow('delegated node');

        // Retrying upstream of the parent recomputes the parent, which drops the old group
        // and re-delegates rather than leaving stale children behind.
        const request = await requestFlowGraphRetry(session, execution.root.id, execution.nodes.get('source')!.id, 'retry-source');
        expect(request.downstream).toContain('parent');
        expect(request.downstream.some(nodeId => nodeId.includes(':delegate:'))).toBe(false);

        kernel.dispose();
        await first.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        kernel.registerEffect(model);
        await kernel.initialize();

        const resumedExecutor = executor(kernel);
        const resumed = await resumedExecutor.resume('session-one', execution.root.id);
        // The discarded children are re-materialized as fresh Tasks, not replayed.
        await vi.waitFor(() => {
            const child = resumed.nodes.get('parent:delegate:1:0');
            expect(child).toBeDefined();
            expect(child!.id).not.toBe(staleChildId);
        }, { timeout: 3_000 });
        expect(resumed.nodes.has('parent:delegate:1:1')).toBe(true);
        if (nested) await vi.waitFor(() => {
            expect(resumed.nodes.get(nestedNodeId)).toBeDefined();
            expect(resumed.nodes.get(nestedNodeId)!.id).not.toBe(staleNestedId);
        }, { timeout: 3_000 });
        let secondHumanId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending' && item.id !== humanTaskId);
            expect(task).toBeDefined();
            secondHumanId = task!.id;
        });
        await (await (await kernel.openSession('session-one')).attachTask(secondHumanId)).respond({ interactionId: 'answer', value: 'done' });
        expect((await resumed.root.wait({ timeoutMs: 5_000 })).status).toBe('succeeded');
        expect(resumed.nodes.get('parent:delegate:1:0')!.id).not.toBe(staleChildId);
        await resumedExecutor.waitIdle();
    });

    it('recomputes a delegation group inside an isolated workspace without re-preparing it', async () => {
        const manager = {
            prepare: vi.fn(async () => ({ directory: '/isolated', record: { version: 1, directory: '/isolated' },
                finish: async () => undefined })),
            restore: vi.fn(async (_sessionId: string, _policy: unknown, record: unknown) => ({
                directory: '/isolated', record: record as never, finish: async () => undefined,
            })),
        };
        const flow = delegationFlow();
        flow.nodes.unshift(valueNode('source', 'delegate now'));
        flow.edges.push({ id: 'source-parent', from: 'source', to: 'parent', output: 'result', input: 'request', kind: 'data' });
        flow.nodes.push({ ...valueNode('human', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Done?' } });
        flow.edges.push({ id: 'parent-human', from: 'parent', to: 'human', output: 'result', input: 'input' });
        const spec = { ...flow, runPolicy: { workspace: { mode: 'worktree' } } } as DagRunSpec;

        const first = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), workspaceManager: manager });
        const submission = first.submit('session-one', spec);
        let humanTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending');
            expect(task).toBeDefined();
            humanTaskId = task!.id;
        });
        const execution = await submission;
        const staleChildId = execution.nodes.get('parent:delegate:1:0')!.id;
        const session = await kernel.openSession('session-one');

        await requestFlowGraphRetry(session, execution.root.id, execution.nodes.get('source')!.id, 'retry-isolated');
        kernel.dispose();
        await first.waitIdle();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        kernel.registerEffect(model);
        await kernel.initialize();

        const resumedExecutor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), workspaceManager: manager });
        const resumed = await resumedExecutor.resume('session-one', execution.root.id);
        await vi.waitFor(() => {
            const child = resumed.nodes.get('parent:delegate:1:0');
            expect(child).toBeDefined();
            expect(child!.id).not.toBe(staleChildId);
        }, { timeout: 3_000 });
        let secondHumanId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending' && item.id !== humanTaskId);
            expect(task).toBeDefined();
            secondHumanId = task!.id;
        });
        await (await (await kernel.openSession('session-one')).attachTask(secondHumanId)).respond({ interactionId: 'answer', value: 'done' });
        expect((await resumed.root.wait({ timeoutMs: 5_000 })).status).toBe('succeeded');
        // The recompute reuses the restored workspace instead of preparing a second one.
        expect(manager.prepare).toHaveBeenCalledTimes(1);
        expect(manager.restore).toHaveBeenCalledTimes(1);
        await resumedExecutor.waitIdle();
    });

    it.each([false, true])('fences a delayed scheduler without cancelling the successor (hook throws: %s)', async hookThrows => {
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const cleanup = vi.fn(async (_status: string) => undefined);
        const workspaceManager = {
            prepare: async () => ({ directory: '/isolated', record: { path: '/isolated' }, finish: cleanup }),
            restore: async () => ({ directory: '/isolated', finish: cleanup }),
        };
        const first = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), workspaceManager,
            schedulerOwnerId: 'host', hooks: { descriptor: { trusted: true, source: 'test', contentHash: 'test' },
                emit: async event => { if (event.event === 'task.started') {
                    entered(); await gate; if (hookThrows) throw new Error('late hook failure');
                } } } });
        const run = await first.submit('session-one', { ...valueFlow(), runPolicy: { workspace: { mode: 'worktree' } } });
        await started;
        // Reusing the host identity deliberately increments the epoch while its old hook is pending.
        const successor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), workspaceManager,
            schedulerOwnerId: 'host' });
        const resumed = await successor.resume('session-one', run.root.id);
        expect((await resumed.root.wait({ timeoutMs: 2000 })).status).toBe('succeeded');
        await successor.waitIdle();
        const before = await kernel.listSessionTasks('session-one');
        release();
        await first.waitIdle();
        expect(await kernel.listSessionTasks('session-one')).toEqual(before);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledWith('succeeded');
    });

    it('refuses a second scheduler while the owner lease is live and fences the old owner', async () => {
        const humanFlow: DagRunSpec = { nodes: [{ ...valueNode('human', null),
            plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Choose' } }], edges: [] };
        const first = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            schedulerOwnerId: 'host-a', schedulerLeaseTtlMs: 60_000 });
        const submission = first.submit('session-one', humanFlow);
        let nodeTaskId = '';
        await vi.waitFor(async () => {
            const task = (await kernel.listSessionTasks('session-one'))
                .find(item => item.interactions?.answer?.status === 'pending');
            expect(task).toBeDefined();
            nodeTaskId = task!.id;
        });
        const execution = await submission;

        // A different host must not override a live owner.
        const second = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            schedulerOwnerId: 'host-b', schedulerLeaseTtlMs: 60_000 });
        await expect(second.resume('session-one', execution.root.id)).rejects.toThrow(/scheduled by host-a/);

        // A declared clock-error constraint reaches the lease: the refusal now names the
        // budget, so a fast host cannot take over a live owner on a skewed clock.
        const skewed = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            schedulerOwnerId: 'host-c', schedulerLeaseTtlMs: 60_000, schedulerLeaseSkewMs: 5_000 });
        await expect(skewed.resume('session-one', execution.root.id)).rejects.toThrow(/5000ms clock skew budget/);

        // The same identity may resume (host restart): its higher epoch fences the old loop,
        // which stops without failing the Run, and the new scheduler continues it.
        const sameHost = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            schedulerOwnerId: 'host-a', schedulerLeaseTtlMs: 60_000 });
        const resumed = await sameHost.resume('session-one', execution.root.id);
        await (await kernel.openSession('session-one')).attachTask(nodeTaskId)
            .then(task => task.respond({ interactionId: 'answer', value: 'done' }));
        expect((await resumed.root.wait({ timeoutMs: 2_000 })).status).toBe('succeeded');
        const owner = (await (await kernel.openSession('session-one'))
            .getShared(`flow.run.${execution.root.id}.scheduler-owner`))?.value as { ownerId: string; epoch: number };
        expect(owner).toMatchObject({ ownerId: 'host-a', epoch: 2 });
    });

    it.each(['target', 'node', 'cancel'])('refreshes persisted retry membership before %s control', async operation => {
        const execution = await executor(kernel).submit('session-one', valueFlow());
        await execution.root.wait({ timeoutMs: 2000 });
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        await handlers.get(FlowCommand.RunGet)!({ taskId: execution.root.id, sessionId: 'session-one' });
        const session = await kernel.openSession('session-one');
        const retry = await prepareFlowTaskRetry(session, execution.root.id, execution.nodes.get('left')!.id, 'control');
        const args = { taskId: execution.root.id, targetTaskId: retry.id };
        const command = operation === 'cancel' ? FlowCommand.RunTaskCancel : FlowCommand.RunSignal;
        if (operation === 'cancel') {
            await handlers.get(command)!(args);
            expect((await retry.status()).task.status).toBe('cancelled');
        } else {
            const target = operation === 'node' ? { taskId: execution.root.id, nodeId: 'left' } : args;
            expect(await handlers.get(command)!({ ...target, signal: { type: 'inject', payload: 'new task' } }))
                .toMatchObject({ targetTaskId: retry.id, signalled: true });
            expect((await kernel.taskEventPage('session-one', retry.id)).items.some(event => event.type === 'task.signal')).toBe(true);
        }
        await expect(handlers.get(command)!({ ...args, targetTaskId: 'outside', signal: { type: 'inject' } }))
            .rejects.toThrow('outside this run');
    });

    it('cancels all concurrent retry members even when the cached latest node is older', async () => {
        const execution = await executor(kernel).submit('session-one', valueFlow());
        await execution.root.wait({ timeoutMs: 2000 });
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        await handlers.get(FlowCommand.RunGet)!({ taskId: execution.root.id, sessionId: 'session-one' });
        const session = await kernel.openSession('session-one');
        const retries = await Promise.all(['one', 'two'].map(request => prepareFlowTaskRetry(session, execution.root.id,
            execution.nodes.get('left')!.id, request)));
        await handlers.get(FlowCommand.RunCancel)!({ taskId: execution.root.id });
        for (const retry of retries) expect((await retry.status()).task.status).toBe('cancelled');
    });

    it('persists concurrent manual retry membership before execution and preserves node budgets', async () => {
        const flow = valueFlow(); flow.nodes[0].budget = { tokens: 7 };
        const execution = await executor(kernel).submit('session-one', flow);
        await execution.root.wait({ timeoutMs: 2000 });
        const session = await kernel.openSession('session-one'), source = execution.nodes.get('left')!.id;
        const [first, duplicate, second] = await Promise.all(['one', 'one', 'two'].map(request =>
            prepareFlowTaskRetry(session, execution.root.id, source, request)));
        expect(first.id).toBe(duplicate.id); expect(second.id).not.toBe(first.id);
        expect((await first.status()).task.status).toBe('created');
        const saved = (await session.getShared(`flow.run.${execution.root.id}.retries`))!.value as any[];
        expect(saved).toHaveLength(2);
        expect(saved.map(entry => entry.iteration).sort()).toEqual([2, 3]);
        expect(saved.every(entry => entry.retryOfTaskId === source && entry.budget.tokens === 7)).toBe(true);
        const restored = await restoreFlowHandle(session, execution.root.id);
        expect(restored.iterations.get('left')).toBe(3);
        expect(restored.taskIds.has(first.id)).toBe(true);
        expect((await readFlowTaskTranscript(kernel, 'session-one', execution.root.id, first.id)).taskId).toBe(first.id);
        await expect(prepareFlowTaskRetry(session, execution.root.id, source, '')).rejects.toThrow('requestId');
        await expect(prepareFlowTaskRetry(session, execution.root.id, execution.root.id, 'root')).rejects.toThrow('outside this run');
    });

    it('reattaches persisted Run nodes, iterations, usage and updated goals in a new service', async () => {
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        const register = () => new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        register();
        const flow = { ...loopFlow(3), id: 'flow', name: 'Flow', revision: 1, createdAt: 1, digest: '' };
        const { taskId } = await handlers.get(FlowCommand.RunStart)!({ sessionId: 'session-one', flow, goal: { objective: 'original' } });
        // `RunStart` returns as soon as the durable root exists; capture the baseline
        // only after the loop graph has actually run to completion.
        await vi.waitFor(async () => {
            const snapshot = await handlers.get(FlowCommand.RunGet)!({ taskId });
            expect(snapshot.root.task.status).toBe('succeeded');
        });
        const before = await handlers.get(FlowCommand.RunGet)!({ taskId });
        await handlers.get(FlowCommand.RunGoalUpdate)!({ taskId, goal: { objective: 'updated' } });
        kernel.dispose();
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        await kernel.initialize();
        register();
        const restored = await handlers.get(FlowCommand.RunGet)!({ taskId, sessionId: 'session-one' });
        expect(restored.attachedFromStorage).toBe(true);
        expect(restored.goal.objective).toBe('updated');
        expect(restored.iterations).toEqual(before.iterations);
        expect(restored.nodes.map((node: any) => [node.nodeId, node.snapshot.task.id]))
            .toEqual(before.nodes.map((node: any) => [node.nodeId, node.snapshot.task.id]));
        expect(restored.taskTree.map((task: any) => task.id).sort()).toEqual(before.taskTree.map((task: any) => task.id).sort());
        expect(restored.usage).toEqual(before.usage);
        const attachedGet = handlers.get(FlowCommand.RunGet)!;
        register();
        await handlers.get(FlowCommand.RunGet)!({ taskId, sessionId: 'session-one' });
        await handlers.get(FlowCommand.RunGoalUpdate)!({ taskId, goal: { objective: 'updated by another service' } });
        expect((await attachedGet({ taskId })).goal.objective).toBe('updated by another service');
        await expect(handlers.get(FlowCommand.RunGet)!({ taskId, sessionId: 'wrong' })).rejects.toThrow('Session mismatch');
    });

    it('rejects signals addressed to a task outside the selected Run', async () => {
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        const flow = { ...valueFlow(), id: 'flow', name: 'Flow', revision: 1, createdAt: 1, digest: '' };
        const run = await handlers.get(FlowCommand.RunStart)!({ sessionId: 'session-one', flow });
        const other = await executor(kernel).submit('session-one', valueFlow());
        await runToEnd(other, 2_000);
        const target = other.nodes.get('left')!;
        const before = (await target.status()).task.pendingEvents;
        await expect(handlers.get(FlowCommand.RunSignal)!({ taskId: run.taskId, targetTaskId: target.id,
            signal: { type: 'steer', payload: 'wrong run' } })).rejects.toThrow('outside this run');
        expect((await target.status()).task.pendingEvents).toEqual(before);
    });

    it.each([0, -1, 501, NaN])('rejects invalid transcript page limits before reading tasks (%s)', async limit => {
        await expect(readFlowTaskTranscript(kernel, 'missing', 'missing', 'missing', { limit }))
            .rejects.toThrow('Invalid transcript page');
    });

    it('includes suppressed loop instances in transcript membership and rejects unrelated tasks', async () => {
        const flow = loopFlow(3);
        (flow.nodes[0].config as any).persistOutput = false;
        const execution = await executor(kernel).submit('session-one', flow);
        await execution.root.wait({ timeoutMs: 3_000 });
        const root = (await execution.root.status()).task;
        // Membership is published to shared state while the Run is live, so it is the
        // authoritative view; the root's own input only carries the initial schedule.
        const runTasks = await readFlowRunMembers(await kernel.openSession('session-one'), root);
        const entries = runTasks.filter(task => task.nodeId === 'entry');
        expect(entries).toHaveLength(3);
        for (const entry of entries) {
            expect((await readFlowTaskTranscript(kernel, 'session-one', root.id, entry.taskId)).taskId).toBe(entry.taskId);
        }
        const unrelated = await executor(kernel).submit('session-one', valueFlow());
        await runToEnd(unrelated, 2_000);
        await expect(readFlowTaskTranscript(kernel, 'session-one', root.id, unrelated.nodes.get('left')!.id))
            .rejects.toThrow('outside this run');
        await expect(readFlowTaskTranscript(kernel, 'session-one', entries[0].taskId, entries[0].taskId))
            .rejects.toThrow('Not a Flow run');
    });

    it('dynamically spawns nodes via a patch-graph effect', async () => {
        const execution = await executor(kernel).submit('session-one', spawnFlow());
        const exit = await execution.root.wait({ timeoutMs: 3_000 });
        const nodes = (exit.output as { nodes: Record<string, unknown> }).nodes;

        expect(exit.status).toBe('succeeded');
        expect(Object.keys(nodes)).toEqual(['source', 'spawned']);
        expect(JSON.stringify(nodes.spawned)).toContain('SPAWNED');
        expect(execution.iterations.get('spawned')).toBe(1);
    });

    it('fans out bounded structured delegation payloads', async () => {
        const execution = await new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            sessionContext: { projectInstructions: 'delegation project rules', skillInstructions: '', skillIndex: '' },
        }).submit('session-one', delegationFlow());
        await waitForNode(execution, 'parent:delegate:1:0');
        const childInput = (await execution.nodes.get('parent:delegate:1:0')!.status()).task.input as { messages: Array<{ content: string }> };
        expect(childInput.messages.map(message => message.content)).toContain('delegation project rules');
        const exit = await execution.root.wait({ timeoutMs: 3_000 });
        const nodes = (exit.output as { nodes: Record<string, unknown> }).nodes;

        expect(exit.status).toBe('succeeded');
        expect(Object.keys(nodes)).toContain('parent:delegate:1:0');
        expect(Object.keys(nodes)).toContain('parent:delegate:1:1');
        expect(Object.keys(nodes)).not.toContain('parent:delegate:1:2');
        expect(JSON.stringify(nodes['parent:delegate:1:0'])).toContain('durable answer');
    });

    it('keeps parent upstream data when the child template is isolated', async () => {
        const flow = delegationFlow();
        flow.nodes.unshift(valueNode('source', 'delegate now'));
        (flow.nodes.find(node => node.id === 'parent')!.config as Record<string, unknown>).messages = [
            { role: 'system', content: 'Use the upstream request' },
        ];
        flow.edges.push({
            id: 'source-parent', from: 'source', to: 'parent', output: 'result', input: 'request', kind: 'data',
        });

        const execution = await executor(kernel).submit('session-one', flow);
        await waitForNode(execution, 'parent:delegate:1:0');
        expect(execution.nodes.has('parent:delegate:1:0')).toBe(true);
    });

    it('fails the flow and cancels the delegation group on fail-fast', async () => {
        const flow = delegationFlow();
        const delegation = (flow.nodes[0].config as Record<string, any>).delegation;
        delegation.resolvedTemplate.config.messages = [{ role: 'system', content: 'fail child' }];
        delegation.failure = { policy: 'fail-fast' };

        const execution = await executor(kernel).submit('session-one', flow);
        const exit = await runToEnd(execution, 3_000);
        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('child failed');
    });

    it('can exclude delegated outputs from the Flow result', async () => {
        const flow = delegationFlow();
        (flow.nodes[0].config as Record<string, any>).delegation.join = { mode: 'none' };
        const execution = await executor(kernel).submit('session-one', flow);
        const exit = await execution.root.wait({ timeoutMs: 3_000 });
        const nodes = (exit.output as { nodes: Record<string, unknown> }).nodes;

        expect(Object.keys(nodes)).toEqual(['parent']);
    });

    it('enforces run node limits before applying a dynamic patch', async () => {
        const execution = await executor(kernel).submit('session-one', { ...spawnFlow(), maxNodes: 1 });
        const exit = await runToEnd(execution, 2_000);
        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('node limit');
    });

    it('resolves $parent dependencies in spawned graph patches', async () => {
        const flow = spawnFlow();
        const spawn = (flow.nodes[0].config as Record<string, any>).spawn;
        spawn.edges = [{ id: 'source-spawned', from: '$parent', to: 'spawned', kind: 'control' }];
        const execution = await executor(kernel).submit('session-one', flow);
        expect((await execution.root.wait({ timeoutMs: 2_000 })).status).toBe('succeeded');
        expect(execution.nodes.has('spawned')).toBe(true);
    });

    it.each([
        ['duplicate nodes', (spawn: any) => spawn.nodes.push({ ...spawn.nodes[0] }), 'node id'],
        ['existing node identity', (spawn: any) => spawn.nodes[0].id = 'source', 'node id'],
        ['duplicate edges', (spawn: any) => spawn.edges.push({ ...spawn.edges[0] }), 'edge id'],
        ['dynamic cycle', (spawn: any) => spawn.edges.push({ id: 'cycle', from: 'spawned', to: 'spawned', kind: 'control' }), 'cycle'],
        ['unknown endpoint', (spawn: any) => spawn.edges[0].from = 'missing', 'scope'],
        ['existing target', (spawn: any) => spawn.edges[0].to = 'source', 'scope'],
        ['unknown output', (spawn: any) => spawn.edges[0].output = 'missing', 'output'],
        ['unknown input', (spawn: any) => spawn.edges[0].input = 'missing', 'input'],
    ])('rejects %s before creating spawned tasks', async (_name, mutate, error) => {
        const flow = spawnFlow();
        mutate((flow.nodes[0].config as any).spawn);
        const execution = await executor(kernel).submit('session-one', flow);
        const exit = await runToEnd(execution, 2_000);
        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain(error);
        const tasks = (await (await kernel.openSession('session-one')).listTasks())
            .filter(task => task.labels?.kind !== 'flow-root');
        expect(tasks).toHaveLength(1);
    });

    it('rejects references to unrelated global nodes', async () => {
        const flow = spawnFlow();
        flow.nodes.push({ ...flow.nodes[0], id: 'unrelated', plugin: 'builtin.transform', config: { value: 'other' } });
        (flow.nodes[0].config as any).spawn.edges[0].from = '$upstream:unrelated';
        const execution = await executor(kernel).submit('session-one', flow);
        const exit = await runToEnd(execution, 2_000);
        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('scope');
    });

    it('allows declared upstream dependencies in a spawned patch', async () => {
        const flow = spawnFlow();
        flow.nodes.push({ ...flow.nodes[0], id: 'upstream', plugin: 'builtin.transform', config: { value: 'upstream' } });
        flow.edges.push({ id: 'upstream-source', from: 'upstream', to: 'source', kind: 'control' });
        (flow.nodes[0].config as any).spawn.edges[0].from = '$upstream:upstream';
        const execution = await executor(kernel).submit('session-one', flow);
        expect((await execution.root.wait({ timeoutMs: 2_000 })).status).toBe('succeeded');
        expect(execution.nodes.has('spawned')).toBe(true);
    });

    it.each([false, true])('checks patch identity on replay (conflict=%s)', async conflict => {
        const flow = spawnFlow();
        const first = (flow.nodes[0].config as any).spawn;
        first.idempotencyKey = 'shared-patch';
        first.edges = [];
        const second = JSON.parse(JSON.stringify(flow.nodes[0]));
        second.id = 'second';
        if (conflict) second.config.spawn.nodes[0].config.value = 'DIFFERENT';
        flow.nodes.push(second);
        flow.edges.push({ id: 'source-second', from: 'source', to: 'second', kind: 'control' });
        const run = executor(kernel).submit('session-one', flow);
        const execution = await run;
        const exit = await runToEnd(execution, 2_000);
        if (conflict) {
            expect(exit.status).toBe('failed');
            expect(exit.error?.message).toContain('idempotency conflict');
        } else {
            expect(exit.status).toBe('succeeded');
            expect(execution.iterations.get('spawned')).toBe(1);
        }
    });

    it.each([false, true])('binds node response schemas to parsed output and preserves raw text (valid: %s)', async valid => {
        const flow = agentFlow();
        const raw = JSON.stringify({ answer: valid ? 'yes' : 7 });
        model.execute = vi.fn(async () => ({ choices: [{ index: 0, message: { role: 'assistant', content: raw }, finish_reason: 'stop' }] })) as any;
        const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
        Object.assign(flow.nodes[0].config!, { responseFormat: { type: 'json_schema', json_schema: { name: 'answer', schema } },
            outputValidation: { onInvalid: 'continue' } });
        flow.nodes[0].portSchemas = { outputs: { result: { id: 'answer', version: '1' } } };
        flow.nodes.push({ ...valueNode('target', null), portSchemas: { inputs: { input: { id: 'answer', version: '1' } } } });
        flow.edges.push({ id: 'typed', from: 'agent', to: 'target', output: 'result', input: 'input' });
        const execution = await executor(kernel).submit('session-one', flow);
        const exit = await runToEnd(execution);
        expect(exit.status).toBe(valid ? 'succeeded' : 'failed');
        const output = (await execution.nodes.get('agent')!.status()).task.output;
        expect(output).toMatchObject({ message: { content: raw }, outputs: { result: { content: JSON.parse(raw) } } });
        if (!valid) {
            expect(exit.error?.message).toContain('Invalid output agent.result');
            expect(execution.nodes.has('target')).toBe(false);
        } else expect((await execution.nodes.get('target')!.status()).task.output)
            .toMatchObject({ outputs: { result: { content: { answer: 'yes' } } } });
    });

    it('repairs invalid structured output and records token usage', async () => {
        const flow = agentFlow();
        (flow.nodes[0].config as Record<string, unknown>).messages = [{ role: 'user', content: 'structured response' }];
        (flow.nodes[0].config as Record<string, unknown>).responseFormat = {
            type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } },
        };
        (flow.nodes[0].config as Record<string, unknown>).outputValidation = { onInvalid: 'repair', retries: 1 };
        const execution = await executor(kernel).submit('session-one', flow);
        const exit = await execution.root.wait({ timeoutMs: 2_000 });
        expect(exit.status).toBe('succeeded');
        expect(JSON.stringify(exit.output)).toContain('corrected');
        expect(execution.usage.tokens).toBe(4);
    });
});

function registerPrograms(kernel: Kernel): void {
    kernel.registerProgram(new DurableAgentProgram());
    kernel.registerProgram(new FlowValueProgram());
    kernel.registerProgram(new FlowHumanProgram());
    kernel.registerProgram(new FlowAggregateProgram());
}

function executor(kernel: Kernel): DurableFlowExecutor {
    return new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
}

function llmEffect(): EffectAdapter<Record<string, unknown>, ChatCompletionResponse> {
    return {
        kind: 'llm.chat', version: '1',
        async execute(request) {
            const inner = request.request && typeof request.request === 'object'
                ? request.request as Record<string, unknown>
                : request;
            const messages = Array.isArray(inner.messages) ? inner.messages : [];
            if (messages.some(message => JSON.stringify(message).includes('delegate now'))) {
                return {
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant', content: '',
                            tool_calls: [{
                                id: 'delegate-one', type: 'function',
                                function: { name: 'delegate_tasks', arguments: JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] }) },
                            }],
                        },
                        finish_reason: 'tool_calls',
                    }],
                    usage: { total_tokens: 2 },
                };
            }
            if (messages.some(message => JSON.stringify(message).includes('fail child'))) {
                throw new Error('child failed');
            }
            if (messages.some(message => JSON.stringify(message).includes('structured response'))) {
                const repairing = messages.some(message => JSON.stringify(message).includes('did not satisfy'));
                return {
                    choices: [{ index: 0, message: { role: 'assistant', content: repairing ? '{"answer":"corrected"}' : 'not-json' }, finish_reason: 'stop' }],
                    usage: { total_tokens: 2 },
                };
            }
            return {
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: 'durable answer' },
                    finish_reason: 'stop',
                }],
                usage: { total_tokens: 2 },
            };
        },
    };
}

function delegationFlow(): DagRunSpec {
    return {
        nodes: [{
            id: 'parent', name: 'parent', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: {
                sessionId: 'session-one', roundId: 'round-parent', connectionId: 'default', approval: 'none',
                messages: [{ role: 'user', content: 'delegate now' }],
                delegation: {
                    enabled: true,
                    toolName: 'delegate_tasks',
                    resolvedTemplate: {
                        plugin: 'builtin.agent', pluginVersion: '1.0.0', capabilities: [],
                        config: {
                            sessionId: 'session-one', roundId: 'round-child', connectionId: 'default', approval: 'none',
                            messages: [{ role: 'system', content: 'Handle one payload' }],
                        },
                    },
                    fanout: { maxTasks: 2, maxConcurrency: 1, maxDepth: 1, order: 'sequential' },
                    failure: { policy: 'continue' },
                },
            },
            inputs: {}, capabilities: [],
        }],
        edges: [],
    };
}

function supervisorFlow(): DagRunSpec {
    return {
        nodes: [
            {
                id: 'lead', name: 'Lead', plugin: 'builtin.agent', pluginVersion: '1.0.0',
                config: {
                    sessionId: 'session-one', roundId: 'round-lead', connectionId: 'default', approval: 'none',
                    messages: [{ role: 'user', content: 'dispatch workers' }], maxIterations: 6,
                },
                inputs: {}, capabilities: [],
            },
            {
                id: 'router', name: 'Router', plugin: 'builtin.route', pluginVersion: '1.0.0',
                config: {
                    mode: 'exclusive',
                    rules: ['A', 'B'].map(worker => ({
                        edgeId: `lead-${worker.toLowerCase()}`,
                        expression: { kind: 'eq', args: [{ kind: 'path', path: ['input'] }, { kind: 'literal', value: worker }] },
                    })),
                },
                inputs: {}, capabilities: [],
            },
            valueNode('worker-a', 'A RESULT'),
            valueNode('worker-b', 'B RESULT'),
        ],
        edges: [
            { id: 'lead-router', from: 'lead', to: 'router', output: 'result', input: 'input' },
            { id: 'lead-a', from: 'router', to: 'worker-a', output: 'result', input: 'input' },
            { id: 'lead-b', from: 'router', to: 'worker-b', output: 'result', input: 'input' },
            { id: 'a-lead', from: 'worker-a', to: 'lead', output: 'result', input: 'input' },
            { id: 'b-lead', from: 'worker-b', to: 'lead', output: 'result', input: 'input' },
        ],
    };
}

function valueFlow(): DagRunSpec {
    return {
        nodes: [
            valueNode('left', 'left'),
            valueNode('right', 'right'),
            {
                ...valueNode('join', null), plugin: 'builtin.reduce',
                config: { outputName: 'result', type: 'text', separator: ',' },
            },
        ],
        edges: [
            { id: 'left-join', from: 'left', to: 'join', output: 'result', input: 'input' },
            { id: 'right-join', from: 'right', to: 'join', output: 'result', input: 'input' },
        ],
    };
}

function valueNode(id: string, value: string | null): DagRunSpec['nodes'][number] {
    return {
        id, name: id, plugin: 'builtin.transform', pluginVersion: '1.0.0',
        config: { operation: 'identity', outputName: 'result', type: 'text', value }, inputs: {},
    };
}

function agentFlow(): DagRunSpec {
    return {
        nodes: [{
            id: 'agent', name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: {
                sessionId: 'session-one', roundId: 'round-one', connectionId: 'default',
                messages: [{ role: 'user', content: 'hello' }], approval: 'none',
            },
            inputs: {}, capabilities: [],
        }],
        edges: [],
    };
}

function routeFlow(source: string): DagRunSpec {
    return {
        nodes: [
            valueNode('source', source),
            {
                id: 'router', name: 'router', plugin: 'builtin.route', pluginVersion: '1.0.0',
                config: {
                    mode: 'exclusive',
                    rules: [
                        { edgeId: 'router-left', expression: routeEq('go-left') },
                        { edgeId: 'router-right', expression: routeEq('go-right') },
                    ],
                    defaultEdgeId: 'router-left',
                },
                inputs: {},
            },
            valueNode('left', 'LEFT'),
            valueNode('right', 'RIGHT'),
        ],
        edges: [
            { id: 'source-router', from: 'source', to: 'router', output: 'result', input: 'input' },
            { id: 'router-left', from: 'router', to: 'left', output: 'result', input: 'input' },
            { id: 'router-right', from: 'router', to: 'right', output: 'result', input: 'input' },
        ],
    };
}

function routeEq(value: string) {
    return { kind: 'eq', args: [{ kind: 'path', path: ['input'] }, { kind: 'literal', value }] };
}

function loopFlow(maxIterations: number): DagRunSpec {
    return {
        nodes: [
            {
                ...valueNode('entry', 'A'),
                config: { ...valueNode('entry', 'A').config, maxIterations },
            },
            valueNode('body', 'B'),
        ],
        edges: [
            { id: 'entry-body', from: 'entry', to: 'body', output: 'result', input: 'input' },
            { id: 'body-entry', from: 'body', to: 'entry', output: 'result', input: 'input' },
        ],
    };
}

function spawnFlow(): DagRunSpec {
    return {
        nodes: [{
            id: 'source', name: 'source', plugin: 'builtin.spawn', pluginVersion: '1.0.0',
            config: {
                value: 'done', outputName: 'result', type: 'text',
                spawn: {
                    nodes: [{
                        id: 'spawned', name: 'spawned', plugin: 'builtin.transform', pluginVersion: '1.0.0',
                        config: { operation: 'identity', outputName: 'result', type: 'text', value: 'SPAWNED' },
                        inputs: {},
                    }],
                    edges: [{ id: 'source-spawned', from: 'source', to: 'spawned', output: 'result', input: 'input' }],
                },
            },
            inputs: {},
        }],
        edges: [],
    };
}

describe('FlowAggregateProgram legacy state recovery', () => {
    it('hydrates missing failures/resolved before reducing a legacy v1 state', () => {
        const program = new FlowAggregateProgram();
        const legacy = JSON.parse(JSON.stringify({
            awaitingSchedule: false,
            dependencies: [{ taskId: 'task-1', nodeId: 'node-1' }],
            outputs: {},
        }));
        const decision = program.reduce(legacy as never, {
            type: 'task-exited', taskId: 'task-1',
            exit: { taskId: 'task-1', status: 'succeeded', output: { ok: true }, completedAt: 1 },
        } as never);
        expect(decision.next).toMatchObject({
            type: 'complete',
            output: { nodes: { 'node-1': { ok: true } } },
        });
    });
});

describe('upstreamOf', () => {
    it('returns ancestors nearest-first (reverse compensation order)', () => {
        const edges = [
            { id: 'a-b', from: 'a', to: 'b', output: 'result', input: 'input' },
            { id: 'b-c', from: 'b', to: 'c', output: 'result', input: 'input' },
        ];
        expect(upstreamOf(edges, 'c')).toEqual(['b', 'a']);
    });
});

describe('conditional loop exit', () => {
    let manager: IVFSManager;
    let fs: IFileSystem;
    let kernel: Kernel;
    let model: ReturnType<typeof llmEffect>;

    async function setup(score: number): Promise<void> {
        ({ manager } = await createVFS({ rootBackend: new MemoryBackend(),}));
        fs = await manager.openFileSystem('/data/test');
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; } });
        registerPrograms(kernel);
        kernel.registerEffect(scoringEffect(score));
        await kernel.initialize();
        await kernel.createSession({ id: 'session-one', storage: { kind: 'test', locator: null } });
    }

    afterEach(async () => { kernel.dispose(); await manager.dispose(); });

    it('exits the rewrite loop once the verdict score reaches the threshold', async () => {
        await setup(55);
        const execution = await executor(kernel).submit('session-one', conditionalLoopFlow());
        const exit = await execution.root.wait({ timeoutMs: 3000 });
        expect(exit.status).toBe('succeeded');
        expect(execution.iterations.get('verdict')).toBe(1);
        expect(execution.iterations.get('rewrite')).toBeUndefined();
    });

    it('keeps rewriting until maxIterations when the score stays below the threshold', async () => {
        await setup(53);
        const execution = await executor(kernel).submit('session-one', conditionalLoopFlow());
        const exit = await execution.root.wait({ timeoutMs: 3000 });
        expect(exit.status).toBe('succeeded');
        expect(execution.iterations.get('verdict')).toBe(2);
        expect(execution.iterations.get('rewrite')).toBe(2);
    });
});

function scoringEffect(score: number): EffectAdapter<Record<string, unknown>, ChatCompletionResponse> {
    return {
        kind: 'llm.chat', version: '1',
        async execute() {
            return {
                choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ score }) }, finish_reason: 'stop' }],
                usage: { total_tokens: 1 },
            };
        },
    };
}

function conditionalLoopFlow(): DagRunSpec {
    const agent = (id: string): DagRunSpec['nodes'][number] => ({
        id, name: id, plugin: 'builtin.agent', pluginVersion: '1.0.0',
        config: { sessionId: 'session-one', roundId: `round-${id}`, connectionId: 'default', messages: [{ role: 'user', content: 'go' }], approval: 'none', maxIterations: 2 },
        inputs: {}, capabilities: [],
    });
    return {
        nodes: [
            agent('verdict'),
            {
                id: 'decide', name: 'decide', plugin: 'builtin.route', pluginVersion: '1.0.0',
                config: {
                    mode: 'exclusive',
                    rules: [
                        { edgeId: 'decide->report', expression: { kind: 'gte', args: [{ kind: 'path', path: ['input', 'score'] }, { kind: 'literal', value: 54 }] } },
                    ],
                    defaultEdgeId: 'decide->rewrite',
                },
                inputs: {},
            },
            agent('rewrite'),
            agent('report'),
        ],
        edges: [
            { id: 'verdict->decide', from: 'verdict', to: 'decide', output: 'result', input: 'input' },
            { id: 'verdict->report', from: 'verdict', to: 'report', output: 'result', input: 'input' },
            { id: 'decide->report', from: 'decide', to: 'report', output: 'result', input: 'input' },
            { id: 'decide->rewrite', from: 'decide', to: 'rewrite', output: 'result', input: 'input' },
            { id: 'rewrite->verdict', from: 'rewrite', to: 'verdict', output: 'result', input: 'input' },
        ],
    };
}
