// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger} from '../../../libraries/llm-ui/src';
import type {ConversationControls, ConversationSnapshot} from '@itookit/ui-common';
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
        [...host.querySelectorAll<HTMLButtonElement>('[data-command-id]')].find(row => row.dataset.commandId === command.id)!.click();
        expect(controls.command).not.toHaveBeenCalled(); await view.submit();
        expect(controls.command).toHaveBeenCalledWith('verify', '', {modelId: 'native', reasoningEffort: 'high'}, '/verify ');
        expect(controls.send).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled(); expect(view.getDraft().text).toBe('');
        state = {...state, messages: [{id: 'native-user', role: 'user', text: '/verify', turnId: 'turn'}]}; listeners.forEach(listener => listener());
        await vi.waitFor(() => expect(host.querySelector('[data-message-id="native-user"]')).not.toBeNull());
        expect(host.querySelectorAll('.llm-chat__message[data-role="user"]')).toHaveLength(1);
    } finally {await view.destroy(); binding.dispose();}
    expect(listeners.size).toBe(0); expect(controls.close).not.toHaveBeenCalled();
});
