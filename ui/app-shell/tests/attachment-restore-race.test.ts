// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { LLMWorkspaceEditor } from '../../llm-ui-adapter/src/shell/LLMWorkspaceEditor';

it.each(['closed', 'hidden', 'session changed', 'live attach started'])('does not restore an old task after %s', async reason => {
    let resolve!: (value: unknown) => void;
    const attachment = { revision: 0, attach: vi.fn(async () => {}) };
    const kernel = { openSession: vi.fn(async () => ({ getShared: () => new Promise(done => { resolve = done; }) })),
        listSessionTasks: vi.fn(async () => []) };
    const editor = { options: { kernel }, currentSessionId: 'old', runAttachment: attachment, attachmentClosed: false, viewActive: true };
    const restoring = (LLMWorkspaceEditor.prototype as any).restorePrivilegedTaskAttachment.call(editor);
    await Promise.resolve();
    if (reason === 'closed') editor.attachmentClosed = true;
    else if (reason === 'hidden') editor.viewActive = false;
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
    const editor = { options: { kernel }, currentSessionId: 'session', runAttachment: attachment, attachmentClosed: false, viewActive: true };
    await (LLMWorkspaceEditor.prototype as any).restorePrivilegedTaskAttachment.call(editor);
    expect(attachment.attach).toHaveBeenCalledExactlyOnceWith('waiting');
});

function activationFixture() {
    let complete!: (loaded: unknown) => void;
    const editor = {
        initComplete: true, activationRevision: 0, viewActive: false, destroyPromise: undefined as Promise<void> | undefined,
        invocationAbort: new AbortController(),
        options: {sessionId: 'session'}, currentTitle: 'Title', branchStore: {}, refreshAgentsTimer: null,
        sessionService: {loadSession: vi.fn(() => new Promise(resolve => {complete = resolve;}))},
        bindSessionEvents: vi.fn(), sessionManager: {onGlobalEvent: vi.fn()},
        historyView: {renderFull: vi.fn()}, navigation: {updatePrompts: vi.fn()}, statusIndicator: {updateFromSnapshot: vi.fn()},
        invocationPanel: {setVisible: vi.fn()}, chatInput: {refreshConnections: vi.fn(async () => {})},
        restorePrivilegedTaskAttachment: vi.fn(async () => {}),
    };
    const activate = () => LLMWorkspaceEditor.prototype.activate.call(editor as never);
    const completeLoad = () => complete({snapshot: {sessions: []}});
    return {editor, activate, completeLoad};
}

it.each(['hidden', 'destroyed'])('does not reactivate a local view when loading finishes after it is %s', async reason => {
    const {editor, activate, completeLoad} = activationFixture();
    const pending = activate();
    if (reason === 'hidden') LLMWorkspaceEditor.prototype.cancelPendingRender.call(editor as never);
    else editor.destroyPromise = Promise.resolve();
    completeLoad(); await pending;
    expect(editor.bindSessionEvents).not.toHaveBeenCalled();
    expect(editor.historyView.renderFull).not.toHaveBeenCalled();
    expect(editor.invocationPanel.setVisible).not.toHaveBeenCalledWith(true);
    expect(editor.restorePrivilegedTaskAttachment).not.toHaveBeenCalled();
});

it('discards an earlier activation after the same view has been activated again', async () => {
    const {editor, activate, completeLoad} = activationFixture();
    const first = activate(), finishFirst = completeLoad.bind(null);
    // Capture the first resolver before starting a newer activation.
    const resolveFirst = vi.mocked(editor.sessionService.loadSession).mock.results[0].value;
    let finishSecond!: (value: unknown) => void;
    editor.sessionService.loadSession.mockImplementationOnce(() => new Promise(resolve => {finishSecond = resolve;}));
    const second = activate();
    finishSecond({snapshot: {sessions: []}}); await second;
    finishFirst(); await resolveFirst; await first;
    expect(editor.bindSessionEvents).toHaveBeenCalledOnce();
    expect(editor.restorePrivilegedTaskAttachment).toHaveBeenCalledOnce();
});

it('does not attach after a view is hidden while refreshing connection options', async () => {
    const {editor, activate, completeLoad} = activationFixture();
    let finish!: () => void;
    editor.chatInput.refreshConnections.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
    const pending = activate(); completeLoad(); await Promise.resolve();
    LLMWorkspaceEditor.prototype.cancelPendingRender.call(editor as never);
    finish(); await pending;
    expect(editor.restorePrivilegedTaskAttachment).not.toHaveBeenCalled();
});
