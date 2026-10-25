import {expect, it} from 'vitest';
import {validFlowFiles, validFileConstraints, type FlowParameter} from '../src/contracts';
import {validateFlowParameters} from '../src/flow/parameters';
import {checkFlowSyntax} from '../src/flow/syntax-check';
import {FlowInputProgram} from '../src/flow/structured/input';
import {validateFlowCallParameters} from '../src/flow/call-parameters';

const part = {type: 'file', name: 'notes.txt', source: {type: 'asset', asset: {kind: 'input',
    id: '12345678-1234-4123-8123-123456789abc', mimeType: 'text/plain', bytes: 0, sha256: 'a'.repeat(64)}}};
const parameter: FlowParameter = {name: 'documents', type: 'json', widget: 'files', required: true,
    inputSource: 'composer.attachments', fileConstraints: {minItems: 1, maxItems: 2, maxBytes: 100, mimeTypes: ['text/plain']}};

it('validates zero-byte references, explicit empty lists, and scoped Task material identities without reading files', () => {
    expect(validFlowFiles([part], parameter.fileConstraints)).toBe(true);
    expect(validFlowFiles([], parameter.fileConstraints)).toBe(false); expect(validFlowFiles([], {})).toBe(true);
    expect(validFlowFiles([{...part, source: {type: 'asset', asset: {sessionId: 's', taskId: 't', owner: 'o', name: 'a.bin',
        bytes: 1, sha256: 'b'.repeat(64), mimeType: 'application/octet-stream'}}}])).toBe(true);
    expect(validFlowFiles([{...part, source: {type: 'asset', asset: {...part.source.asset, id: '../private'}}}])).toBe(false);
    expect(validFileConstraints({minItems: 3, maxItems: 2})).toBe(false);
    expect(validFileConstraints({maxBytes: -1})).toBe(false); expect(validFileConstraints({unknown: 1} as never)).toBe(false);
});

it('uses one file declaration for source validation, admission checks and deferred collection', () => {
    const flow = {id: 'files', name: 'Files', draftVersion: 1, updatedAt: 0, parameters: [parameter], nodes: [
        {id: 'value', name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', config: {value: '${param.documents}'}, inputs: {}},
    ], edges: []};
    expect(checkFlowSyntax(flow).valid).toBe(true);
    expect(checkFlowSyntax({...flow, parameters: [{...parameter, default: null}]}).valid).toBe(false);
    expect(checkFlowSyntax({...flow, parameters: [{...parameter, type: 'string'}]}).valid).toBe(false);
    expect(validateFlowParameters([parameter], {documents: [part]})).toEqual([]);
    expect(validateFlowParameters([parameter], {documents: []})).toHaveLength(1);
    const deferred = {...parameter, onMissing: 'interact' as const};
    expect(validateFlowParameters([deferred], {})).toEqual([]);
    const program = new FlowInputProgram(), waiting = program.init({fields: {documents: deferred}, values: {}, dependencies: []});
    expect(waiting.next.type).toBe('wait'); expect(waiting.actions?.[0]).toMatchObject({type: 'request-interaction', interaction: {id: 'input-1'}});
    const done = program.reduce(waiting.state, {type: 'interaction-resolved', interactionId: 'input-1', value: {documents: [part]}} as never);
    expect(done.next.type).toBe('complete');
});

it('keeps dynamic file bindings unevaluated until a child consumes actual values', () => {
    expect(validateFlowCallParameters([parameter], {documents: '${nodes.producer.outputs.files}'})).toEqual([]);
    expect(validateFlowCallParameters([parameter], {documents: [{...part, source: {type: 'asset', asset: '${nodes.producer.outputs.asset}'}}] as never})).toEqual([]);
    expect(validateFlowCallParameters([parameter], {documents: 'wrong'})).toHaveLength(1);
});
