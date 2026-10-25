import {expect, it, vi} from 'vitest';
import type {ConversationUIState, ISessionRepository} from '@itookit/llm-session/contracts';
import {StateService} from './StateService';

const target = {kind: 'agent' as const, id: 'worker', version: '1', digest: 'published'};
const context = () => ({revision: 1, sessionId: 'session', branchId: 'main', target, selection: {
    mode: 'fork' as const, sourceBindingId: 'binding', expectedBindingRevision: 2, expectedGeneration: 1, checkpointRef: 'checkpoint-A'}});
function fixture() {
    let state: ConversationUIState = {}; let revision = 0;
    const engine = {getManifest: async () => ({revision, uiState: structuredClone(state)}), compareAndSetUIState: async (_id: string, expected: number, patch: ConversationUIState) => {
        if (expected !== revision) throw Object.assign(new Error('Changed'), {code: 'SESSION_UI_STATE_CONFLICT'});
        state = {...state, ...structuredClone(patch), branchDrafts: {...state.branchDrafts, ...structuredClone(patch.branchDrafts)}}; revision++;
    }, getUIState: async () => structuredClone(state), updateUIState: vi.fn(async (_id, patch) => {
        state = {...state, ...structuredClone(patch), branchDrafts: {...state.branchDrafts, ...structuredClone(patch.branchDrafts)}};
    })};
    const service = new StateService(engine as unknown as ISessionRepository); service.observeDraft('session', 'main', {}); service.observeDraft('session', 'review', {});
    return {service, engine, state: () => state};
}

it('persists branch-scoped context and returns independent copies without selecting a newer checkpoint', async () => {
    const f = fixture(), selected = context();
    await f.service.saveUIState('session', {collapse_states: {}, input_text: 'Main', input_context: selected}, 'main');
    await f.service.saveUIState('session', {collapse_states: {}, input_text: 'Review', input_context: {...context(), branchId: 'review'}}, 'review');
    selected.selection.checkpointRef = 'checkpoint-B';
    const main = await f.service.loadUIState('session', 'main'), review = await f.service.loadUIState('session', 'review');
    expect(main?.input_context).toMatchObject({branchId: 'main', selection: {checkpointRef: 'checkpoint-A'}});
    expect(review?.input_context?.branchId).toBe('review');
    (main!.input_context!.selection as {checkpointRef: string}).checkpointRef = 'changed';
    expect((await f.service.loadUIState('session', 'main'))?.input_context?.selection).toMatchObject({checkpointRef: 'checkpoint-A'});
});

it('clears only the saved branch selection when the composer explicitly consumes it', async () => {
    const f = fixture();
    await f.service.saveUIState('session', {collapse_states: {}, input_text: 'Main', input_context: context()}, 'main');
    await f.service.saveUIState('session', {collapse_states: {}, input_text: 'Review', input_context: {...context(), branchId: 'review'}}, 'review');
    await f.service.saveUIState('session', {collapse_states: {}, input_text: '', input_context: undefined}, 'main');
    expect(f.state().branchDrafts?.main.inputContext).toBeUndefined();
    expect(f.state().branchDrafts?.review.inputContext).toMatchObject({branchId: 'review'});
});

it('reports corrupt persisted context instead of returning an empty draft', async () => {
    const f = fixture();
    await f.engine.updateUIState('session', {branchDrafts: {main: {inputText: 'Keep', inputContext: {...context(), selection: {mode: 'continue'}}}}});
    await expect(f.service.loadUIState('session', 'main')).rejects.toMatchObject({code: 'CONTEXT_DRAFT_INVALID'});
    expect(f.state().branchDrafts?.main.inputText).toBe('Keep');
});
