import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IVFSManager, type IFileSystem } from '@itookit/vfs-core';
import type { DagNodeDefinition, DagRunSpec } from '../src/contracts';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms } from '../src/flow';
import { FlowVariableStore, validateVariableGraph } from '../src/flow/variables';

const node = (id: string, value: unknown, assign?: DagNodeDefinition['assign']): DagNodeDefinition =>
    ({ id, name: id, plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value }, assign });
const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from, to, kind: 'control' as const, output: 'result', input: 'input' });
const variables = { essay: { type: 'string' as const, initial: '${param.essay}' }, flag: { type: 'boolean' as const, initial: false } };
let manager: IVFSManager, fs: IFileSystem, kernel: Kernel, executor: DurableFlowExecutor;
function boot() {
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel);
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
}
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    fs = await manager.openFileSystem('/test'); boot(); await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
});
afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

it('commits ordinary node output, keeps params immutable, and isolates runs', async () => {
    const spec: DagRunSpec = { variables, nodes: [node('write', { essay: 'NEW' }, { essay: '${output.essay}' }),
        node('read', { original: '${param.essay}', current: '${vars.essay}' })], edges: [edge('write', 'read')] };
    const run = await executor.submit('s', spec, { essay: 'OLD' });
    expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
    expect((await run.nodes.get('read')!.status()).task.output).toMatchObject({ outputs: { result: { content: { original: 'OLD', current: 'NEW' } } } });
    const again = await executor.submit('s', { variables, nodes: [node('read', '${vars.essay}')], edges: [] }, { essay: 'OTHER' });
    expect((await again.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
    expect((await again.nodes.get('read')!.status()).task.output).toMatchObject({ outputs: { result: { content: 'OTHER' } } });
});

it('restores committed variables and their source without applying a write twice', async () => {
    const pause: DagNodeDefinition = { id: 'pause', name: 'pause', plugin: 'builtin.input', pluginVersion: '1.0.0', inputs: {}, config: { fields: { proceed: { type: 'boolean', required: true } } } };
    const run = await executor.submit('s', { variables, nodes: [node('write', { essay: 'NEW' }, { essay: '${output.essay}' }), pause,
        node('read', '${vars.essay}')], edges: [edge('write', 'pause'), edge('pause', 'read')] }, { essay: 'OLD' });
    await vi.waitFor(async () => expect((await run.nodes.get('pause')?.status())?.task.interactions['input-1']).toBeDefined());
    kernel.dispose(); await executor.waitIdle(); boot(); await kernel.initialize();
    const resumed = await executor.resume('s', run.root.id);
    await resumed.nodes.get('pause')!.respond({ interactionId: 'input-1', value: { proceed: true } });
    expect((await resumed.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
    expect((await resumed.nodes.get('read')!.status()).task.output).toMatchObject({ outputs: { result: { content: 'NEW' } } });
    const session = await kernel.inspectSession('s');
    const checkpoint = (await session.getShared(`flow.run.${run.root.id}.scheduler`))!.value as any;
    expect(checkpoint.variables.commits).toHaveLength(1);
    expect(checkpoint.variables.commits[0]).toMatchObject({ nodeId: 'write', taskId: resumed.nodes.get('write')!.id, updates: { essay: 'NEW' } });
});

it('rejects unordered read/write and write/write but permits disjoint writes', () => {
    const a = node('a', {}, { essay: 'A' }), b = node('b', {}, { essay: 'B' });
    expect(() => validateVariableGraph({ variables, nodes: [a, b], edges: [] })).toThrow('Unordered');
    expect(() => validateVariableGraph({ variables, nodes: [a, node('read', '${vars.essay}')], edges: [] })).toThrow('Unordered');
    expect(() => validateVariableGraph({ variables, nodes: [a, b], edges: [edge('a', 'b')] })).not.toThrow();
    expect(() => validateVariableGraph({ variables, nodes: [a, node('b', {}, { flag: true })], edges: [] })).not.toThrow();
    expect(() => validateVariableGraph({ variables, nodes: [node('read', '${vars.unknown}')], edges: [] })).toThrow('Undeclared');
});

it('validates all assignments atomically and prunes superseded retry writes', () => {
    const spec = { variables, nodes: [], edges: [] }, store = new FlowVariableStore(spec);
    const writer = node('write', {}, { essay: '${output.essay}', flag: '${output.flag}' });
    const context = store.snapshot(writer, { param: { essay: 'OLD' } });
    store.remember('task', context);
    expect(() => store.commit(writer, 'task', { outputs: { result: { content: { essay: 'NEW', flag: 'invalid' } } } })).toThrow('Invalid');
    expect(store.state.commits).toHaveLength(0);
    const output = { outputs: { result: { content: { essay: '${param.secret}', flag: true } } } };
    store.commit(writer, 'task', output); store.commit(writer, 'task', output);
    expect(store.state.commits).toHaveLength(1);
    expect(store.snapshot(writer, context).vars?.essay).toBe('${param.secret}');
    store.retry('task', 'retry');
    expect(store.state.snapshots.retry).toEqual(context);
    expect(store.snapshot(writer, context).vars?.essay).toBe('OLD');
    store.commit(writer, 'retry', output);
    store.prune(new Set());
    expect(store.snapshot(writer, context).vars?.essay).toBe('OLD');
});

it('initializes variables after missing inputs are collected', async () => {
    const collect: DagNodeDefinition = { id: 'collect', name: 'collect', plugin: 'builtin.input', pluginVersion: '1.0.0', inputs: {}, config: { fields: { essay: { type: 'string', required: true } } } };
    const run = await executor.submit('s', { variables, nodes: [collect, node('read', '${vars.essay}')], edges: [] });
    await vi.waitFor(async () => expect((await run.nodes.get('collect')?.status())?.task.interactions['input-1']).toBeDefined());
    expect(run.nodes.has('read')).toBe(false);
    await run.nodes.get('collect')!.respond({ interactionId: 'input-1', value: { essay: 'COLLECTED' } });
    expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
    expect((await run.nodes.get('read')!.status()).task.output).toMatchObject({ outputs: { result: { content: 'COLLECTED' } } });
});

it('keeps composite variable scopes separate from each other and the parent', async () => {
    const { flowToDag } = await import('../src/flow/to-dag');
    const child = { id: 'child', revision: 1, name: 'Child', createdAt: 0, digest: '', variables,
        parameters: [{ name: 'essay', type: 'string' }], nodes: [node('write', { essay: 'CHILD' }, { essay: '${output.essay}' }), node('read', '${vars.essay}')], edges: [edge('write', 'read')] };
    const composite = (id: string) => ({ id, name: id, plugin: 'builtin.flow', pluginVersion: '1.0.0', config: { flowId: 'child', parameters: { essay: id } }, inputs: {} });
    const flow = { ...child, id: 'parent', variables: { essay: { type: 'string', initial: 'ROOT' } }, nodes: [composite('a'), composite('b'), node('parent', '${vars.essay}')], edges: [] };
    const spec = await flowToDag(flow as never, undefined, undefined, async () => child as never);
    const run = await executor.submit('s', spec, { essay: 'INPUT' });
    const exit = await run.root.wait({ timeoutMs: 6000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    const summary = (exit.output as any).variables;
    expect(summary.initial).toMatchObject({ 'a/': { essay: 'a' }, 'b/': { essay: 'b' }, '': { essay: 'ROOT' } });
    expect(summary.current).toMatchObject({ 'a/': { essay: 'CHILD' }, 'b/': { essay: 'CHILD' }, '': { essay: 'ROOT' } });
});

it('assigns plain text or validated JSON fields from ordinary agent output', () => {
    const store = new FlowVariableStore({ variables, nodes: [], edges: [] });
    const agent = { ...node('agent', {}, { essay: '${output}' }), plugin: 'builtin.agent' };
    store.remember('a', store.snapshot(agent, { param: { essay: 'OLD' } }));
    store.commit(agent, 'a', { message: { content: 'Plain text ${vars.secret}' } });
    expect(store.state.commits[0].updates.essay).toBe('Plain text ${vars.secret}');
    agent.assign = { essay: '${output.essay}' };
    store.remember('b', store.snapshot(agent, { param: { essay: 'OLD' } }));
    store.commit(agent, 'b', { message: { content: '{"essay":"JSON text"}' } });
    expect(store.state.commits[1].updates.essay).toBe('JSON text');
});
