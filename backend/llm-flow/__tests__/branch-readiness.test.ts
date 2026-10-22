import { afterEach, beforeEach, expect, it } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms, flowToDag } from '../src/flow';
import type { FlowRevision, FlowNodeDefinition } from '../src/contracts';

const value = (id: string): FlowNodeDefinition => ({ id: id as never, name: id,
    plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: id } });
const definition = (id: string, nodes: FlowNodeDefinition[]): FlowRevision => ({
    id: id as never, name: id, revision: 1, digest: id, createdAt: 0, nodes, edges: [],
});
function branchFlow(): FlowRevision {
    return { ...definition('branch', [value('merge'), value('unused-2'), value('unused-1'), value('selected'),
        { ...value('route'), plugin: 'builtin.route', config: {
            rules: [{ edgeId: 'selected', expression: { kind: 'literal', value: true } }], defaultEdgeId: 'unused',
        } }]), edges: [
        { id: 'selected', from: 'route', to: 'selected' }, { id: 'unused', from: 'route', to: 'unused-1' },
        { id: 'unused-tail', from: 'unused-1', to: 'unused-2' },
        { id: 'selected-merge', from: 'selected', to: 'merge' }, { id: 'unused-merge', from: 'unused-2', to: 'merge' },
    ] as FlowRevision['edges'] };
}

let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/data/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
});
afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

it.each([false, true])('skips the entire unselected branch and runs a shared merge, function=%s', async callable => {
    const child = branchFlow();
    child.outputs = { result: { value: '${nodes.merge.outputs.result}' } };
    const flow = callable ? definition('parent', [{ ...value('call'), plugin: 'builtin.flow',
        pluginVersion: '2.0.0', config: { flowId: child.id } }]) : child;
    const spec = await flowToDag(flow, undefined, undefined, async () => child);
    const run = await executor.submit('s', spec);
    expect((await run.root.wait({ timeoutMs: 3000 })).status).toBe('succeeded');
    const prefix = callable ? 'call/' : '';
    expect(run.nodes.has(`${prefix}unused-1`)).toBe(false);
    expect(run.nodes.has(`${prefix}unused-2`)).toBe(false);
    expect((await run.nodes.get(`${prefix}merge`)!.status()).task.status).toBe('succeeded');
    const restored = await executor.resume('s', run.root.id);
    expect(restored.nodes.has(`${prefix}unused-2`)).toBe(false);
});

it('skips a whole unselected function call before joining the selected branch', async () => {
    const child = { ...definition('child', [value('work')]), outputs: { result: { value: '${nodes.work.outputs.result}' } } };
    const parent = branchFlow();
    parent.nodes = parent.nodes.map(node => node.id === 'unused-1' ? { ...node, plugin: 'builtin.flow',
        pluginVersion: '2.0.0', config: { flowId: child.id } } : node);
    parent.outputs = { result: { value: '${nodes.merge.outputs.result}' } };
    const spec = await flowToDag(parent, undefined, undefined, async () => child);
    const run = await executor.submit('s', spec);
    expect((await run.root.wait({ timeoutMs: 3000 })).status).toBe('succeeded');
    expect([...run.nodes.keys()].some(id => id.startsWith('unused'))).toBe(false);
    expect((await run.nodes.get('merge')?.status())?.task.status).toBe('succeeded');
    expect((await run.nodes.get('__flow_return')?.status())?.task.status).toBe('succeeded');
});

it.each([false, true])('keeps shared parameter dependencies from activating an unselected branch, function=%s', async callable => {
    const child = branchFlow();
    child.nodes.unshift(value('shared'));
    child.nodes.find(node => node.id === 'unused-2')!.config = { value: '${nodes.shared.outputs.result}' };
    child.outputs = { result: { value: '${nodes.merge.outputs.result}' } };
    const parent = callable ? definition('parent', [{ ...value('call'), plugin: 'builtin.flow',
        pluginVersion: '2.0.0', config: { flowId: child.id } }]) : child;
    const spec = await flowToDag(parent, undefined, undefined, async () => child);
    const run = await executor.submit('s', spec);
    expect((await run.root.wait({ timeoutMs: 3000 })).status).toBe('succeeded');
    const prefix = callable ? 'call/' : '';
    expect(run.nodes.has(`${prefix}shared`)).toBe(true);
    expect(run.nodes.has(`${prefix}unused-2`)).toBe(false);
    expect((await run.nodes.get(`${prefix}merge`)?.status())?.task.status).toBe('succeeded');
});
