import {expect, it, vi} from 'vitest';
import {flowConnectionRequired, flowInputDeclarationIssues, flowParameterValues, validateFlowInputGroups, type FlowDraft, type FlowInputGroup, type FlowParameter} from '../src/contracts';
import {createFlowRevision} from '../src/flow-definition-store';
import {flowRevisionToDraft} from '../src/flow/definition-projection';
import {prepareFlowRun} from '../src/flow/prepare-run';
import {prepareFlowParameters} from '../src/flow/parameters';
import {flowToDag} from '../src/flow/to-dag';
import {isDagRunSpec} from '../src/flow/checkpoint-decoder';
import {scopedParameters} from '../src/flow/structured/references';

const schema: FlowParameter[] = [{name: 'body', type: 'string', inputSource: 'composer.text'},
    {name: 'pages', type: 'json', widget: 'images', inputSource: 'composer.attachments'}];
const groups: FlowInputGroup[] = [{name: 'source', mode: 'oneOf', parameters: ['body', 'pages']}];
const condition = {kind: 'eq' as const, args: [{kind: 'param' as const, path: ['enabled']}, {kind: 'literal' as const, value: true}]};
const definition = (): FlowDraft => ({id: 'declarations' as never, name: 'Declarations', draftVersion: 1, updatedAt: 0, layout: {},
    parameters: [...structuredClone(schema), {name: 'enabled', type: 'boolean', default: false}], inputGroups: structuredClone(groups),
    connections: [{name: 'media', label: 'Image connection', requiredWhen: condition}], edges: [], nodes: [
        {id: 'echo' as never, name: 'Echo', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 'Ready'}}]});

it('preserves input sources, groups and conditional slots through revision publication and draft projection', () => {
    const draft = definition(), revision = createFlowRevision(draft, 1), restored = flowRevisionToDraft(revision);
    expect(restored.inputGroups).toEqual(groups); expect(restored.parameters).toEqual(draft.parameters); expect(restored.connections).toEqual(draft.connections);
    draft.inputGroups![0] = {...groups[0], label: 'Choose input'};
    expect(createFlowRevision(draft, 1, revision.createdAt).digest).not.toBe(revision.digest);
});

it('checks exactly one nonempty source and does not restore defaults for the unselected member', () => {
    expect(validateFlowInputGroups(schema, groups, {body: 'word'})).toEqual([]);
    expect(validateFlowInputGroups(schema, groups, {body: ' ', pages: []})[0].code).toBe('missing-input-group');
    expect(validateFlowInputGroups(schema, groups, {body: 'word', pages: [1]})[0].code).toBe('conflicting-input-group');
    const defaults = schema.map(field => ({...field, default: field.name === 'body' ? 'Old text' : [1]}));
    expect(flowParameterValues(defaults, {body: 'New text'}, groups)).toEqual({body: 'New text'});
    expect(prepareFlowParameters(defaults, {body: 'New text'}, groups)).toEqual({body: 'New text'});
});

it('allows explicit collectors to obtain a missing group while rejecting conflicting sources', () => {
    const interactive = schema.map(field => ({...field, onMissing: 'interact' as const}));
    expect(prepareFlowParameters(interactive, {}, groups)).toEqual({});
    expect(() => prepareFlowParameters(interactive, {body: 'word', pages: [1]}, groups)).toThrow('exactly one');
});

it('rejects invalid input metadata and parameter conditions without exposing values', () => {
    const flow = definition(); flow.parameters![0].inputSource = 'inferred-from-name' as never;
    flow.inputGroups![0] = {name: 'invalid', mode: 'oneOf', parameters: ['body', 'missing']};
    flow.connections![0].requiredWhen = {kind: 'param', path: ['undeclared']};
    expect(flowInputDeclarationIssues(flow).map(issue => issue.code)).toEqual(['invalid-input-source', 'invalid-input-group', 'invalid-connection-condition']);
    flow.connections![0].requiredWhen = {kind: 'path', path: ['upstream', 'text']};
    expect(flowInputDeclarationIssues(flow).some(issue => issue.code === 'invalid-connection-condition')).toBe(true);
});

it('rejects an invalid source group before invoking connection admission', async () => {
    const prepareConnections = vi.fn(async flow => flow);
    await expect(prepareFlowRun(createFlowRevision(definition(), 1), {parameters: {body: 'private input', pages: [1]}, prepareConnections})).rejects.toThrow('exactly one');
    expect(prepareConnections).not.toHaveBeenCalled();
});

it('uses current run parameters for connection requirements and freezes the computed requirement', async () => {
    const draft = definition(), revision = createFlowRevision(draft, 1), observed: boolean[] = [];
    const prepare = async (flow: typeof revision) => {
        if (flow.connections?.length) observed.push(flow.connections[0].required!);
        return {...flow, connections: flow.connections?.map(slot => ({...slot, connectionId: slot.required ? 'selected' : undefined}))};
    };
    const graph = await prepareFlowRun(revision, {parameters: {body: 'word', enabled: true}, prepareConnections: prepare});
    expect(observed).toEqual([true]); expect(graph.inputGroups).toEqual(groups);
    expect(flowConnectionRequired(revision.connections![0], {enabled: false})).toBe(false);
    expect(flowConnectionRequired(revision.connections![0], {enabled: true})).toBe(true);
    expect(flowConnectionRequired({name: 'flag', requiredWhen: {kind: 'param', path: ['enabled']}}, {enabled: false})).toBe(false);
    expect(revision.connections![0].requiredWhen).toEqual(condition);
});

it('evaluates a child connection condition with explicit parameters resolved from its parent', async () => {
    const child = definition(); child.id = 'child' as never; delete child.inputGroups; child.parameters = [{name: 'enabled', type: 'boolean', default: false}];
    child.outputs = {result: {value: '${nodes.echo.outputs.result}'}};
    const parent = definition(); delete parent.inputGroups; parent.connections = []; parent.functions = [child];
    parent.nodes = [{id: 'call' as never, name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
        config: {flowId: 'child', parameters: {enabled: '${param.enabled}'}}}];
    const observed: boolean[] = [];
    await flowToDag(createFlowRevision(parent, 1), undefined, undefined, undefined, [], undefined, false, undefined, undefined,
        async flow => {if (flow.id === 'child' && flow.connections?.length) observed.push(flow.connections[0].required!);
            return {...flow, connections: flow.connections?.map(slot => ({...slot, connectionId: 'selected'}))};}, {enabled: true});
    expect(observed).toEqual([true]);
});

it('does not reintroduce unselected scoped defaults in function, legacy or batch parameters', () => {
    const fields: FlowParameter[] = [{name: 'body', type: 'string'}, {name: 'pages', type: 'json'}];
    const base = {parent: '', defaults: {pages: ['Old source']}, values: {body: 'Selected'}, schema: fields, groups};
    const expected = {body: 'Selected'};
    expect(scopedParameters({nodes: [], edges: [], parameterScopes: {'child/': base}}, 'child/echo', {})).toEqual(expected);
    expect(scopedParameters({nodes: [], edges: [], parameterScopes: {'child/': {...base, source: 'input'}}}, 'child/echo', {},
        {input: {body: 'Selected'}})).toEqual(expected);
    expect(scopedParameters({nodes: [], edges: [], parameterScopes: {'child/': {...base, source: 'input', parameterSet: 0}}}, 'child/echo', {},
        {input: {parameters: {}, parameterSets: [{body: 'Selected'}]}})).toEqual(expected);
});

it.each([
    [[{enabled: false}], false],
    [[{enabled: true}], true],
    [[{enabled: false}, {enabled: true}], true],
    [[{enabled: true}, {enabled: false}], true],
    ['${nodes.producer.outputs.result}', true],
])('admits conditional connections needed by any batch row or by unresolved runtime rows: %j', async (parameterSets, required) => {
    const child = definition(); child.id = 'conditional-child' as never; delete child.inputGroups;
    child.parameters = [{name: 'enabled', type: 'boolean', default: false}]; child.outputs = {result: {value: '${nodes.echo.outputs.result}'}};
    const parent = definition(); delete parent.inputGroups; parent.connections = []; parent.functions = [child];
    parent.nodes = [{id: 'call' as never, name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
        config: {flowId: child.id, parameterSets: parameterSets as never}}];
    if (typeof parameterSets === 'string') parent.nodes.unshift({id: 'producer' as never, name: 'Rows',
        plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: [{enabled: true}]}});
    const observed: boolean[] = [];
    const graph = await flowToDag(createFlowRevision(parent, 1), undefined, undefined, undefined, [], undefined, false, undefined, undefined,
        async flow => {if (flow.id === child.id && flow.connections?.length) observed.push(flow.connections[0].required!);
            return {...flow, connections: flow.connections?.map(slot => ({...slot, connectionId: slot.required ? 'selected' : undefined}))};});
    expect(observed).toEqual([required]);
    const frozen = Object.values(graph.functionCalls ?? {})[0].child.nodeConnections!['echo'].connections![0];
    expect(frozen.required).toBe(required); expect(frozen.requiredWhen).toBeUndefined();
});


it('supports inclusive anyOf groups through defaults, scoped values and persisted graph decoding', () => {
    const any: FlowInputGroup[] = [{...groups[0], mode: 'anyOf'}];
    const fields: FlowParameter[] = [{name: 'body', type: 'string', default: 'Default text'}, {name: 'pages', type: 'json'}];
    expect(flowInputDeclarationIssues({parameters: fields, inputGroups: any})).toEqual([]);
    expect(validateFlowInputGroups(fields, any, {body: 'word', pages: [1]})).toEqual([]);
    expect(validateFlowInputGroups(fields, any, {body: ' ', pages: []})).toMatchObject([{code: 'missing-input-group', message: expect.stringContaining('at least one')}]);
    const expected = {body: 'Default text', pages: [1]};
    expect(prepareFlowParameters(fields, {pages: [1]}, any)).toEqual(expected);
    const scope = {parent: '', defaults: {body: 'Default text'}, values: {pages: [1]}, schema: fields, groups: any};
    const spec = {nodes: [], edges: [], parameterSchema: fields, inputGroups: any, parameterScopes: {'child/': scope}};
    expect(scopedParameters(spec, 'child/echo', {})).toEqual(expected);
    expect(isDagRunSpec(JSON.parse(JSON.stringify(spec)))).toBe(true);
    const draft = definition(); draft.inputGroups = any;
    expect(flowRevisionToDraft(createFlowRevision(draft, 1)).inputGroups).toEqual(any);
    expect(prepareFlowParameters(schema.map(field => ({...field, onMissing: 'interact' as const})), {}, any)).toEqual({});
});


it('accepts presentation hints without changing retained execution parameters', () => {
    const draft = definition();
    draft.parameters![0].presentation = {group: 'Sources', contentSource: false, visibleWhen: condition};
    draft.connections![0].presentation = {group: 'Sources'};
    expect(flowInputDeclarationIssues(draft)).toEqual([]);
    const restored = flowRevisionToDraft(createFlowRevision(draft, 1));
    expect(restored.parameters![0].presentation).toEqual(draft.parameters![0].presentation);
    expect(restored.connections![0].presentation).toEqual({group: 'Sources'});
    expect(prepareFlowParameters(draft.parameters, {body: 'retained', enabled: false}, draft.inputGroups).body).toBe('retained');
    for (const presentation of [{group: ''}, {contentSource: 'false'}, {visibleWhen: {kind: 'param', path: ['missing']}}]) {
        draft.parameters![0].presentation = presentation as never;
        expect(flowInputDeclarationIssues(draft).some(issue => issue.code === 'invalid-parameter-presentation')).toBe(true);
    }
    draft.connections![0].presentation = {group: false} as never;
    expect(flowInputDeclarationIssues(draft).some(issue => issue.code === 'invalid-connection-presentation')).toBe(true);
});

it('defers a missing anyOf group when one member has a collector', () => {
    const fields = schema.map((field, index) => ({...field, onMissing: index === 0 ? 'interact' as const : 'error' as const}));
    const any: FlowInputGroup[] = [{...groups[0], mode: 'anyOf'}];
    expect(prepareFlowParameters(fields, {}, any)).toEqual({});
    expect(validateFlowInputGroups(fields, any, {})).toMatchObject([{code: 'missing-input-group'}]);
    expect(() => prepareFlowParameters(fields, {}, groups)).toThrow('exactly one');
});

it('publishes parameter roles and rejects composer bindings on configuration fields', () => {
    const draft = definition(); draft.parameters![0].role = 'input'; draft.parameters![2].role = 'policy';
    expect(flowInputDeclarationIssues(draft)).toEqual([]);
    expect(flowRevisionToDraft(createFlowRevision(draft, 1)).parameters).toEqual(draft.parameters);
    draft.parameters![0].role = 'option';
    expect(flowInputDeclarationIssues(draft).some(issue => issue.code === 'invalid-input-source')).toBe(true);
    draft.parameters![0].role = 'unknown' as never;
    expect(flowInputDeclarationIssues(draft).some(issue => issue.code === 'invalid-parameter-role')).toBe(true);
});
