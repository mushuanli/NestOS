import {expect, it} from 'vitest';
import {sha256HexSync} from '@itookit/llm-context';
import {prepareHarnessInput, harnessInputDigest} from '../llm-management/contracts/harness-input';
import type {HarnessConnectionSnapshot} from '../llm-management/contracts/harness-execution';
import type {HarnessContextRequest} from '../llm-management/contracts/context-binding';
import {HarnessProgram} from './harness-program';

const connection: HarnessConnectionSnapshot = {id: 'native', name: 'Native', kind: 'harness', nodeConnectionId: 'node',
    projectId: 'project', profileId: 'profile', version: 1, revision: 1, project: {}};
const basis = {invocationId: 'call', branchId: 'main', targetRef: 'agent@1', scopeRef: 'conversation', policyRef: 'policy',
    workspaceRef: 'workspace', memoryPolicyRef: 'native-inherited'};
const file = {kind: 'text' as const, name: 'notes.txt', content: 'original', mimeType: 'text/plain'};

it('keeps file boundaries, supplies attachment-only input and preserves legacy plain-text identity', () => {
    const input = prepareHarnessInput({messages: [{role: 'user', content: '', attachments: [{type: 'text', name: file.name, source: file.content, mimeType: file.mimeType}]}]});
    expect(input).toEqual({prompt: 'Attachments: notes.txt', attachments: [file]});
    expect(harnessInputDigest({prompt: 'legacy'})).toBe(sha256HexSync('legacy'));
    expect(() => prepareHarnessInput({prompt: 'Review', attachments: [file, {...file, content: 'changed'}]}))
        .toThrow('HARNESS_ATTACHMENT_NAME_CONFLICT');
});

it('checks actual canonical input against the host snapshot digest before starting an Effect', () => {
    const messages = [{role: 'user', content: 'Review', attachments: [{type: 'text', name: file.name, source: file.content}]}];
    const digest = sha256HexSync(JSON.stringify(messages));
    const context: HarnessContextRequest = {...basis, conversation: {mode: 'new'}, input: {mode: 'host-assembled', snapshotRef: 'snapshot', digest}};
    const input = {connection, context, messages, contextSnapshot: {id: 'snapshot', digest} as never};
    expect(new HarnessProgram().init(input).next.type).toBe('wait');
    expect(() => new HarnessProgram().init({...input, messages: [{...messages[0], attachments: [{...messages[0].attachments[0], source: 'changed'}]}]}))
        .toThrow('HARNESS_CONTEXT_DIGEST_MISMATCH');
    expect(() => new HarnessProgram().init({...input, dependencies: [{taskId: 'worker', input: 'result'}]}))
        .toThrow('HARNESS_CONTEXT_DEPENDENCIES_UNSNAPSHOTTED');
});

it('pins native incremental file data and rejects a changed file under the same context reference', () => {
    const prepared = prepareHarnessInput({prompt: 'Review', attachments: [file]});
    const context: HarnessContextRequest = {...basis, input: {mode: 'native-continuation', inputRef: 'input', digest: harnessInputDigest(prepared)},
        conversation: {mode: 'fork', sourceBindingId: 'binding', expectedBindingRevision: 1, expectedGeneration: 1, checkpointRef: 'turn'}};
    expect(new HarnessProgram().init({connection, context, ...prepared}).next.type).toBe('wait');
    expect(() => new HarnessProgram().init({connection, context, ...prepared, attachments: [{...file, content: 'changed'}]}))
        .toThrow('HARNESS_INPUT_DIGEST_MISMATCH');
});

it('retains selected immutable asset references and rejects conflicting or malformed sources', () => {
    const asset = {kind: 'input', id: '12345678-1234-1234-1234-123456789012', mimeType: 'image/png', bytes: 8, sha256: 'a'.repeat(64)};
    const input = {messages: [{role: 'user', content: [{type: 'image', name: 'figure.png', source: {type: 'asset', asset}}]}]};
    const prepared = prepareHarnessInput(input);
    expect(prepared).toEqual({prompt: 'File attachment: figure.png', attachments: [{kind: 'asset', name: 'figure.png', asset}]});
    const changed = prepareHarnessInput({messages: [{role: 'user', content: [{type: 'image', name: 'figure.png', source: {type: 'asset', asset: {...asset, sha256: 'b'.repeat(64)}}}]}]});
    expect(changed.prompt).toBe(prepared.prompt); expect(harnessInputDigest(prepared)).not.toBe(harnessInputDigest(changed));
    const reordered = {...input, messages: [{role: 'user', content: [{type: 'image', name: 'figure.png', source: {type: 'asset', asset: Object.fromEntries(Object.entries(asset).reverse())}}]}]};
    expect(prepareHarnessInput(reordered)).toEqual(prepared);
    expect(() => prepareHarnessInput({attachments: [{kind: 'asset', name: 'figure.png', asset: {...asset, id: '../foreign'}}] as never})).toThrow('HARNESS_ASSET_REFERENCE_INVALID');
    expect(() => prepareHarnessInput({attachments: [{kind: 'asset', name: 'figure.png', asset, content: 'ignored'}] as never})).toThrow('HARNESS_ATTACHMENT_SOURCE_CONFLICT');
    expect(input.messages[0].content[0].source.asset).toEqual(asset);
});

it('carries frozen inline files through Program capability admission into the Effect request', () => {
    const program = new HarnessProgram(), input = {connection, messages: [{role: 'user', content: '', attachments: [file]}]};
    const state = program.init(input).state;
    const next = program.reduce(state, {type: 'signal', signal: {type: 'capabilities', payload: {harnessHandleId: 'handle'}}});
    expect(next.actions).toMatchObject([{type: 'effect', effect: {request: {prompt: 'Attachments: notes.txt', attachments: [file]}}}]);
    expect(input.messages[0].attachments).toEqual([file]);
});
