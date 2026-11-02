import type {ConversationControls, ConversationSnapshot} from '@itookit/llm-ui-adapter/contracts';
// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';

import {createNativeChatBinding, createNativeChatView, replaceNativeChatBinding} from '../../llm-ui-adapter/src/independent/native';
import {IndependentConversationEditor} from '../../llm-ui-adapter/src/shell/IndependentConversationEditor';
import {NativeChatStore} from '../../llm-ui-adapter/src/independent/native-store';

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

it('catches up buffered native output after hiding and keeps receiving subsequent streaming updates', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const f = fixture('Streaming'), initial = structuredClone(f.state);
    let buffered = initial.messages;
    f.controls.read = vi.fn(async () => {f.state.messages = initial.messages; return f.state;});
    f.controls.refresh = vi.fn(async () => {f.state.messages = buffered; return f.state;});
    const binding = await createNativeChatBinding({conversationId: 'native', controls: f.controls, operations: createOperationLedger(), reconcile: vi.fn()});
    const host = document.createElement('div'); document.body.append(host);
    const view = await createNativeChatView(host, binding);
    const emit = (text: string, notify = true) => {
        buffered = [{id: 'stream', role: 'assistant', text, status: 'running', turnId: 'turn'}];
        if (notify) {f.state.messages = buffered; f.listeners.forEach(listener => listener());}
    };
    try {
        view.setText('Unsent draft'); emit('Before leaving');
        await vi.waitFor(() => expect(host.textContent).toContain('Before leaving'));
        const input = host.querySelector('.llm-chat__input');
        view.setActive(false); emit('Received while hidden', false);
        view.setActive(true); await binding.source.refresh();
        await vi.waitFor(() => expect(host.textContent).toContain('Received while hidden'));
        emit('Streaming continues after returning');
        await vi.waitFor(() => expect(host.textContent).toContain('Streaming continues after returning'));
        expect(host.querySelector('.llm-chat__input')).toBe(input); expect(view.getDraft().text).toBe('Unsent draft');
        expect(f.controls.read).toHaveBeenCalledOnce(); expect(f.controls.refresh).toHaveBeenCalledOnce();
        expect(f.controls.send).not.toHaveBeenCalled(); expect(f.controls.close).not.toHaveBeenCalled();
    } finally {await view.destroy(); binding.dispose(); host.remove(); vi.unstubAllGlobals();}
});

it('resumes the fallback observer even when activation catch-up fails', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const f = fixture('Polling'); f.controls.subscribe = undefined;
    f.controls.read = vi.fn(async () => f.state); f.controls.refresh = vi.fn(async () => f.state);
    let documentState = {revision: '0', data: '', acceptedOperationIds: [] as string[]};
    f.controls.readComposerDraft = async () => documentState;
    f.controls.saveComposerDraft = async (data, _revision, id) => {
        documentState = {revision: String(Number(documentState.revision) + 1), data, acceptedOperationIds: [id]}; return documentState;
    };
    const store = (await NativeChatStore.open(f.controls))!, host = document.createElement('div'); document.body.append(host);
    const editor = new IndependentConversationEditor(host, f.controls, {}, store);
    try {
        await editor.init(host); editor.setText('Keep the draft'); editor.cancelPendingRender();
        f.state.messages = [{id: 'later', role: 'assistant', text: 'Output after catch-up retry'}];
        vi.mocked(f.controls.refresh).mockRejectedValueOnce(Object.assign(new Error('Temporarily unavailable'), {code: 'ETIMEDOUT'}));
        await expect(editor.activate()).rejects.toThrow('Temporarily unavailable');
        await vi.waitFor(() => expect(host.textContent).toContain('Output after catch-up retry'), {timeout: 2500});
        expect(f.controls.refresh).toHaveBeenCalledTimes(2); expect(f.controls.read).toHaveBeenCalledOnce();
        expect(host.querySelector<HTMLTextAreaElement>('.llm-chat__input')!.value).toBe('Keep the draft');
        expect(f.controls.send).not.toHaveBeenCalled(); expect(f.controls.close).not.toHaveBeenCalled();
    } finally {await editor.destroy(); host.remove(); vi.unstubAllGlobals();}
});
