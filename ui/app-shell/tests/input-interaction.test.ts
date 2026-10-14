// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../../llm-ui/src/components/input/ChatInputView';
import type { ChatInputInteraction } from '../../llm-ui/src/domain/ports/IChatInputPresenter';
import { LLMWorkspaceEditor } from '../../llm-ui/src/shell/LLMWorkspaceEditor';

const approval: ChatInputInteraction = {
    key: '1:approval', id: 'approval', kind: 'approval', prompt: 'Approve <script>bad()</script>?',
    details: 'printf "APPROVAL_TEST_OK\\n"',
};
let input: ChatInput;
afterEach(() => { input?.destroy(); document.body.replaceChildren(); });

function setup() {
    const container = document.createElement('div'); document.body.append(container);
    const onSend = vi.fn(async () => {});
    input = new ChatInput(container, { onSend, onStop: vi.fn() });
    return { container, onSend };
}
function note(): HTMLTextAreaElement { return document.querySelector('.llm-input__interaction-input')!; }
function click(action: string): void { document.querySelector<HTMLButtonElement>(`[data-interaction-action="${action}"]`)!.click(); }
function panel(): Element | null { return document.querySelector('.llm-input__interaction'); }

it.each([true, false])('keeps a fixed confirmation with a separate draft and sends approved=%s', async approved => {
    const { container, onSend } = setup();
    input.setConfig({ text: 'unfinished chat draft' }); input.setLoading(true);
    const respond = vi.fn(async () => {});
    input.showInteraction(approval, respond);
    expect(panel()?.parentElement).toBe(container.querySelector('.llm-input__main'));
    expect(panel()?.querySelector('script')).toBeNull();
    expect(note().disabled).toBe(false);
    note().value = 'reviewed';
    note().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(respond).not.toHaveBeenCalled(); expect(onSend).not.toHaveBeenCalled();
    input.showInteraction(approval, respond);
    expect(note().value).toBe('reviewed');
    click(approved ? 'approve' : 'reject');
    await vi.waitFor(() => expect(panel()).toBeNull());
    expect(respond).toHaveBeenCalledExactlyOnceWith({ approved, note: 'reviewed' });
    expect(input.getConfig().text).toBe('unfinished chat draft');
});

it('blocks duplicate submissions and preserves the note after a failure', async () => {
    setup();
    let reject!: (reason: Error) => void;
    const respond = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    input.showInteraction(approval, respond); note().value = 'keep this';
    click('approve'); click('approve');
    expect(respond).toHaveBeenCalledTimes(1); expect(note().disabled).toBe(true);
    reject(new Error('connection lost'));
    await vi.waitFor(() => expect(note().disabled).toBe(false));
    expect(note().value).toBe('keep this');
    expect(panel()?.querySelector('[role="alert"]')?.textContent).toContain('connection lost');
    respond.mockImplementation(async () => {}); click('reject');
    await vi.waitFor(() => expect(panel()).toBeNull());
});

it.each(['resolve', 'reject'])('a late %s cannot clear or overwrite a newer interaction', async result => {
    setup();
    let resolve!: () => void, reject!: (error: Error) => void;
    input.showInteraction(approval, () => new Promise<void>((done, fail) => { resolve = done; reject = fail; }));
    click('approve');
    input.showInteraction({ ...approval, id: 'new', key: '2:new' }, async () => {});
    note().value = 'new note';
    if (result === 'resolve') resolve(); else reject(new Error('old failure'));
    await Promise.resolve(); await Promise.resolve();
    expect(note().value).toBe('new note'); expect(note().disabled).toBe(false);
    expect(panel()?.querySelector('[role="alert"]')?.textContent).toBe('');
    input.clearInteraction('approval'); expect(panel()).not.toBeNull();
    input.clearInteraction('new'); expect(panel()).toBeNull();
});

it('requires a reply and lets an option fill the input without submitting', async () => {
    setup(); const respond = vi.fn(async () => {});
    input.showInteraction({ ...approval, kind: 'input', options: ['Option <A>'] }, respond);
    click('reply'); expect(respond).not.toHaveBeenCalled();
    expect(panel()?.querySelector('[role="alert"]')?.textContent).not.toBe('');
    document.querySelector<HTMLButtonElement>('[data-interaction-choice]')!.click();
    expect(note().value).toBe('Option <A>'); expect(respond).not.toHaveBeenCalled();
    click('reply'); await vi.waitFor(() => expect(panel()).toBeNull());
    expect(respond).toHaveBeenCalledExactlyOnceWith('Option <A>');
});

it('routes editor approvals to the captured interaction and clears resolved or terminal requests', async () => {
    setup();
    const attachment = { revision: 3, respondApproval: vi.fn(async () => {}) };
    const editor = { chatInput: input, currentSessionId: 'session', runAttachment: attachment,
        showFlowInput: () => false, restorePrivilegedTaskAttachment: async () => {}, showDirectCommandOutput: async () => {},
        statusIndicator: { update: vi.fn() } };
    const methods = LLMWorkspaceEditor.prototype as any;
    const request = { id: 'approval', kind: 'approval', prompt: 'Approve?', payload: { command: 'inspect' } };
    methods.handleRunWaiting.call(editor, request); note().value = 'checked'; click('approve');
    await vi.waitFor(() => expect(panel()).toBeNull());
    expect(attachment.respondApproval).toHaveBeenCalledExactlyOnceWith('approval', true, 'checked', 3);
    methods.handleRunWaiting.call(editor, request);
    methods.handleRunEvent.call(editor, { type: 'task.interaction.resolved', payload: { interactionId: 'other' } });
    expect(panel()).not.toBeNull();
    methods.handleRunEvent.call(editor, { type: 'task.interaction.resolved', payload: { interactionId: 'approval' } });
    expect(panel()).toBeNull();
    methods.handleRunWaiting.call(editor, request);
    methods.handleRunEvent.call(editor, { type: 'task.cancelled' }); expect(panel()).toBeNull();
});

it('rejects a card response after the editor switches sessions', async () => {
    setup();
    const attachment = { revision: 1, respondApproval: vi.fn() };
    const editor = { chatInput: input, currentSessionId: 'old', runAttachment: attachment, showFlowInput: () => false };
    (LLMWorkspaceEditor.prototype as any).handleRunWaiting.call(editor, { id: 'approval', kind: 'approval', prompt: 'Approve?' });
    editor.currentSessionId = 'new'; click('approve');
    await vi.waitFor(() => expect(panel()?.textContent).toContain('Task attachment changed'));
    expect(attachment.respondApproval).not.toHaveBeenCalled();
});
