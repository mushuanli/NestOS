import { afterEach, beforeEach, expect, it } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms, flowToDag } from '../src/flow';
import { lockFlowDependencies } from '../src/flow/dependency-locks';
import type { FlowRevision, FlowNodeDefinition } from '../src/contracts';

const value = (id: string, content: unknown): FlowNodeDefinition => ({ id: id as never, name: id, plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: content } as never });
const definition = (id: string, nodes: FlowNodeDefinition[]): FlowRevision => ({ id: id as never, name: id, revision: 1, digest: id, createdAt: 0, nodes, edges: [] });
const call = (id: string, text: string): FlowNodeDefinition => ({ ...value(id, null), plugin: 'builtin.flow', pluginVersion: '2.0.0', config: { flowId: 'child', parameters: { text } } });
const child = (): FlowRevision => ({ ...definition('child', [value('echo', '${param.text}'), value('length', 7)]),
    parameters: [{ name: 'text', type: 'string', required: true }], outputs: {
        result: { value: '${nodes.echo.outputs.result}', schema: { type: 'string' } }, count: { value: '${nodes.length.outputs.result}', schema: { type: 'number' } },
    } });
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

it('passes upstream results to concurrent calls and joins named returns without interpreting user data twice', async () => {
    const parent = definition('parent', [value('source', '${param.secret}'), call('a', '${nodes.source.outputs.result}'), call('b', 'B'),
        value('join', { a: '${nodes.a.outputs.result}', b: '${nodes.b.outputs.result}', count: '${nodes.a.outputs.count}' })]);
    const graph = await flowToDag(parent, undefined, undefined, async () => child());
    const run = await executor.submit('s', graph, { secret: '${param.private}', private: 'PRIVATE' });
    const result = await run.root.wait({ timeoutMs: 4000 });
    expect(result.status, JSON.stringify(result)).toBe('succeeded');
    expect((await run.nodes.get('join')!.status()).task.output).toMatchObject({ outputs: { result: { content: { a: '${param.private}', b: 'B', count: 7 } } } });
});

it('rejects missing arguments without implicitly inheriting parent parameters', async () => {
    const invocation = call('a', 'unused'); invocation.config = { flowId: 'child', parameters: {} };
    const graph = await flowToDag(definition('parent', [invocation]), undefined, undefined, async () => child());
    const run = await executor.submit('s', graph, { text: 'Must not inherit' });
    expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('failed');
    expect(run.nodes.has('a/echo')).toBe(false);
});

it('locks transitive revisions and rejects cycles and silently dropped child policies', async () => {
    let latest = child();
    const first = latest, parent = definition('parent', [call('a', 'A')]);
    const resolver = async (_: string, revision?: number) => revision === 1 ? first : latest;
    parent.dependencyLocks = await lockFlowDependencies(parent, resolver);
    latest = { ...child(), revision: 2, digest: 'changed', nodes: [value('echo', 'changed'), value('length', 2)] };
    const graph = await flowToDag(parent, undefined, undefined, resolver);
    expect(graph.nodes.find(node => node.id === 'a/echo')?.config).toMatchObject({ value: '${param.text}' });
    await expect(lockFlowDependencies({ ...parent, dependencyLocks: undefined }, async () => ({ ...parent, dependencyLocks: undefined }))).rejects.toThrow('cycle');
    await expect(flowToDag(definition('outer', [call('a', 'A')]), undefined, undefined, async () => ({ ...child(), runPolicy: { maxConcurrency: 1 } }))).rejects.toThrow('runPolicy');
    const grouped = definition('parent', [{ ...value('group', null), plugin: 'builtin.taskGroup', config: { maxConcurrency: 1 } },
        call('a', 'A'), { ...value('join', null), plugin: 'builtin.join', config: { mode: 'all' } }]);
    grouped.edges = [{ id: 'g-a', from: 'group', to: 'a', kind: 'control' }, { id: 'a-j', from: 'a', to: 'join' }] as never;
    await expect(flowToDag(grouped, undefined, undefined, async () => child())).rejects.toThrow('taskGroup cannot limit');
    const invalid = call('a', 'A'); invalid.config = { flowId: 'child', parameters: [] };
    await expect(flowToDag(definition('parent', [invalid]), undefined, undefined, async () => child())).rejects.toThrow('parameters must be an object');
});

it('keeps nested call parameters lexical and isolates every descendant passed to the host binder', async () => {
    const middle = { ...definition('middle', [call('inner', '${param.text}')]), parameters: child().parameters,
        outputs: { result: { value: '${nodes.inner.outputs.result}' } } };
    const outer = call('outer', '${vars.message}'); outer.config = { ...outer.config, flowId: 'middle' };
    const parent = { ...definition('parent', [outer, value('read', '${nodes.outer.outputs.result}')]),
        variables: { message: { type: 'string' as const, initial: 'from parent variable' } } };
    const bound: FlowNodeDefinition[] = [];
    const graph = await flowToDag(parent, node => { bound.push(node); return {}; }, undefined, async id => id === 'middle' ? middle : child());
    expect(bound.filter(node => ['echo', 'length'].includes(node.id)).every(node => node.config.invocationContext === 'isolated')).toBe(true);
    const run = await executor.submit('s', graph, { text: 'unrelated parent parameter' });
    expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded');
    expect((await run.nodes.get('read')!.status()).task.output).toMatchObject({ outputs: { result: { content: 'from parent variable' } } });
});

it('waits for the final loop round before exposing a function return', async () => {
    const work = value('work', '${iteration.round}'); work.config = { ...work.config, maxIterations: 2 };
    const feedback = value('feedback', '${nodes.work.outputs.result}'); feedback.config = { ...feedback.config, maxIterations: 2 };
    const looping: FlowRevision = { ...definition('child', [work, feedback]), parameters: child().parameters,
        edges: [{ id: 'forward', from: 'work', to: 'feedback', kind: 'control' }, { id: 'back', from: 'feedback', to: 'work', kind: 'control' }] as never,
        outputs: { result: { value: '${nodes.feedback.outputs.result}' } } };
    const graph = await flowToDag(definition('parent', [call('a', 'A'), value('read', '${nodes.a.outputs.result}')]), undefined, undefined, async () => looping);
    const run = await executor.submit('s', graph);
    expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded');
    expect(run.iterations.get('a/work')).toBe(2);
    expect((await run.nodes.get('read')!.status()).task.output).toMatchObject({ outputs: { result: { content: 2 } } });
});

it('fails the call when its return violates the declared schema and never runs its consumer', async () => {
    const invalid = child(); invalid.outputs!.result.schema = { type: 'number' };
    const graph = await flowToDag(definition('parent', [call('a', 'A'), value('read', '${nodes.a.outputs.result}')]), undefined, undefined, async () => invalid);
    const run = await executor.submit('s', graph);
    expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('failed');
    const consumer = run.nodes.get('read');
    expect(consumer && (await consumer.status()).task.status).not.toBe('succeeded');
    await expect(flowToDag(definition('collision', [call('a', 'A'), value('a__input', 1)]), undefined, undefined, async () => child())).rejects.toThrow('namespace collision');
});

it('preserves control node ownership and join result keys across parallel function instances', async () => {
    const grouped = definition('child', [
        { ...value('group', null), plugin: 'builtin.taskGroup', config: { maxConcurrency: 1 } },
        value('one', 1), value('two', 2), { ...value('join', null), plugin: 'builtin.join', config: { mode: 'all' } },
    ]);
    grouped.edges = ['one', 'two'].flatMap(id => [
        { id: `group-${id}`, from: 'group', to: id, kind: 'control' }, { id: `${id}-join`, from: id, to: 'join' },
    ]) as never;
    grouped.parameters = child().parameters;
    grouped.outputs = { result: { value: '${nodes.join.outputs.result}' } };
    const graph = await flowToDag(definition('parent', [call('a', 'A'), call('b', 'B')]), undefined, undefined, async () => grouped);
    expect(graph.nodes.find(node => node.id === 'a/group')?.config).toMatchObject({ members: ['a/one', 'a/two'], joinId: 'a/join' });
    const run = await executor.submit('s', graph);
    expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded');
    expect((await run.nodes.get('a/__flow_return')!.status()).task.output).toMatchObject({ outputs: { result: { content: { results: { one: 1, two: 2 } } } } });
});

it('remaps a caller route edge to its selected function and namespaces routes inside functions', async () => {
    const route = { ...value('route', null), plugin: 'builtin.route', config: { defaultEdgeId: 'selected' } };
    const routed = { ...child(), nodes: [route, value('echo', '${param.text}'), value('length', 7)],
        edges: [{ id: 'selected', from: 'route', to: 'echo', kind: 'control' }] as never };
    const parent = definition('parent', [route, call('a', 'A')]);
    parent.edges = [{ id: 'selected', from: 'route', to: 'a', kind: 'control' }] as never;
    const graph = await flowToDag(parent, undefined, undefined, async () => routed);
    expect(graph.nodes.find(node => node.id === 'route')?.config).toMatchObject({ defaultEdgeId: 'selected:route->a__input' });
    expect(graph.nodes.find(node => node.id === 'a/route')?.config).toMatchObject({ defaultEdgeId: 'a/selected' });
    const run = await executor.submit('s', graph);
    expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded');
    expect((await run.nodes.get('a/__flow_return')!.status()).task.output).toMatchObject({ outputs: { result: { content: 'A' } } });
});
