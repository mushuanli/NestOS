// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SessionCommand, type SessionInstructionQueue } from '@itookit/llm-session/contracts';
import { InstructionQueuePanel } from '../../llm-ui-adapter/src/components/InstructionQueuePanel';
import {InstructionQueueView} from '@itookit/llm-ui';

const panels: InstructionQueuePanel[] = [];
afterEach(() => { panels.splice(0).forEach(panel => panel.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup() {
    const element = document.createElement('section'); document.body.append(element);
    const queue: SessionInstructionQueue = { sessionId: 's', revision: 7, paused: false,
        items: ['a', 'b', 'c'].map(id => ({ id, branch: 'main', state: 'pending', text: id, files: [], agentId: 'default', createdAt: 1 })) };
    const execute = vi.fn(async () => ({ ...queue, revision: 8 }));
    const panel = new InstructionQueuePanel(element, { execute } as never, 's');
    panels.push(panel); panel.update(queue);
    const click = (selector: string) => element.querySelector<HTMLButtonElement>(selector)!.click();
    return { element, panel, queue, execute, click };
}

it('edits with the displayed revision and disables duplicate actions until confirmation', async () => {
    const f = setup(); let finish!: (queue: SessionInstructionQueue) => void;
    f.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.click('[data-instruction="b"] [data-action="up"]');
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.EditInstructionQueue, { action: 'reorder', ids: ['b', 'a', 'c'], expectedRevision: 7 });
    f.click('[data-instruction="b"] [data-action="remove"]'); expect(f.execute).toHaveBeenCalledOnce();
    f.panel.update({ ...f.queue, revision: 9, items: [f.queue.items[2]] });
    finish({ ...f.queue, revision: 8 });
    await vi.waitFor(() => expect(f.element.querySelectorAll('li')).toHaveLength(1));
    expect(f.element.textContent).toContain('c'); expect(f.element.querySelector('[data-instruction="a"]')).toBeNull();
});

it('maps business parameter edits to the original Flow source without exposing binding internals', async () => {
    const f = setup();
    const update = vi.spyOn(InstructionQueueView.prototype, 'update');
    const source = {kind: 'arguments' as const, value: {request: 'Before', count: 0}};
    const flow = {source: 'target' as const, definition: {name: 'Worker'}, agent: undefined};
    f.panel.update({...f.queue, revision: 8, items: [{...f.queue.items[0], agentId: '', text: '', source,
        target: {kind: 'flow', id: 'worker', version: '1'}, flowBinding: flow as never}]});
    expect(update.mock.calls.at(-1)![0].items[0]).not.toHaveProperty('flowBinding');
    f.click('[data-instruction="a"] [data-action="edit"]');
    const input = f.element.querySelector<HTMLTextAreaElement>('[data-argument-input]')!;
    expect(input.value).toContain('Before'); expect(input.value).not.toContain('definition');
    input.value = '{"request":"After","count":2}'; input.dispatchEvent(new Event('input', {bubbles: true}));
    f.click('[data-instruction="a"] [data-action="save"]');
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(SessionCommand.EditInstructionQueue, {action: 'update-input', id: 'a', expectedRevision: 8,
        source: {kind: 'arguments', value: {request: 'After', count: 2}}}));
});

it('keeps the latest source envelope when an older edit response arrives after a newer observation', async () => {
    const f = setup(), binding = {source: 'target', definition: {name: 'Worker'}} as never;
    const old = {...f.queue, revision: 8, items: [{...f.queue.items[0], flowBinding: binding,
        source: {kind: 'arguments' as const, value: {count: 1}}}]};
    f.panel.update(old);
    let release!: (queue: SessionInstructionQueue) => void;
    f.execute.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
    f.click('[data-action="pause"]');
    f.panel.update({...old, revision: 10, items: [{...old.items[0], text: 'Latest request',
        source: {kind: 'composer', text: 'Latest request', values: {count: 3}, attachments: []}}]});
    release({...old, revision: 9});
    await vi.waitFor(() => expect(f.element.querySelector<HTMLButtonElement>('[data-action="edit"]')!.disabled).toBe(false));
    f.click('[data-action="edit"]');
    const input = f.element.querySelector<HTMLTextAreaElement>('[data-argument-input]')!;
    input.value = '{"count":4}'; input.dispatchEvent(new Event('input', {bubbles: true}));
    f.click('[data-action="save"]');
    await vi.waitFor(() => expect(f.execute).toHaveBeenLastCalledWith(SessionCommand.EditInstructionQueue,
        {action: 'update-input', id: 'a', expectedRevision: 10,
            source: {kind: 'composer', text: 'Latest request', values: {count: 4}, attachments: []}}));
});

it('submits selected identities for merging and refreshes a conflicting server projection', async () => {
    const f = setup();
    for (const id of ['a', 'b']) {
        const input = f.element.querySelector<HTMLInputElement>(`input[data-select="${id}"]`)!;
        input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    f.execute.mockRejectedValueOnce(new Error('Queue changed; refresh before editing'));
    f.execute.mockResolvedValueOnce({ ...f.queue, revision: 10, items: [f.queue.items[2]] });
    f.click('[data-action="merge"]');
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
    expect(f.execute.mock.calls[0]).toEqual([SessionCommand.EditInstructionQueue, { action: 'merge', ids: ['a', 'b'], expectedRevision: 7 }]);
    await vi.waitFor(() => expect(f.element.querySelectorAll('li')).toHaveLength(1));
    expect(f.element.querySelector('[role="alert"]')!.textContent).toContain('Queue changed');
});

it('escapes instruction content and protects in-flight instructions from removal', () => {
    const f = setup();
    f.panel.update({ ...f.queue, revision: 8, items: [{ ...f.queue.items[0], state: 'dispatching', text: '<img src=x onerror="alert(1)">' }] });
    expect(f.element.querySelector('img')).toBeNull();
    expect(f.element.textContent).toContain('<img');
    expect(f.element.querySelector<HTMLButtonElement>('[data-action="remove"]')!.disabled).toBe(true);
    f.panel.destroy(); f.panel.update({ ...f.queue, revision: 20 });
    expect(document.body.children).toHaveLength(0);
});
