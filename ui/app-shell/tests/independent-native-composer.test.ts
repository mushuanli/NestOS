import type {ConversationControls, ConversationSnapshot} from '@itookit/llm-ui-adapter/contracts';
// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {t} from '@itookit/common';
import {createOperationLedger} from '@itookit/llm-ui';

import {createNativeChatBinding, createNativeChatView} from '../../llm-ui-adapter/src/independent/native';

afterEach(() => {document.body.replaceChildren(); vi.unstubAllGlobals();});
it('routes an actual independent composer selection through the binding and replaces its prompt bubble', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const listeners = new Set<() => void>();
    let state: ConversationSnapshot = {sessionId: 'session', title: 'Native', messages: [], requests: [], canSend: true,
        canInterrupt: false, canRespond: false, pending: false, disconnected: false, gap: false, supportsModels: true, supportsSlashCommands: true};
    const controls: ConversationControls = {read: vi.fn(async () => state), snapshot: () => state,
        subscribe: listener => {listeners.add(listener); return () => {listeners.delete(listener);};}, refresh: vi.fn(async () => state),
        models: vi.fn(async () => ({models: [{id: 'native', label: 'Native', reasoningEfforts: [{id: 'high', label: 'High'}]}]})),
        commands: vi.fn(async () => [{name: 'verify', description: 'Native verify', kind: 'prompt'}]),
        command: vi.fn(async () => ({...state, submittedTurnId: 'turn'})), send: vi.fn(), interrupt: vi.fn(), respond: vi.fn(), reconcile: vi.fn(), close: vi.fn()};
    const local = vi.fn(async (_input, context) => ({status: 'accepted' as const, operationId: context.operationId}));
    const binding = await createNativeChatBinding({conversationId: 'conversation', controls, operations: createOperationLedger(), reconcile: vi.fn(),
        commandProviders: [{source: {id: 'ui', label: 'UI'}, commands: () => [{id: 'verify', revision: 0, name: 'verify', description: 'View verify', kind: 'action'}], execute: local}]});
    const host = document.createElement('div'); document.body.append(host);
    const view = await createNativeChatView(host, binding);
    try {
        const choose = (id: string, value: string) => {const select = host.querySelector<HTMLSelectElement>(`[data-selector-id="${id}"]`)!;
            select.value = value; select.dispatchEvent(new Event('change'));};
        choose('modelId', 'native'); choose('reasoningEffort', 'high'); view.setText('/verify');
        await expect(view.submit()).rejects.toThrow('同名');
        const command = binding.source.getSnapshot().commands!.find(command => command.source.id === 'harness')!;
        const candidates = [...document.querySelectorAll<HTMLElement>('[data-chat-commands] [role=option]')];
        const index = binding.source.getSnapshot().commands!.findIndex(row => row.id === command.id); candidates[index].click();
        expect(controls.command).not.toHaveBeenCalled(); await view.submit();
        expect(controls.command).toHaveBeenCalledWith('verify', '', {modelId: 'native', reasoningEffort: 'high'}, '/verify ', expect.any(String));
        expect(controls.send).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled(); expect(view.getDraft().text).toBe('');
        state = {...state, messages: [{id: 'native-user', role: 'user', text: '/verify', turnId: 'turn'}]}; listeners.forEach(listener => listener());
        await vi.waitFor(() => expect(host.querySelector('[data-message-id="native-user"]')).not.toBeNull());
        expect(host.querySelectorAll('.llm-chat__message[data-role="user"]')).toHaveLength(1);
    } finally {await view.destroy(); binding.dispose();}
    expect(listeners.size).toBe(0); expect(controls.close).not.toHaveBeenCalled();
});

async function queuedConversation() {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const listeners = new Set<() => void>(), operations = createOperationLedger();
    let state: ConversationSnapshot = {sessionId: 'session', title: 'Native', messages: [], requests: [], canSend: true, canQueue: true,
        canInterrupt: false, canRespond: false, pending: false, disconnected: false, gap: false,
        instructionQueue: {revision: 1, paused: false, acceptedIds: ['instruction'], items: [
            {id: 'instruction', text: 'Original', files: [], state: 'pending'}]}};
    const emit = (change: Partial<ConversationSnapshot>) => {state = {...state, ...change}; listeners.forEach(listener => listener());};
    const controls: ConversationControls = {read: vi.fn(async () => state), snapshot: () => state,
        subscribe: listener => {listeners.add(listener); return () => {listeners.delete(listener);};}, refresh: vi.fn(async () => state),
        send: vi.fn(), enqueue: vi.fn(), interrupt: vi.fn(), respond: vi.fn(), reconcile: vi.fn(), close: vi.fn(),
        editInstructionQueue: vi.fn(async () => {emit({instructionQueue: {...state.instructionQueue!, revision: 3, paused: false,
            items: [{...state.instructionQueue!.items[0], state: 'pending'}]}}); return state;})};
    await operations.register({context: {operationId: 'instruction', viewId: 'previous'}, conversationId: 'conversation',
        kind: 'send', input: {text: 'Original', attachments: []}, status: 'accepted',
        draft: {scopeId: 'scope', revision: 0, textRevision: 0, text: 'Original', attachments: []}});
    const binding = await createNativeChatBinding({conversationId: 'conversation', controls, operations, reconcile: vi.fn()});
    const host = document.createElement('div'); document.body.append(host);
    const view = await createNativeChatView(host, binding, {initialDraft: {scopeId: 'scope', revision: 2, textRevision: 2, text: 'New draft', attachments: []}});
    const fail = (kind: 'failed' | 'uncertain' = 'failed') => emit({instructionQueue: {...state.instructionQueue!, revision: 2, paused: true,
        items: [{...state.instructionQueue!.items[0], state: kind, error: 'HARNESS_SESSION_BUSY'}]}});
    const retry = () => host.querySelector<HTMLButtonElement>('[data-message-id="operation:instruction"] button[aria-label="重新提交"]');
    return {host, controls, view, binding, emit, fail, retry};
}

it('adds retry to the unchanged user bubble only after definite queue failure and keeps newer input', async () => {
    const f = await queuedConversation();
    try {
        const bubble = f.host.querySelector('[data-message-id="operation:instruction"]');
        expect(f.retry()).toBeNull(); f.fail();
        await vi.waitFor(() => expect(f.retry()).not.toBeNull());
        expect(f.host.querySelector('[data-message-id="operation:instruction"]')).toBe(bubble);
        expect(f.host.textContent).toContain(t('chat.submission.occupied'));
        f.retry()!.click();
        await vi.waitFor(() => expect(f.controls.editInstructionQueue).toHaveBeenCalledWith({action: 'retry', id: 'instruction', expectedRevision: 2}));
        await vi.waitFor(() => expect(f.retry()).toBeNull());
        expect(f.view.getDraft().text).toBe('New draft');
        expect(f.controls.send).not.toHaveBeenCalled(); expect(f.controls.enqueue).not.toHaveBeenCalled();
    } finally {await f.view.destroy(); f.binding.dispose();}
});

it('does not replay uncertain queue entries and refreshes a rejected retry without repeating the mutation', async () => {
    const f = await queuedConversation();
    try {
        f.fail('uncertain'); expect(f.retry()).toBeNull();
        f.emit({instructionQueue: {revision: 3, paused: true, acceptedIds: ['instruction'], items: [
            {id: 'instruction', text: 'Original', files: [], state: 'failed', error: 'HARNESS_SESSION_BUSY'}]}});
        await vi.waitFor(() => expect(f.retry()).not.toBeNull());
        const reads = vi.mocked(f.controls.read).mock.calls.length;
        vi.mocked(f.controls.editInstructionQueue!).mockRejectedValueOnce(new Error('Queue revision changed'));
        f.retry()!.click();
        await vi.waitFor(() => expect(f.host.querySelector('.llm-chat__message .llm-chat__error')?.textContent).toContain('Queue revision changed'));
        expect(f.controls.editInstructionQueue).toHaveBeenCalledOnce();
        expect(f.controls.read).toHaveBeenCalledTimes(reads + 1);
        expect(f.view.getDraft().text).toBe('New draft');
    } finally {await f.view.destroy(); f.binding.dispose();}
});
