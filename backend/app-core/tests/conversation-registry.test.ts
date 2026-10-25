import {expect, it, vi} from 'vitest';
import {ConversationRegistry} from '../src/projects/conversation-registry';

it('retains an obtained query report until its uncertain storage write is reconciled', async () => {
    const registry = new ConversationRegistry(), listeners = new Set<() => void>();
    const state = {pendingQueryReports: ['query']};
    const source = {snapshot: () => state, close: vi.fn(async () => {}), subscribe: (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};}};
    const create = vi.fn(async () => source as never), view = await registry.acquire('query', create);
    await view.close(); expect(source.close).not.toHaveBeenCalled();
    const reopened = await registry.acquire('query', create); expect(create).toHaveBeenCalledOnce(); await reopened.close();
    state.pendingQueryReports = []; for (const listener of listeners) listener();
    await vi.waitFor(() => expect(source.close).toHaveBeenCalledOnce()); await registry.dispose();
});

it('shares one host queue, retains background work after closing viewers, and releases a drained queue', async () => {
    const registry = new ConversationRegistry(), listeners = new Set<() => void>();
    const state = {instructionQueue: {revision: 1, paused: false, items: [{id: 'a'}]}};
    const source = {snapshot: () => state, close: vi.fn(async () => {}),
        subscribe: (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};}};
    const create = vi.fn(async () => source as never);
    const [first, second] = await Promise.all([registry.acquire('same', create), registry.acquire('same', create)]);
    expect(create).toHaveBeenCalledOnce();
    await first.close(); await first.close(); await second.close();
    expect(source.close).not.toHaveBeenCalled(); expect(listeners.size).toBe(1);
    const reopened = await registry.acquire('same', create); expect(create).toHaveBeenCalledOnce();
    await reopened.close(); state.instructionQueue.items = [];
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(source.close).toHaveBeenCalledOnce());
    expect(listeners.size).toBe(0); await registry.dispose();
});

it('closes retained queues on host shutdown while preserving their durable records', async () => {
    const registry = new ConversationRegistry();
    const close = vi.fn(async () => {}), release = vi.fn();
    const source = {snapshot: () => ({instructionQueue: {paused: false, items: [{id: 'pending'}]}}), close, subscribe: () => release};
    const view = await registry.acquire('pending', async () => source as never);
    await view.close(); expect(close).not.toHaveBeenCalled();
    await registry.dispose(); expect(close).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
});

it('retains an unconfirmed control after all viewers close and releases its confirmed terminal observation', async () => {
    const registry = new ConversationRegistry(), listeners = new Set<() => void>();
    const state = {controls: [{operationId: 'stop', sessionId: 's', turnId: 't', receipt: 'accepted', effect: 'unconfirmed'}]};
    const source = {snapshot: () => state, close: vi.fn(async () => {}), subscribe: (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};}};
    const view = await registry.acquire('control', async () => source as never); await view.close();
    expect(source.close).not.toHaveBeenCalled(); state.controls[0].effect = 'completed';
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(source.close).toHaveBeenCalledOnce()); await registry.dispose();
});
