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
    const enqueue = vi.fn(async (text: string, _files, _selection, id: string) => {
        state = {...state, instructionQueue: {revision: (state.instructionQueue?.revision ?? 0) + 1, paused: false,
            acceptedIds: [...state.instructionQueue?.acceptedIds ?? [], id], items: [...state.instructionQueue?.items ?? [],
                {id, text, files: [], createdAt: 1, state: 'pending'}]}};
        emit();
        if (!original) {
            original = state; await new Promise<void>(resolve => {finish = resolve;});
            if (late === 'failure') throw new Error('Late old reply');
            return original;
        }
        return state;
    });
    const edit = vi.fn(async (change: import('@itookit/ui-common').ConversationQueueEdit) => {
        const queue = state.instructionQueue!;
        state = {...state, instructionQueue: {...queue, revision: queue.revision + 1,
            items: queue.items.map(item => change.action === 'update' && item.id === change.id ? {...item, text: change.text} : item)}};
        emit(); return state;
    });
    const controls = {enqueue, editInstructionQueue: edit, read: async () => state, snapshot: () => state,
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
        host.querySelector<HTMLButtonElement>('.llm-instruction-queue [data-action="edit"]')!.click();
        const queuedText = host.querySelector<HTMLTextAreaElement>('.llm-instruction-queue__editor')!;
        queuedText.value = 'Revised first'; queuedText.dispatchEvent(new Event('input', {bubbles: true}));
        host.querySelector<HTMLButtonElement>('.llm-instruction-queue [data-action="save"]')!.click();
        await vi.waitFor(() => expect(edit).toHaveBeenCalledOnce());
        expect(edit).toHaveBeenCalledWith({action: 'update', id: enqueue.mock.calls[0][3], text: 'Revised first', expectedRevision: 2});
        await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('.llm-instruction-queue [data-action="edit"]')!.disabled).toBe(false));
        view.setActive(false);
        expect(host.querySelector<HTMLButtonElement>('.llm-instruction-queue [data-action="edit"]')!.disabled).toBe(true);
        view.setActive(true);
        expect(host.querySelector<HTMLButtonElement>('.llm-instruction-queue [data-action="edit"]')!.disabled).toBe(false);
        finish(); await new Promise(resolve => setTimeout(resolve, 0));
        expect(input.value).toBe('Third draft'); expect(send.disabled).toBe(false);
        expect(operations.getSnapshot().map(record => record.status)).toEqual(['accepted', 'accepted']);
        expect(binding.source.getSnapshot().messages).toEqual([]);
    } finally {finish?.(); await view.destroy(); binding.dispose(); host.remove();}
});
