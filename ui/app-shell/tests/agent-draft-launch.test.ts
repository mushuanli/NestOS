// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { SessionDraftEditor } from '../../llm-ui-adapter/src/shell/drafts/SessionDraftEditor';

it('selects the launch agent in an existing draft without replacing text, attachments or creating a session', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const save = vi.fn(async (_data: string) => {}), put = vi.fn(), materialize = vi.fn();
    const agents = [{id: 'default', name: 'Default', config: {}}, {id: 'writer', name: 'Writer', config: {}}];
    const service = {listAgents: () => agents, onChange: () => () => {}, getConnections: async () => [],
        getDefaultConnection: async () => null, getProvider: () => undefined};
    const input = {version: 2, config: {text: '保留现有正文', agentId: 'default', settings: {}},
        files: [{id: 'attachment-1', name: 'draft.txt', type: 'text/plain', lastModified: 1}]};
    const host = document.createElement('div'); document.body.append(host);
    const editor = new SessionDraftEditor(host, service as never, {sessionDraft: {initialData: JSON.stringify(input), save, materialize,
        attachments: {put, read: async () => new TextEncoder().encode('keep attachment').buffer}}});
    try {
        await editor.init(host); await editor.commands.selectDraftAgent('writer');
        const saved = JSON.parse(save.mock.calls.at(-1)![0]);
        expect(saved.config).toMatchObject({text: input.config.text, agentId: 'writer'});
        expect(saved.files).toMatchObject(input.files); expect(saved.files[0]).toMatchObject({bytes: 15, sha256: expect.stringMatching(/^[a-f0-9]{64}$/)}); expect(put).not.toHaveBeenCalled(); expect(materialize).not.toHaveBeenCalled();
        await expect(editor.commands.selectDraftAgent('missing')).rejects.toThrow();
        expect(JSON.parse(save.mock.calls.at(-1)![0]).config.agentId).toBe('writer');
    } finally {await editor.destroy(); document.body.replaceChildren(); vi.unstubAllGlobals();}
});

it('places project selection before the mode picker and restricts remote drafts to remote harnesses', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const host = document.createElement('div'); document.body.append(host);
    const service = {listAgents: () => [{id: 'writer', name: 'Writer', config: {}}], onChange: () => () => {},
        getConnections: async () => [], getDefaultConnection: async () => null, getProvider: () => undefined};
    const editor = new SessionDraftEditor(host, service as never, {sessionDraft: {executorScope: 'remote', materialize: vi.fn(),
        scope: {id: 'remote-project', label: 'Remote project', choices: async () => [{id: 'remote-project', label: 'Remote project'}], select: vi.fn()}},
        remoteAgents: {list: async () => [{id: 'remote:codex', name: 'Codex'}], send: vi.fn()}} as never);
    try {
        await editor.init(host);
        const mode = host.querySelector<HTMLElement>('.llm-input__execution-picker')!;
        expect(mode.previousElementSibling?.className).toBe('llm-draft-scope'); expect(mode.hidden).toBe(true);
        expect(host.querySelector('.llm-input__agent-trigger')?.textContent).toContain('Codex');
        await expect(editor.commands.selectDraftAgent('writer')).rejects.toThrow();
        await editor.commands.selectDraftAgent('remote:codex');
    } finally {await editor.destroy(); document.body.replaceChildren(); vi.unstubAllGlobals();}
});

it('disables sending a remote project draft when no creating harness is available', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const host = document.createElement('div'); document.body.append(host);
    const service = {onChange: () => () => {}, getConnections: async () => [], getDefaultConnection: async () => null, getProvider: () => undefined};
    const materialize = vi.fn(), send = vi.fn();
    const editor = new SessionDraftEditor(host, service as never, {sessionDraft: {executorScope: 'remote', materialize}, remoteAgents: {list: async () => [], send}});
    try {
        await editor.init(host); editor.setText('Keep this draft');
        expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(true);
        expect(host.textContent).toContain('远程'); expect(materialize).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    } finally {await editor.destroy(); document.body.replaceChildren(); vi.unstubAllGlobals();}
});
