import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms } from '../src/flow';
import { createRunCatalog } from '../src/flow/run-catalog';
import { GraphMutationRuntime, type GraphMutationState } from '../src/flow/graph-mutations';
import type { DagNodeDefinition, GraphPatch } from '../src/contracts';

const node = (id: string, config: Record<string, unknown> = {}): DagNodeDefinition => ({
    id, name: id, plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: config as never,
});
const edge = (id: string, from: string, to: string) => ({ id, from, to, kind: 'control' as const });
const patch = (): GraphPatch => ({ idempotencyKey: 'workers', nodes: [node('worker', { value: 7 })], edges: [
    edge('start-worker', 'spawn', 'worker'), { id: 'worker-result', from: 'worker', to: 'barrier', kind: 'data', output: 'result', input: 'input' },
] });
function state(): GraphMutationState {
    const nodes = [node('spawn'), node('barrier'), node('other')], edges = [edge('gate', 'spawn', 'barrier')];
    return { spec: { nodes, edges }, nodes, edges, plugins: createRunCatalog(createBuiltinDagPluginRegistry(), nodes), maxNodes: 100,
        appliedPatches: new Map(), nodeDefaults: new Map(), nodeConnections: new Map(), edgeState: new Map(), backEdges: new Set(),
        skipped: new Set(), dispatchOrder: [], instances: new Map() };
}
const apply = (runtime: GraphMutationRuntime, value = patch()) => runtime.applyEffects({ effects: [{ type: 'patch-graph', patch: value }] }, 'spawn');

it.each(['started', 'skipped'])('rejects returning into a %s consumer before publishing nodes or receipts', async status => {
    const current = state();
    if (status === 'started') current.instances.set('barrier', [{ id: 'already-started' } as never]);
    else current.skipped.add('barrier');
    await expect(apply(new GraphMutationRuntime(current))).rejects.toThrow('already started or skipped');
    expect(current.nodes.map(item => item.id)).toEqual(['spawn', 'barrier', 'other']);
    expect(current.appliedPatches.size).toBe(0);
    expect(current.edges).toHaveLength(1);
});

it.each(['unrelated', 'existing-to-existing', 'cycle-through-existing'])('rejects %s return edges atomically', async kind => {
    const current = state(), value = patch();
    if (kind === 'unrelated') value.edges[1].to = 'other';
    if (kind === 'existing-to-existing') value.edges[1].from = 'spawn';
    if (kind === 'cycle-through-existing') {
        current.edges.push(edge('barrier-spawn', 'barrier', 'spawn'));
        current.backEdges.add('barrier-spawn');
    }
    const edgeCount = current.edges.length;
    await expect(apply(new GraphMutationRuntime(current), value)).rejects.toThrow(kind === 'cycle-through-existing' ? 'cycle' : 'scope');
    expect(current.nodes).toHaveLength(3);
    expect(current.edges).toHaveLength(edgeCount);
    expect(current.appliedPatches.size).toBe(0);
});

it('revalidates target eligibility after host binding and replays admitted patches without duplicates', async () => {
    const rejected = state();
    rejected.bindNode = async () => { rejected.skipped.add('barrier'); return {}; };
    await expect(apply(new GraphMutationRuntime(rejected))).rejects.toThrow('already started or skipped');
    expect(rejected.nodes).toHaveLength(3);
    const current = state(), runtime = new GraphMutationRuntime(current);
    await apply(runtime);
    current.instances.set('barrier', [{ id: 'after-patch' } as never]);
    await apply(new GraphMutationRuntime(current));
    expect(current.nodes).toHaveLength(4);
    expect(current.edges).toHaveLength(3);
    expect(current.appliedPatches.size).toBe(1);
});

let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
});
afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

it('waits for dynamic workers before the existing consumer and preserves the joined result on resume', async () => {
    const dynamic = patch();
    dynamic.nodes.push(node('second', { value: 'ready' }));
    dynamic.edges.push(edge('second-start', 'spawn', 'second'), edge('second-done', 'second', 'worker'));
    const spawn = { ...node('spawn', { spawn: dynamic }), plugin: 'builtin.spawn' };
    const run = await executor.submit('s', { nodes: [spawn, node('barrier')], edges: [edge('gate', 'spawn', 'barrier')] });
    const result = await run.root.wait({ timeoutMs: 4000 });
    expect(result.status, JSON.stringify(result)).toBe('succeeded');
    expect((await run.nodes.get('barrier')!.status()).task.output).toMatchObject({ outputs: { result: { content: 7 } } });
    expect(run.iterations.get('barrier')).toBe(1);
    const resumed = await executor.resume('s', run.root.id);
    expect((await resumed.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded');
    expect(resumed.iterations.get('worker')).toBe(1);
    expect(resumed.iterations.get('barrier')).toBe(1);
});

it('restores an unfinished dynamic return with unbound optional connections after host restart', async () => {
    const dynamic = patch();
    dynamic.nodes.push({ ...node('pending', { requestId: 'answer', prompt: 'Continue' }), plugin: 'builtin.human' });
    dynamic.edges.push(edge('pending-start', 'spawn', 'pending'), edge('pending-worker', 'pending', 'worker'));
    const spawn = { ...node('spawn', { spawn: dynamic }), plugin: 'builtin.spawn' };
    const run = await executor.submit('s', { nodes: [spawn, node('barrier')], edges: [edge('gate', 'spawn', 'barrier')],
        nodeConnections: { spawn: { defaultConnection: 'text', connections: [
            { name: 'text', connectionId: 'bound', required: true }, { name: 'image', required: false },
        ] } },
    });
    await vi.waitFor(async () => expect((await kernel.listSessionTasks('s')).some(task => task.interactions?.answer?.status === 'pending')).toBe(true));
    const pendingId = run.nodes.get('pending')!.id;
    expect(run.nodes.has('barrier')).toBe(false);
    kernel.dispose(); await executor.waitIdle();
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
    const resumed = await executor.resume('s', run.root.id);
    expect(resumed.nodes.has('barrier')).toBe(false);
    await (await (await kernel.openSession('s')).attachTask(pendingId)).respond({ interactionId: 'answer', value: 9 });
    expect((await resumed.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded');
    expect((await resumed.nodes.get('barrier')!.status()).task.output).toMatchObject({ outputs: { result: { content: 7 } } });
    expect(resumed.nodes.get('pending')!.id).toBe(pendingId);
    expect(resumed.iterations.get('worker')).toBe(1);
    expect(resumed.iterations.get('barrier')).toBe(1);
});
