import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DagRunSpec, DagNodeDefinition, JsonValue } from '../src/contracts';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IVFSManager, type IFileSystem } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms, flowToDag, validateFlowRevision } from '../src/flow';
import { compileControlGraph } from '../src/flow/control/graph';
import { FlowJoinProgram } from '../src/flow/control/join-program';
import { findCycles } from '../src/flow/graph';

function node(id: string, plugin: string, config: Record<string, JsonValue> = {}): DagNodeDefinition {
    return { id, name: id, plugin: `builtin.${plugin}`, pluginVersion: '1.0.0', inputs: {}, config };
}
function graph(limit = 2, mode = 'all', remaining = 'continue'): DagRunSpec {
    return { nodes: [node('group', 'taskGroup', { maxConcurrency: limit }),
        ...['a', 'b', 'c'].map(id => node(id, 'agent', { approval: 'none', historyPolicy: 'none', systemPrompt: [id], messages: [{ role: 'user', content: id }] })),
        node('join', 'join', { mode, remaining }), node('report', 'transform')],
    edges: [...['a', 'b', 'c'].flatMap(id => [
        { id: `group-${id}`, from: 'group', to: id, kind: 'control' as const, output: 'result', input: 'input' },
        { id: `${id}-join`, from: id, to: 'join', output: 'result', input: 'input' }]),
        { id: 'join-report', from: 'join', to: 'report', output: 'result', input: 'input' }] };
}

describe('ordinary task groups and joins', () => {
    let manager: IVFSManager, fs: IFileSystem, kernel: Kernel, executor: DurableFlowExecutor;
    let calls: string[], active: number, peak: number;
    let automatic: boolean, scores: number[], invalidRevisions: number, requests: any[];
    let releases: Map<string, () => void>;
    beforeEach(async () => {
        ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
        fs = await manager.openFileSystem('/test'); calls = []; active = 0; peak = 0; releases = new Map();
        automatic = false; scores = []; invalidRevisions = 0; requests = [];
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
        registerDurablePrograms(kernel);
        kernel.registerEffect({ kind: 'llm.chat', version: '1', async execute(request: any, context) {
            const id = request.request.messages[0].content;
            calls.push(id); peak = Math.max(peak, ++active);
            requests.push(structuredClone(request));
            try {
                if (automatic) {
                    const revising = JSON.stringify(request).includes('你是作文修改员');
                    const content = revising && invalidRevisions-- > 0 ? 'not JSON' : JSON.stringify(revising
                        ? { essay: 'REVISED_ESSAY' } : { score: scores.shift() ?? 9, issues: [], suggestions: [] });
                    return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { total_tokens: 2 } };
                }
                await new Promise<void>((resolve, reject) => {
                    releases.set(id, resolve);
                    context.abortSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
                });
                return { choices: [{ message: { role: 'assistant', content: id }, finish_reason: 'stop' }] };
            } finally { active--; }
        }, async cancel() {} });
        await kernel.initialize(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
    });
    afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

    it('preserves worker and join tasks and bounds actual concurrent requests', async () => {
        const run = await executor.submit('s', graph(2));
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        await vi.waitFor(() => expect(run.nodes.has('join')).toBe(true));
        expect(run.nodes.has('c')).toBe(true);
        expect((await run.nodes.get('c')!.status()).task.status).toBe('created');
        releases.get('a')!();
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        releases.get('b')!(); releases.get('c')!();
        expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded');
        expect(peak).toBe(2);
        expect((await run.nodes.get('join')!.status()).task.program.kind).toBe('flow.join');
        expect((await run.nodes.get('report')!.status()).task.output).toMatchObject({ outputs: { result: { content: { results: { a: 'a', b: 'b', c: 'c' } } } } });
    });

    it.each(['continue', 'cancel'])('keeps first-success waiting independent of remaining=%s', async remaining => {
        const run = await executor.submit('s', graph(1, 'first-success', remaining));
        await vi.waitFor(() => expect(calls).toEqual(['a']));
        await vi.waitFor(() => expect(run.nodes.has('join')).toBe(true));
        releases.get('a')!();
        await vi.waitFor(async () => expect((await run.nodes.get('report')?.status())?.task.status).toBe('succeeded'));
        if (remaining === 'continue') {
            await vi.waitFor(() => expect(releases.has('b')).toBe(true)); releases.get('b')!();
            await vi.waitFor(() => expect(releases.has('c')).toBe(true)); releases.get('c')!();
        }
        expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded');
        if (remaining === 'cancel') expect((await run.nodes.get('c')!.status()).task.status).toBe('cancelled');
    });

    it('honors a Run concurrency of one without deadlocking the join', async () => {
        const run = await executor.submit('s', { ...graph(3), maxConcurrency: 1 });
        for (const id of ['a', 'b', 'c']) {
            await vi.waitFor(() => expect(releases.has(id)).toBe(true)); releases.get(id)!();
        }
        expect((await run.root.wait({ timeoutMs: 4000 })).status).toBe('succeeded'); expect(peak).toBe(1);
    });

    it.each([1, 2])('executes the shipped ordinary graph with maxRounds=%s and three revision repairs', async maxRounds => {
        automatic = true; scores = Array(8).fill(7); invalidRevisions = 3;
        const draft = JSON.parse(readFileSync(new URL('../../app-core/src/presets/essay-review-isolated.json', import.meta.url), 'utf8'));
        const revision = { ...draft, revision: 1, createdAt: 0, digest: '' };
        expect(validateFlowRevision(revision, createBuiltinDagPluginRegistry()).filter(issue => issue.severity !== 'warning')).toEqual([]);
        const spec = await flowToDag(revision);
        expect(spec.nodes).toHaveLength(draft.nodes.length);
        const run = await executor.submit('s', { ...spec, maxConcurrency: 1 }, { requirements: 'REQ', essay: 'ESSAY', maxRounds, maxConcurrency: 1 });
        const exit = await run.root.wait({ timeoutMs: 6000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(requests).toHaveLength(maxRounds === 1 ? 4 : 12);
        const report = (await run.nodes.get('report')!.status()).task.output;
        expect(report).toMatchObject({ outputs: { result: { content: { completedRounds: maxRounds, stopReason: 'max_rounds',
            inputs: { essay: 'ESSAY' }, vars: { essay: maxRounds === 1 ? 'ESSAY' : 'REVISED_ESSAY' } } } } });
        if (maxRounds === 2) {
            expect(requests[5].request.messages.at(-1).content).toContain('Escape newlines');
            expect(requests[8].request.messages.at(-1).content).toContain('REVISED_ESSAY');
            expect((await run.nodes.get('aggregate')!.status()).task.program.kind).toBe('flow.value');
        }
    });

    it('rechecks passing dimensions after revision and gates the report until the new draft passes', async () => {
        automatic = true; scores = [9, 7, 9, 9, 9, 9, 9, 9];
        const draft = JSON.parse(readFileSync(new URL('../../app-core/src/presets/essay-review-isolated.json', import.meta.url), 'utf8'));
        const spec = await flowToDag({ ...draft, revision: 1, createdAt: 0, digest: '' }, async item => item.plugin === 'builtin.agent'
            ? { config: { ...item.config, invocationInstructions: item.config.systemPrompt, messages: [] } } : {});
        executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            sessionContext: { projectInstructions: 'OLD_PROJECT', skillInstructions: 'OLD_SKILL', skillIndex: 'OLD_INDEX' } });
        const run = await executor.submit('s', spec, { requirements: 'REQ', essay: 'ESSAY', maxRounds: 10, maxConcurrency: 2 });
        const exit = await run.root.wait({ timeoutMs: 6000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded'); expect(requests).toHaveLength(9);
        expect(JSON.stringify(requests)).not.toContain('OLD_');
        expect(requests[5].request.messages.at(-1).content).toContain('REVISED_ESSAY');
        expect((await run.nodes.get('report')!.status()).task.output).toMatchObject({ outputs: { result: { content: {
            completedRounds: 2, stopReason: 'condition_met', vars: { essay: 'REVISED_ESSAY' },
            results: { content: { current: true, round: 2, value: { score: 9 } } },
        } } } });
    });

    it('runs the shipped review graph as a function and returns its final report after revision', async () => {
        automatic = true; scores = [9, 7, 9, 9, 9, 9, 9, 9];
        const draft = JSON.parse(readFileSync(new URL('../../app-core/src/presets/essay-review-isolated.json', import.meta.url), 'utf8'));
        const child = { ...draft, revision: 1, digest: 'child', createdAt: 0, runPolicy: undefined,
            outputs: { report: { value: '${nodes.report.outputs.result}' } } };
        const parent = { id: 'parent', name: 'Parent', revision: 1, digest: 'parent', createdAt: 0, edges: [],
            nodes: [{ ...node('review', 'flow'), pluginVersion: '2.0.0', config: { flowId: child.id,
                parameters: { requirements: 'REQ', essay: 'ESSAY', maxRounds: 10, maxConcurrency: 2 } } },
                node('result', 'transform', { value: '${nodes.review.outputs.report}' })] };
        const spec = await flowToDag(parent as never, undefined, undefined, async () => child);
        const run = await executor.submit('s', spec);
        const exit = await run.root.wait({ timeoutMs: 6000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect((await run.nodes.get('result')!.status()).task.output).toMatchObject({ outputs: { result: { content: {
            completedRounds: 2, stopReason: 'condition_met', vars: { essay: 'REVISED_ESSAY' },
        } } } });
    });
});

it('rejects impossible quorums and result-key collisions before execution', () => {
    const program = new FlowJoinProgram();
    expect(() => program.init({ policy: { mode: 'quorum', quorum: 2 }, dependencies: [{ taskId: 'a', nodeId: 'a', input: 'a' }] })).toThrow('quorum');
    const spec = graph(); spec.nodes.find(node => node.id === 'join')!.config = { keys: { a: 'same', b: 'same' } };
    expect(() => compileControlGraph(spec)).toThrow('distinct result keys');
});

it.each(['first-success', 'quorum'])('persists failed evidence while waiting for %s successes', mode => {
    const program = new FlowJoinProgram();
    const input = { policy: { mode, quorum: 2, remaining: 'cancel' }, dependencies: ['a', 'b', 'c'].map(id => ({ taskId: id, nodeId: id, input: id })) } as const;
    let step = program.init(input as any);
    const result = (id: string, status: 'succeeded' | 'failed') => ({ type: 'task-exited' as const, taskId: id,
        exit: { taskId: id, status, completedAt: 1, output: id, error: status === 'failed' ? { message: 'failed a' } : undefined } });
    step = program.reduce(step.state, result('a', 'failed'));
    expect(step.next.type).toBe('wait');
    step = program.reduce(JSON.parse(JSON.stringify(step.state)), result('b', 'succeeded'));
    if (mode === 'quorum') {
        expect(step.next.type).toBe('wait');
        step = program.reduce(JSON.parse(JSON.stringify(step.state)), result('c', 'succeeded'));
    }
    expect(step.next).toMatchObject({ type: 'complete', output: { outputs: { result: { content: { failures: { a: 'failed a' }, results: { b: 'b' } } } } } });
});

it('fails an impossible success quorum and keeps discard independent of cancellation', () => {
    const program = new FlowJoinProgram();
    const dependencies = ['a', 'b'].map(id => ({ taskId: id, nodeId: id, input: id }));
    const step = program.init({ policy: { mode: 'quorum', quorum: 2 }, dependencies });
    expect(program.reduce(step.state, { type: 'task-exited', taskId: 'a', exit: { taskId: 'a', status: 'failed', completedAt: 1, error: { message: 'failure' } } }).next)
        .toMatchObject({ type: 'fail', error: { code: 'JOIN_UNSATISFIED' } });
    const discarded = program.init({ policy: { mode: 'any', result: 'discard' }, dependencies });
    expect(program.reduce(discarded.state, { type: 'task-exited', taskId: 'b', exit: { taskId: 'b', status: 'succeeded', completedAt: 1, output: 'unused' } }).next)
        .toMatchObject({ type: 'complete', output: { outputs: { result: { content: { results: {} } } } } });
});

it('identifies every parallel path in a cycle while retaining the DFS back-edge identity', () => {
    const spec = graph();
    spec.nodes.unshift(node('loop', 'loop', { maxRounds: 2 }));
    spec.edges.push({ id: 'entry', from: 'loop', to: 'group', input: 'input', output: 'result' },
        { id: 'feedback', from: 'join', to: 'loop', input: 'input', output: 'result' });
    const cycles = findCycles(spec.nodes, spec.edges);
    expect(cycles.backEdges).toEqual(new Set(['feedback']));
    expect(cycles.loopNodes).toEqual(new Set(['loop', 'group', 'a', 'b', 'c', 'join']));
});
