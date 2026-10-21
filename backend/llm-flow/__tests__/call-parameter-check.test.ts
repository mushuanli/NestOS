import { expect, it } from 'vitest';
import type { FlowDraft, FlowParameter, FlowRevision, JsonValue } from '../src/contracts';
import { checkFlowSource, checkFlowSyntax } from '../src/flow/syntax-check';

function child(parameters: FlowParameter[] = [{ name: 'word', type: 'string', required: true }]): FlowRevision {
    return checkFlowSyntax({ id: 'child', name: 'Child', draftVersion: 1, parameters,
        nodes: [{ id: 'work', name: 'Work', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 1 } }],
        edges: [], outputs: { result: { value: '${nodes.work.outputs.result}' } } }).flow!;
}

function parent(parameters: Record<string, JsonValue> = {}): FlowDraft {
    return { id: 'parent' as FlowDraft['id'], name: 'Parent', draftVersion: 1, updatedAt: 0, layout: {}, edges: [],
        nodes: [{ id: 'call' as FlowDraft['nodes'][number]['id'], name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0',
            inputs: {}, config: { flowId: 'child', parameters } }] };
}

const check = (flow: FlowDraft, dependency = child()) => checkFlowSource(JSON.stringify(flow, null, 2), {
    resolveComposite: async () => dependency,
});

it('reports unknown and missing arguments together with the caller source location', async () => {
    const result = await check(parent({ wrod: 'hello' }));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unknown-call-parameter', message: expect.stringContaining('wrod') }),
        expect.objectContaining({ code: 'missing-call-parameter', message: expect.stringContaining('word') }),
    ]));
    for (const issue of result.diagnostics) expect(issue).toMatchObject({
        nodeId: 'call', path: '$.nodes[0].config.parameters', line: expect.any(Number), column: expect.any(Number),
    });
});

it('never inherits a missing child argument from a same-named parent parameter', async () => {
    const flow = parent(); flow.parameters = [{ name: 'word', type: 'string', default: 'parent only' }];
    expect(await check(flow)).toMatchObject({ valid: false, diagnostics: [expect.objectContaining({ code: 'missing-call-parameter' })] });
});

it('locates missing parameters at the call configuration when no binding object was authored', async () => {
    const flow = parent(); flow.nodes[0].config = { flowId: 'child' };
    expect(await check(flow)).toMatchObject({ valid: false, diagnostics: [expect.objectContaining({
        code: 'missing-call-parameter', path: '$.nodes[0].config', line: expect.any(Number), column: expect.any(Number),
    })] });
});

it.each([
    [{ name: 'word', type: 'string' }, 42],
    [{ name: 'word', type: 'boolean' }, 'false'],
    [{ name: 'word', type: 'number' }, '42'],
    [{ name: 'word', type: 'number', minimum: 1, maximum: 3 }, 4],
    [{ name: 'word', type: 'number', minimum: 1 }, 0],
    [{ name: 'word', type: 'number', integer: true }, 1.5],
    [{ name: 'word', type: 'string', nonBlank: true }, '  '],
    [{ name: 'word', type: 'string', options: ['allowed'] }, 'typo'],
    [{ name: 'word', type: 'json', widget: 'images', imageConstraints: { maxItems: 1 } }, []],
] as Array<[FlowParameter, JsonValue]>)('rejects literal arguments violating %j', async (field, value) => {
    expect(await check(parent({ word: value }), child([field]))).toMatchObject({
        valid: false, diagnostics: [expect.objectContaining({ code: 'invalid-call-parameter' })],
    });
});

it('accepts child defaults, optional arguments, nullable JSON and equivalent object options', async () => {
    const dependency = child([{ name: 'word', type: 'string', required: true, default: '${literal.data}' },
        { name: 'optional', type: 'boolean' }, { name: 'data', type: 'json', required: true }]);
    expect(await check(parent({ data: null }), dependency)).toMatchObject({ valid: true, diagnostics: [] });
    expect(await check(parent({ word: { b: 2, a: 1 } }), child([
        { name: 'word', type: 'json', options: [{ a: 1, b: 2 }] },
    ]))).toMatchObject({ valid: true });
});

it('accepts whole dynamic references and interpolated strings without comparing unresolved options', async () => {
    const flow = parent({ word: ' ${param.value} ' });
    flow.parameters = [{ name: 'value', type: 'string' }];
    expect(await check(flow, child([{ name: 'word', type: 'number', required: true }]))).toMatchObject({ valid: true });
    flow.nodes[0].config = { flowId: 'child', parameters: { word: 'prefix-${param.value}' } };
    expect(await check(flow, child([{ name: 'word', type: 'string', options: ['prefix-a'] }]))).toMatchObject({ valid: true });
    expect(await check(flow, child([{ name: 'word', type: 'number' }]))).toMatchObject({ valid: false });
});

it('still rejects unknown argument names when their values are dynamic', async () => {
    const flow = parent({ typo: '${param.value}' }); flow.parameters = [{ name: 'value', type: 'string' }];
    expect((await check(flow)).diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown-call-parameter' }));
});

it('checks the known outer type of containers containing dynamic references', async () => {
    const flow = parent({ word: { nested: '${param.value}' } }); flow.parameters = [{ name: 'value', type: 'string' }];
    expect(await check(flow)).toMatchObject({ valid: false });
    expect(await check(flow, child([{ name: 'word', type: 'json' }]))).toMatchObject({ valid: true });
});

it('allows explicit input collectors to supply interactive child parameters', async () => {
    const dependency = child(); dependency.parameters![0].onMissing = 'interact';
    dependency.nodes.push({ id: 'collect' as never, name: 'Collect', plugin: 'builtin.input', pluginVersion: '1.0.0',
        inputs: {}, config: { fields: { word: { type: 'string', required: true } } } });
    expect(await check(parent(), dependency)).toMatchObject({ valid: true });
});

it('checks nested calls and identifies the root caller and nested call path', async () => {
    const middle = checkFlowSyntax({ ...parent({ wrod: 'typo' }), id: 'middle', outputs: { result: { value: '${nodes.call.outputs.result}' } } }).flow!;
    const flow = parent(); flow.nodes[0].config = { flowId: 'middle', parameters: {} };
    const result = await checkFlowSource(flow, { resolveComposite: async id => id === 'middle' ? middle : child() });
    expect(result).toMatchObject({ valid: false, diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'unknown-call-parameter', nodeId: 'call', path: '$.nodes[0].config.flowId', message: expect.stringContaining('call/call') }),
    ]) });
});

it('preserves legacy composition argument behavior and syntax-only checks without a resolver', async () => {
    const flow = parent({ extra: 'legacy' }); flow.nodes[0].pluginVersion = '1.0.0';
    expect(await check(flow)).toMatchObject({ valid: true });
    expect(await checkFlowSource(parent({ typo: 1 }))).toMatchObject({ valid: true });
});
