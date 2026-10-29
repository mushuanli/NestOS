// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {RunAttachmentController} from './RunAttachmentController';
import {SharedChatTaskPanel} from './SharedChatTaskPanel';

afterEach(() => {document.body.replaceChildren(); vi.restoreAllMocks();});
it('freezes approval revisions and keeps a failed response available for explicit retry', async () => {
    const respond = vi.fn().mockRejectedValueOnce(new Error('TASK_REVISION_CONFLICT')).mockResolvedValue(undefined);
    const attachment = {revision: 7, respondApproval: respond};
    const panel = new SharedChatTaskPanel(vi.fn()); document.body.append(panel.element); panel.bind(attachment as unknown as RunAttachmentController);
    panel.callbacks.onWaiting?.({id: 'approval', kind: 'approval', prompt: 'Confirm', requestedAt: 1} as never);
    const approve = panel.element.querySelector<HTMLButtonElement>('button')!; approve.click();
    await vi.waitFor(() => expect(panel.element.textContent).toContain('TASK_REVISION_CONFLICT'));
    expect(respond).toHaveBeenCalledWith('approval', true, '', 7);
    panel.setActive(false); expect(approve.disabled).toBe(true); panel.setActive(true);
    approve.click(); await vi.waitFor(() => expect(panel.element.querySelector('[data-request-id]')).toBeNull());
    expect(respond).toHaveBeenCalledTimes(2); panel.destroy();
});
it('discards task reads from an obsolete attachment and ignores late reads after destruction', async () => {
    let finish!: (task: unknown) => void;
    const current = vi.fn(() => new Promise(resolve => {finish = resolve;})), attachment = {revision: 1, current};
    const fail = vi.fn(), panel = new SharedChatTaskPanel(fail); document.body.append(panel.element); panel.bind(attachment as unknown as RunAttachmentController);
    panel.callbacks.onEvent?.({} as never); await vi.waitFor(() => expect(current).toHaveBeenCalledOnce());
    attachment.revision++; finish({id: 'old', status: 'running'}); await Promise.resolve(); await Promise.resolve();
    expect(panel.element.textContent).not.toContain('old'); expect(panel.element.hidden).toBe(true);
    panel.destroy(); expect(panel.element.isConnected).toBe(false); expect(fail).not.toHaveBeenCalled();
});
it('opens one structured Flow dialog with defaults and submits the current step without completing the run', async () => {
    if (!HTMLDialogElement.prototype.showModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value() {}});
    if (!HTMLDialogElement.prototype.close) Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value() {}});
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {this.open = true;});
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {this.open = false; this.dispatchEvent(new Event('close'));});
    const request = {id: 'review', kind: 'input', prompt: 'Review current step', requestedAt: 1, status: 'pending', payload: {
        fields: {cards: {type: 'json', label: 'Cards', widget: 'textarea', required: true}, sizes: {type: 'json', label: 'Sizes', widget: 'textarea'}},
        values: {cards: [{word: 'fixture'}], sizes: [1]}}};
    const task = {id: 'flow-root', status: 'waiting', interactions: {review: request}};
    const attachment = {revision: 3, current: vi.fn(async () => task), respondInput: vi.fn(async () => {})};
    const fail = vi.fn(), commands = {execute: vi.fn()};
    const panel = new SharedChatTaskPanel(fail, commands as never); document.body.append(panel.element); panel.bind(attachment as unknown as RunAttachmentController);
    panel.callbacks.onWaiting?.(request as never); panel.callbacks.onWaiting?.(request as never);
    expect(document.querySelectorAll('dialog')).toHaveLength(1); expect(panel.element.querySelector('.llm-chat__interaction')).toBeNull();
    const dialog = document.querySelector('dialog')!;
    expect(dialog.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!.value).toContain('fixture');
    expect(dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).not.toContain('完成');
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true, bubbles: true}));
    await vi.waitFor(() => expect(attachment.respondInput).toHaveBeenCalledWith('review', {cards: [{word: 'fixture'}], sizes: [1]}, 3));
    await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull()); expect(task.status).toBe('waiting');
    expect(fail).not.toHaveBeenCalled(); panel.destroy();
});
it('keeps approvals for privileged tasks which have no Session message owner', async () => {
    const attachment = {revision: 1, current: vi.fn(async () => ({id: 'command', interactions: {}})), respondApproval: vi.fn(async () => {})};
    const panel = new SharedChatTaskPanel(vi.fn(), {execute: vi.fn()} as never, () => false);
    document.body.append(panel.element); panel.bind(attachment as unknown as RunAttachmentController);
    panel.callbacks.onWaiting?.({id: 'approval', kind: 'approval', prompt: 'Confirm command', requestedAt: 1} as never);
    await vi.waitFor(() => expect(panel.element.querySelector('button')).not.toBeNull());
    panel.element.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(attachment.respondApproval).toHaveBeenCalledWith('approval', true, '', 1)); panel.destroy();
});
