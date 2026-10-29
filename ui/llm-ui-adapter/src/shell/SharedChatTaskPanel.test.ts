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
