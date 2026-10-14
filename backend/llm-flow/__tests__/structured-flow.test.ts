import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DagRunSpec, DispatchConfig, SerializableExpression } from '../src/contracts';
import { Kernel, type EffectAdapter } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IVFSManager, type IFileSystem } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms } from '../src/flow';
import { readFlowRunMembers } from '../src/flow/run-members';
import { flowToDag } from '../src/flow/to-dag';
import { flowRevisionDigest, validateFlowRevision } from '../src/flow/validation';
import { withDispatchWorkspace } from '../src/flow/structured/limits';

const path = (...path: string[]): SerializableExpression => ({ kind: 'path', path });
const literal = (value: number | boolean): SerializableExpression => ({ kind: 'literal', value });
const keys = ['content', 'structure', 'language', 'logic'];
const passed = (key: string): SerializableExpression => ({ kind: 'and', args: [
    { kind: 'eq', args: [path('results', key, 'current'), literal(true)] },
    { kind: 'gte', args: [path('results', key, 'value', 'score'), literal(9)] },
] });

function config(maxRounds = 10): DispatchConfig {
    return { mode: 'exclusive', maxRounds, maxConcurrency: 2, context: { history: 'none' }, requireNoHistory: true,
        until: { kind: 'and', args: keys.map(passed) }, branches: keys.map(key => ({ key,
            when: { kind: 'not', args: [passed(key)] },
            input: { requirements: path('inputs', 'requirements'), essay: path('inputs', 'essay') },
            instruction: `Check ${key}`,
            target: { id: key, name: key, plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, capabilities: [],
                config: { connectionId: 'default', approval: 'none', systemPrompt: [`Rubric ${key}`],
                    messages: [{ role: 'user', content: 'OLD_TEMPLATE_HISTORY' }], memoryPolicy: { namespaceId: 'old' } } },
            output: path('output', 'message', 'content'), outputFormat: 'json',
            outputSchema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] },
            validate: { kind: 'and', args: [{ kind: 'gte', args: [path('value', 'score'), literal(0)] },
                { kind: 'lte', args: [path('value', 'score'), literal(10)] }] },
        })) };
}

function graph(settings = config()): DagRunSpec {
    return { nodes: [
        { id: 'collect', name: 'Collect', plugin: 'builtin.input', pluginVersion: '1.0.0', inputs: {}, config: {
            fields: { requirements: { type: 'string', nonBlank: true }, essay: { type: 'string', nonBlank: true } } } },
        { id: 'route', name: 'Review', plugin: 'builtin.route', pluginVersion: '2.0.0', inputs: {}, config: settings },
        { id: 'report', name: 'Report', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {} },
    ], edges: [
        { id: 'input', from: 'collect', to: 'route', output: 'result', input: 'input', kind: 'data' },
        { id: 'result', from: 'route', to: 'report', output: 'result', input: 'input', kind: 'data' },
    ] };
}

describe('structured route / spawn / aggregate DAG', () => {
    let manager: IVFSManager, fs: IFileSystem, kernel: Kernel, executor: DurableFlowExecutor;
    let requests: Record<string, any>[];
    let scores: number[];
    let delay = 0, active = 0, peak = 0, invalidResponses = 0, llmFailures = 0, invalidRevisionResponses = 0;

    function boot() {
        kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
        registerDurablePrograms(kernel);
        kernel.registerEffect({ kind: 'llm.chat', version: '1', shouldRetry: () => true, async execute(request: Record<string, any>) {
            requests.push(request);
            if (llmFailures-- > 0) throw new Error('temporary network failure');
            active++; peak = Math.max(peak, active);
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            active--;
            const revising = JSON.stringify(request).includes('你是作文修改员');
            if (revising && invalidRevisionResponses-- > 0) return { choices: [{ index: 0,
                message: { role: 'assistant', content: 'Here is the revised essay:\nnot JSON' }, finish_reason: 'stop' }] };
            return { choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(revising ? { essay: `REVISED_ESSAY_${requests.length}` } : { score: scores.shift() ?? 9, issues: [], suggestions: [], ...(invalidResponses-- > 0 ? { additionalProperties: false } : {}) }) }, finish_reason: 'stop' }], usage: { total_tokens: 2 } };
        } } as EffectAdapter);
        executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
            sessionContext: { projectInstructions: 'OLD_PROJECT', skillInstructions: 'OLD_SKILL', skillIndex: 'OLD_INDEX' } });
    }

    beforeEach(async () => {
        ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
        fs = await manager.openFileSystem('/test'); requests = []; scores = []; delay = 0; active = 0; peak = 0; invalidResponses = 0;
        boot(); await kernel.initialize();
        await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    });
    afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

    it('runs a reference-only DAG after input completion without explicit bindings or edges', async () => {
        const run = await executor.submit('s', { nodes: [
            { id: 'collect', name: 'Input', plugin: 'builtin.input', pluginVersion: '1.0.0', inputs: {}, config: { param: { essay: { type: 'string', widget: 'textarea' } } } },
            { id: 'echo', name: 'Echo', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: '${param.essay}' } },
            { id: 'copy', name: 'Copy', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: '${nodes.echo.outputs.result}' } },
        ], edges: [] });
        await vi.waitFor(() => expect(run.nodes.has('collect')).toBe(true));
        const input = run.nodes.get('collect')!;
        await vi.waitFor(async () => expect((await input.status()).task.interactions['input-1']).toBeDefined());
        expect(run.nodes.has('echo')).toBe(false);
        await input.respond({ interactionId: 'input-1', value: { essay: '${param.secret}' } });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        expect((await run.nodes.get('copy')!.status()).task.output).toMatchObject({ outputs: { result: { content: '${param.secret}' } } });
    });

    it('renders shared prompts from revised input snapshots and keeps per-node system instructions', async () => {
        const settings = config(2); settings.branches = settings.branches.slice(0, 1);
        settings.until = { kind: 'literal', value: false }; delete settings.branches[0].when;
        settings.branches[0].input = {};
        settings.invocationDefaults = { prompt: 'Essay: ${params.essay}; round: ${iteration.round}', context: { history: 'none' } };
        settings.revision = { fields: { essay: { type: 'string' } }, prompt: 'Revise' };
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'FIRST' });
        await vi.waitFor(() => expect(run.nodes.has('route')).toBe(true));
        const route = run.nodes.get('route')!;
        await vi.waitFor(async () => expect((await route.status()).task.interactions['revision-1']).toBeDefined());
        await route.respond({ interactionId: 'revision-1', value: { essay: '${param.secret}' } });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        expect(requests).toHaveLength(2);
        expect(requests[0].request.messages.at(-1).content).toContain('Essay: FIRST; round: 1');
        expect(requests[1].request.messages.at(-1).content).toContain('Essay: ${param.secret}; round: 2');
        expect(requests[1].request.messages[0]).toEqual({ role: 'system', content: 'Rubric content' });
        expect(JSON.stringify(requests)).not.toContain('OLD_');
    });

    it.each([{ retries: 3, failures: 3, calls: 4, status: 'succeeded' },
        { retries: 3, failures: 4, calls: 4, status: 'failed' },
        { retries: 0, failures: 1, calls: 1, status: 'failed' }])(
        'honors LLM retry budget $retries after $failures failed calls', async ({ retries, failures, calls, status }) => {
            llmFailures = failures;
            const settings = config(1);
            settings.branches = settings.branches.slice(0, 1);
            settings.until = passed('content');
            settings.branches[0].target.config = { ...settings.branches[0].target.config as object,
                llmRetry: { retries, backoffMs: 5 } };
            const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
            expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe(status);
            expect(requests).toHaveLength(calls);
            expect(requests.every(request => request.request._maxAttempts === 1)).toBe(true);
            const events = (await kernel.eventList('s', 0)).filter(event => event.type === 'effect.retry.scheduled');
            expect(events).toHaveLength(calls - 1);
            llmFailures = 0;
        });

    it('cancels an LLM retry during durable backoff', async () => {
        llmFailures = 4;
        const settings = config(1);
        settings.branches = settings.branches.slice(0, 1);
        settings.until = passed('content');
        settings.branches[0].target.config = { ...settings.branches[0].target.config as object,
            llmRetry: { retries: 3, backoffMs: 5000 } };
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        await vi.waitFor(async () => expect((await kernel.eventList('s', 0))
            .some(event => event.type === 'effect.retry.scheduled')).toBe(true));
        await run.root.cancel('stop');
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('cancelled');
        expect(requests).toHaveLength(1);
        llmFailures = 0;
    });

    it('records an initial passing judgment without pretending to execute reviews', async () => {
        const settings = config(2);
        settings.branches = settings.branches.slice(0, 1);
        settings.until = passed('content');
        settings.initialResults = { content: { score: 9 } };
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        expect(requests).toHaveLength(0);
        const events = (await kernel.eventList('s', 0)).filter(event => event.type === 'flow.logic.completed');
        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({ phase: 'judge', round: 0,
            result: { matched: true, stopReason: 'condition_met' } });
    });

    it('journals aggregate and judge decisions for each round, including continuation and limits', async () => {
        scores = [4, 5];
        const settings = config(2);
        settings.branches = settings.branches.slice(0, 1);
        settings.until = passed('content');
        settings.logicNodes = { aggregate: { id: 'summary', name: 'Summary' }, judge: { id: 'exit', name: 'Exit' } };
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        const events = (await kernel.eventList('s', 0)).filter(event => event.type === 'flow.logic.completed');
        expect(events.map(event => (event.payload as any).phase)).toEqual(['aggregate', 'judge', 'aggregate', 'judge']);
        expect(events[1].payload).toMatchObject({ nodeId: 'exit', round: 1,
            result: { matched: false, maxRounds: 2, stopReason: 'continue', condition: settings.until } });
        expect(events[2].payload).toMatchObject({ nodeId: 'summary', round: 2,
            result: { results: { content: { value: { score: 5 } } } } });
        expect(events[3].payload).toMatchObject({ round: 2, result: { stopReason: 'max_rounds' } });
    });

    it.each([1, undefined])('enforces a shared output schema with repair retries=%s within the same spawned Task', async retries => {
        scores = retries === undefined ? [11, 11, 11, 9] : [11, 9];
        const settings = config(1); settings.branches = settings.branches.slice(0, 1);
        settings.until = passed('content');
        const branch = settings.branches[0];
        delete branch.output; delete branch.outputFormat; delete branch.outputSchema; delete branch.validate;
        settings.invocationDefaults = { prompt: 'Essay ${param.essay}', outputContract: {
            format: 'json', onInvalid: 'repair', ...(retries === undefined ? {} : { retries }),
            schema: { type: 'object', properties: { score: { type: 'number', minimum: 0, maximum: 10 } }, required: ['score'] },
        } };
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        expect(requests).toHaveLength(retries === undefined ? 4 : 2);
        const result = (await run.nodes.get('report')!.status()).task.output as any;
        expect(result.outputs.result.content).toMatchObject({ completedRounds: 1, stopReason: 'condition_met' });
        const tasks = await (await kernel.openSession('s')).listTasks();
        expect(tasks.filter(task => task.parentTaskId === run.nodes.get('route')!.id)).toHaveLength(1);
    });

    it('allows explicit partial batches while failed types cannot reuse an earlier passing score', async () => {
        scores = [11];
        const settings = config(1); settings.branches = settings.branches.slice(0, 1);
        delete settings.branches[0].when;
        settings.until = { kind: 'literal', value: false };
        settings.initialResults = { content: { score: 10 } };
        settings.join = { failure: 'partial', reducer: 'latest@1' };
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        const result = (await run.nodes.get('report')!.status()).task.output as any;
        expect(result.outputs.result.content.results.content.current).toBe(false);
        expect(result.outputs.result.content.failures.content).toBeDefined();
    });

    it('runs composite output references with isolated parameter scopes and no repeated interpolation', async () => {
        const child = { id: 'child', name: 'Child', revision: 1, createdAt: 0, digest: '', nodes: [
            { id: 'echo', name: 'Echo', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: '${param.essay}' } },
        ], edges: [] };
        const parent = { id: 'parent', name: 'Parent', revision: 1, createdAt: 0, digest: '', nodes: [
            { id: 'nested', name: 'Nested', plugin: 'builtin.flow', pluginVersion: '1.0.0', inputs: {}, config: { flowId: 'child', parameters: { essay: '${params.essay}' } } },
            { id: 'copy', name: 'Copy', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: '${nodes.nested.outputs.result}' } },
        ], edges: [] };
        const spec = await flowToDag(parent as any, undefined, undefined, async () => child as any);
        const run = await executor.submit('s', spec, { essay: '${param.secret}', secret: 'PRIVATE' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        expect((await run.nodes.get('copy')!.status()).task.output).toMatchObject({ outputs: { result: { content: '${param.secret}' } } });
    });

    it('inherits the Run workspace in spawned templates and preserves explicit target directories', () => {
        const node = graph().nodes[1];
        const bound = withDispatchWorkspace(node, '/isolated');
        expect((bound.config as DispatchConfig).branches[0].target.config).toMatchObject({ workingDirectory: '/isolated' });
        expect((node.config as DispatchConfig).branches[0].target.config).not.toHaveProperty('workingDirectory');
        const target = (bound.config as DispatchConfig).branches[0].target;
        expect(withDispatchWorkspace(target, '/different').config).toMatchObject({ workingDirectory: '/isolated' });
    });

    it('merges independently connected aggregate inputs and preserves unselected keys', async () => {
        const run = await executor.submit('s', { nodes: [
            { id: 'old', name: 'Old', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: { value: { content: 8, logic: 9 } } },
            { id: 'new', name: 'New', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: { value: { content: 7 } } },
            { id: 'merge', name: 'Merge', plugin: 'builtin.aggregate', pluginVersion: '1.0.0', inputs: {}, config: {} },
        ], edges: [
            { id: 'previous', from: 'old', to: 'merge', output: 'result', input: 'previous', kind: 'data' },
            { id: 'updates', from: 'new', to: 'merge', output: 'result', input: 'updates', kind: 'data' },
        ] });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        const result = (await run.nodes.get('merge')!.status()).task.output as any;
        expect(result.outputs.result.content).toEqual({ content: 7, logic: 9 });
    });

    it('repairs forbidden schema keywords inside a child before the route joins its output', async () => {
        invalidResponses = 1;
        const settings = config();
        settings.branches = [settings.branches[0]];
        settings.until = passed('content');
        settings.branches[0].outputSchema = { type: 'object', properties: {
            score: { type: 'number' }, issues: { type: 'array' }, suggestions: { type: 'array' },
        }, required: ['score'], additionalProperties: false };
        settings.invocationDefaults = { outputContract: { format: 'json', onInvalid: 'repair', retries: 1 } };
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        const exit = await run.root.wait({ timeoutMs: 6000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(requests).toHaveLength(2);
        expect(requests[1].request.messages.at(-1).content).toContain('$.additionalProperties: unexpected property');
    });

    it('spawns isolated Tasks and preserves other result types across batches, then feeds a downstream DAG node', async () => {
        const run = await executor.submit('s', graph(), { requirements: 'REQ', essay: 'ESSAY' });
        const exit = await run.root.wait({ timeoutMs: 6000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(requests).toHaveLength(4);
        for (const request of requests) {
            expect(JSON.stringify(request)).not.toContain('OLD_');
            expect(request.request.messages.at(-1).content.split('\n')[0]).toBe(JSON.stringify({ requirements: 'REQ', essay: 'ESSAY' }));
            expect(request.request.messages.at(-1).content).toContain('not the schema itself');
        }
        const result = (await run.nodes.get('report')!.status()).task.output as any;
        expect(result.outputs.result.content).toMatchObject({ stopReason: 'condition_met', completedRounds: 4 });
        expect(Object.keys(result.outputs.result.content.results)).toEqual(keys);
        const session = await kernel.openSession('s');
        const children = (await session.listTasks()).filter(task => task.parentTaskId === run.nodes.get('route')!.id);
        expect(children).toHaveLength(4);
        expect(new Set(children.map(task => task.id)).size).toBe(4);
        expect(await readFlowRunMembers(session, (await run.root.status()).task)).toHaveLength(7);
    });

    it('collects only missing fields, preserves partial replies, and resumes the same interaction', async () => {
        const run = await executor.submit('s', graph(), { requirements: 'REQ' });
        await vi.waitFor(() => expect(run.nodes.has('collect')).toBe(true));
        const input = run.nodes.get('collect')!;
        await vi.waitFor(async () => expect((await input.status()).task.interactions['input-1']).toBeDefined());
        expect((await input.status()).task.interactions['input-1'].prompt).not.toContain('requirements');
        await input.respond({ interactionId: 'input-1', value: { requirements: 'OVERRIDE', essay: '   ' } });
        await vi.waitFor(async () => expect((await input.status()).task.interactions['input-2']).toBeDefined());
        kernel.dispose(); await executor.waitIdle(); boot(); await kernel.initialize();
        const resumed = await executor.resume('s', run.root.id);
        await (await (await kernel.openSession('s')).attachTask(input.id)).respond({ interactionId: 'input-2', value: { essay: 'ESSAY' } });
        expect((await resumed.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        expect(requests).toHaveLength(4);
        expect(JSON.stringify(requests)).toContain('REQ');
        expect(JSON.stringify(requests)).not.toContain('OVERRIDE');
    });

    it('stops exactly at a configurable batch limit and replaces a previous higher score', async () => {
        scores = [8, 7, 6];
        const settings = config(3); settings.branches = settings.branches.slice(0, 1);
        settings.until = passed('content');
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        expect(requests).toHaveLength(3);
        const state = (await run.nodes.get('route')!.status()).task.state as any;
        expect(state.results.content.value.score).toBe(6);
        expect(state.round).toBe(3);
    });

    it('joins multicast child results and rejects invalid scores without partially committing a batch', async () => {
        scores = [9, 12, 9, 9];
        const settings = config(); settings.mode = 'multicast';
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('failed');
        const state = (await run.nodes.get('route')!.status()).task.state as any;
        expect(state.results).toEqual({});
        expect(Object.keys(state.failures)).toHaveLength(1);
    });

    it.each([1, 10])('never starts batch %i + 1 when scores remain below threshold', async limit => {
        scores = Array(limit).fill(8);
        const settings = config(limit); settings.branches = settings.branches.slice(0, 1); settings.until = passed('content');
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        const output = (await run.nodes.get('route')!.status()).task.output as any;
        expect(output.outputs.result.content).toMatchObject({ completedRounds: limit, stopReason: 'max_rounds' });
        expect(requests).toHaveLength(limit);
    });

    it('preserves completed results and spawned child identity through a controller restart', async () => {
        const settings = config(3); settings.branches = settings.branches.slice(0, 1); settings.until = passed('content');
        settings.branches[0].target = { id: 'human', name: 'Human', plugin: 'builtin.human', pluginVersion: '1.0.0',
            inputs: {}, config: { requestId: 'score', prompt: 'Score' } };
        settings.branches[0].output = path('output', 'outputs', 'response', 'content');
        settings.branches[0].outputFormat = 'value';
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        const session = await kernel.openSession('s');
        const childAt = async (round: string) => (await session.listTasks()).find(task => task.labels?.dispatchRound === round);
        await vi.waitFor(async () => expect((await childAt('1'))?.interactions.score).toBeDefined());
        await (await session.attachTask((await childAt('1'))!.id)).respond({ interactionId: 'score', value: { score: 8 } });
        await vi.waitFor(async () => expect((await childAt('2'))?.interactions.score).toBeDefined());
        const secondId = (await childAt('2'))!.id;
        kernel.dispose(); await executor.waitIdle(); boot(); await kernel.initialize();
        const resumed = await executor.resume('s', run.root.id);
        const restoredSession = await kernel.openSession('s');
        await (await restoredSession.attachTask(secondId)).respond({ interactionId: 'score', value: { score: 9 } });
        expect((await resumed.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        const children = (await restoredSession.listTasks()).filter(task => task.labels?.dispatchRound);
        expect(children).toHaveLength(2);
        const output = (await resumed.nodes.get('route')!.status()).task.output as any;
        expect(output.outputs.result.content.results.content).toMatchObject({ taskId: secondId, round: 2, value: { score: 9 } });
    });

    it('persists generic check assignments through a scope restart', async () => {
        const settings = config(2); settings.branches = settings.branches.slice(0, 1);
        settings.until = { kind: 'literal', value: false }; delete settings.branches[0].when;
        settings.branches[0].assign = { score: '${output.score}' };
        settings.branches[0].target = { id: 'human', name: 'Human', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {}, config: { requestId: 'score', prompt: 'Score' } };
        settings.branches[0].output = path('output', 'outputs', 'response', 'content');
        settings.branches[0].outputFormat = 'value';
        const spec = graph(settings); spec.variables = { score: { type: 'number', initial: 0 } };
        const run = await executor.submit('s', spec, { requirements: 'REQ', essay: 'ESSAY' });
        const session = await kernel.openSession('s');
        const childAt = async (round: string) => (await session.listTasks()).find(task => task.labels?.dispatchRound === round);
        await vi.waitFor(async () => expect((await childAt('1'))?.interactions.score).toBeDefined());
        await (await session.attachTask((await childAt('1'))!.id)).respond({ interactionId: 'score', value: { score: 8 } });
        await vi.waitFor(async () => expect((await childAt('2'))?.interactions.score).toBeDefined());
        const secondId = (await childAt('2'))!.id;
        kernel.dispose(); await executor.waitIdle(); boot(); await kernel.initialize();
        const resumed = await executor.resume('s', run.root.id);
        await (await (await kernel.openSession('s')).attachTask(secondId)).respond({ interactionId: 'score', value: { score: 9 } });
        expect((await resumed.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        const output = (await resumed.nodes.get('route')!.status()).task.output as any;
        expect(output.outputs.result.content.vars).toEqual({ score: 9 });
        expect(output.outputs.result.content.variableChanges).toHaveLength(2);
        expect(output.outputs.result.content.results.content.current).toBe(true);
    });

    it('marks earlier type results stale when a revision changes the input and rechecks them', async () => {
        const settings = config(2); settings.branches = settings.branches.slice(0, 1);
        settings.until = { kind: 'literal', value: false };
        settings.branches[0].when = { kind: 'literal', value: true };
        settings.initialResults = { logic: { score: 9 } };
        settings.revision = { fields: { essay: { type: 'string', nonBlank: true } }, prompt: 'Revise' };
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'OLD_ESSAY' });
        await vi.waitFor(async () => expect((await run.nodes.get('route')?.status())?.task.interactions['revision-1']).toBeDefined());
        await run.nodes.get('route')!.respond({ interactionId: 'revision-1', value: { essay: 'NEW_ESSAY' } });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        const output = (await run.nodes.get('route')!.status()).task.output as any;
        expect(output.outputs.result.content.results.logic).toMatchObject({ current: false, value: { score: 9 } });
        expect(output.outputs.result.content.results.content.current).toBe(true);
        expect(JSON.stringify(requests.at(-1))).toContain('NEW_ESSAY');
        expect(JSON.stringify(requests.at(-1))).not.toContain('OLD_ESSAY');
    });

    it('rejects a branch history override that relaxes the route constraint', async () => {
        const settings = config(); settings.branches[0].context = { history: 'explicit', messages: [{ role: 'user', content: 'OLD' }] };
        await expect(executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' })).rejects.toThrow('history:none');
        expect(requests).toHaveLength(0);
    });

    it('validates and executes the legacy reusable Flow definition with customized rounds and threshold', async () => {
        const draft = JSON.parse(readFileSync(new URL('./fixtures/essay-review-legacy.flow', import.meta.url), 'utf8'));
        scores = Array(8).fill(7);
        const revision = { ...draft, revision: 1, createdAt: 0, digest: '' };
        revision.digest = flowRevisionDigest(revision);
        expect(validateFlowRevision(revision, createBuiltinDagPluginRegistry())).toEqual([]);
        const run = await executor.submit('s', await flowToDag(revision), { requirements: 'REQ', essay: 'ESSAY', passScore: 8, maxRounds: 2, maxConcurrency: 1 });
        const exit = await run.root.wait({ timeoutMs: 6000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(Object.keys((exit.output as any).nodes)).toEqual(['report']);
        expect(requests).toHaveLength(9);
        expect(JSON.stringify(requests[4])).toContain('本轮评审意见');
        expect(JSON.stringify(requests[5])).toContain('REVISED_ESSAY_5');
        expect(requests[5].request.messages.every((message: any) => ['system', 'user'].includes(message.role))).toBe(true);
        const report = (await run.nodes.get('report')!.status()).task.output as any;
        expect(report.outputs.result.content).toMatchObject({ completedRounds: 2, stopReason: 'max_rounds' });
    });

    it('repairs three non-JSON revision responses and reroutes using the repaired essay', async () => {
        const draft = JSON.parse(readFileSync(new URL('./fixtures/essay-review-legacy.flow', import.meta.url), 'utf8'));
        scores = [7, 7, 7, 7, 9, 9, 9, 9];
        invalidRevisionResponses = 3;
        const spec = await flowToDag({ ...draft, revision: 1, createdAt: 0, digest: '' });
        const run = await executor.submit('s', spec, { requirements: 'REQ', essay: 'ESSAY', maxRounds: 2, maxConcurrency: 1 });
        const exit = await run.root.wait({ timeoutMs: 6000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(requests).toHaveLength(12);
        expect(requests[5].request.messages.at(-1).content).toContain('Escape newlines');
        expect(requests[5].request.messages.at(-1).content).toContain('"essay"');
        expect(requests[8].request.messages.at(-1).content).toContain('REVISED_ESSAY_8');
        const report = (await run.nodes.get('report')!.status()).task.output as any;
        expect(report.outputs.result.content).toMatchObject({ completedRounds: 2, stopReason: 'condition_met', vars: { essay: 'REVISED_ESSAY_8' } });
        invalidRevisionResponses = 0;
    });

    it('invalidates even passing scores after rewriting and stops on the new passing draft', async () => {
        const draft = JSON.parse(readFileSync(new URL('./fixtures/essay-review-legacy.flow', import.meta.url), 'utf8'));
        scores = [9, 7, 9, 9, 9, 9, 9, 9];
        const revision = { ...draft, revision: 1, createdAt: 0, digest: '' };
        revision.digest = flowRevisionDigest(revision);
        const spec = await flowToDag(revision);
        spec.nodes.push({ id: 'observe', name: 'observe', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: { original: '${param.essay}', current: '${vars.essay}' } } });
        spec.edges.push({ id: 'observe', from: 'report', to: 'observe', kind: 'control', input: 'input', output: 'result' });
        const run = await executor.submit('s', spec, { requirements: 'REQ', essay: 'ESSAY', maxRounds: 10, maxConcurrency: 1 });
        const exit = await run.root.wait({ timeoutMs: 6000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(requests).toHaveLength(9);
        const report = (await run.nodes.get('report')!.status()).task.output as any;
        expect(report.outputs.result.content).toMatchObject({ completedRounds: 2, stopReason: 'condition_met', inputs: { essay: 'ESSAY' }, vars: { essay: 'REVISED_ESSAY_5' } });
        expect(report.outputs.result.content.revisions).toHaveLength(1);
        expect((await run.nodes.get('observe')!.status()).task.output).toMatchObject({ outputs: { result: { content: { original: 'ESSAY', current: 'REVISED_ESSAY_5' } } } });
        expect(Object.values(report.outputs.result.content.results).every((slot: any) => slot.current && slot.round === 2)).toBe(true);
    });

    it('repairs an invalid first response in the legacy essay Flow without consuming another review round', async () => {
        const draft = JSON.parse(readFileSync(new URL('./fixtures/essay-review-legacy.flow', import.meta.url), 'utf8'));
        scores = [11, 9, 9, 9, 9];
        const spec = await flowToDag({ ...draft, revision: 1, createdAt: 0, digest: '' });
        const run = await executor.submit('s', spec, { requirements: 'REQ', essay: 'ESSAY', maxRounds: 1, maxConcurrency: 1 });
        const exit = await run.root.wait({ timeoutMs: 6000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(requests).toHaveLength(5);
        expect(JSON.stringify(requests[1])).toContain('did not satisfy the required output contract');
        const report = (await run.nodes.get('report')!.status()).task.output as any;
        expect(report.outputs.result.content.completedRounds).toBe(1);
    });

    it('applies declared defaults and rejects invalid runtime limits before creating Tasks', async () => {
        const draft = JSON.parse(readFileSync(new URL('./fixtures/essay-review-legacy.flow', import.meta.url), 'utf8'));
        const spec = await flowToDag({ ...draft, revision: 1, createdAt: 0, digest: '' });
        await expect(executor.submit('s', spec, { maxRounds: 1.5 })).rejects.toThrow('numeric constraints');
        expect(await (await kernel.openSession('s')).listTasks()).toEqual([]);
        const run = await executor.submit('s', spec, { requirements: 'REQ', essay: 'ESSAY' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        const state = (await run.nodes.get('review')!.status()).task.state as any;
        expect(state.maxRounds).toBe(10);
        expect(state.maxConcurrency).toBe(4);
        expect(state.values.passScore).toBe(9);
    });

    it('waits for both missing inputs and never starts a child after the controller is cancelled', async () => {
        const run = await executor.submit('s', graph());
        await vi.waitFor(async () => expect((await run.nodes.get('collect')?.status())?.task.interactions['input-1']).toBeDefined());
        const input = run.nodes.get('collect')!;
        expect((await input.status()).task.interactions['input-1'].prompt).toContain('requirements');
        expect((await input.status()).task.interactions['input-1'].prompt).toContain('essay');
        await input.respond({ interactionId: 'input-1', value: { requirements: 'REQ' } });
        await vi.waitFor(async () => expect((await input.status()).task.interactions['input-2']).toBeDefined());
        expect(requests).toHaveLength(0);
        await run.root.cancel();
        await executor.waitIdle();
        expect(requests).toHaveLength(0);
    });

    it('reserves child capacity against the Run node bound before creating tasks', async () => {
        await expect(executor.submit('s', { ...graph(), maxNodes: 5 })).rejects.toThrow('reservation');
        expect(await (await kernel.openSession('s')).listTasks()).toHaveLength(0);
    });

    it.each([1, 2])('bounds active child model calls by Run maxConcurrency=%i', async maxConcurrency => {
        delay = 20;
        const settings = config(); settings.mode = 'multicast'; settings.maxConcurrency = 4;
        const run = await executor.submit('s', { ...graph(settings), maxConcurrency }, { requirements: 'REQ', essay: 'ESSAY' });
        expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('succeeded');
        expect(peak).toBe(maxConcurrency);
        const children = (await kernel.listSessionTasks('s')).filter(task => task.labels?.dispatchKey);
        if (maxConcurrency === 1) expect(children.every(task => !task.labels?.flowHistoryGroup)).toBe(true);
        else expect(children.filter(task => task.labels?.flowHistoryGroup).length).toBeGreaterThanOrEqual(2);
    });

    it('cancels the owned spawned Task when its Run is cancelled', async () => {
        const settings = config(); settings.branches = settings.branches.slice(0, 1);
        settings.branches[0].target = { id: 'human', name: 'Human', plugin: 'builtin.human', pluginVersion: '1.0.0',
            config: { prompt: 'WAIT', requestId: 'wait' }, inputs: {} };
        const run = await executor.submit('s', graph(settings), { requirements: 'REQ', essay: 'ESSAY' });
        const session = await kernel.openSession('s');
        await vi.waitFor(async () => expect((await session.listTasks()).some(task => task.labels?.dispatchKey && task.interactions.wait)).toBe(true));
        await run.root.cancel(); await executor.waitIdle();
        const children = (await session.listTasks()).filter(task => task.labels?.dispatchKey);
        expect(children).toHaveLength(1);
        expect(children[0].status).toBe('cancelled');
    });
});
