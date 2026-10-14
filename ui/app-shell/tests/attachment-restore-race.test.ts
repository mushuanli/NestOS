// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { LLMWorkspaceEditor } from '../../llm-ui/src/shell/LLMWorkspaceEditor';

it.each(['closed', 'session changed', 'live attach started'])('does not restore an old task after %s', async reason => {
    let resolve!: (value: unknown) => void;
    const attachment = { revision: 0, attach: vi.fn(async () => {}) };
    const kernel = { openSession: vi.fn(async () => ({ getShared: () => new Promise(done => { resolve = done; }) })),
        listSessionTasks: vi.fn(async () => []) };
    const editor = { options: { kernel }, currentSessionId: 'old', runAttachment: attachment, attachmentClosed: false };
    const restoring = (LLMWorkspaceEditor.prototype as any).restorePrivilegedTaskAttachment.call(editor);
    await Promise.resolve();
    if (reason === 'closed') editor.attachmentClosed = true;
    else if (reason === 'session changed') editor.currentSessionId = 'new';
    else attachment.revision++;
    resolve({ value: { taskId: 'old-task' } }); await restoring;
    expect(attachment.attach).not.toHaveBeenCalled();
    expect(kernel.listSessionTasks).not.toHaveBeenCalled();
});

it('looks for a pending approval when the saved privileged task has finished', async () => {
    const attachment = { revision: 0, attach: vi.fn(async () => {}) };
    const kernel = { openSession: async () => ({ getShared: async () => ({ value: { taskId: 'finished' } }),
        attachTask: async () => ({ status: async () => ({ task: { status: 'succeeded' } }) }) }),
        listSessionTasks: vi.fn(async () => [{ id: 'waiting', status: 'waiting', updatedAt: 1,
            interactions: { approve: { status: 'pending' } } }]) };
    const editor = { options: { kernel }, currentSessionId: 'session', runAttachment: attachment, attachmentClosed: false };
    await (LLMWorkspaceEditor.prototype as any).restorePrivilegedTaskAttachment.call(editor);
    expect(attachment.attach).toHaveBeenCalledExactlyOnceWith('waiting');
});
