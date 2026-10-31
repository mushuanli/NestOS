// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {ChatDraftEditor} from '../../llm-ui-adapter/src/shell/drafts/ChatDraftEditor';
import type {ConversationModelCatalog} from '@itookit/ui-common';
import {getLogger} from '@itookit/common';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); document.body.replaceChildren(); vi.unstubAllGlobals();});
async function fixture() {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const host = document.createElement('div'); document.body.append(host);
    const catalog = (label: string): ConversationModelCatalog => ({models: [
        {id: 'shared', label, reasoningEfforts: [{id: 'low', label: 'Low'}, {id: 'high', label: 'High'}], defaultReasoningEffort: 'low'},
        {id: 'other', label: 'Other', reasoningEfforts: [{id: 'medium', label: 'Medium'}], defaultReasoningEffort: 'medium'}],
        default: {modelId: 'shared', reasoningEffort: 'low'}});
    const models = vi.fn(async (id: string) => catalog(id)), save = vi.fn(async (_value: string) => {}), materialize = vi.fn();
    const editor = new ChatDraftEditor(host, {onChange: () => () => {}} as never,
        {sessionDraft: {id: 'draft', executorScope: 'remote', materialize, save},
            remoteAgents: {list: async () => [{id: 'remote:a', name: 'A'}, {id: 'remote:b', name: 'B'}], models, send: vi.fn()}}, vi.fn(), {});
    cleanup.push(() => editor.destroy()); await editor.init(host);
    const select = (id: string) => host.querySelector<HTMLSelectElement>(`[data-selector-id="${id}"]`)!;
    const choose = (id: string, value: string) => {const node = select(id); node.value = value; node.dispatchEvent(new Event('change'));};
    return {editor, select, choose, models, save, materialize};
}

it('opens a remote draft with model and effort choices and preserves the draft when models change', async () => {
    const f = await fixture(); f.editor.setText('Keep this draft');
    expect(f.select('executorId').value).toBe('remote:a'); expect(f.select('modelId').value).toBe('shared');
    f.choose('reasoningEffort', 'high'); f.choose('modelId', 'other');
    expect(f.select('reasoningEffort').value).toBe('medium'); expect(f.editor.getText()).toBe('Keep this draft');
    await f.editor.flushPendingSave();
    expect(JSON.parse(f.save.mock.calls.at(-1)![0]).config.settings.nativeModelSelection).toMatchObject({modelId: 'other', reasoningEffort: 'medium'});
    expect(f.materialize).not.toHaveBeenCalled();
});

it('resets model preferences when switching remote executors, including cached catalogs with identical model ids', async () => {
    const f = await fixture(); f.editor.setText('Preserved'); f.choose('reasoningEffort', 'high');
    f.choose('executorId', 'remote:b');
    await vi.waitFor(() => expect(f.select('modelId')?.selectedOptions[0].textContent).toBe('remote:b'));
    expect(f.select('reasoningEffort').value).toBe('low');
    f.choose('reasoningEffort', 'high'); f.choose('executorId', 'remote:a');
    await vi.waitFor(() => expect(f.select('modelId')?.selectedOptions[0].textContent).toBe('remote:a'));
    expect(f.select('reasoningEffort').value).toBe('low'); expect(f.models).toHaveBeenCalledTimes(2);
    expect(f.editor.getText()).toBe('Preserved'); expect(f.materialize).not.toHaveBeenCalled();
});

it('keeps input and reports model catalog failures without leaking prompt or exception text into diagnostics', async () => {
    const f = await fixture(), error = new Error('Model catalog unavailable: sensitive-detail'), report = vi.fn();
    f.editor.on('error', report); f.editor.setText('Private draft content'); f.choose('reasoningEffort', 'high');
    await f.editor.flushPendingSave(); f.models.mockRejectedValueOnce(error); getLogger().clear();
    f.choose('executorId', 'remote:b'); await vi.waitFor(() => expect(report).toHaveBeenCalledWith(error));
    expect(f.editor.getText()).toBe('Private draft content'); expect(f.select('modelId')).toBeNull();
    await f.editor.flushPendingSave();
    expect(JSON.parse(f.save.mock.calls.at(-1)![0]).config.settings.nativeModelSelection).toBeUndefined();
    const entries = getLogger().query({modules: ['chat-draft-editor']});
    expect(entries).toContainEqual(expect.objectContaining({message: 'chat.draft.models', data: expect.objectContaining({
        operationId: expect.any(String), stage: 'catalog', result: 'failure', code: 'DRAFT_MODELS_READ_FAILED', durationMs: expect.any(Number)})}));
    expect(JSON.stringify(entries)).not.toMatch(/Private draft content|sensitive-detail/); expect(f.materialize).not.toHaveBeenCalled();
});
