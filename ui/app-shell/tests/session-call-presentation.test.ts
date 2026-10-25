// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger, type ChatMessage, type ExtensionRenderer} from '@itookit/llm-ui';
import type {ICommandBus, IndependentCallView, SessionGroup} from '@itookit/llm-session/contracts';
import {SessionCallPresentation} from '../../llm-ui-adapter/src/independent/session-calls';

let presentation: SessionCallPresentation | undefined;
afterEach(() => {presentation?.destroy(); presentation = undefined; document.body.replaceChildren();});
function call(id: string, head: string | null, createdAt = 1): IndependentCallView {
    return {createdAt, head, status: 'completed', summary: '<result>', input: {title: id, request: {
        expectedSessionId: 'parent', expectedBranch: 'main', source: {kind: 'arguments', value: {}},
        submission: {id, source: {kind: 'conversation', ownerId: 'parent', id}},
    }}, receipt: {operationId: id, callerSessionId: 'parent', status: 'accepted', executionSessionId: `child-${id}`}};
}
async function mount(calls: IndependentCallView[]) {
    const execute = vi.fn(async () => calls), changed = vi.fn();
    presentation = new SessionCallPresentation({execute} as unknown as ICommandBus, 'parent', () => 'main', createOperationLedger(), changed);
    await presentation.refresh(); return {execute, changed};
}
function render(container: HTMLElement, message: ChatMessage) {
    const part = message.parts[0] as Parameters<ExtensionRenderer>[1];
    return presentation!.renderer(container, part, {} as Parameters<ExtensionRenderer>[2]);
}

it('anchors calls after their original round with stable sibling order and no admission evidence', async () => {
    await mount([call('later', 'round', 3), call('first', null), call('earlier', 'round', 2), call('missing', 'unloaded')]);
    const groups = [{id: 'u', roundId: 'round'}, {id: 'a', roundId: 'round'}, {id: 'next'}] as SessionGroup[];
    const messages = groups.map(group => ({id: group.id, revision: 0, role: 'assistant', state: 'complete', parts: []})) as ChatMessage[];
    const result = presentation!.merge(messages, groups);
    expect(result.map(message => message.id)).toEqual(['independent-call:first', 'u', 'a', 'independent-call:earlier', 'independent-call:later', 'next', 'independent-call:missing']);
    expect(result.filter(message => message.id.startsWith('independent-call:')).every(message => !message.submissionId && !message.acceptance)).toBe(true);
    expect(messages).toHaveLength(3);
});

it('moves the existing card safely across renderers and updates results without replacing details', async () => {
    const calls = [call('call', null)]; await mount(calls);
    const message = presentation!.merge([], [])[0], first = document.createElement('div'), second = document.createElement('div');
    const oldRenderer = await render(first, message), card = first.firstElementChild!;
    const details = card.querySelector('details')!; details.open = true;
    const nextRenderer = await render(second, message); await oldRenderer.destroy();
    expect(second.firstElementChild).toBe(card); expect(details.open).toBe(true);
    expect(card.querySelector<HTMLButtonElement>('[data-open-child]')!.hidden).toBe(true);
    calls[0] = {...calls[0], summary: 'Finished'}; await presentation!.refresh();
    expect(card.querySelector('[data-output]')!.textContent).toBe('Finished'); expect(card.querySelector('details')).toBe(details);
    await nextRenderer.destroy(); expect(second.childElementCount).toBe(0);
    calls.splice(0); await presentation!.refresh(); expect(presentation!.merge([], [])).toEqual([]);
});

it('ignores a late list after disposal and keeps failures in the shared notice channel', async () => {
    let finish!: (calls: IndependentCallView[]) => void;
    const execute = vi.fn(() => new Promise<IndependentCallView[]>(resolve => {finish = resolve;}));
    presentation = new SessionCallPresentation({execute} as unknown as ICommandBus, 'parent', () => 'main', createOperationLedger(), vi.fn());
    const reading = presentation.refresh(); presentation.destroy(); finish([call('late', null)]); await reading;
    expect(presentation.merge([], [])).toEqual([]);
    const failed = vi.fn(async () => {throw Object.assign(new Error('secret request text'), {code: 'CALL_VIEW_UNAVAILABLE'});});
    presentation = new SessionCallPresentation({execute: failed} as unknown as ICommandBus, 'parent', () => 'main', createOperationLedger(), vi.fn());
    await presentation.refresh();
    expect(presentation.notices.textContent).toContain('CALL_VIEW_UNAVAILABLE');
    expect(presentation.notices.textContent).not.toContain('secret request text');
    expect(presentation.merge([], [])).toEqual([]);
});
