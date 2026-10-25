import {expect, it, vi} from 'vitest';
import {InteractionDraftEditor} from './InteractionDraftEditor';
import type {InteractionDraftScope, InteractionDraftStorage, InteractionDraftRecord} from '../domain/interaction-draft';
const scope: InteractionDraftScope = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'root', targetTaskId: 'worker', interactionId: 'ask', requestedAt: 1};
const content = (text: string) => ({format: 'text' as const, values: {}, editor: {fields: {answer: {value: text}}}});
function fixture() {
    let record: InteractionDraftRecord | undefined;
    const storage: InteractionDraftStorage = {read: vi.fn(async () => structuredClone(record)), write: vi.fn(async change => {
        if (record?.editId === change.editId) return structuredClone(record);
        if ((record?.revision ?? null) !== change.expectedRevision) throw new Error('CONFLICT');
        record = {revision: (change.expectedRevision ?? 0) + 1, editId: change.editId, content: structuredClone(change.content)};
        return structuredClone(record);
    })};
    return {storage, get: () => record};
}
it('serializes edits, freezes caller values, and restores the final saved editor state', async () => {
    const f = fixture(), editor = await InteractionDraftEditor.open(f.storage, scope, vi.fn()), value = content('First');
    editor.save(value); value.editor.fields.answer.value = 'Mutated'; await editor.flush();
    expect(f.get()?.content).toEqual(content('First'));
    editor.save(content('Second')); editor.save(content('Third')); await editor.flush();
    expect((await InteractionDraftEditor.open(f.storage, scope, vi.fn())).content).toEqual(content('Third'));
});
it('keeps an unknown proposal and retries its original identity before saving later edits', async () => {
    const f = fixture(), original = f.storage.write; let attempts = 0;
    f.storage.write = vi.fn(async change => {const result = await original(change); if (++attempts === 1) throw new Error('LOST'); return result;});
    const editor = await InteractionDraftEditor.open(f.storage, scope, vi.fn());
    editor.save(content('First')); await expect(editor.flush()).rejects.toThrow('LOST');
    editor.save(content('Later')); await expect(editor.flush()).rejects.toThrow('LOST'); expect(attempts).toBe(1);
    await editor.retry(); expect(f.get()?.content).toEqual(content('Later'));
    const calls = vi.mocked(f.storage.write).mock.calls;
    expect(calls[0][0]).toEqual(calls[1][0]); expect(calls[2][0].editId).not.toBe(calls[0][0].editId);
});
it('does not clear edits made by another view after the submitted revision', async () => {
    const f = fixture(), first = await InteractionDraftEditor.open(f.storage, scope, vi.fn()); first.save(content('Submitted'));
    const submitted = await first.flush(), other = await InteractionDraftEditor.open(f.storage, scope, vi.fn());
    other.save(content('Other page')); await other.flush();
    await expect(first.clear(submitted)).rejects.toThrow('CONFLICT'); expect(f.get()?.content).toEqual(content('Other page'));
});
it('clears only its captured draft and retains a revision tombstone', async () => {
    const f = fixture(), editor = await InteractionDraftEditor.open(f.storage, scope, vi.fn()); editor.save(content('Submitted'));
    const submitted = await editor.flush(); await editor.clear(submitted);
    expect(f.get()).toMatchObject({revision: 2, content: null});
    editor.save(content('New')); await editor.flush(); await editor.clear(submitted);
    expect(f.get()?.content).toEqual(content('New'));
});
it('retries an uncertain clear with its original identity without reviving the submitted text', async () => {
    const f = fixture(), editor = await InteractionDraftEditor.open(f.storage, scope, vi.fn()); editor.save(content('Submitted'));
    const submitted = await editor.flush(), original = f.storage.write; let calls = 0;
    f.storage.write = vi.fn(async change => {const record = await original(change); if (++calls === 1) throw new Error('LOST CLEAR'); return record;});
    await expect(editor.clear(submitted)).rejects.toThrow('LOST CLEAR'); await editor.retry();
    expect(f.get()?.content).toBeNull(); expect(vi.mocked(f.storage.write).mock.calls[0][0]).toEqual(vi.mocked(f.storage.write).mock.calls[1][0]);
});
it('does not turn a diagnostic callback failure into an uncertain write', async () => {
    const f = fixture(), editor = await InteractionDraftEditor.open(f.storage, scope, () => {throw new Error('Observer');});
    editor.save(content('Saved')); await expect(editor.flush()).resolves.toMatchObject({content: content('Saved')});
});
