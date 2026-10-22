import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel, type EffectAdapter } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { extractNodeOutput } from '@itookit/llm-tasks';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, flowToDag, registerDurablePrograms } from '../src/flow';
import { createFlowRevision } from '../src/flow-definition-store';
import { checkFlowSource } from '../src/flow/syntax-check';
import { compileReferenceGraph } from '../src/flow/structured/references';
import { compileCondition } from '../src/flow/structured/condition';
import { evaluate } from '../src/flow/operations';
import { renderFlowTemplate, flowTemplateReferences } from '../src/contracts';
import type { DagRunSpec, FlowDraft, FlowNodeDefinition } from '../src/contracts';

const value = (id: string, content: unknown): FlowNodeDefinition => ({ id: id as never, name: id,
    plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: content } as never });
const draft = (id: string, nodes: FlowNodeDefinition[], outputs: FlowDraft['outputs'] = { result: { value: '${input.prompt}' } }): FlowDraft => ({
    id: id as never, name: id, draftVersion: 1, updatedAt: 0, layout: {}, nodes, edges: [], outputs });
const call = (id: string, flowId: string, config = {}): FlowNodeDefinition => ({ ...value(id, null),
    plugin: 'builtin.flow', pluginVersion: '2.0.0', config: { flowId, ...config } });
let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;
let requests: string[];
async function startKernel(): Promise<void> {
    const fs = await manager.openFileSystem('/test'); kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel);
    kernel.registerEffect({ kind: 'llm.chat', version: '1', async execute(request: Record<string, unknown>) {
        requests.push(JSON.stringify(request));
        return { choices: [{ index: 0, message: { role: 'assistant', content: '{"score":9}' }, finish_reason: 'stop' }] };
    } } as EffectAdapter);
    await kernel.initialize(); executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
}
beforeEach(async () => { ({ manager } = await createVFS({ rootBackend: new MemoryBackend() })); requests = [];
    await startKernel(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } }); });
afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });
async function result(run: Awaited<ReturnType<DurableFlowExecutor['submit']>>): Promise<any> {
    const exit = await run.root.wait({ timeoutMs: 6000 }); expect(exit.error, JSON.stringify(exit.error)).toBeUndefined(); expect(exit.status).toBe('succeeded');
    const output = (await run.nodes.get('__flow_return')!.status()).task.output as { outputs: Record<string, { content: unknown }> };
    return Object.fromEntries(Object.entries(output.outputs).map(([name, artifact]) => [name, artifact.content]));
}

it('recognizes the immutable input root without producing parameter dependencies', () => {
    expect(flowTemplateReferences('${input.prompt}')).toEqual([{ root: 'input', path: ['prompt'] }]);
    expect(flowTemplateReferences({ kind: 'path', path: ['input', 'legacy-port-value'] })).toEqual([]);
    expect(renderFlowTemplate('${input.prompt}', {})).toBe('');
    expect(renderFlowTemplate('P:${input.prompt}', { input: { prompt: '${param.secret}' }, param: { secret: 'PRIVATE' } })).toBe('P:${param.secret}');
    expect(() => renderFlowTemplate('${input.constructor}', { input: { prompt: '' } })).toThrow('Unsafe');
    const compiled = compileReferenceGraph({ nodes: [value('echo', '${input.prompt}')], edges: [] });
    expect(compiled.edges).toEqual([]);
    const condition = compileCondition({ value: '${input.prompt}', operator: 'eq', expected: 'match' });
    expect(evaluate(condition, { input: { prompt: 'match' }, inputs: { prompt: 'different' } })).toBe(true);
});

it('defaults prompt to empty independently from a declared prompt parameter', async () => {
    const source = { ...draft('default', [value('echo', '${input.prompt}')], {
        result: { value: '${input.prompt}' }, param: { value: '${param.prompt}' } }),
        parameters: [{ name: 'prompt', type: 'string' as const, required: true }] };
    const run = await executor.submit('s', await flowToDag(createFlowRevision(source, 1, 0)), { prompt: 'parameter value' });
    expect(await result(run)).toEqual({ result: '', param: 'parameter value' });
});

it('initializes writable variables from the frozen prompt without mutating the invocation input', async () => {
    const prompt = 'literal ${param.secret}', source = { ...draft('variables', [
        { ...value('write', '${input.prompt}'), assign: { scratch: 'changed' } }, value('read', '${vars.scratch}'),
    ], { result: { value: '${input.prompt}' }, initial: { value: '${vars.initial}' }, changed: { value: '${nodes.read.outputs.result}' } }),
        variables: { initial: { type: 'string' as const, initial: '${input.prompt}' }, scratch: { type: 'string' as const, initial: '${input.prompt}' } },
        edges: [{ id: 'order', from: 'write', to: 'read', kind: 'control' }] as FlowDraft['edges'] };
    expect((await checkFlowSource(source)).valid).toBe(true);
    const input = { prompt }, spec = { ...await flowToDag(createFlowRevision(source, 1, 0)), input };
    const run = await executor.submit('s', spec); input.prompt = 'external mutation';
    expect(await result(run)).toEqual({ result: prompt, initial: prompt, changed: 'changed' });
});

it('shares the same frozen input across nested batch functions and dynamically spawned nodes', async () => {
    const prompt = '${param.secret}';
    const worker = { ...draft('worker', [value('echo', { prompt: '${input.prompt}', row: '${param.row}' }),
        { ...value('spawn', null), plugin: 'builtin.spawn', config: { scope: 'local', spawn: { idempotencyKey: 'work',
            nodes: [value('dynamic', '${input.prompt}')], edges: [{ id: 'start', from: '$parent', to: 'dynamic', kind: 'control' }] } } }],
        { result: { value: '${nodes.echo.outputs.result}' } }), parameters: [{ name: 'row', type: 'number' as const, required: true }] };
    const middle = draft('middle', [call('batch', 'worker', { parameterSets: [{ row: 1 }, { row: 2 }], maxConcurrency: 2 })],
        { result: { value: '${nodes.batch.outputs.result}' } });
    const source = { ...draft('parent', [call('invoke', 'middle')], { result: { value: '${nodes.invoke.outputs.result}' } }), functions: [middle, worker] };
    const spec = { ...await flowToDag(createFlowRevision(source, 1, 0)), input: { prompt } };
    const run = await executor.submit('s', spec);
    expect(await result(run)).toEqual({ result: [{ result: { prompt, row: 1 } }, { result: { prompt, row: 2 } }] });
    for (const index of [0, 1]) expect(extractNodeOutput((await run.nodes.get(`invoke/batch/${index}/dynamic`)!.status()).task.output, 'result')).toBe(prompt);
});

it('restores frozen input and variable initialization after a new Kernel attaches', async () => {
    const source = { ...draft('restore', [{ ...value('wait', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: '${input.prompt}' } }],
        { result: { value: '${input.prompt}' }, initial: { value: '${vars.initial}' } }), variables: { initial: { type: 'string' as const, initial: '${input.prompt}' } } };
    const spec = { ...await flowToDag(createFlowRevision(source, 1, 0)), input: { prompt: 'original ${param.secret}' } };
    const run = await executor.submit('s', spec);
    await vi.waitFor(async () => expect((await run.nodes.get('wait')?.status())?.task.interactions.answer?.status).toBe('pending'));
    const taskId = run.nodes.get('wait')!.id; spec.input.prompt = 'changed';
    kernel.dispose(); await executor.waitIdle(); await startKernel();
    const resumed = await executor.resume('s', run.root.id);
    await (await (await kernel.openSession('s')).attachTask(taskId)).respond({ interactionId: 'answer', value: true });
    expect(await result(resumed)).toEqual({ result: 'original ${param.secret}', initial: 'original ${param.secret}' });
});

it('preserves input in deferred structured prompts, assignments and human revision across restart', async () => {
    const prompt = 'request ${param.secret}';
    const route = { ...value('route', null), plugin: 'builtin.route', pluginVersion: '2.0.0', config: {
        mode: 'exclusive', maxRounds: 2, maxConcurrency: 1, context: { history: 'none' },
        invocationDefaults: { prompt: 'shared ${input.prompt}' },
        until: { kind: 'gte', args: [{ kind: 'path', path: ['round'] }, { kind: 'literal', value: 2 }] },
        branches: [{ key: 'check', prompt: 'branch ${input.prompt}', instruction: 'rule ${input.prompt}', assign: { seen: '${input.prompt}' },
            input: { copy: { kind: 'path', path: ['input', 'prompt'] } }, outputFormat: 'json',
            target: { ...value('agent', null), plugin: 'builtin.agent', config: { instruction: 'Check', approval: 'none' }, inputs: { promptCopy: '${input.prompt}' } } }],
        revision: { fields: { label: { type: 'string', required: true } }, prompt: 'rev ${input.prompt}' },
    } };
    const source = { ...draft('structured', [route], { result: { value: '${input.prompt}' }, seen: { value: '${vars.seen}' } }),
        variables: { seen: { type: 'string' as const, initial: '${input.prompt}' } },
        parameters: [{ name: 'secret', type: 'string' as const, required: true }] };
    const spec = { ...await flowToDag(createFlowRevision(source, 1, 0)), input: { prompt } };
    const run = await executor.submit('s', spec, { secret: 'PRIVATE_VALUE' });
    await vi.waitFor(async () => expect((await run.nodes.get('route')?.status())?.task.interactions['revision-1']?.status).toBe('pending'));
    expect((await run.nodes.get('route')!.status()).task.interactions['revision-1'].prompt).toBe(`rev ${prompt}`);
    const routeId = run.nodes.get('route')!.id; spec.input.prompt = 'changed';
    kernel.dispose(); await executor.waitIdle(); await startKernel();
    const resumed = await executor.resume('s', run.root.id);
    await (await (await kernel.openSession('s')).attachTask(routeId)).respond({ interactionId: 'revision-1', value: { label: 'next' } });
    expect(await result(resumed)).toEqual({ result: prompt, seen: prompt });
    expect(requests).toHaveLength(2);
    for (const request of requests) { expect(request).toContain(prompt); expect(request).not.toContain('PRIVATE_VALUE'); }
});

it.each([null, {}, { prompt: null }, { prompt: 1 }, { prompt: 'private', other: true }])('rejects malformed runtime input without including it in the error (%j)', async input => {
    const spec = { ...await flowToDag(createFlowRevision(draft('invalid', [value('echo', '${input.prompt}')]), 1, 0)), input } as DagRunSpec;
    await expect(executor.submit('s', spec)).rejects.toThrow('Invalid Flow runtime input: prompt must be a string');
});

it('retains deferred input references through nested static spawn and a persisted wait', async () => {
    const prompt = 'literal ${param.secret}';
    const nested = { ...value('nested', null), plugin: 'builtin.spawn', config: { scope: 'local', spawn: { idempotencyKey: 'nested',
        nodes: [value('leaf', '${input.prompt}')], edges: [{ id: 'leaf', from: '$parent', to: 'leaf', kind: 'control' }] } } };
    const wait = { ...value('wait', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: '${input.prompt}' } };
    const spawn = { ...value('spawn', null), plugin: 'builtin.spawn', config: { scope: 'local', spawn: { idempotencyKey: 'outer', nodes: [wait, nested],
        edges: [{ id: 'wait', from: '$parent', to: 'wait', kind: 'control' }, { id: 'continue', from: 'wait', to: 'nested', kind: 'control' }] } } };
    const spec = { ...await flowToDag(createFlowRevision(draft('spawn-restore', [spawn]), 1, 0)), input: { prompt } };
    const run = await executor.submit('s', spec);
    await vi.waitFor(async () => expect((await run.nodes.get('wait')?.status())?.task.interactions.answer?.status).toBe('pending'));
    const taskId = run.nodes.get('wait')!.id; spec.input.prompt = 'changed';
    kernel.dispose(); await executor.waitIdle(); await startKernel();
    const resumed = await executor.resume('s', run.root.id);
    await (await (await kernel.openSession('s')).attachTask(taskId)).respond({ interactionId: 'answer', value: true });
    expect(await result(resumed)).toEqual({ result: prompt });
    expect(extractNodeOutput((await resumed.nodes.get('leaf')!.status()).task.output, 'result')).toBe(prompt);
});

it('validates the built-in input field without adding it to authored parameter declarations', async () => {
    const source = draft('syntax', [value('echo', '${input.prompt}')]);
    expect((await checkFlowSource(source)).valid).toBe(true);
    source.nodes[0].config = { value: '${input.other}' };
    expect((await checkFlowSource(source)).diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown-runtime-input' }));
});
