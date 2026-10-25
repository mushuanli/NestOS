import {expect, it, vi} from 'vitest';
import {assertRootCallable, callableExposure, isRootCallable, type FlowDraft, type FlowRevision} from '../src/contracts';
import {createFlowRevision} from '../src/flow-definition-store';
import {flowRevisionToDraft} from '../src/flow/definition-projection';
import {prepareFlowRun} from '../src/flow/prepare-run';
import {checkFlowSource, checkFlowSyntax} from '../src/flow/syntax-check';
import {flowRevisionDigest, validateFlowRevision} from '../src/flow/validation';

const draft = (id: string, exposure?: FlowDraft['exposure']): FlowDraft => ({id: id as never, name: id,
    ...(exposure === undefined ? {} : {exposure}), nodes: [], edges: [], layout: {}, draftVersion: 1, updatedAt: 0});

it('preserves legacy digest identities while signing explicit exposure and recursive draft projections', () => {
    const legacy = createFlowRevision(draft('legacy'), 1, 0);
    expect(legacy).not.toHaveProperty('exposure');
    expect(flowRevisionDigest({...legacy, exposure: undefined})).toBe(legacy.digest);
    const published = createFlowRevision({...draft('root', 'global'), functions: [draft('private', 'local')]}, 1, 0);
    expect(flowRevisionToDraft(published)).toMatchObject({exposure: 'global', functions: [{exposure: 'local'}]});
    expect(createFlowRevision(draft('legacy', 'global'), 1, 0).digest).not.toBe(legacy.digest);
    expect(callableExposure(undefined)).toBe('global');
});

it('rejects root local calls before parameter resolution or connection work', async () => {
    const privateFlow = createFlowRevision({...draft('private', 'local'), parameters: [{name: 'required', type: 'string', required: true}]}, 1);
    const prepareConnections = vi.fn(async (flow: FlowRevision) => flow);
    await expect(prepareFlowRun(privateFlow, {prepareConnections})).rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
    expect(prepareConnections).not.toHaveBeenCalled();
});

it.each([null, '', 'GLOBAL', 'private', false, 1])('fails closed for malformed exposure %j at syntax, publication and root admission', value => {
    const malformed = {...createFlowRevision(draft('invalid'), 1, 0), exposure: value} as FlowRevision;
    expect(isRootCallable(malformed)).toBe(false);
    expect(() => assertRootCallable(malformed)).toThrow('Exposure must be global or local');
    expect(validateFlowRevision(malformed)).toContainEqual(expect.objectContaining({code: 'invalid-exposure'}));
    expect(checkFlowSyntax(malformed).valid).toBe(false);
});

it('allows local source validation and a global root to compile a local dependency without a caller override', async () => {
    const child = createFlowRevision({...draft('child', 'local'), nodes: [{id: 'value' as never, name: 'Value',
        plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 'ok'}}],
        outputs: {result: {value: '${nodes.value.outputs.result}'}}}, 1, 0);
    expect((await checkFlowSource(child)).valid).toBe(true);
    const parent = createFlowRevision({...draft('parent'), nodes: [{id: 'call' as never, name: 'Call',
        plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: {flowId: 'child', revision: 1, parameters: {}}}]}, 1, 0);
    const graph = await prepareFlowRun(parent, {resolveComposite: async () => child});
    expect(graph.nodes.some(node => node.id === 'call/value')).toBe(true);
    await expect(prepareFlowRun({...parent, exposure: 'local'}, {caller: 'flow'} as never))
        .rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
});
