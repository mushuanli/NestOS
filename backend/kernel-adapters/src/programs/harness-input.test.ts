import {expect, it} from 'vitest';
import {sha256HexSync} from '@itookit/llm-context';
import {prepareHarnessInput, harnessInputDigest} from '../llm-management/contracts/harness-input';
import type {HarnessConnectionSnapshot} from '../llm-management/contracts/harness-execution';
import {HarnessProgram} from './harness-program';

const connection: HarnessConnectionSnapshot = {id: 'native', name: 'Native', kind: 'harness', nodeConnectionId: 'node',
    projectId: 'project', profileId: 'profile', version: 1, revision: 1, project: {}};
const file = {kind: 'text' as const, name: 'notes.txt', content: 'original', mimeType: 'text/plain'};

it('keeps file boundaries, supplies attachment-only input and preserves legacy plain-text identity', () => {
    const input = prepareHarnessInput({messages: [{role: 'user', content: '', attachments: [{type: 'text', name: file.name, source: file.content, mimeType: file.mimeType}]}]});
    expect(input).toEqual({prompt: 'Attachments: notes.txt', attachments: [file]});
    expect(harnessInputDigest({prompt: 'legacy'})).toBe(sha256HexSync('legacy'));
    expect(() => prepareHarnessInput({prompt: 'Review', attachments: [file, {...file, content: 'changed'}]}))
        .toThrow('HARNESS_ATTACHMENT_NAME_CONFLICT');
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
