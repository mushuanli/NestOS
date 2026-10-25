import { afterEach, expect, it, vi } from 'vitest';
import { observeConversation } from '../src/projects/conversation-view';

const closes: Array<() => Promise<void>> = [];
it('reads command and model catalogs while the original native send is unresolved', async () => {
    const {view, source, state} = setup();
    let finish!: () => void;
    source.send.mockImplementationOnce(async () => {await new Promise<void>(resolve => {finish = resolve;}); return state;});
    const commands = vi.fn(async () => [{name: 'session:status'}]), models = vi.fn(async () => ({models: []}));
    const queryCommand = vi.fn(async () => Object.assign(state, {queryReceipts: [{id: 'query', status: 'accepted'}]}));
    Object.assign(source, {commands, models, queryCommand});
    const sending = view.send('Pending input');
    await vi.waitFor(() => expect(source.send).toHaveBeenCalledOnce());
    expect(await view.commands!()).toEqual([{name: 'session:status'}]);
    expect(await view.models!()).toEqual({models: []});
    expect((await view.queryCommand!('session:status', '', 'query')).queryReceipts).toEqual([{id: 'query', status: 'accepted'}]);
    expect(queryCommand).toHaveBeenCalledOnce();
    finish(); await sending;
});
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); vi.useRealTimers(); });
function setup() {
    const state = { messages: [{ id: 'first', text: 'stable' }, { id: 'last', text: 'before' }], requests: [], pending: false,
        disconnected: false, canSend: true, canInterrupt: false, canRespond: false, title: 'Native', gap: false };
    const listeners = new Set<() => void>();
    const source = { subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }), kind: 'codex', snapshot: () => state, refresh: vi.fn(async () => state), read: vi.fn(async () => state),
        send: vi.fn(async () => state), close: vi.fn(async () => {}) };
    const view = observeConversation(source as never); closes.push(() => view.close()); return { source, view, state, emit: () => { for (const listener of listeners) listener(); } };
}
it('shares one source subscription, coalesces events and releases it with the last viewer', async () => {
    vi.useFakeTimers(); const {source,view,state,emit} = setup(), first = vi.fn(), second = vi.fn();
    await view.read(); const a = view.subscribe(first), b = view.subscribe(second);
    await vi.advanceTimersByTimeAsync(1000); expect(source.refresh).not.toHaveBeenCalled();
    expect(source.subscribe).toHaveBeenCalledOnce();
    state.messages[1].text = 'changed'; emit(); emit(); emit();
    await vi.advanceTimersByTimeAsync(20);
    expect(source.refresh).toHaveBeenCalledOnce(); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    a(); b(); emit(); await vi.advanceTimersByTimeAsync(20_000); expect(source.refresh).toHaveBeenCalledOnce();
});
it('retains low frequency reconciliation without adding active-turn polling', async () => {
    vi.useFakeTimers(); const {source,view,state} = setup(); view.subscribe(vi.fn());
    state.canInterrupt = true; await view.send('prompt');
    await vi.advanceTimersByTimeAsync(14_999); expect(source.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(source.refresh).toHaveBeenCalledOnce();
});
it('receives events while submission acceptance is pending', async () => {
    vi.useFakeTimers(); const {source,view,state,emit} = setup(); let accept!: () => void;
    source.send.mockImplementationOnce(async () => { await new Promise<void>(resolve => { accept = resolve; }); return state; });
    view.subscribe(vi.fn()); const sending = view.send('prompt'); await Promise.resolve();
    state.messages[1].text = 'live'; emit(); await vi.advanceTimersByTimeAsync(20);
    expect(view.snapshot().messages[1].text).toBe('live'); expect(source.refresh).toHaveBeenCalledOnce();
    accept(); await sending;
});
it('recovers on the next event after a failed projection read', async () => {
    vi.useFakeTimers(); const {source,view,emit} = setup(); view.subscribe(vi.fn());
    source.refresh.mockRejectedValueOnce(new Error('Invalid observation'));
    emit(); await vi.advanceTimersByTimeAsync(20); expect(source.refresh).toHaveBeenCalledOnce();
    emit(); await vi.advanceTimersByTimeAsync(20); expect(source.refresh).toHaveBeenCalledTimes(2);
});
it('keeps unchanged message identities and isolates previous snapshots from mutable driver state', async () => {
    const { view, state } = setup(); const before = await view.read();
    expect(before.requests).toEqual([]); state.messages[1].text += ' token';
    const after = await view.refresh();
    expect(after.messages[0]).toBe(before.messages[0]); expect(after.messages[1]).not.toBe(before.messages[1]);
    expect(before.messages[1].text).toBe('before'); expect(after.messages[1].text).toBe('before token');
    expect(view.snapshot()).toBe(after);
});
it('publishes receipt uncertainty after a failed mutation and closes only once', async () => {
    const { view, source, state } = setup(), changed = vi.fn(); view.subscribe(changed);
    source.send.mockImplementationOnce(async () => { state.pending = true; state.canSend = false; throw new Error('unknown outcome'); });
    await expect(view.send('request')).rejects.toThrow('unknown outcome');
    expect(view.snapshot().pending).toBe(true); expect(changed).toHaveBeenCalledOnce();
    await Promise.all([view.close(), view.close()]); expect(source.close).toHaveBeenCalledOnce();
    await expect(view.refresh()).rejects.toMatchObject({ code: 'EIO' });
});
it('serializes polling and mutations on the same native cursor', async () => {
    const { view, source, state } = setup(); let resume!: () => void;
    source.refresh.mockImplementationOnce(async () => { await new Promise<void>(resolve => { resume = resolve; }); return state; });
    const poll = view.refresh(); await Promise.resolve(); const send = view.send('request');
    expect(source.send).not.toHaveBeenCalled(); resume(); await Promise.all([poll, send]); expect(source.send).toHaveBeenCalledOnce();
});

it('observes a claimed queue and accepts queue controls while its dispatch reply is pending', async () => {
    vi.useFakeTimers(); const {source, view, state, emit} = setup(); let finish!: () => void;
    Object.assign(state, {instructionQueue: {revision: 1, paused: false, acceptedIds: [], items: [{id: 'first', state: 'dispatching', text: 'First', files: [], createdAt: 0}]}});
    const enqueue = vi.fn(async () => state), editInstructionQueue = vi.fn(async () => state), reconcileControl = vi.fn(async () => state);
    Object.assign(source, {enqueue, editInstructionQueue, reconcileControl});
    source.refresh.mockImplementationOnce(async () => {await new Promise<void>(resolve => {finish = resolve;}); return state;});
    view.subscribe(vi.fn()); emit(); await vi.advanceTimersByTimeAsync(20);
    expect(source.refresh).toHaveBeenCalledOnce();
    await view.enqueue!('Second'); await view.editInstructionQueue!({action: 'pause', expectedRevision: 1}); await view.reconcileControl!('cancel');
    expect(enqueue).toHaveBeenCalledOnce(); expect(editInstructionQueue).toHaveBeenCalledOnce(); expect(reconcileControl).toHaveBeenCalledOnce();
    state.canInterrupt = true; state.messages[1].text = 'Native progress'; emit(); await vi.advanceTimersByTimeAsync(20);
    try {expect(source.refresh).toHaveBeenCalledTimes(2); expect(view.snapshot()).toMatchObject({canInterrupt: true});}
    finally {finish(); await vi.advanceTimersByTimeAsync(0);}
});
