import {expect, it, vi} from 'vitest';
import {StateService} from './StateService';
import type {ConversationUIState, ISessionRepository} from '@itookit/llm-session/contracts';
import {randomUUID} from '@itookit/common';
const diagnostics = vi.hoisted(() => ({debug: vi.fn(), warn: vi.fn()}));
vi.mock('@itookit/common', async original => {
    const actual = await original<typeof import('@itookit/common')>();
    return {...actual, createModuleLogger: (name: string) => ['workspace-draft-store', 'workspace-state'].includes(name) ? diagnostics : actual.createModuleLogger(name)};
});
const input = (text: string) => ({collapse_states: {}, input_text: text, input_token: randomUUID(), input_files: []});
function fixture() {
    let state: ConversationUIState = {}, revision = 0;
    const engine = {getUIState: vi.fn(async () => structuredClone(state)), getManifest: vi.fn(async () => ({revision, uiState: structuredClone(state)})),
        compareAndSetUIState: vi.fn(async (_id: string, expected: number, patch: ConversationUIState) => {
            if (expected !== revision) throw Object.assign(new Error('Changed'), {code: 'SESSION_UI_STATE_CONFLICT'});
            state = {...state, ...structuredClone(patch), branchDrafts: {...state.branchDrafts, ...structuredClone(patch.branchDrafts)}}; revision++;
        }), updateUIState: vi.fn(async (_id: string, patch: ConversationUIState) => {state = {...state, ...patch}; revision++;})};
    const service = () => new StateService(engine as unknown as ISessionRepository);
    return {engine, service, state: () => state};
}
it('rejects a stale same-branch save and preserves both the saved draft and the caller input', async () => {
    const f = fixture(), a = f.service(), b = f.service(); await Promise.all([a.loadUIState('session'), b.loadUIState('session')]);
    const saved = input('Saved A'), local = input('Local B'); await a.saveUIState('session', saved);
    await expect(b.saveUIState('session', local)).rejects.toMatchObject({code: 'SESSION_DRAFT_CONFLICT'});
    expect(f.state().branchDrafts!.main.inputText).toBe('Saved A'); expect(local.input_text).toBe('Local B');
    expect(b.getDraftConflict('session', 'main')?.saved?.inputText).toBe('Saved A');
    expect(f.engine.updateUIState).not.toHaveBeenCalled();
});
it('merges writes to independent branches after a rejected global revision condition', async () => {
    const f = fixture(), a = f.service(), b = f.service(); await a.loadUIState('session'); await b.loadUIState('session', 'review');
    await Promise.all([a.saveUIState('session', input('Main')), b.saveUIState('session', input('Review'), 'review')]);
    expect(f.state().branchDrafts!.main.inputText).toBe('Main'); expect(f.state().branchDrafts!.review.inputText).toBe('Review');
    expect(f.engine.compareAndSetUIState.mock.calls.length).toBeGreaterThan(2);
});
it('verifies a committed draft write with a lost reply instead of acknowledging an uncommitted failure', async () => {
    const f = fixture(), a = f.service(); await a.loadUIState('session'); const original = f.engine.compareAndSetUIState.getMockImplementation()!;
    f.engine.compareAndSetUIState.mockImplementationOnce(async (...args) => {await original(...args); throw new Error('Reply lost');});
    const value = input('Committed'); await a.saveUIState('session', value); expect(f.state().branchDrafts!.main.inputText).toBe('Committed');
    expect(f.engine.compareAndSetUIState).toHaveBeenCalledOnce();
    const failure = Object.assign(new Error('Unavailable'), {code: 'EIO'}); f.engine.compareAndSetUIState.mockRejectedValueOnce(failure);
    await expect(a.saveUIState('session', input('Not committed'))).rejects.toBe(failure);
    expect(f.state().branchDrafts!.main.inputText).toBe('Committed');
});
it('requires a second explicit replacement when the saved draft advances after a conflict was shown', async () => {
    const f = fixture(), a = f.service(), b = f.service(); await a.loadUIState('session'); await b.loadUIState('session');
    await a.saveUIState('session', input('A')); const local = input('B'); await expect(b.saveUIState('session', local)).rejects.toHaveProperty('code', 'SESSION_DRAFT_CONFLICT');
    const previous = b.getDraftConflict('session', 'main')!; await a.saveUIState('session', input('A newer'));
    await expect(b.saveUIState('session', local, 'main', previous.id)).rejects.toHaveProperty('code', 'SESSION_DRAFT_CONFLICT');
    expect(f.state().branchDrafts!.main.inputText).toBe('A newer');
    await expect(b.saveUIState('session', local, 'main', previous.id)).rejects.toHaveProperty('code', 'DRAFT_RESOLUTION_CHANGED');
    const current = b.getDraftConflict('session', 'main')!; await b.saveUIState('session', local, 'main', current.id);
    expect(f.state().branchDrafts!.main.inputText).toBe('B'); expect(b.getDraftConflict('session', 'main')).toBeUndefined();
});
it('keeps layout-only writes separate and requires an observed baseline before saving input', async () => {
    const f = fixture(), a = f.service(), b = f.service(); await a.loadUIState('session'); await a.saveUIState('session', input('Keep'));
    await b.saveUIState('session', {collapse_states: {message: true}});
    expect(f.state().branchDrafts!.main.inputText).toBe('Keep');
    await expect(b.saveUIState('session', input('Unobserved'))).rejects.toHaveProperty('code', 'DRAFT_BASELINE_UNAVAILABLE');
});
it('does not turn a failed read into a writable empty baseline', async () => {
    const f = fixture(), a = f.service(), failure = Object.assign(new Error('Unavailable'), {code: 'EIO'});
    f.engine.getUIState.mockRejectedValueOnce(failure);
    await expect(a.loadUIState('session')).rejects.toBe(failure);
    await expect(a.saveUIState('session', input('Keep'))).rejects.toHaveProperty('code', 'DRAFT_BASELINE_UNAVAILABLE');
    expect(f.engine.compareAndSetUIState).not.toHaveBeenCalled();
});

it('rejects malformed branch envelopes and emits metadata rather than draft bodies or raw errors', async () => {
    const f = fixture(), a = f.service();
    f.engine.getUIState.mockResolvedValueOnce({branchDrafts: {main: 'invalid' as never}});
    await expect(a.loadUIState('session')).rejects.toHaveProperty('code', 'DRAFT_BASELINE_INVALID');
    await a.loadUIState('session'); const failure = Object.assign(new Error('PRIVATE_ERROR'), {code: 'EIO'});
    f.engine.compareAndSetUIState.mockRejectedValueOnce(failure);
    diagnostics.warn.mockClear(); diagnostics.warn.mockImplementationOnce(() => {throw new Error('Sink failed');});
    await expect(a.saveUIState('session', input('PRIVATE_BODY'))).rejects.toBe(failure);
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('PRIVATE_');
    expect(diagnostics.warn.mock.calls.some(([, data]) => data.operationId && data.code === 'EIO' && data.result === 'failure')).toBe(true);
});
