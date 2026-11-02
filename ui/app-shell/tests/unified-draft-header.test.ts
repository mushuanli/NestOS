// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {ChatDraftEditor} from '../../llm-ui-adapter/src/shell/drafts/ChatDraftEditor';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0)) await cleanup(); document.body.replaceChildren(); vi.unstubAllGlobals();});
async function fixture(options: {getConnections?: () => Promise<never[]>; configuration?: ConstructorParameters<typeof ChatDraftEditor>[4]['configuration']} = {}) {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const host = document.createElement('div'); document.body.append(host);
    const save = vi.fn(async (_data: string) => {}), move = vi.fn(async (_id: string) => {}), materialize = vi.fn(), titleChanged = vi.fn();
    const editor = new ChatDraftEditor(host, {onChange: () => () => {}, listAgents: () => [{id: 'writer', name: 'Writer', config: {}}],
        getSystemPrompt: async () => null, getConnections: options.getConnections ?? (async () => []), getDefaultConnection: async () => null, getProvider: () => undefined} as never,
    {sessionDraft: {id: 'draft-id', save, materialize, presentation: {titleChanged}, scope: {id: 'a', label: 'Project A', move,
        choices: async () => [{id: 'a', label: 'Project A'}, {id: 'b', label: 'Project B'}], select: vi.fn()}}}, vi.fn(), {configuration: options.configuration});
    cleanups.push(() => editor.destroy()); await editor.init(host);
    const title = () => host.querySelector<HTMLInputElement>('.llm-draft-header__title')!;
    const project = () => host.querySelector<HTMLSelectElement>('.llm-draft-header__project')!;
    return {editor, host, save, move, materialize, titleChanged, title, project};
}
it('persists an editable title and flushes the entire draft before switching projects', async () => {
    const f = await fixture(); f.editor.setText('Keep body'); f.title().value = 'My title'; f.title().dispatchEvent(new Event('input'));
    f.project().value = 'b'; f.project().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.move).toHaveBeenCalledWith('b'));
    const saved = JSON.parse(f.save.mock.calls.at(-1)![0]);
    expect(saved.chatDraft.selection.draftTitle).toBe('My title'); expect(saved.chatDraft.text).toBe('Keep body');
    expect(f.titleChanged).toHaveBeenCalledWith('My title'); expect(f.materialize).not.toHaveBeenCalled();
});
it('retains title and body and restores the project field after a rejected move', async () => {
    const f = await fixture(); f.move.mockRejectedValueOnce(Object.assign(new Error('Destination occupied'), {code: 'EBUSY'}));
    f.editor.setText('Keep body'); f.title().value = 'Keep title'; f.title().dispatchEvent(new Event('input'));
    f.project().value = 'b'; f.project().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.project().value).toBe('a'));
    expect(f.title().value).toBe('Keep title'); expect(f.editor.getText()).toBe('Keep body'); expect(f.project().disabled).toBe(false);
});
it('uses the draft title for materialization and locks title and project while submission starts', async () => {
    const f = await fixture(); let reject!: (reason: unknown) => void;
    f.materialize.mockImplementation(() => new Promise((_resolve, no) => {reject = no;}));
    f.title().value = 'Formal title'; f.title().dispatchEvent(new Event('input'));
    const sending = f.editor.commands.sendMessage({text: 'Send body'});
    await vi.waitFor(() => expect(f.materialize).toHaveBeenCalledWith(expect.objectContaining({title: 'Formal title'})));
    expect(f.title().disabled).toBe(true); expect(f.project().disabled).toBe(true);
    reject(new Error('Stop before handoff')); await sending;
    expect(f.title().value).toBe('Formal title'); expect(f.editor.getText()).toBe('Send body');
});
it('shows the configuration stage during a slow draft open and removes it when the composer is ready', async () => {
    let ready!: (value: never[]) => void;
    const connections = new Promise<never[]>(resolve => {ready = resolve;});
    const opening = fixture({getConnections: () => connections});
    await vi.waitFor(() => expect(document.querySelector('.llm-draft-loading')?.textContent).toContain('执行器'));
    expect(document.querySelector('.llm-draft-loading')?.getAttribute('role')).toBe('status');
    ready([]); const f = await opening;
    expect(f.host.querySelector('.llm-draft-loading')).toBeNull(); expect(f.host.querySelector('.llm-chat__input')).not.toBeNull();
});
it('keeps a concrete failure visible if restoring model configuration fails before the composer mounts', async () => {
    await expect(fixture({getConnections: async () => {throw Object.assign(new Error('Model settings unavailable'), {code: 'EIO'});}}))
        .rejects.toThrow('Model settings unavailable');
    const notice = document.querySelector('.llm-draft-loading');
    expect(notice?.getAttribute('role')).toBe('alert'); expect(notice?.textContent).toContain('Model settings unavailable');
});
it('uses the already prepared configuration instead of issuing redundant connection reads', async () => {
    const getConnections = vi.fn(async () => {throw new TypeError('Load failed');});
    const f = await fixture({getConnections, configuration: {getConfigurationSnapshot: () => ({agents: [{id: 'writer', name: 'Writer', config: {}}],
        promptPresets: {}, connections: [], providers: []}), subscribe: () => () => {}, dispose: async () => {}}});
    expect(getConnections).not.toHaveBeenCalled(); expect(f.host.querySelector('.llm-chat__input')).not.toBeNull();
});
