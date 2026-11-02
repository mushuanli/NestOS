import type {ConversationControls, ConversationSnapshot} from '@itookit/llm-ui-adapter/contracts';
// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {getLogger} from '@itookit/common';

import {createNativeChatBinding, createNativeChatView} from '../../llm-ui-adapter/src/independent/native';

async function queueFixture() {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const now = Date.now(), listeners = new Set<() => void>(), operations = createOperationLedger();
    const items = ['first', 'second'].map((id, index) => ({id, text: `Input ${id}`, files: [], createdAt: now + index * 1000, state: 'pending' as const}));
    let state: ConversationSnapshot = {sessionId: 'native', title: 'Native', messages: [], requests: [], canSend: false, canQueue: true,
        canInterrupt: false, canRespond: false, pending: false, disconnected: false, gap: false, active: true,
        instructionQueue: {revision: 1, paused: false, acceptedIds: items.map(item => item.id), items}};
    const emit = () => listeners.forEach(listener => listener());
    for (const item of items) await operations.register({context: {operationId: item.id, viewId: 'old'}, conversationId: 'conversation',
        kind: 'send', input: {text: item.text, attachments: []}, status: 'accepted', draft: {revision: 0, textRevision: 0, text: item.text, attachments: []}});
    const original = structuredClone(operations.getSnapshot());
    const controls: ConversationControls = {snapshot: () => state, read: vi.fn(async () => state), refresh: vi.fn(async () => state),
        subscribe: listener => {listeners.add(listener); return () => {listeners.delete(listener);};}, send: vi.fn(), enqueue: vi.fn(), interrupt: vi.fn(), respond: vi.fn(), reconcile: vi.fn(), close: vi.fn(),
        editInstructionQueue: vi.fn(async edit => {
            expect(edit).toEqual({action: 'merge', ids: ['first', 'second'], expectedRevision: 1});
            state = {...state, instructionQueue: {...state.instructionQueue!, revision: 2, items: [{...items[0], text: 'Input first\n\nInput second'}]}};
            emit(); return state;
        })};
    const binding = await createNativeChatBinding({conversationId: 'conversation', controls, operations, reconcile: vi.fn()});
    const host = document.createElement('div'); document.body.append(host); const view = await createNativeChatView(host, binding, {locale: 'zh-CN'});
    const publish = (change: Partial<ConversationSnapshot>) => {state = {...state, ...change}; emit();};
    return {now, operations, original, controls, binding, host, view, publish, state: () => state};
}

function mergeSelection(host: HTMLElement) {
    const toggle = host.querySelector<HTMLButtonElement>('.llm-instruction-queue [data-action=toggle]')!;
    if (toggle.getAttribute('aria-expanded') === 'false') toggle.click();
    for (const id of ['first', 'second']) {const checkbox = host.querySelector<HTMLInputElement>(`[data-select="${id}"]`)!;
        checkbox.checked = true; checkbox.dispatchEvent(new Event('change', {bubbles: true}));}
    host.querySelector<HTMLButtonElement>('.llm-instruction-queue [data-action=merge]')!.click();
}

it('updates merged queue bubbles and timing without changing submitted inputs or fabricating native history', async () => {
    const {now, operations, original, controls, binding, host, view, publish, state} = await queueFixture();
    try {
        view.setText('Keep this draft'); expect(host.querySelectorAll('.llm-chat__message[data-role=user]')).toHaveLength(2);
        expect(host.querySelector<HTMLButtonElement>('.llm-chat__composer button[type=submit]')!.getAttribute('aria-label')).toContain('当前执行结束后');
        expect(host.querySelector('.llm-instruction-queue time')?.getAttribute('datetime')).toBe(new Date(now).toISOString());
        mergeSelection(host);
        await vi.waitFor(() => expect(host.querySelectorAll('.llm-chat__message[data-role=user]')).toHaveLength(1));
        const bubble = host.querySelector('[data-message-id="operation:first"]')!;
        expect(bubble.textContent).toContain('Input first'); expect(bubble.textContent).toContain('Input second');
        expect(host.querySelectorAll('.llm-instruction-queue [data-instruction]')).toHaveLength(1);
        expect(operations.getSnapshot()).toEqual(original); expect(state().messages).toEqual([]);
        publish({instructionQueue: {...state().instructionQueue!, revision: 3, items: [{...state().instructionQueue!.items[0], state: 'dispatching', dispatchedAt: now + 2000, acceptedAt: now + 3000}]}});
        expect(host.querySelector('[data-message-id="operation:first"]')!.textContent).toContain('执行器已接纳');
        publish({messages: [{id: 'real-user', role: 'user', text: 'Input first\n\nInput second', turnId: 'turn'}],
            instructionQueue: {...state().instructionQueue!, revision: 4, items: [], submissions: [{id: 'first', turnId: 'turn'}, {id: 'second'}]}});
        await vi.waitFor(() => expect(host.querySelector('[data-message-id="real-user"]')).not.toBeNull());
        await vi.waitFor(() => expect(host.querySelectorAll('.llm-chat__message[data-role=user]')).toHaveLength(1));
        expect(view.getDraft().text).toBe('Keep this draft'); expect(controls.send).not.toHaveBeenCalled(); expect(controls.enqueue).not.toHaveBeenCalled();
    } finally {await view.destroy(); binding.dispose(); host.remove(); vi.unstubAllGlobals();}
});

it('keeps both accepted inputs after a rejected merge and logs safe error metadata without replaying it', async () => {
    const f = await queueFixture();
    vi.mocked(f.controls.editInstructionQueue!).mockRejectedValueOnce(Object.assign(new Error('Queue revision changed: private-detail'), {code: 'ECONFLICT'}));
    try {
        getLogger().clear(); mergeSelection(f.host);
        await vi.waitFor(() => expect(f.host.querySelector('.llm-instruction-queue__error')!.textContent).toContain('Queue revision changed'));
        expect(f.host.querySelectorAll('.llm-chat__message[data-role=user]')).toHaveLength(2);
        expect(f.host.querySelectorAll('.llm-instruction-queue [data-instruction]')).toHaveLength(2);
        expect(f.operations.getSnapshot()).toEqual(f.original); expect(f.controls.editInstructionQueue).toHaveBeenCalledOnce();
        const entries = getLogger().query({modules: ['native-instruction-queue']});
        expect(entries).toContainEqual(expect.objectContaining({message: 'chat.native.queue.edit', data: expect.objectContaining({
            operationId: expect.any(String), stage: 'merge', result: 'failure', code: 'ECONFLICT', expectedRevision: 1, durationMs: expect.any(Number)})}));
        expect(JSON.stringify(entries)).not.toMatch(/Input first|Input second|private-detail/);
    } finally {await f.view.destroy(); f.binding.dispose(); f.host.remove(); vi.unstubAllGlobals();}
});

it('keeps only the merged preview after reopening from the original accepted operation ledger', async () => {
    const f = await queueFixture(); let reopened: Awaited<ReturnType<typeof createNativeChatView>> | undefined;
    let binding: Awaited<ReturnType<typeof createNativeChatBinding>> | undefined;
    const host = document.createElement('div');
    try {
        mergeSelection(f.host);
        await vi.waitFor(() => expect(f.host.querySelectorAll('.llm-chat__message[data-role=user]')).toHaveLength(1));
        await f.view.destroy(); f.binding.dispose(); f.host.remove(); document.body.append(host);
        binding = await createNativeChatBinding({conversationId: 'conversation', controls: f.controls, operations: f.operations, reconcile: vi.fn()});
        reopened = await createNativeChatView(host, binding, {locale: 'zh-CN'});
        expect(host.querySelectorAll('.llm-chat__message[data-role=user]')).toHaveLength(1);
        const merged = host.querySelector('[data-message-id="operation:first"]')!;
        expect(merged.textContent).toContain('Input first'); expect(merged.textContent).toContain('Input second');
        expect(host.querySelector('[data-message-id="operation:second"]')).toBeNull();
        expect(host.querySelectorAll('.llm-instruction-queue [data-instruction]')).toHaveLength(1);
        expect(f.operations.getSnapshot()).toEqual(f.original);
        expect(f.controls.send).not.toHaveBeenCalled(); expect(f.controls.enqueue).not.toHaveBeenCalled();
    } finally {
        await reopened?.destroy(); binding?.dispose(); host.remove();
        await f.view.destroy(); f.binding.dispose(); f.host.remove(); vi.unstubAllGlobals();
    }
});
