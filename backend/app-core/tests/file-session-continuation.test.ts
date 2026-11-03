import {afterEach, expect, it, vi} from 'vitest';
import {prepareFileContinuation} from '../src/run/file-session-continuation';
const state = vi.hoisted(() => ({generation: 2, valid: true, native: true, active: false}));
vi.mock('../src/projects/harness-context-catalog', () => ({readContextCatalog: async () => ({value: {bindings: {binding: {id: 'binding', generation: state.generation, revision: 9, branchId: 'main', connectionId: 'work-original', validity: state.valid ? 'valid' : 'invalid', activeOperation: state.active ? {} : undefined, nativeRef: state.native ? {profileId: 'codex', sessionId: 'native-original'} : undefined}}}})}));
afterEach(() => {state.generation = 2; state.valid = state.native = true; state.active = false;});
function fixture() {
    const base = {expectedSessionId: 'original', expectedBranch: 'main', expectedTarget: {kind: 'agent', id: 'managed', version: '1', digest: 'digest'},
        source: {kind: 'composer', text: JSON.stringify({instruction: 'Read-only merge analysis', dependencies: {lifecycle: {stage: 'postload.succeeded'}}}), values: {}, attachments: []},
        overrides: {harnessConversation: {mode: 'resume', bindingId: 'binding', expectedBindingRevision: 2, expectedGeneration: 2}}};
    const options = {kernel: {sessionActivity: async () => ({counts: {running: 0}})}, base, sessionId: 'original', connectionId: 'work-original', id: 'next-round', paths: [{path: '_nestos/kanban/outbox/request.yaml', sha256: 'a'.repeat(64)}]} as never;
    return {base, options};
}
it('continues the same logical/native identity with the current revision and response hashes', async () => {
    const f = fixture(), before = JSON.stringify(f.base), request = await prepareFileContinuation(f.options);
    expect(request).toMatchObject({expectedSessionId: 'original', expectedTarget: f.base.expectedTarget, submission: {id: 'next-round'}, overrides: {branchMode: 'continue', harnessConversation: {mode: 'resume', bindingId: 'binding', expectedBindingRevision: 9, expectedGeneration: 2}}});
    const message = JSON.parse((request.source as {text: string}).text);
    expect(message.dependencies).toMatchObject({lifecycle: {stage: 'postload.succeeded'}, fileExchange: {responses: [{path: '_nestos/kanban/outbox/request.yaml', sha256: 'a'.repeat(64)}]}});
    expect(message.continuation).toContain('Do not rerun'); expect(JSON.stringify(f.base)).toBe(before);
});
it('refuses a changed generation, missing native context, active operation or invalid binding', async () => {
    const f = fixture(); state.generation = 3; await expect(prepareFileContinuation(f.options)).rejects.toMatchObject({code: 'FILE_EXCHANGE_CONTEXT_CHANGED'});
    state.generation = 2; state.native = false; await expect(prepareFileContinuation(f.options)).rejects.toMatchObject({code: 'FILE_EXCHANGE_CONTEXT_UNAVAILABLE'});
    state.native = true; state.active = true; await expect(prepareFileContinuation(f.options)).rejects.toMatchObject({code: 'FILE_EXCHANGE_CONTEXT_UNAVAILABLE'});
    state.active = false; state.valid = false; await expect(prepareFileContinuation(f.options)).rejects.toMatchObject({code: 'FILE_EXCHANGE_CONTEXT_UNAVAILABLE'});
});
