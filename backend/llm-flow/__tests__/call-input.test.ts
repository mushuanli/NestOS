import {describe, expect, it} from 'vitest';
import {prepareFlowCallInput} from '../src/flow/call-input';
import type {FlowParameter, FlowRevision, JsonValue} from '../src/contracts';

const flow = (parameters: FlowParameter[] = []) => ({id: 'callable' as FlowRevision['id'], revision: 1, digest: 'frozen', parameters});

describe('shared Flow call input preparation', () => {
    it.each([
        {kind: 'arguments', value: {}, ignored: 'unconsumed'},
        {kind: 'composer', text: '', attachments: [], values: {}, ignored: 'unconsumed'},
    ])('rejects undeclared source envelope fields before freezing the input: $kind', source => {
        expect(() => prepareFlowCallInput(flow(), source as never))
            .toThrowError(expect.objectContaining({code: 'FLOW_INPUT_SOURCE_INVALID'}));
    });
    it('binds declared composer sources and preserves JSON-looking text as text', () => {
        const definition = flow([{name: 'request', type: 'string', inputSource: 'composer.text'}, {name: 'language', type: 'string', default: 'en'}]);
        const result = prepareFlowCallInput(definition, {kind: 'composer', text: '{"literal":true}', attachments: [], values: {language: 'zh-CN'}});
        expect(result.parameters).toEqual({request: '{"literal":true}', language: 'zh-CN'});
        expect(result.origins).toEqual({request: ['composer.text'], language: ['form']});
    });
    it('resolves defaults in declaration, Agent and explicit order without treating falsy values as missing', () => {
        const definition = flow(['enabled', 'count', 'text', 'nullable', 'items'].map(name => ({name, type: 'json', default: 'flow'})));
        const source = {enabled: false, count: 0, text: '', nullable: null, items: []};
        const result = prepareFlowCallInput(definition, {kind: 'arguments', value: source}, {defaults: {enabled: true, count: 10}});
        expect(result.parameters).toEqual(source); expect(result.origins.enabled).toEqual(['arguments']);
        expect(prepareFlowCallInput(definition, {kind: 'arguments', value: {}}, {defaults: {text: 'agent'}}).origins.text).toEqual(['agent-default']);
    });
    it('applies mutually exclusive defaults at each precedence layer', () => {
        const definition = {...flow([{name: 'a', type: 'string', default: 'flow'}, {name: 'b', type: 'string'}]),
            inputGroups: [{name: 'source', mode: 'oneOf' as const, parameters: ['a', 'b']}]};
        expect(prepareFlowCallInput(definition, {kind: 'arguments', value: {}}, {defaults: {b: 'agent'}}).parameters).toEqual({b: 'agent'});
        expect(prepareFlowCallInput(definition, {kind: 'arguments', value: {a: 'explicit'}}, {defaults: {b: 'agent'}}).parameters).toEqual({a: 'explicit'});
    });
    it('reports conflicting source values without exposing their content', () => {
        const definition = flow([{name: 'request', type: 'string', inputSource: 'composer.text'}]);
        try {prepareFlowCallInput(definition, {kind: 'composer', text: 'private-text', attachments: [], values: {request: 'private-form'}});}
        catch (error) {
            expect(error).toMatchObject({code: 'FLOW_INPUT_CONFLICT', field: 'request'});
            expect(String(error)).not.toContain('private'); return;
        }
        throw new Error('Expected an input conflict');
    });
    it('retains both explicit origins when their structured values match', () => {
        const definition = flow([{name: 'request', type: 'string', inputSource: 'composer.text'}]);
        expect(prepareFlowCallInput(definition, {kind: 'composer', text: 'Same', attachments: [], values: {request: 'Same'}}).origins.request)
            .toEqual(['form', 'composer.text']);
    });
    it('rejects unused text and ambiguous attachment bindings instead of dropping input', () => {
        expect(() => prepareFlowCallInput(flow(), {kind: 'composer', text: 'Unused', attachments: [], values: {}})).toThrow('no declared binding');
        const definition = flow(['a', 'b'].map(name => ({name, type: 'json', widget: 'images', inputSource: 'composer.attachments'})));
        expect(() => prepareFlowCallInput(definition, {kind: 'composer', text: '', attachments: [{}], values: {}})).toThrow('explicit parameter selection');
    });
    it('accepts parameter-only, zero-argument and default-only inputs', () => {
        expect(prepareFlowCallInput(flow(), {kind: 'composer', text: '', attachments: [], values: {}}).parameters).toEqual({});
        const definition = flow([{name: 'limit', type: 'number', default: 3}]);
        expect(prepareFlowCallInput(definition, {kind: 'composer', text: '', attachments: [], values: {}}).parameters).toEqual({limit: 3});
        expect(prepareFlowCallInput(definition, {kind: 'arguments', value: {limit: 0}}).parameters).toEqual({limit: 0});
    });
    it('distinguishes an untouched empty surface from an explicitly empty parameter', () => {
        const definition = flow([{name: 'request', type: 'string', inputSource: 'composer.text', default: 'flow-default'}]);
        const source = {kind: 'composer' as const, text: '', attachments: [], values: {}};
        expect(prepareFlowCallInput(definition, source).parameters).toEqual({request: 'flow-default'});
        expect(prepareFlowCallInput(definition, {...source, values: {request: ''}}).parameters).toEqual({request: ''});
    });
    it('treats prototype property names as ordinary explicitly declared parameters', () => {
        const definition = flow([{name: 'constructor', type: 'string', required: true, inputSource: 'composer.text'}]);
        expect(() => prepareFlowCallInput(definition, {kind: 'arguments', value: {}})).toThrow('constructor');
        expect(prepareFlowCallInput(definition, {kind: 'composer', text: 'value', attachments: [], values: {}}))
            .toMatchObject({parameters: {constructor: 'value'}, origins: {constructor: ['composer.text']}});
    });
    it('defers interactive missing and invalid initial values while retaining the original input', () => {
        const definition = flow([{name: 'count', type: 'number', required: true, onMissing: 'interact'}]);
        expect(prepareFlowCallInput(definition, {kind: 'arguments', value: {}})).toMatchObject({parameters: {}, deferredFields: ['count']});
        expect(prepareFlowCallInput(definition, {kind: 'arguments', value: {count: 'initial'}}).parameters).toEqual({count: 'initial'});
    });
    it('validates the selected signature before accepting parameters', () => {
        const definition = flow();
        expect(() => prepareFlowCallInput(definition, {kind: 'arguments', value: {}}, {expected: {...definition, revision: 2}}))
            .toThrow('signature changed');
    });
    it('rejects unknown fields unless an explicit legacy boundary permits them', () => {
        expect(() => prepareFlowCallInput(flow(), {kind: 'arguments', value: {other: 1}})).toThrow('Unknown Flow parameter');
        expect(prepareFlowCallInput(flow(), {kind: 'arguments', value: {other: 1}}, {allowUndeclared: true}).parameters).toEqual({other: 1});
    });
    it.each([[], null, 3, 'text'])('rejects non-object argument roots: %j', value => {
        expect(() => prepareFlowCallInput(flow(), {kind: 'arguments', value})).toThrow('must be an object');
    });
    it('rejects non-JSON and cyclic input before persistence or execution', () => {
        for (const value of [{value: NaN}, {value: undefined}, {value: new Date()}, {value: () => {}}])
            expect(() => prepareFlowCallInput(flow(), {kind: 'arguments', value: value as unknown as JsonValue})).toThrow('only JSON data');
        const cycle: Record<string, JsonValue> = {}; cycle.self = cycle;
        expect(() => prepareFlowCallInput(flow(), {kind: 'arguments', value: cycle})).toThrow('only JSON data');
        expect(() => prepareFlowCallInput(flow([{name: 'data', type: 'json', default: NaN}]), {kind: 'arguments', value: {}}))
            .toThrow('only JSON data');
    });
    it('freezes resolved values independently from caller-owned data', () => {
        const definition = flow([{name: 'data', type: 'json'}]), value = {data: {items: ['original']}};
        const result = prepareFlowCallInput(definition, {kind: 'arguments', value});
        value.data.items[0] = 'changed'; expect(result.parameters.data).toEqual({items: ['original']});
    });
});
