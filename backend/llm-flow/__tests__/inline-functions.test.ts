import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { extractNodeOutput } from '@itookit/llm-tasks';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, flowToDag, registerDurablePrograms } from '../src/flow';
import { createFlowRevision } from '../src/flow-definition-store';
import { checkFlowSource, checkFlowSyntax } from '../src/flow/syntax-check';
import { lockFlowDependencies } from '../src/flow/dependency-locks';
import { flowRevisionDigest, validateFlowRevision } from '../src/flow/validation';
import type { FlowDraft, FlowNodeDefinition } from '../src/contracts';

const value = (id: string, content: unknown): FlowNodeDefinition => ({ id: id as never, name: id,
    plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: content } as never });
const draft = (id: string, nodes: FlowNodeDefinition[] = [], functions?: FlowDraft[]): FlowDraft => ({ id: id as never,
    name: id, draftVersion: 1, updatedAt: 0, layout: {}, nodes, edges: [], ...(functions ? { functions } : {}) });
const call = (id: string, flowId = id, config = {}): FlowNodeDefinition => ({ ...value(id, null),
    plugin: 'builtin.flow', pluginVersion: '2.0.0', config: { flowId, ...config } });
const leaf = (id: string, content: unknown): FlowDraft => ({ ...draft(id, [value('echo', content)]),
    outputs: { result: { value: '${nodes.echo.outputs.result}' } } });
const returns = (flow: FlowDraft, expression: string): FlowDraft => ({ ...flow, outputs: { result: { value: expression } } });
let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;
async function startKernel(): Promise<void> {
    const fs = await manager.openFileSystem('/test'); kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
}
beforeEach(async () => { ({ manager } = await createVFS({ rootBackend: new MemoryBackend() })); await startKernel();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } }); });
afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });
async function runResult(source: FlowDraft, resolver?: Parameters<typeof flowToDag>[3]): Promise<unknown> {
    const run = await executor.submit('s', await flowToDag(createFlowRevision(source, 1, 0), undefined, undefined, resolver));
    const exit = await run.root.wait({ timeoutMs: 5000 }); expect(exit.error).toBeUndefined(); expect(exit.status).toBe('succeeded');
    return extractNodeOutput((await run.nodes.get('__flow_return')!.status()).task.output, 'result');
}

it('freezes inline definition trees and includes their content in the owning digest', () => {
    const source = draft('parent', [], [draft('middle', [], [leaf('leaf', 'original')])]);
    const frozen = createFlowRevision(source, 7, 1), same = createFlowRevision(source, 7, 2);
    expect(frozen.functions![0].functions![0]).toMatchObject({ revision: 7, createdAt: 1 });
    expect(frozen.digest).toBe(same.digest);
    source.functions![0].functions![0].nodes[0].config = { value: 'changed' };
    expect(frozen.functions![0].functions![0].nodes[0].config).toEqual({ value: 'original' });
    expect(createFlowRevision(source, 7, 1).digest).not.toBe(frozen.digest);
    frozen.functions![0].functions![0].nodes[0].config = { value: 'tampered' };
    frozen.digest = flowRevisionDigest(frozen);
    expect(validateFlowRevision(frozen)).toContainEqual(expect.objectContaining({ code: 'invalid-inline-digest' }));
});

it('calls inline siblings with repeated named parameters without an external resolver', async () => {
    const worker = { ...leaf('worker', '${param.text}'), parameters: [{ name: 'text', type: 'string' as const, required: true }] };
    const bridge = returns(draft('bridge', [call('work', 'worker', { parameterSets: [{ text: 'a' }, { text: 'b' }], maxConcurrency: 2 })]), '${nodes.work.outputs.result}');
    const source = returns(draft('parent', [call('invoke', 'bridge')], [bridge, worker]), '${nodes.invoke.outputs.result}');
    expect(await runResult(source)).toEqual([{ result: 'a' }, { result: 'b' }]);
    expect((await checkFlowSource(source)).valid).toBe(true);
});

it('uses the nearest definition scope and never lets the caller shadow the callee environment', async () => {
    const globalB = leaf('b', 'root');
    const globalA = returns(draft('a', [call('b')]), '${nodes.b.outputs.result}');
    const caller = returns(draft('caller', [call('a')], [leaf('b', 'caller-shadow')]), '${nodes.a.outputs.result}');
    const source = returns(draft('parent', [call('invoke', 'caller')], [globalA, globalB, caller]), '${nodes.invoke.outputs.result}');
    expect(await runResult(source)).toBe('root');
    const local = returns(draft('caller', [call('b')], [leaf('b', 'nearest')]), '${nodes.b.outputs.result}');
    expect(await runResult(returns(draft('other', [call('invoke', 'caller')], [globalB, local]), '${nodes.invoke.outputs.result}'))).toBe('nearest');
});

it('prefers inline declarations while preserving external fallback and its own lexical environment', async () => {
    const external = createFlowRevision(returns(draft('external', [call('b')], [leaf('b', 'external-local')]), '${nodes.b.outputs.result}'), 1, 0);
    const resolve = vi.fn(async (id: string) => id === 'external' ? external : null);
    const source = returns(draft('parent', [call('local', 'b'), call('remote', 'external')], [leaf('b', 'inline')]),
        '${nodes.remote.outputs.result}');
    expect(await runResult(source, resolve)).toBe('external-local');
    expect(resolve.mock.calls).toEqual([['external', undefined]]);
});

it('pins local and external transitive dependencies and rejects changed inline bodies', async () => {
    const external = createFlowRevision(leaf('external', 'pinned'), 3, 0);
    const source = returns(draft('parent', [call('invoke', 'local')], [returns(draft('local', [call('remote', 'external')]), '${nodes.remote.outputs.result}')]), '${nodes.invoke.outputs.result}');
    const revision = createFlowRevision(source, 4, 0);
    const resolve = vi.fn(async (id: string, version?: number) => id === 'external' && (version === undefined || version === 3) ? external : null);
    revision.dependencyLocks = await lockFlowDependencies(revision, resolve); revision.digest = flowRevisionDigest(revision);
    expect(revision.dependencyLocks.invoke).toMatchObject({ flowId: 'local', revision: 4, digest: revision.functions![0].digest,
        children: { remote: { flowId: 'external', revision: 3, digest: external.digest } } });
    await flowToDag(revision, undefined, undefined, resolve);
    expect(resolve.mock.calls.at(-1)).toEqual(['external', 3]);
    revision.functions![0].nodes.push(value('changed', true));
    await expect(flowToDag(revision, undefined, undefined, resolve)).rejects.toThrow('digest mismatch');
    revision.functions![0].digest = flowRevisionDigest(revision.functions![0]);
    await expect(flowToDag(revision, undefined, undefined, resolve)).rejects.toThrow('digest mismatch');
});

it.each(['self', 'mutual'])('rejects %s inline recursion during compilation and dependency locking', async mode => {
    const a = returns(draft('a', [call('next', mode === 'self' ? 'a' : 'b')]), '${nodes.next.outputs.result}');
    const source = draft('parent', [call('invoke', 'a')], [a, ...(mode === 'mutual' ? [returns(draft('b', [call('next', 'a')]), '${nodes.next.outputs.result}')] : [])]);
    const revision = createFlowRevision(source, 1, 0);
    await expect(flowToDag(revision)).rejects.toThrow('cycle');
    await expect(lockFlowDependencies(revision, async () => null)).rejects.toThrow('cycle');
});

it('rejects duplicate names, malformed definitions and declaration count limits', () => {
    expect(() => createFlowRevision(draft('parent', [], [leaf('same', 1), leaf('same', 2)]), 1)).toThrow('Duplicate inline');
    expect(checkFlowSyntax({ ...draft('parent'), functions: [{}] }).diagnostics).toContainEqual(expect.objectContaining({ path: '$.functions[0].id' }));
    expect(() => createFlowRevision(draft('parent', [], Array.from({ length: 1000 }, (_, index) => leaf(`fn${index}`, index))), 1)).toThrow('declaration limit');
});

it('resumes an inline repeated call from persisted templates after the source changes', async () => {
    const worker = { ...leaf('worker', '${param.text}'), parameters: [{ name: 'text', type: 'string' as const, required: true }],
        nodes: [{ ...value('wait', null), plugin: 'builtin.human', config: { requestId: 'answer', prompt: 'Continue' } }] };
    worker.outputs = { result: { value: '${param.text}' } };
    const source = returns(draft('parent', [call('invoke', 'worker', { parameterSets: [{ text: 'original' }] })], [worker]), '${nodes.invoke.outputs.result}');
    const run = await executor.submit('s', await flowToDag(createFlowRevision(source, 1, 0)));
    await vi.waitFor(async () => expect((await kernel.listSessionTasks('s')).some(task => task.interactions.answer?.status === 'pending')).toBe(true));
    const taskId = run.nodes.get('invoke/0/wait')!.id;
    worker.outputs.result.value = 'changed'; kernel.dispose(); await executor.waitIdle(); await startKernel();
    const resumed = await executor.resume('s', run.root.id);
    await (await (await kernel.openSession('s')).attachTask(taskId)).respond({ interactionId: 'answer', value: true });
    expect((await resumed.root.wait({ timeoutMs: 5000 })).status).toBe('succeeded');
    expect(extractNodeOutput((await resumed.nodes.get('__flow_return')!.status()).task.output, 'result')).toEqual([{ result: 'original' }]);
    expect(resumed.nodes.get('invoke/0/wait')!.id).toBe(taskId);
});

it('rejects unknown call targets, mismatched explicit local revisions and excessive declaration depth', async () => {
    const source = draft('parent', [call('invoke', 'missing')], [leaf('local', 'value')]);
    await expect(flowToDag(createFlowRevision(source, 1, 0))).rejects.toThrow('external resolver: missing');
    source.nodes = [call('invoke', 'local', { revision: 1 })];
    await expect(flowToDag(createFlowRevision(source, 2, 0))).rejects.toThrow('Inline Flow revision mismatch');
    let nested = leaf('bottom', 'value');
    for (let depth = 0; depth < 33; depth++) nested = draft(`level${depth}`, [], [nested]);
    expect(() => createFlowRevision(nested, 1, 0)).toThrow('declaration limit');
});

it('accepts exactly 32 nested inline calls in both compilation and dependency locking', async () => {
    let fn = leaf('fn32', 'done');
    for (let index = 31; index >= 1; index--) fn = returns(draft(`fn${index}`, [call('next', `fn${index + 1}`)], [fn]), '${nodes.next.outputs.result}');
    const revision = createFlowRevision(draft('parent', [call('invoke', 'fn1')], [fn]), 1, 0);
    expect((await flowToDag(revision)).nodes.length).toBeGreaterThan(32);
    expect(await lockFlowDependencies(revision, async () => null)).toHaveProperty('invoke');
});
