import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IVFSManager, type IFileSystem } from '@itookit/vfs-core';
import type { DagNodeDefinition, DagRunSpec } from '../src/contracts';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, readFlowSchedulerCheckpoint, registerDurablePrograms } from '../src/flow';
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
    const checkpoint = (await readFlowSchedulerCheckpoint(session, run.root.id))!;
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
    store.remember('task', writer, context);
    expect(() => store.commit(writer, 'task', { outputs: { result: { content: { essay: 'NEW', flag: 'invalid' } } } })).toThrow('Invalid');
    expect(store.state.commits).toHaveLength(0);
    const output = { outputs: { result: { content: { essay: '${param.secret}', flag: true } } } };
    store.commit(writer, 'task', output); store.commit(writer, 'task', output);
    expect(store.state.commits).toHaveLength(1);
    expect(store.snapshot(writer, context).vars?.essay).toBe('${param.secret}');
    store.retry('task', 'retry');
    expect(store.state.snapshots.retry).toBeUndefined();
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
    store.remember('a', agent, store.snapshot(agent, { param: { essay: 'OLD' } }));
    store.commit(agent, 'a', { message: { content: 'Plain text ${vars.secret}' } });
    expect(store.state.commits[0].updates.essay).toBe('Plain text ${vars.secret}');
    agent.assign = { essay: '${output.essay}' };
    store.remember('b', agent, store.snapshot(agent, { param: { essay: 'OLD' } }));
    store.commit(agent, 'b', { message: { content: '{"essay":"JSON text"}' } });
    expect(store.state.commits[1].updates.essay).toBe('JSON text');
});

it('does not checkpoint unrelated invocation data for nodes without deferred context assignments', () => {
    const store = new FlowVariableStore({ variables, nodes: [], edges: [] });
    const reader = node('read', '${vars.essay}'), writer = node('write', {}, { essay: '${output.essay}' });
    const context = { param: { essay: 'OLD', large: 'x'.repeat(100_000) }, nodes: { source: { outputs: { result: 'y'.repeat(100_000) } } } };
    for (let index = 0; index < 100; index++) {
        store.remember(`reader-${index}`, reader, store.snapshot(reader, context));
        store.remember(`writer-${index}`, writer, store.snapshot(writer, context));
    }
    expect(store.state.snapshots).toEqual({});
    expect(JSON.stringify(store.state).length).toBeLessThan(200);
    store.retry('writer-0', 'retry');
    expect(store.state.snapshots).toEqual({});
    store.commit(writer, 'retry', { outputs: { result: { content: { essay: 'NEW' } } } });
    expect(store.snapshot(reader, context).vars?.essay).toBe('NEW');
});

it('freezes only assignment references and keeps their original values across retry', () => {
    const store = new FlowVariableStore({ variables, nodes: [], edges: [] });
    const writer = node('write', {}, { essay: '${param.document.title}|${param.items.length}|${param.items.1.name}|${param.flat.key}|${input.prompt}|${nodes.source.outputs.result.label}|${vars.essay}|${iteration.round}', flag: '${param.allow}' });
    const original = { param: { essay: 'SEED', allow: true, 'flat.key': 'FLAT', document: { title: 'TITLE', unused: 'x'.repeat(100_000) },
        items: [{ name: 'FIRST' }, { name: 'SECOND', unused: 'x'.repeat(100_000) }] }, input: { prompt: 'REQUEST' }, iteration: { round: 2 },
        nodes: { source: { outputs: { result: { label: 'SOURCE', unused: 'x'.repeat(100_000) } } }, unused: { output: 'x'.repeat(100_000) } } };
    store.remember('original', writer, store.snapshot(writer, original));
    expect(JSON.stringify(store.state.snapshots.original).length).toBeLessThan(500);
    original.param.document.title = 'CHANGED'; original.param.items[1].name = 'CHANGED'; original.input.prompt = 'CHANGED';
    store.commit(writer, 'original', null);
    const updates = { essay: 'TITLE|2|SECOND|FLAT|REQUEST|SOURCE|SEED|2', flag: true };
    expect(store.state.commits[0].updates).toEqual(updates);
    store.retry('original', 'retry'); store.commit(writer, 'retry', null);
    expect(store.state.commits).toHaveLength(1);
    expect(store.state.commits[0].updates).toEqual(updates);
    store.prune(new Set(['retry']));
    expect(Object.keys(store.state.snapshots)).toEqual(['retry']);
    expect(store.state.snapshots.retry).toEqual({ param: { document: { title: 'TITLE' }, items: { length: 2, 1: { name: 'SECOND' } }, 'flat.key': 'FLAT', allow: true },
        input: { prompt: 'REQUEST' }, nodes: { source: { outputs: { result: { label: 'SOURCE' } } } }, vars: { essay: 'SEED' }, iteration: { round: 2 } });
});

it('reads legacy full-context snapshots and prunes only tasks removed from the scheduler', () => {
    const context = { param: { essay: 'LEGACY', unrelated: 'x'.repeat(1000) }, input: { prompt: 'REQUEST' } };
    const store = new FlowVariableStore({ variables, nodes: [], edges: [] }, {
        initial: {}, commits: [], snapshots: { legacy: context, removed: context },
    });
    const writer = node('write', {}, { essay: '${param.essay}' });
    store.commit(writer, 'legacy', null);
    expect(store.state.commits[0].updates).toEqual({ essay: 'LEGACY' });
    store.retry('legacy', 'retry'); store.prune(new Set(['legacy', 'retry']));
    expect(store.state.snapshots.removed).toBeUndefined();
    expect(store.state.snapshots.legacy).toEqual(context);
    expect(store.state.snapshots.retry).toEqual(context);
    store.commit(writer, 'retry', null);
    expect(store.state.commits[0].updates).toEqual({ essay: 'LEGACY' });
});

it('preserves whole JSON values alongside overlapping assignment paths', () => {
    const store = new FlowVariableStore({ variables: { bundle: { type: 'json', initial: null } }, nodes: [], edges: [] });
    const items = [{ name: 'FIRST' }, { name: 'SECOND' }];
    const writer = node('write', {}, { bundle: { second: '${param.items.1.name}', items: '${param.items}', length: '${param.items.length}' } });
    store.remember('task', writer, { param: { items } });
    items[1].name = 'CHANGED'; items.push({ name: 'THIRD' });
    expect(Array.isArray(store.state.snapshots.task.param?.items)).toBe(true);
    store.commit(writer, 'task', null);
    expect(store.state.commits[0].updates.bundle).toEqual({ second: 'SECOND', items: [{ name: 'FIRST' }, { name: 'SECOND' }], length: 2 });
});

it('restores a minimal deferred assignment snapshot before the writer finishes', async () => {
    const collect: DagNodeDefinition = { id: 'collect', name: 'collect', plugin: 'builtin.input', pluginVersion: '1.0.0',
        inputs: {}, config: { fields: { proceed: { type: 'boolean', required: true } } },
        assign: { essay: '${param.document.title}|${input.prompt}|${vars.essay}' } };
    const run = await executor.submit('s', { input: { prompt: 'REQUEST' }, variables,
        nodes: [collect, node('read', '${vars.essay}')], edges: [edge('collect', 'read')] },
        { essay: 'OLD', document: { title: 'TITLE', unrelated: 'x'.repeat(100_000) } });
    await vi.waitFor(async () => expect((await run.nodes.get('collect')?.status())?.task.interactions['input-1']).toBeDefined());
    const checkpoint = (await readFlowSchedulerCheckpoint(await kernel.inspectSession('s'), run.root.id))!;
    expect(checkpoint.variables?.snapshots[run.nodes.get('collect')!.id]).toEqual({
        param: { document: { title: 'TITLE' } }, input: { prompt: 'REQUEST' }, vars: { essay: 'OLD' },
    });
    kernel.dispose(); await executor.waitIdle(); boot(); await kernel.initialize();
    const resumed = await executor.resume('s', run.root.id);
    await resumed.nodes.get('collect')!.respond({ interactionId: 'input-1', value: { proceed: true } });
    expect((await resumed.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
    expect((await resumed.nodes.get('read')!.status()).task.output).toMatchObject({
        outputs: { result: { content: 'TITLE|REQUEST|OLD' } },
    });
});
