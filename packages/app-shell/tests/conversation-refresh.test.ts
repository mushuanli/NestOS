// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { t } from '@itookit/common';
import { LayoutTemplates } from '../../llm-ui/src/components/templates/LayoutTemplates';
import { EventBinder } from '../../llm-ui/src/shell/EventBinder';
import { LLMWorkspaceEditor } from '../../llm-ui/src/shell/LLMWorkspaceEditor';

afterEach(() => document.body.replaceChildren());

function fixture() {
    const host = document.createElement('div');
    host.innerHTML = LayoutTemplates.renderWorkspace('Chat'); document.body.append(host);
    const snapshot = { sessionId: 's', sessions: [{ id: 'new', role: 'assistant' }], status: 'idle', isRunning: false };
    const editor = { currentSessionId: 's', refreshPending: false, attachmentClosed: false,
        domCache: { byId: (id: string) => host.querySelector('#' + id) },
        commandBus: { execute: vi.fn(async () => snapshot) },
        historyView: { renderFull: vi.fn() }, statusIndicator: { updateFromSnapshot: vi.fn() },
        branchStore: { refresh: vi.fn(async () => []) }, navigation: { pushNavData: vi.fn() },
        errorHandler: { handle: vi.fn() }, chatInput: { restoreInput: vi.fn(), text: 'unsent draft' },
    };
    const refresh = () => (LLMWorkspaceEditor.prototype as any).handleRefresh.call(editor) as Promise<void>;
    return { host, editor, snapshot, refresh };
}

it('binds the shared refresh button and releases its event on cleanup', () => {
    const { host } = fixture(), onRefresh = vi.fn();
    const binder = new EventBinder(host, { onRefresh }); binder.bindNavigationEvents();
    const button = host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!;
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.getAttribute('aria-label')).toBe(t('action.refresh'));
    const rerun = host.querySelector<HTMLButtonElement>('#llm-btn-session-rerun')!;
    expect(rerun.querySelector('svg')).not.toBeNull();
    expect(rerun.getAttribute('aria-label')).toBe(t('session.rerun.title'));
    button.click(); expect(onRefresh).toHaveBeenCalledOnce();
    binder.cleanup(); button.click(); expect(onRefresh).toHaveBeenCalledOnce();
});

it('refreshes history and status once while preserving input and execution bindings', async () => {
    const { host, editor, snapshot, refresh } = fixture();
    let release!: () => void;
    editor.commandBus.execute.mockImplementationOnce(async () => {
        await new Promise<void>(resolve => { release = resolve; }); return snapshot;
    });
    const pending = refresh(); await refresh();
    expect(host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.disabled).toBe(true);
    release(); await pending;
    expect(editor.commandBus.execute).toHaveBeenCalledOnce();
    expect(editor.commandBus.execute).toHaveBeenCalledWith(SessionCommand.GetSnapshot);
    expect(editor.historyView.renderFull).toHaveBeenCalledWith(snapshot.sessions);
    expect(editor.statusIndicator.updateFromSnapshot).toHaveBeenCalledWith(snapshot);
    expect(editor.branchStore.refresh).toHaveBeenCalledOnce();
    expect(editor.navigation.pushNavData).toHaveBeenCalledOnce();
    expect(editor.chatInput.restoreInput).not.toHaveBeenCalled();
    expect(editor.chatInput.text).toBe('unsent draft');
    expect(host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.disabled).toBe(false);
});

it.each(['failure', 'closed', 'switched'])('keeps the current history intact on %s', async reason => {
    const { editor, snapshot, refresh } = fixture();
    editor.commandBus.execute.mockImplementationOnce(async () => {
        if (reason === 'failure') throw new Error('Read failed');
        if (reason === 'closed') editor.attachmentClosed = true;
        if (reason === 'switched') editor.currentSessionId = 'other';
        return snapshot;
    });
    await refresh();
    expect(editor.historyView.renderFull).not.toHaveBeenCalled();
    expect(editor.refreshPending).toBe(false);
    expect(editor.errorHandler.handle).toHaveBeenCalledTimes(reason === 'failure' ? 1 : 0);
});
