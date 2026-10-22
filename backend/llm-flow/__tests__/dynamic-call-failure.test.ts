import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, flowToDag, registerDurablePrograms } from '../src/flow';
import type { FlowNodeDefinition, FlowRevision } from '../src/contracts';

const value = (id: string, content: unknown): FlowNodeDefinition => ({ id: id as never, name: id,
    plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: content } as never });
const definition = (id: string, nodes: FlowNodeDefinition[]): FlowRevision => ({ id: id as never, name: id,
    revision: 1, digest: id, createdAt: 0, nodes, edges: [] });
const call = (id: string): FlowNodeDefinition => ({ ...value(id, null), plugin: 'builtin.flow', pluginVersion: '2.0.0',
    config: { flowId: id, parameters: {} } });
let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;

async function startKernel(): Promise<void> {
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel);
    kernel.registerProgram({ manifest: { kind: 'test.failure', version: '1' },
        init: () => ({ state: null, next: { type: 'fail', error: { code: 'PACKAGE_FAILED', message: 'Package write failed' } } }),
        reduce: () => { throw new Error('Unexpected reducer invocation'); } });
    kernel.registerProgram({ manifest: { kind: 'test.delegate', version: '1' },
        init: () => ({ state: null, next: { type: 'complete', output: { message: { content: '[{}]' } } } }),
        reduce: () => { throw new Error('Unexpected reducer invocation'); } });
    const plugins = createBuiltinDagPluginRegistry();
    for (const kind of ['failure', 'delegate']) plugins.register({ manifest: { id: `test.${kind}`, version: '1', kind, title: kind, category: 'Test',
        configSchema: { type: 'object' }, defaultConfig: {}, inputs: [], outputs: [] },
        runtime: async () => ({ createTask: () => ({ programKind: `test.${kind}`, programVersion: '1', input: null }) }) });
    await kernel.initialize();
    executor = new DurableFlowExecutor({ kernel, plugins });
}

beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    await startKernel(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
});
afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

function dynamicFunction(worker: FlowNodeDefinition, tolerate = false): FlowRevision {
    const nodes = [worker], edges: Record<string, unknown>[] = [{ id: 'start', from: '$parent', to: worker.id, kind: 'control' }];
    if (tolerate) {
        nodes.push(value('fallback', 'recovered'));
        edges.push({ id: 'recover', from: worker.id, to: 'fallback', kind: 'control', onFailure: 'continue' });
    }
    return { ...definition('child', [value('plan', 'planned.apkg'), { ...value('spawn', null), plugin: 'builtin.spawn',
        config: { scope: 'local', spawn: { idempotencyKey: 'package', nodes, edges } } as never }]),
        outputs: { result: { value: '${nodes.plan.outputs.result}' } } };
}

it.each([false, true])('propagates dynamic failure to the call unless explicitly tolerated (%s)', async tolerated => {
    const fn = dynamicFunction({ ...value('package', null), plugin: 'test.failure', pluginVersion: '1' }, tolerated);
    const spec = await flowToDag(definition('parent', [call('build'), value('publish', '${nodes.build.outputs.result}')]),
        undefined, undefined, async () => fn);
    const run = await executor.submit('s', spec), exit = await run.root.wait({ timeoutMs: 4000 });
    expect(exit.status).toBe(tolerated ? 'succeeded' : 'failed');
    expect((await run.nodes.get('build/package')!.status()).task.status).toBe('failed');
    expect((await run.nodes.get('build/__flow_return')!.status()).task.status).toBe(tolerated ? 'succeeded' : 'failed');
    expect((await run.nodes.get('publish')!.status()).task.status).toBe(tolerated ? 'succeeded' : 'failed');
    if (!tolerated) expect(exit.error).toMatchObject({ code: 'PACKAGE_FAILED', message: expect.stringContaining('Package write failed') });
});

it('reconstructs dynamic return dependencies after restart and propagates cancellation', async () => {
    const fn = dynamicFunction({ ...value('package', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Continue' } });
    const spec = await flowToDag(definition('parent', [call('build'), value('publish', '${nodes.build.outputs.result}')]),
        undefined, undefined, async () => fn);
    const run = await executor.submit('s', spec);
    await vi.waitFor(async () => expect((await kernel.listSessionTasks('s')).some(task => task.interactions?.answer?.status === 'pending')).toBe(true));
    const workerId = run.nodes.get('build/package')!.id;
    kernel.dispose(); await executor.waitIdle(); await startKernel();
    const resumed = await executor.resume('s', run.root.id);
    await (await (await kernel.openSession('s')).attachTask(workerId)).cancel('Package cancelled');
    expect((await resumed.root.wait({ timeoutMs: 4000 })).status).toBe('failed');
    expect((await resumed.nodes.get('build/__flow_return')!.status()).task.status).toBe('failed');
    expect((await resumed.nodes.get('publish')!.status()).task.status).toBe('failed');
    expect(resumed.nodes.get('build/package')!.id).toBe(workerId);
});

it('keeps failures isolated from an independent sibling function return', async () => {
    const failed = dynamicFunction({ ...value('package', null), plugin: 'test.failure', pluginVersion: '1' });
    const healthy = dynamicFunction(value('package', 'written'));
    const spec = await flowToDag(definition('parent', [call('bad'), call('good'), value('publish', '${nodes.good.outputs.result}')]),
        undefined, undefined, async id => id === 'bad' ? failed : healthy);
    const run = await executor.submit('s', spec);
    expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('failed');
    expect((await run.nodes.get('bad/__flow_return')!.status()).task.status).toBe('failed');
    expect((await run.nodes.get('good/__flow_return')!.status()).task.status).toBe('succeeded');
    expect((await run.nodes.get('publish')!.status()).task.status).toBe('succeeded');
});

it.each(['continue', 'detached'])('preserves %s delegation semantics when collecting dynamic return dependencies', async mode => {
    const template = mode === 'detached' ? { plugin: 'builtin.human', pluginVersion: '1.0.0', config: { requestId: 'background', prompt: 'Continue' } }
        : { plugin: 'test.failure', pluginVersion: '1', config: {} };
    const fn = { ...definition('child', [{ ...value('delegate', null), plugin: 'test.delegate', pluginVersion: '1', config: {
        delegation: { enabled: true, resolvedTemplate: template, failure: { policy: 'continue' }, result: { mode: 'discard' },
            ...(mode === 'detached' ? { execution: { mode: 'detached' }, wait: { timeoutMs: 10_000 } } : {}) },
    } }]), outputs: { result: { value: 'ready' } } };
    const spec = await flowToDag(definition('parent', [call('build'), value('publish', '${nodes.build.outputs.result}')]),
        undefined, undefined, async () => fn);
    const run = await executor.submit('s', spec);
    expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded');
    expect((await run.nodes.get('build/__flow_return')!.status()).task.status).toBe('succeeded');
    expect((await run.nodes.get('publish')!.status()).task.status).toBe('succeeded');
    const worker = run.nodes.get('build/delegate:delegate:1:0')!;
    if (mode === 'continue') expect((await worker.status()).task.status).toBe('failed');
    else {
        expect((await worker.status()).task.status).not.toBe('succeeded');
        await worker.cancel('Test cleanup');
    }
});
