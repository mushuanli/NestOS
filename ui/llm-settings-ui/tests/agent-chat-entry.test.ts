// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { AgentConfigEditor } from '../src/editors/AgentConfigEditor';
import type { EditorOptions } from '@itookit/ui-common';
import {getLogger} from '@itookit/common';

const editors: AgentConfigEditor[] = [];
afterEach(async () => {
    for (const editor of editors.splice(0)) await editor.destroy();
    document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); getLogger().clear();
});

async function setup(extra: Partial<EditorOptions> = {}) {
    const root = document.createElement('div'); document.body.append(root);
    const save = vi.fn(async (_id: string, _content: string) => {}), start = vi.fn(async () => {});
    const service = {listSystemPrompts: async () => [], getMCPServers: async () => [], getSkills: async () => []};
    const options = {target: {kind: 'entity', entityType: 'agent', id: 'a'}, hostContext: {saveContent: save},
        onStartConversation: start, ...extra} as EditorOptions;
    const editor = new AgentConfigEditor(root, options, service as never); editors.push(editor);
    await editor.init(root, JSON.stringify({id: 'a', name: 'Agent', config: {systemPrompt: 'Original instructions'}}));
    return {root, editor, save, start, button: root.querySelector<HTMLButtonElement>('[data-agent-start-chat]')!};
}

function editPrompt(root: HTMLElement, value: string): HTMLTextAreaElement {
    root.querySelector<HTMLButtonElement>('[data-agent-page-link="behavior"]')!.click();
    const prompt = root.querySelector<HTMLTextAreaElement>('[name="systemPrompt"]')!;
    prompt.value = value; prompt.dispatchEvent(new Event('input', {bubbles: true})); return prompt;
}

it('flushes host preferences and the edited configuration before opening chat without replacing the configuration', async () => {
    const order: string[] = [];
    const f = await setup({mountSettings: async () => ({flush: async () => {order.push('settings');}, destroy: async () => {}, isDirty: () => false})});
    const prompt = editPrompt(f.root, 'Updated instructions');
    f.save.mockImplementation(async () => {order.push('agent');}); f.start.mockImplementation(async () => {order.push('chat');});
    f.button.click(); await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    expect(order).toEqual(['settings', 'agent', 'chat']);
    expect(JSON.parse(f.save.mock.calls[0]![1]).config.systemPrompt).toBe('Updated instructions');
    expect(f.root.querySelector('[name="systemPrompt"]')).toBe(prompt); expect(f.editor.isDirty()).toBe(false);
});

it('keeps a failed save and its concrete reason visible, logs safe metadata, and permits retry', async () => {
    const f = await setup();
    const prompt = editPrompt(f.root, 'Private prompt body'); f.save.mockRejectedValueOnce(new Error('Storage is read-only'));
    f.button.click();
    await vi.waitFor(() => expect(f.root.querySelector('[data-agent-chat-status]')?.textContent).toContain('Storage is read-only'));
    expect(f.start).not.toHaveBeenCalled(); expect(f.editor.isDirty()).toBe(true);
    expect(f.root.querySelector('[name="systemPrompt"]')).toBe(prompt); expect(prompt.value).toBe('Private prompt body');
    const logs = getLogger().query({modules: ['agent-settings']});
    expect(logs).toContainEqual(expect.objectContaining({message: 'agent.chat.open', data: expect.objectContaining({
        operationId: expect.any(String), stage: 'save', result: 'failure', code: 'AGENT_CHAT_SAVE_FAILED', durationMs: expect.any(Number)})}));
    expect(JSON.stringify(logs)).not.toContain('Storage is read-only');
    expect(JSON.stringify(logs)).not.toContain('Private prompt body');
    f.button.click(); await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    expect(f.root.querySelector<HTMLElement>('[data-agent-chat-status]')!.hidden).toBe(true);
});

it('opens chat from a read-only configuration and restores its action after a host error', async () => {
    const f = await setup({readOnly: true});
    f.start.mockRejectedValueOnce(new Error('The selected project is unavailable'));
    expect(f.root.querySelector<HTMLInputElement>('[name="name"]')!.disabled).toBe(true); expect(f.button.disabled).toBe(false);
    f.button.click();
    await vi.waitFor(() => expect(f.button.disabled).toBe(false));
    expect(f.root.querySelector('[data-agent-chat-status]')!.textContent).toBe('The selected project is unavailable');
    expect(f.save).not.toHaveBeenCalled(); expect(JSON.stringify(getLogger().query({modules: ['agent-settings']}))).not.toContain('selected project');
    f.button.click(); await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
});

it('deduplicates clicks and cancels an unsubmitted launch when its editor is destroyed', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const flush = vi.fn(async () => {await pending;});
    const f = await setup({mountSettings: async () => ({flush, destroy: async () => {}, isDirty: () => false})});
    f.button.click(); f.button.click(); expect(flush).toHaveBeenCalledOnce(); expect(f.button.disabled).toBe(true);
    const destroying = f.editor.destroy(); release(); await destroying;
    editors.splice(editors.indexOf(f.editor), 1);
    expect(f.start).not.toHaveBeenCalled(); expect(f.root.children).toHaveLength(0);
});

it('moves the same identity fields and action to the mobile navigation and releases the host mount', async () => {
    const media = {matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()};
    vi.stubGlobal('matchMedia', () => media);
    const cleanup = vi.fn(), navigation = vi.fn((slot: HTMLElement) => {slot.append(document.createElement('nav')); return cleanup;});
    const f = await setup({mountCompactNavigation: navigation});
    const identity = f.root.querySelector<HTMLElement>('[data-agent-identity]')!, name = f.root.querySelector('[name="name"]');
    expect(f.root.dataset.editorMobileNavigation).toBe('embedded'); expect(identity.parentElement?.className).toBe('agent-header');
    media.matches = true; media.addEventListener.mock.calls[0]![1]();
    expect(identity.parentElement?.hasAttribute('data-agent-identity-slot')).toBe(true);
    expect(f.button.parentElement?.hasAttribute('data-agent-compact-actions')).toBe(true);
    expect(f.root.querySelector('[name="name"]')).toBe(name); expect(f.root.querySelectorAll('[name="name"]')).toHaveLength(1);
    expect(f.root.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
    expect(f.save).not.toHaveBeenCalled();
    media.matches = false; media.addEventListener.mock.calls[0]![1]();
    expect(identity.parentElement?.className).toBe('agent-header');
    await f.editor.destroy(); editors.splice(editors.indexOf(f.editor), 1);
    expect(cleanup).toHaveBeenCalledOnce(); expect(media.removeEventListener).toHaveBeenCalledOnce();
    expect(f.root.hasAttribute('data-editor-mobile-navigation')).toBe(false);
});
