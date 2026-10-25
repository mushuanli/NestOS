import {expect, it, vi} from 'vitest';
import type {ConversationUIState} from '@itookit/llm-session/contracts';
import {InteractionDraftPersistence} from './InteractionDraftPersistence';
import type {InteractionDraftScope, InteractionDraftContent} from '../domain/interaction-draft';
const diagnostics = vi.hoisted(() => ({debug: vi.fn(), warn: vi.fn()}));
vi.mock('@itookit/common', async original => ({...await original<typeof import('@itookit/common')>(), createModuleLogger: () => diagnostics}));
const scope: InteractionDraftScope = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'root', targetTaskId: 'worker', interactionId: 'ask', requestedAt: 1};
const content = (text: string): InteractionDraftContent => ({format: 'text', values: {answer: text}});
function fixture() {
    let revision = 0, state: ConversationUIState = {operationRecords: [], branchDrafts: {main: {inputText: 'Unrelated composer'}}};
    const repository = {getManifest: vi.fn(async () => structuredClone({revision, uiState: state})),
        compareAndSetUIState: vi.fn(async (_id: string, expected: number, patch: Partial<ConversationUIState>) => {
            if (expected !== revision) throw Object.assign(new Error('Changed'), {code: 'SESSION_UI_STATE_CONFLICT'});
            state = {...state, ...structuredClone(patch)}; revision++;
        })};
    return {repository, store: () => new InteractionDraftPersistence(repository as never), state: () => state};
}
it('preserves concurrent drafts in different branches and leaves composer and operation state unchanged', async () => {
    const f = fixture(), a = f.store(), b = f.store();
    await Promise.all([a.write({scope, expectedRevision: null, editId: 'main-edit', content: content('Main')}),
        b.write({scope: {...scope, branchId: 'review'}, expectedRevision: null, editId: 'review-edit', content: content('Review')})]);
    expect((await f.store().read(scope))?.content).toEqual(content('Main'));
    expect((await f.store().read({...scope, branchId: 'review'}))?.content).toEqual(content('Review'));
    expect(f.state().branchDrafts?.main.inputText).toBe('Unrelated composer'); expect(f.state().operationRecords).toEqual([]);
});
it('rejects stale edits and stale clears instead of overwriting a newer answer draft', async () => {
    const f = fixture(), store = f.store();
    await store.write({scope, expectedRevision: null, editId: 'first', content: content('First')});
    await store.write({scope, expectedRevision: 1, editId: 'newer', content: content('Newer')});
    for (const next of [content('Stale'), null])
        await expect(store.write({scope, expectedRevision: 1, editId: 'stale', content: next})).rejects.toMatchObject({code: 'INTERACTION_DRAFT_CONFLICT'});
    expect((await store.read(scope))?.content).toEqual(content('Newer'));
});
it('retains a clear revision so an old page cannot revive the deleted draft', async () => {
    const f = fixture(), store = f.store();
    await store.write({scope, expectedRevision: null, editId: 'first', content: content('First')});
    await store.write({scope, expectedRevision: 1, editId: 'clear', content: null});
    expect(await f.store().read(scope)).toEqual({revision: 2, editId: 'clear', content: null});
    await expect(store.write({scope, expectedRevision: null, editId: 'old-page', content: content('Old')})).rejects.toMatchObject({code: 'INTERACTION_DRAFT_CONFLICT'});
    await store.write({scope, expectedRevision: 2, editId: 'new', content: content('New')});
    expect((await store.read(scope))?.revision).toBe(3);
});
it('queries an uncertain write and confirms the exact edit without writing a second time', async () => {
    const f = fixture(), write = f.repository.compareAndSetUIState.getMockImplementation()!;
    f.repository.compareAndSetUIState.mockImplementationOnce(async (...args) => {await write(...args); throw new Error('PRIVATE NETWORK FAILURE');});
    const input = {scope, expectedRevision: null, editId: 'once', content: {format: 'json' as const, values: {answer: '{invalid draft'}, note: 'PRIVATE NOTE'}};
    expect(await f.store().write(input)).toMatchObject({revision: 1, content: input.content});
    expect(f.repository.compareAndSetUIState).toHaveBeenCalledTimes(1);
    expect(await f.store().write(input)).toMatchObject({revision: 1}); expect(f.repository.compareAndSetUIState).toHaveBeenCalledTimes(1);
    await expect(f.store().write({...input, content: content('Changed')})).rejects.toMatchObject({code: 'INTERACTION_DRAFT_IDENTITY_CONFLICT'});
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('PRIVATE NOTE');
});
it('does not reapply an uncertain edit over a later write by another view', async () => {
    const f = fixture(), write = f.repository.compareAndSetUIState.getMockImplementation()!;
    f.repository.compareAndSetUIState.mockImplementationOnce(async (...args) => {
        await write(...args); await f.store().write({scope, expectedRevision: 1, editId: 'later', content: content('Later')}); throw new Error('Lost');
    });
    await expect(f.store().write({scope, expectedRevision: null, editId: 'first', content: content('First')})).rejects.toThrow('Lost');
    expect((await f.store().read(scope))?.content).toEqual(content('Later')); expect(f.repository.compareAndSetUIState).toHaveBeenCalledTimes(2);
});
it('does not acknowledge storage failures or retry an unproven write', async () => {
    const f = fixture(); f.repository.compareAndSetUIState.mockRejectedValue(new Error('Unwritten'));
    await expect(f.store().write({scope, expectedRevision: null, editId: 'failed', content: content('PRIVATE ANSWER')})).rejects.toThrow('Unwritten');
    expect(await f.store().read(scope)).toBeUndefined(); expect(f.repository.compareAndSetUIState).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('PRIVATE ANSWER');
});
it('isolates changed interaction identities and freezes input before asynchronous persistence', async () => {
    const f = fixture(), draft = content('Original'), input = {scope: {...scope}, expectedRevision: null, editId: 'snapshot', content: draft};
    const saving = f.store().write(input); input.scope.branchId = 'other'; draft.values.answer = 'Changed'; await saving;
    expect((await f.store().read(scope))?.content).toEqual(content('Original'));
    for (const change of [{requestedAt: 2}, {callId: 'other'}, {executionSessionId: 'other'}, {targetTaskId: 'other'}])
        expect(await f.store().read({...scope, ...change})).toBeUndefined();
});
it('bounds CAS retries without falling back to an unconditional update', async () => {
    const f = fixture(); f.repository.compareAndSetUIState.mockRejectedValue(Object.assign(new Error('Changed'), {code: 'SESSION_UI_STATE_CONFLICT'}));
    await expect(f.store().write({scope, expectedRevision: null, editId: 'busy', content: content('Local')})).rejects.toMatchObject({code: 'INTERACTION_DRAFT_SAVE_CONFLICT'});
    expect(f.repository.compareAndSetUIState).toHaveBeenCalledTimes(8);
});

it('rejects malformed drafts before touching storage and reports only safe diagnostics', async () => {
    const f = fixture(), valid = {scope, expectedRevision: null, editId: 'edit', content: content('PRIVATE')};
    for (const invalid of [{...valid, expectedRevision: -1}, {...valid, editId: ''},
        {...valid, content: {format: 'text', values: {answer: new Array(2)}}},
        {...valid, scope: {...scope, requestedAt: NaN}}])
        await expect(f.store().write(invalid as never)).rejects.toHaveProperty('code');
    await expect(f.store().read({...scope, unexpected: () => 'PRIVATE'} as never)).rejects.toThrow();
    expect(f.repository.getManifest).not.toHaveBeenCalled();
    expect(f.repository.compareAndSetUIState).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('PRIVATE');
});
it('refuses corrupt persisted records and unavailable conditional storage', async () => {
    const f = fixture();
    await f.store().write({scope, expectedRevision: null, editId: 'first', content: content('Original')});
    const records = f.state().interactionDrafts!;
    records[Object.keys(records)[0]] = {revision: 0, editId: 'broken', content: null};
    await expect(f.store().read(scope)).rejects.toMatchObject({code: 'INTERACTION_DRAFT_RECORD_INVALID'});
    const store = new InteractionDraftPersistence({getManifest: f.repository.getManifest} as never);
    await expect(store.write({scope, expectedRevision: null, editId: 'next', content: null})).rejects.toMatchObject({code: 'INTERACTION_DRAFT_STORE_UNAVAILABLE'});
});
it('preserves unchecked custom-choice text and rejects malformed editor snapshots', async () => {
    const f = fixture(), editor = {fields: {choice: {selected: ['a'], other: {selected: false, value: 'Local custom text'}}}, note: 'Note'};
    await f.store().write({scope, expectedRevision: null, editId: 'editor', content: {format: 'text', values: {}, editor}});
    expect((await f.store().read(scope))?.content).toMatchObject({editor});
    await expect(f.store().write({scope, expectedRevision: 1, editId: 'bad', content: {format: 'text', values: {}, editor: {fields: {choice: {selected: new Array(1)}}}}})).rejects.toMatchObject({code: 'INTERACTION_DRAFT_INVALID'});
});
