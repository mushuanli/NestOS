import { expect, it } from 'vitest';
import type { FlowDraft, FlowRevision } from '../src/contracts';
import { externalFlowReferences, visitFlowCalls } from '../src/flow/definition-references';
const call = (id: string, flowId: string) => ({ id, name: id, plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: { flowId } });
const draft = (id: string, nodes: unknown[] = [], functions: FlowDraft[] = []): FlowDraft => ({ id, name: id, nodes, functions,
    edges: [], layout: {}, draftVersion: 1, updatedAt: 0 } as FlowDraft);
const lock = (flowId: string, revision: number, children = {}) => ({ flowId, revision, digest: `${flowId}-${revision}`, children });

it('keeps direct locks separate from equally named transitive dependencies', () => {
    const flow = { ...draft('root', [call('direct', 'shared'), call('wrapper', 'wrapper')]), dependencyLocks: {
        direct: lock('shared', 2), wrapper: lock('wrapper', 1, { nested: lock('shared', 1) }),
    } } as unknown as FlowRevision;
    expect(externalFlowReferences(flow)).toEqual([{ flowId: 'shared', revision: 2, digest: 'shared-2' },
        { flowId: 'wrapper', revision: 1, digest: 'wrapper-1' }]);
});
it('uses the lock children of each inline invocation, including sibling lexical calls', () => {
    const flow = { ...draft('root', [call('first', 'helper')], [draft('helper', [call('next', 'sibling')]),
        draft('sibling', [call('external', 'shared')])]), dependencyLocks: {
        first: lock('helper', 1, { next: lock('sibling', 1, { external: lock('shared', 2) }) }),
    } } as unknown as FlowRevision;
    expect(externalFlowReferences(flow)).toEqual([{ flowId: 'shared', revision: 2, digest: 'shared-2' }]);
});
it('retains distinct locks for separate calls to the same local function', () => {
    const flow = { ...draft('root', [call('first', 'helper'), call('second', 'helper')], [draft('helper', [call('external', 'shared')])]),
        dependencyLocks: { first: lock('helper', 1, { external: lock('shared', 1) }), second: lock('helper', 1, { external: lock('shared', 2) }) } } as unknown as FlowRevision;
    expect(externalFlowReferences(flow).map(ref => ref.revision)).toEqual([1, 2]);
});
it('rewrites authored calls with lexical ownership and includes uncalled declarations', () => {
    const flow = draft('root', [call('local', 'helper'), call('external', 'shared')], [draft('helper', [call('back', 'helper')]), draft('unused', [call('global', 'shared')])]);
    const calls: Array<[string, boolean]> = [];
    visitFlowCalls(flow, ({ node, local }) => { calls.push([node.id, local]); });
    expect(calls).toEqual([['local', true], ['external', false], ['back', true], ['global', false]]);
    expect(() => externalFlowReferences(flow)).toThrow(/cycle/);
});
