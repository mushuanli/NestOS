import { readFlowSchedulerCheckpoint } from '../src/flow/checkpoint-store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { extractNodeOutput } from '@itookit/llm-tasks';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, flowToDag, registerDurablePrograms } from '../src/flow';
import { checkFlowSource } from '../src/flow/syntax-check';
import type { FlowNodeDefinition, FlowRevision } from '../src/contracts';

const value = (id: string, content: unknown): FlowNodeDefinition => ({ id: id as never, name: id,
    plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: content } as never });
const definition = (id: string, nodes: FlowNodeDefinition[]): FlowRevision => ({ id: id as never, name: id,
    revision: 1, digest: id, createdAt: 0, nodes, edges: [] });
const call = (id: string, config: Record<string, unknown>): FlowNodeDefinition => ({ ...value(id, null),
    plugin: 'builtin.flow', pluginVersion: '2.0.0', config: { flowId: 'child', ...config } as never });
const child = (): FlowRevision => ({ ...definition('child', [value('echo', { id: '${param.id}', text: '${param.text}' })]),
    parameters: [{ name: 'id', type: 'number', required: true }, { name: 'text', type: 'string', required: true }],
    outputs: { item: { value: '${nodes.echo.outputs.result}' }, tag: { value: '${param.text}' } } });
let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;

async function startKernel(): Promise<void> {
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
}
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    await startKernel(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
});
afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });
async function result(run: Awaited<ReturnType<DurableFlowExecutor['submit']>>): Promise<unknown> {
    const exit = await run.root.wait({ timeoutMs: 5000 });
    expect(exit.error).toBeUndefined(); expect(exit.status).toBe('succeeded');
    return extractNodeOutput((await run.nodes.get('call/__flow_return')!.status()).task.output, 'result');
}
async function waiting(id: string): Promise<void> {
    try { await vi.waitFor(async () => expect((await kernel.listSessionTasks('s')).some(task => task.interactions?.[id]?.status === 'pending'), id).toBe(true)); }
    catch { throw new Error(id + ': ' + JSON.stringify((await kernel.listSessionTasks('s')).map(task => ({ status: task.status, kind: task.program.kind, error: task.exit?.error ?? task.lastError })))); }
}
async function respond(id: string): Promise<void> {
    const session = await kernel.openSession('s');
    const task = (await session.listTasks()).find(task => task.interactions?.[id]?.status === 'pending')!;
    await (await session.attachTask(task.id)).respond({ interactionId: id, value: 'ok' });
}

it('calls one frozen Flow with upstream parameter objects, shared arguments and literal data', async () => {
    const rows = [{ id: 1 }, { id: 2, text: '${param.secret}' }];
    const parent = { ...definition('parent', [value('source', '${param.jobs}'), call('call', { parameters: { text: 'shared' },
        parameterSets: '${nodes.source.outputs.result}', maxConcurrency: 2 }), value('consume', '${nodes.call.outputs.result}')]), parameters: [{ name: 'jobs', type: 'json' as const, required: true }] };
    const resolve = vi.fn(async () => child());
    const spec = await flowToDag(parent, undefined, undefined, resolve);
    const run = await executor.submit('s', spec, { jobs: rows });
    expect(await result(run)).toEqual([{ item: { id: 1, text: 'shared' }, tag: 'shared' },
        { item: { id: 2, text: '${param.secret}' }, tag: '${param.secret}' }]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(extractNodeOutput((await run.nodes.get('consume')!.status()).task.output, 'result')).toEqual(await result(run));
});

it('returns an empty result for zero calls', async () => {
    const spec = await flowToDag(definition('parent', [call('call', { parameterSets: [] })]), undefined, undefined, async () => child());
    const run = await executor.submit('s', spec);
    expect(await result(run)).toEqual([]);
    expect([...run.nodes.keys()].filter(id => id.startsWith('call/0/'))).toEqual([]);
});

function waitingChild(): FlowRevision {
    const human = (id: string) => ({ ...value(id, null), plugin: 'builtin.human', config: { requestId: `${id}-\${param.id}`, prompt: id } });
    return { ...child(), nodes: [human('first'), human('second')],
        edges: [{ id: 'phases' as never, from: 'first' as never, to: 'second' as never, kind: 'control' }],
        outputs: { item: { value: '${param.id}' } } };
}
it('limits an entire multi-node call and resumes persisted groups without replay', async () => {
    const spec = await flowToDag(definition('parent', [call('call', { parameters: { text: 'shared' },
        parameterSets: [{ id: 1 }, { id: 2 }], maxConcurrency: 1 })]), undefined, undefined, async () => waitingChild());
    const run = await executor.submit('s', spec);
    await waiting('first-1'); const inputId = run.nodes.get('call__input')!.id, firstId = run.nodes.get('call/0/first')!.id;
    await respond('first-1'); await waiting('second-1');
    expect(run.nodes.has('call/1/first')).toBe(false);
    kernel.dispose(); await executor.waitIdle(); await startKernel();
    const resumed = await executor.resume('s', run.root.id);
    await waiting('second-1');
    expect(resumed.nodes.get('call__input')!.id).toBe(inputId);
    expect(resumed.nodes.get('call/0/first')!.id).toBe(firstId);
    expect((await kernel.listSessionTasks('s')).filter(task => task.id === firstId)).toHaveLength(1);
    await respond('second-1'); await waiting('first-2'); await respond('first-2'); await waiting('second-2'); await respond('second-2');
    expect(await result(resumed)).toEqual([{ item: 1 }, { item: 2 }]);
});

it('bounds parallel call lanes and preserves input order after out-of-order completion', async () => {
    const spec = await flowToDag(definition('parent', [call('call', { parameters: { text: 'shared' },
        parameterSets: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], maxConcurrency: 2 })]), undefined, undefined, async () => waitingChild());
    const run = await executor.submit('s', spec);
    await waiting('first-1'); await waiting('first-2');
    expect(run.nodes.has('call/2/first')).toBe(false);
    await respond('first-2'); await waiting('second-2'); await respond('second-2'); await waiting('first-4');
    expect(run.nodes.has('call/2/first')).toBe(false);
    await respond('first-4'); await waiting('second-4'); await respond('second-4');
    await respond('first-1'); await waiting('second-1'); await respond('second-1'); await waiting('first-3');
    await respond('first-3'); await waiting('second-3'); await respond('second-3');
    expect(await result(run)).toEqual([{ item: 1 }, { item: 2 }, { item: 3 }, { item: 4 }]);
});

it.each([{ rows: [{ id: 'invalid' }] }, { rows: [{ id: 1, unexpected: true }] }, { rows: [null] }])('rejects malformed call rows atomically (%j)', async ({ rows }) => {
    const spec = await flowToDag(definition('parent', [call('call', { parameters: { text: 'shared' }, parameterSets: rows })]), undefined, undefined, async () => child());
    const run = await executor.submit('s', spec), exit = await run.root.wait({ timeoutMs: 5000 });
    expect(exit.status).toBe('failed'); expect(exit.error?.message).toMatch(/parameterSets\[0\]/);
    expect([...run.nodes.keys()].some(id => /^call\/\d/.test(id))).toBe(false);
});

it('rejects the whole batch before any child executes when maxNodes is exceeded', async () => {
    const spec = await flowToDag(definition('parent', [call('call', { parameters: { text: 'shared' }, parameterSets: [{ id: 1 }, { id: 2 }] })]), undefined, undefined, async () => child());
    const run = await executor.submit('s', { ...spec, maxNodes: 5 });
    const exit = await run.root.wait({ timeoutMs: 5000 });
    expect(exit.status).toBe('failed'); expect(exit.error?.message).toContain('node limit exceeded');
    expect([...run.nodes.keys()].some(id => /^call\/\d/.test(id))).toBe(false);
});

it('isolates variables between repeated and nested function calls', async () => {
    const inner = { ...child(), variables: { current: { type: 'number' as const, initial: '${param.id}' } },
        nodes: [{ ...value('echo', '${vars.current}'), assign: { current: '${param.id}' } }],
        outputs: { item: { value: '${nodes.echo.outputs.result}' } } };
    const outer = { ...child(), nodes: [call('nested', { parameterSets: [{ id: '${param.id}' }], parameters: { text: '${param.text}' } })],
        outputs: { item: { value: '${nodes.nested.outputs.result}' } } };
    const parent = definition('parent', [call('call', { flowId: 'outer', parameterSets: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }], maxConcurrency: 2 })]);
    const spec = await flowToDag(parent, undefined, undefined, async id => id === 'outer' ? outer : inner);
    const run = await executor.submit('s', spec);
    expect(await result(run)).toEqual([{ item: [{ item: 1 }] }, { item: [{ item: 2 }] }]);
});

it('validates static rows and defers dynamic row shape to runtime', async () => {
    const check = (parameterSets: unknown) => checkFlowSource(definition('parent', [call('call', { parameters: { text: 'shared' }, parameterSets })]), { resolveComposite: async () => child() });
    expect((await check([{ id: 1 }])).valid).toBe(true);
    expect((await check([{ id: 'bad' }])).diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-call-parameter' }));
});

it('keeps route decisions and dynamically spawned work inside each repeated call', async () => {
    const fn = { ...child(), nodes: [value('selected', '${param.id}'), value('unused', 'unused'), value('merge', '${param.id}'),
        { ...value('route', null), plugin: 'builtin.route', config: { rules: [{ edgeId: 'selected', expression: { kind: 'literal', value: true } }], defaultEdgeId: 'unused' } },
        { ...value('spawn', null), plugin: 'builtin.spawn', config: { scope: 'local', spawn: { idempotencyKey: 'work',
            nodes: [value('work', '${param.text}')], edges: [{ id: 'spawned', from: '$parent', to: 'work', kind: 'control' }] } } }],
        edges: [{ id: 'selected', from: 'route', to: 'selected', kind: 'control' }, { id: 'unused', from: 'route', to: 'unused', kind: 'control' },
            { id: 'selected-merge', from: 'selected', to: 'merge', kind: 'control' }, { id: 'unused-merge', from: 'unused', to: 'merge', kind: 'control' }] as FlowRevision['edges'],
        outputs: { item: { value: '${nodes.merge.outputs.result}' } } };
    const spec = await flowToDag(definition('parent', [call('call', { parameterSets: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }], maxConcurrency: 2 })]), undefined, undefined, async () => fn);
    const run = await executor.submit('s', spec);
    expect(await result(run)).toEqual([{ item: 1 }, { item: 2 }]);
    for (let index = 0; index < 2; index++) {
        expect(run.nodes.has(`call/${index}/unused`)).toBe(false);
        expect((await run.nodes.get(`call/${index}/work`)!.status()).task.status).toBe('succeeded');
    }
});

it('propagates a failed repeated call to the collector and downstream consumers', async () => {
    const fn = { ...child(), outputs: { item: { value: '${param.text}', schema: { type: 'number' } } } };
    const parent = definition('parent', [call('call', { parameterSets: [{ id: 1, text: 'invalid' }, { id: 2, text: 'invalid' }] }),
        value('consume', '${nodes.call.outputs.result}')]);
    const run = await executor.submit('s', await flowToDag(parent, undefined, undefined, async () => fn));
    const exit = await run.root.wait({ timeoutMs: 5000 });
    expect(exit.status).toBe('failed'); expect(exit.error?.message).toContain('Invalid Flow return item');
    expect((await run.nodes.get('call/__flow_return')!.status()).task.status).toBe('failed');
    expect((await run.nodes.get('consume')!.status()).task.status).toBe('failed');
});

it('runs bounded child loops independently within each call', async () => {
    const work = { ...value('work', '${iteration.round}'), config: { value: '${iteration.round}', maxIterations: 2 } };
    const feedback = { ...value('feedback', '${nodes.work.outputs.result}'), config: { value: '${nodes.work.outputs.result}', maxIterations: 2 } };
    const fn = { ...child(), nodes: [work, feedback], edges: [
        { id: 'forward', from: 'work', to: 'feedback', kind: 'control' },
        { id: 'back', from: 'feedback', to: 'work', kind: 'control' },
    ] as FlowRevision['edges'], outputs: { item: { value: '${nodes.feedback.outputs.result}' } } };
    const spec = await flowToDag(definition('parent', [call('call', { parameterSets: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }] })]), undefined, undefined, async () => fn);
    const run = await executor.submit('s', spec);
    expect(await result(run)).toEqual([{ item: 2 }, { item: 2 }]);
    expect(run.iterations.get('call/0/work')).toBe(2); expect(run.iterations.get('call/1/work')).toBe(2);
});

it('pins not-yet-expanded template manifests before its input dependency completes', async () => {
    const fn = { ...child(), nodes: [{ ...value('agent', null), plugin: 'builtin.agent', config: { instruction: '${param.text}' } }],
        outputs: { item: { value: '${nodes.agent.outputs.result}' } } };
    const gate = { ...value('gate', null), plugin: 'builtin.human', config: { requestId: 'gate', prompt: 'Continue' } };
    const parent = { ...definition('parent', [gate, call('call', { parameterSets: [{ id: 1, text: 'a' }] })]),
        edges: [{ id: 'gate', from: 'gate', to: 'call', kind: 'control' }] as FlowRevision['edges'] };
    const run = await executor.submit('s', await flowToDag(parent, undefined, undefined, async () => fn));
    await waiting('gate');
    const saved = (await readFlowSchedulerCheckpoint(await kernel.openSession('s'), run.root.id))!;
    expect(saved.catalog.manifests.some(([key]: [string]) => key === '["builtin.agent","1.0.0"]')).toBe(true);
    expect([...run.nodes.keys()].some(id => /^call\/\d/.test(id))).toBe(false);
    await run.root.cancel('Test complete');
});

it('records expansion outcomes without including supplied argument data', async () => {
    const events: unknown[] = [], inputCompletions: string[] = [];
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), hooks: {
        descriptor: { source: 'test', contentHash: 'test', trusted: true },
        async emit(context) {
            if ((context.payload as any)?.operation === 'flow.call.expand') events.push({ event: context.event, ...context.payload as any });
            if (context.event === 'task.completed' && (context.payload as any)?.nodeId === 'call__input') inputCompletions.push(context.sessionId);
        },
    } });
    const make = async (parameterSets: unknown) => flowToDag(definition('parent', [call('call', { parameterSets })]), undefined, undefined, async () => child());
    const good = await executor.submit('s', await make([{ id: 1, text: 'private-argument' }]));
    expect(await result(good)).toEqual([{ item: { id: 1, text: 'private-argument' }, tag: 'private-argument' }]);
    const bad = await executor.submit('s', await make([{ id: 'private-argument', text: 'private-argument' }]));
    expect((await bad.root.wait({ timeoutMs: 5000 })).status).toBe('failed');
    expect(events).toContainEqual(expect.objectContaining({ event: 'flow.calls.expanded', operation: 'flow.call.expand', result: 'success', rootTaskId: good.root.id, operationId: `${good.root.id}:call__input`, count: 1, maxConcurrency: 1, elapsedMs: expect.any(Number) }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'flow.calls.failed', operation: 'flow.call.expand', result: 'failure', rootTaskId: bad.root.id, operationId: `${bad.root.id}:call__input`, errorCategory: 'invalid-parameter-set', elapsedMs: expect.any(Number) }));
    expect(JSON.stringify(events)).not.toContain('private-argument');
    expect(inputCompletions).toHaveLength(2);
});

it('admits structured dispatch capacity with the completed call parameter scope', async () => {
    const route = { ...value('route', null), plugin: 'builtin.route', pluginVersion: '2.0.0', config: {
        mode: 'multicast', maxRounds: '${param.id}', maxConcurrency: 1, context: { history: 'none' },
        until: { kind: 'literal', value: true }, branches: [{ key: 'check', input: {},
            target: value('check', 7), output: { kind: 'path', path: ['output', 'outputs', 'result', 'content'] } }],
    } };
    const fn = { ...child(), nodes: [route], outputs: { item: { value: '${param.id}' } } };
    const spec = await flowToDag(definition('parent', [call('call', { parameterSets: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }] })]), undefined, undefined, async () => fn);
    const run = await executor.submit('s', spec);
    expect(await result(run)).toEqual([{ item: 1 }, { item: 2 }]);
});
