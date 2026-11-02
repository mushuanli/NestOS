// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {ConversationControls, ConversationMessage, ConversationSnapshot} from '@itookit/llm-ui-adapter/contracts';
import {createOperationLedger} from '@itookit/llm-ui';
import {createNativeChatBinding, createNativeChatView} from '../../llm-ui-adapter/src/independent/native';

afterEach(() => {document.body.replaceChildren(); vi.unstubAllGlobals();});

async function fixture(messages: ConversationMessage[]) {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const listeners = new Set<() => void>();
    let state: ConversationSnapshot = {sessionId: 'session', title: 'Native', messages, requests: [], canSend: true,
        canInterrupt: false, canRespond: false, pending: false, disconnected: false, gap: false};
    const controls: ConversationControls = {read: vi.fn(async () => state), snapshot: () => state,
        subscribe: listener => {listeners.add(listener); return () => {listeners.delete(listener);};}, refresh: vi.fn(async () => state),
        send: vi.fn(), interrupt: vi.fn(), respond: vi.fn(), reconcile: vi.fn(), close: vi.fn()};
    const binding = await createNativeChatBinding({conversationId: 'conversation', controls, operations: createOperationLedger(), reconcile: vi.fn()});
    const host = document.createElement('div'); document.body.append(host);
    const view = await createNativeChatView(host, binding);
    return {host, controls, binding, view, emit(messages: ConversationMessage[]) {state = {...state, messages}; listeners.forEach(listener => listener());},
        groups: () => host.querySelectorAll<HTMLDetailsElement>('.llm-chat__history > .llm-tool-group')};
}
const user = (id: string, turnId?: string): ConversationMessage => ({id, role: 'user', text: id, turnId});
const tool = (id: string, name: string, status: string, turnId?: string): ConversationMessage => ({id, role: 'tool', name, text: name, status, turnId});

it('appends different live tools to one turn record across prose, retaining expansion, nodes and failure status', async () => {
    const first = tool('read', 'Read', 'running', 'turn-1');
    const f = await fixture([user('prompt', 'turn-1'), first]);
    try {
        expect(f.groups()).toHaveLength(1); const group = f.groups()[0]; expect(group.open).toBe(false);
        const original = group.querySelector('[data-message-id="read"]'); group.open = true; group.dispatchEvent(new Event('toggle'));
        f.view.setText('Keep this draft');
        const progress: ConversationMessage = {id: 'progress', role: 'assistant', text: 'Checking the next source', turnId: 'turn-1'};
        const messages = [user('prompt', 'turn-1'), {...first, status: 'completed'}, progress, tool('search', 'WebSearch', 'running', 'turn-1')];
        f.emit(messages);
        await vi.waitFor(() => expect(group.querySelectorAll('[data-role="tool"]')).toHaveLength(2));
        expect(f.groups()).toHaveLength(1); expect(f.groups()[0]).toBe(group); expect(group.open).toBe(true);
        expect(group.querySelector('[data-message-id="read"]')).toBe(original); expect(group.dataset.state).toBe('running');
        expect(f.host.querySelector('[data-message-id="progress"]')?.closest('.llm-tool-group')).toBeNull();
        f.emit([user('older-user', 'older'), tool('older-tool', 'Bash', 'completed', 'older'), ...messages.slice(0, -1),
            tool('search', 'WebSearch', 'failed', 'turn-1'), user('next', 'turn-2'), tool('next-tool', 'Read', 'running', 'turn-2')]);
        await vi.waitFor(() => expect(f.groups()).toHaveLength(3));
        expect(f.groups()[1]).toBe(group); expect(group.open).toBe(true); expect(group.dataset.state).toBe('failed');
        expect(group.querySelector('.llm-tool-group__summary')?.textContent).toContain('2');
        expect(f.view.getDraft().text).toBe('Keep this draft'); expect(f.controls.send).not.toHaveBeenCalled();
        expect(f.view.revealMessage('search')).toBe(true);
    } finally {await f.view.destroy(); f.binding.dispose();}
});

it('uses user boundaries for legacy history without turn IDs and retains intervening prose', async () => {
    const f = await fixture([user('first'), tool('read', 'Read', 'completed'),
        {id: 'progress', role: 'assistant', text: 'Progress'}, tool('bash', 'Bash', 'completed'),
        user('second'), tool('search', 'Search', 'completed')]);
    try {
        expect(f.groups()).toHaveLength(2);
        expect(f.groups()[0].querySelectorAll('[data-role="tool"]')).toHaveLength(2);
        expect(f.groups()[1].querySelectorAll('[data-role="tool"]')).toHaveLength(1);
        expect(f.host.querySelector('[data-message-id="progress"]')?.closest('.llm-tool-group')).toBeNull();
    } finally {await f.view.destroy(); f.binding.dispose();}
});
