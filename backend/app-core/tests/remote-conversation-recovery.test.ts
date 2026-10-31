import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {getLogger} from '@itookit/common';
import {RemoteConversationStore} from '../src/projects/remote-conversation-store';
import {recoverRemoteConversationQueues} from '../src/projects/remote-conversation-recovery';
import {ConversationRegistry} from '../src/projects/conversation-registry';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';
import {RemoteConversationRecoveryLoop} from '../src/projects/remote-conversation-retry';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers();});
async function fixture(id = 'first') {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), key = JSON.stringify(['project', 'connection', 'export', 'principal', 'codex', 'native']);
    const store = new RemoteConversationStore(fs, key); await store.load();
    await store.save({sessionId: 'native', instructionQueue: {revision: 1, paused: false, receipts: [],
        items: [{id, text: 'Private queued input', attachments: [], createdAt: Date.now(), state: 'pending'}]}});
    return {fs, key, store};
}

it('reattaches one shared host observer from the journal and leaves dispatch to the recovered runtime', async () => {
    const f = await fixture(), registry = new ConversationRegistry(); cleanup.push(() => registry.dispose());
    const record = await f.store.load(), close = vi.fn(async () => {}), read = vi.fn(async () => ({}));
    const source = {snapshot: () => record, read, close, subscribe: () => () => {}, send: vi.fn(), enqueue: vi.fn()};
    const create = vi.fn(async () => source as never), open = vi.fn(async () => registry.acquire('native', create));
    expect(await recoverRemoteConversationQueues(f.fs, open)).toEqual({recovered: 1, deferred: 0});
    expect(open).toHaveBeenCalledWith({projectId: 'project', connectionId: 'connection', serverProjectId: 'export',
        principalId: 'principal', profileId: 'codex', conversationId: 'native', sessionId: 'native'});
    await recoverRemoteConversationQueues(f.fs, open);
    expect(create).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled();
    expect(source.send).not.toHaveBeenCalled(); expect(source.enqueue).not.toHaveBeenCalled();
});

it('keeps identical project/session identities isolated by each user filesystem', async () => {
    const first = await fixture('alice-input'), second = await fixture('bob-input');
    const seen: string[][] = [];
    for (const user of [first, second]) await recoverRemoteConversationQueues(user.fs, async () => {
        const saved = await user.store.load(); seen.push(saved!.instructionQueue!.items.map(item => item.id));
        return {read: vi.fn(), snapshot: () => saved, close: vi.fn()} as never;
    });
    expect(seen).toEqual([['alice-input'], ['bob-input']]);
});

it('defers an unavailable connection without deleting its journal or logging private input', async () => {
    const f = await fixture(); getLogger().clear();
    const open = vi.fn(async () => {throw Object.assign(new Error('Private transport details'), {code: 'ECONFLICT'});});
    expect(await recoverRemoteConversationQueues(f.fs, open)).toEqual({recovered: 0, deferred: 1});
    expect((await f.store.load())?.instructionQueue?.items).toHaveLength(1);
    const events = getLogger().query({modules: ['remote-conversation-recovery']});
    expect(events).toContainEqual(expect.objectContaining({data: expect.objectContaining({stage: 'observe', result: 'deferred', code: 'ECONFLICT', operationId: expect.any(String)})}));
    expect(JSON.stringify(events)).not.toMatch(/Private queued input|Private transport details/);
});

it('refuses startup recovery against another remote principal before opening a conversation', async () => {
    const f = await fixture(), provider = {dispose: vi.fn(async () => {})};
    const mounts = new ProjectRemoteMountService(f.fs, provider as never, async () => {}, async () => {});
    cleanup.push(async () => {await mounts.dispose(); await mounts.eventLog.dispose();});
    await mounts.eventLog.attach(f.fs);
    vi.spyOn(mounts, 'list').mockReturnValue([{at: '/', connectionId: 'connection', serverProjectId: 'export', authorization: {principalId: 'another-principal'}}] as never);
    const open = vi.spyOn(mounts, 'projectConversation');
    await mounts.recoverConversations(); expect(open).not.toHaveBeenCalled();
    expect((await f.store.load())?.instructionQueue?.items).toHaveLength(1);
    const events = await mounts.eventLog.query({projectId: 'project'});
    expect(events.persistence).toBe('ready'); expect(events.events).toContainEqual(expect.objectContaining({operation: 'remote.queue.recover', code: 'ECONFLICT'}));
});

it('retries only transiently deferred targets with backoff and leaves recovered observers alone', async () => {
    const f = await fixture(); vi.useFakeTimers();
    const second = new RemoteConversationStore(f.fs, JSON.stringify(['project', 'connection', 'export', 'principal', 'codex', 'second']));
    await second.load(); await second.save({...await f.store.load(), sessionId: 'second'});
    const send = vi.fn(), read = vi.fn(async () => ({})), close = vi.fn(async () => {});
    let attempts = 0;
    const open = vi.fn(async target => {
        if (target.sessionId === 'second' && ++attempts < 3) throw Object.assign(new Error('Private transport'), {code: 'EIO'});
        return {read, close, send, snapshot: () => ({})} as never;
    });
    const loop = new RemoteConversationRecoveryLoop(f.fs, open, () => {}); cleanup.push(() => loop.close());
    await loop.recover(); expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14999); expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(open).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30000); expect(open).toHaveBeenCalledTimes(4);
    expect(open.mock.calls.filter(([target]) => target.sessionId === 'native')).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120000); expect(open).toHaveBeenCalledTimes(4);
});

it('does not retry authorization failures or keep a timer after shutdown', async () => {
    const f = await fixture(); vi.useFakeTimers();
    const open = vi.fn(async () => {throw {code: 'EACCES'};});
    const loop = new RemoteConversationRecoveryLoop(f.fs, open, () => {}); cleanup.push(() => loop.close());
    await loop.recover(); await vi.advanceTimersByTimeAsync(120000); expect(open).toHaveBeenCalledOnce();
    open.mockRejectedValue({code: 'EIO'}); await loop.recover(); await loop.close();
    await vi.advanceTimersByTimeAsync(120000); expect(open).toHaveBeenCalledTimes(2);
    expect((await f.store.load())?.instructionQueue?.items).toHaveLength(1);
});

it('rechecks persisted work on retry and rediscovers it after a new recovery loop starts', async () => {
    const f = await fixture(); vi.useFakeTimers();
    const open = vi.fn(async () => {throw {code: 'ETIMEDOUT'};});
    const first = new RemoteConversationRecoveryLoop(f.fs, open, () => {}); cleanup.push(() => first.close());
    await first.recover(); await first.close();
    const second = new RemoteConversationRecoveryLoop(f.fs, open, () => {}); cleanup.push(() => second.close());
    await second.recover(); expect(open).toHaveBeenCalledTimes(2);
    const record = (await f.store.load())!;
    await f.store.save({...record, instructionQueue: {...record.instructionQueue!, revision: record.instructionQueue!.revision + 1, items: []}});
    await vi.advanceTimersByTimeAsync(15000); expect(open).toHaveBeenCalledTimes(2);
});

it('drains active recovery reads on shutdown without starting the remaining targets', async () => {
    const f = await fixture();
    for (let n = 0; n < 5; n++) {
        const store = new RemoteConversationStore(f.fs, JSON.stringify(['project', 'connection', 'export', 'principal', 'codex', 'extra-' + n]));
        await store.load(); await store.save({...await f.store.load(), sessionId: 'extra-' + n});
    }
    let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;});
    const close = vi.fn(async () => {}), open = vi.fn(async () => {
        await gate; return {read: async () => ({}), snapshot: () => ({}), close} as never;
    });
    const loop = new RemoteConversationRecoveryLoop(f.fs, open, () => {}); cleanup.push(() => loop.close());
    const recovering = loop.recover();
    try {await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(4));}
    finally {
        const closing = loop.close(); finish(); await recovering; await closing;
    }
    expect(open).toHaveBeenCalledTimes(4); expect(close).toHaveBeenCalledTimes(4);
});
