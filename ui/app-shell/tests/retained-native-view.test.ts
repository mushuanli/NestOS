// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import type {ConversationControls, ConversationSnapshot} from '@itookit/ui-common';
import {createNativeChatBinding, createNativeChatView, replaceNativeChatBinding} from '../../llm-ui-adapter/src/independent/native';

function fixture(title: string) {
    const listeners = new Set<() => void>();
    const state: ConversationSnapshot = {sessionId: 'native', title, messages: [{id: title, role: 'user', text: title}], requests: [],
        canSend: true, canInterrupt: false, canRespond: false, pending: false, disconnected: false, gap: false};
    const controls: ConversationControls = {snapshot: () => state, read: async () => state, refresh: async () => state,
        subscribe: listener => {listeners.add(listener); return () => {listeners.delete(listener);};}, send: vi.fn(async () => state),
        interrupt: vi.fn(async () => state), respond: vi.fn(async () => state), reconcile: vi.fn(async () => state), close: vi.fn(async () => {})};
    return {controls, state, listeners};
}
it('rebinds native presentation and preserves the composer without closing either shared native connection', async () => {
    const first = fixture('First history'), second = fixture('Second history');
    const old = await createNativeChatBinding({conversationId: 'native', controls: first.controls, operations: createOperationLedger()});
    const next = await createNativeChatBinding({conversationId: 'native', controls: second.controls, operations: createOperationLedger()});
    const host = document.createElement('div'); document.body.append(host);
    const oldRelease = vi.fn(), newRelease = vi.fn();
    const view = await createNativeChatView(host, old, {mountHeader: root => {
        const label = document.createElement('span'); label.textContent = 'Old host menu'; root.append(label);
        return {destroy: () => {oldRelease(); label.remove();}};
    }});
    try {
        const input = host.querySelector<HTMLTextAreaElement>('.llm-chat__input')!;
        view.setText('Retained input'); input.focus(); input.setSelectionRange(3, 7);
        await replaceNativeChatBinding(view, next, {mountHeader: root => {
            const label = document.createElement('span'); label.textContent = 'New host menu'; root.append(label);
            return {destroy: () => {newRelease(); label.remove();}};
        }});
        expect(host.querySelector('.llm-chat__input')).toBe(input); expect(input.value).toBe('Retained input');
        expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
        await vi.waitFor(() => expect(host.querySelector('.llm-chat__history')!.textContent).toContain('Second history'));
        expect(host.textContent).not.toContain('First history'); expect(host.textContent).not.toContain('Old host menu');
        expect(host.textContent).toContain('New host menu'); expect(oldRelease).toHaveBeenCalledOnce();
        first.listeners.forEach(listener => listener()); expect(host.querySelector('h2')!.textContent).toBe('Second history');
        expect(first.controls.close).not.toHaveBeenCalled(); expect(second.controls.close).not.toHaveBeenCalled();
    } finally {await view.destroy(); old.dispose(); next.dispose(); host.remove();}
    expect(newRelease).toHaveBeenCalledOnce(); expect(first.listeners.size).toBe(0); expect(second.listeners.size).toBe(0);
    expect(first.controls.close).not.toHaveBeenCalled(); expect(second.controls.close).not.toHaveBeenCalled();
});
