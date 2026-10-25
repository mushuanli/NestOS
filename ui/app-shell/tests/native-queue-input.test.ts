// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import type {ConversationControls, ConversationSnapshot} from '@itookit/ui-common';
import {createNativeChatBinding, createNativeChatView} from '../../llm-ui-adapter/src/independent/native';

it.each(['success', 'failure'] as const)('uses durable native receipts to release ChatView while its original reply ends in %s', async late => {
    const host = document.createElement('div'); document.body.append(host);
    const operations = createOperationLedger(), listeners = new Set<() => void>();
    let state: ConversationSnapshot = {title: 'Native', messages: [], requests: [], canSend: false, canQueue: true,
        canInterrupt: false, canRespond: false, pending: true, disconnected: false, gap: false};
    let finish!: () => void, original: ConversationSnapshot | undefined;
    const emit = () => {for (const listener of [...listeners]) listener();};
    const enqueue = vi.fn(async (_text, _files, _selection, id: string) => {
        state = {...state, instructionQueue: {revision: (state.instructionQueue?.revision ?? 0) + 1, paused: false,
            acceptedIds: [...state.instructionQueue?.acceptedIds ?? [], id], items: []}};
        emit();
        if (!original) {
            original = state; await new Promise<void>(resolve => {finish = resolve;});
            if (late === 'failure') throw new Error('Late old reply');
            return original;
        }
        return state;
    });
    const controls = {enqueue, read: async () => state, snapshot: () => state,
        subscribe: (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};}} as unknown as ConversationControls;
    const binding = await createNativeChatBinding({conversationId: 'native', controls, operations,
        reconcile: async operationId => ({status: 'unknown', operationId, message: 'Awaiting receipt'})});
    const view = await createNativeChatView(host, binding);
    try {
        const input = host.querySelector<HTMLTextAreaElement>('.llm-chat__input')!;
        const form = host.querySelector<HTMLFormElement>('.llm-chat__composer')!;
        const send = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        const type = (text: string) => {input.value = text; input.dispatchEvent(new Event('input', {bubbles: true}));};
        const submit = () => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
        type('First'); submit(); await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(input.value).toBe(''));
        type('Second'); expect(send.disabled).toBe(false); submit(); await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(input.value).toBe('')); type('Third draft');
        finish(); await new Promise(resolve => setTimeout(resolve, 0));
        expect(input.value).toBe('Third draft'); expect(send.disabled).toBe(false);
        expect(operations.getSnapshot().map(record => record.status)).toEqual(['accepted', 'accepted']);
        expect(binding.source.getSnapshot().messages).toEqual([]);
    } finally {finish?.(); await view.destroy(); binding.dispose(); host.remove();}
});
