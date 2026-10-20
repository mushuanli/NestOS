import { afterEach, expect, it, vi } from 'vitest';
import { observeConversation } from '../src/projects/conversation-view';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); vi.useRealTimers(); });
function setup() {
    const state = { messages: [{ id: 'first', text: 'stable' }, { id: 'last', text: 'before' }], requests: [], pending: false,
        disconnected: false, canSend: true, canInterrupt: false, canRespond: false, title: 'Native', gap: false };
    const source = { kind: 'codex', snapshot: () => state, poll: vi.fn(async () => state), read: vi.fn(async () => state),
        send: vi.fn(async () => state), close: vi.fn(async () => {}) };
    const view = observeConversation(source as never); closes.push(() => view.close()); return { source, view, state };
}
it('shares one cursor pump and stops it after the final subscriber leaves', async () => {
    vi.useFakeTimers(); const { source, view, state } = setup(), first = vi.fn(), second = vi.fn();
    state.canInterrupt = true;
    await view.read();
    const stopFirst = view.subscribe(first), stopSecond = view.subscribe(second);
    await vi.advanceTimersByTimeAsync(200); expect(source.poll).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
    state.messages[1].text = 'changed';
    await vi.advanceTimersByTimeAsync(200); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    stopFirst(); stopSecond(); await vi.advanceTimersByTimeAsync(5000); expect(source.poll).toHaveBeenCalledTimes(2);
});
it('uses slow idle observation and switches to fast updates while a turn runs', async () => {
    vi.useFakeTimers(); const {source, view, state} = setup(), changed = vi.fn();
    view.subscribe(changed); await vi.advanceTimersByTimeAsync(14_999); expect(source.poll).not.toHaveBeenCalled();
    source.send.mockImplementationOnce(async () => {state.canInterrupt = true; return state;});
    await view.send('prompt'); await vi.advanceTimersByTimeAsync(200); expect(source.poll).toHaveBeenCalledOnce();
    source.poll.mockImplementationOnce(async () => {state.canInterrupt = false; state.messages[1].text = 'done'; return state;});
    await vi.advanceTimersByTimeAsync(200); expect(view.snapshot().canInterrupt).toBe(false);
    await vi.advanceTimersByTimeAsync(14_999); expect(source.poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(source.poll).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(2);
});
it('discovers external activity while idle and stops all observation after unsubscribe', async () => {
    vi.useFakeTimers(); const {source, view, state} = setup();
    const stop = view.subscribe(vi.fn());
    source.poll.mockImplementationOnce(async () => {state.canInterrupt = true; return state;});
    await vi.advanceTimersByTimeAsync(15_000); expect(view.snapshot().canInterrupt).toBe(true);
    await vi.advanceTimersByTimeAsync(200); expect(source.poll).toHaveBeenCalledTimes(2);
    stop(); await vi.advanceTimersByTimeAsync(30_000); expect(source.poll).toHaveBeenCalledTimes(2);
});
it('backs off failed active observations and returns to fast updates after recovery', async () => {
    vi.useFakeTimers(); const {source, view, state} = setup();
    state.canInterrupt = true; await view.read(); view.subscribe(vi.fn());
    source.poll.mockImplementationOnce(async () => {state.disconnected = true; return state;});
    await vi.advanceTimersByTimeAsync(200); expect(view.snapshot().disconnected).toBe(true);
    await vi.advanceTimersByTimeAsync(999); expect(source.poll).toHaveBeenCalledOnce();
    source.poll.mockImplementationOnce(async () => {state.disconnected = false; return state;});
    await vi.advanceTimersByTimeAsync(1); expect(source.poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200); expect(source.poll).toHaveBeenCalledTimes(3);
});
it('backs off a thrown observation error even when the transport kept its last snapshot', async () => {
    vi.useFakeTimers(); const {source, view, state} = setup();
    state.canInterrupt = true; await view.read(); view.subscribe(vi.fn());
    source.poll.mockRejectedValueOnce(new Error('Invalid observation'));
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(999); expect(source.poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(source.poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200); expect(source.poll).toHaveBeenCalledTimes(3);
});
it('keeps unchanged message identities and isolates previous snapshots from mutable driver state', async () => {
    const { view, state } = setup(); const before = await view.read();
    expect(before.requests).toEqual([]); state.messages[1].text += ' token';
    const after = await view.poll();
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
    await expect(view.poll()).rejects.toMatchObject({ code: 'EIO' });
});
it('serializes polling and mutations on the same native cursor', async () => {
    const { view, source, state } = setup(); let resume!: () => void;
    source.poll.mockImplementationOnce(async () => { await new Promise<void>(resolve => { resume = resolve; }); return state; });
    const poll = view.poll(); await Promise.resolve(); const send = view.send('request');
    expect(source.send).not.toHaveBeenCalled(); resume(); await Promise.all([poll, send]); expect(source.send).toHaveBeenCalledOnce();
});
