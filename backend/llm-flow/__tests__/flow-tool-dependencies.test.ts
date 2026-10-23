import {expect, it} from 'vitest';
import {collectFlowToolDependencies, flowToolDependencyIssues, type FlowDraft} from '../src/contracts';
import {createFlowRevision} from '../src/flow-definition-store';
import {flowRevisionToDraft} from '../src/flow/definition-projection';
import {checkFlowSyntax} from '../src/flow/syntax-check';

const flow = (): FlowDraft => ({id: 'tools' as never, name: 'Tools', draftVersion: 1, updatedAt: 0, layout: {}, edges: [], nodes: [
    {id: 'call' as never, name: 'Call', plugin: 'builtin.tool', pluginVersion: '1.0.0', inputs: {}, config: {toolId: 'fixture.call', toolVersion: '1', args: {}}}]});

it('combines explicit dynamic dependencies, static calls and inline declarations without guessing templates', () => {
    const source = flow(); source.toolDependencies = [{id: 'fixture.dynamic', version: '2'}];
    source.functions = [{...flow(), id: 'child' as never, toolDependencies: [{id: 'fixture.child', version: '1'}]}];
    source.nodes.push({...source.nodes[0], id: 'dynamic' as never, config: {toolId: '${param.tool}', toolVersion: '1', args: {}}});
    expect(collectFlowToolDependencies(source)).toEqual([{id: 'fixture.dynamic', version: '2'}, {id: 'fixture.call', version: '1'}, {id: 'fixture.child', version: '1'}]);
    const revision = createFlowRevision(source, 1);
    expect(flowRevisionToDraft(revision).toolDependencies).toEqual(source.toolDependencies);
});

it('rejects paths, undeclared installer arguments and conflicting versions before publication', () => {
    expect(flowToolDependencyIssues([{id: 'package/tool', version: '1'}])).toEqual([]);
    expect(flowToolDependencyIssues([{id: '../arbitrary', version: '1'}])).not.toEqual([]);
    expect(flowToolDependencyIssues([{id: 'package/../tool', version: '1'}])).not.toEqual([]);
    expect(flowToolDependencyIssues([{id: 'fixture.call', modulePath: '/tmp/module.mjs'}])).not.toEqual([]);
    const source = flow(); source.toolDependencies = [{id: 'fixture.call', version: '2'}];
    expect(checkFlowSyntax(source).diagnostics).toContainEqual(expect.objectContaining({code: 'invalid-tool-dependencies'}));
});
