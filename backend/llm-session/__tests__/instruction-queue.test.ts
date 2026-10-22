import { afterEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import type { SessionInstructionInput } from '../src/contracts/instruction-queue';
import { InstructionQueueStore } from '../src/persistence/instruction-queue-store';
import { createInstructionQueueSessions } from '../src/persistence/instruction-queue-sessions';
import { SessionInstructionQueues, type InstructionQueuePorts } from '../src/session/instruction-queue';
import { createSessionHost } from '../src/utils/host-ports';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function input(id: string, text = id): SessionInstructionInput {
    return { text, files: [], agentId: 'agent', overrides: { connectionId: 'chosen', reasoningEffort: 'low' },
        sendIntent: { execution: { kind: 'agent', agentId: 'agent', mode: 'chat' }, branch: { mode: 'continue' },
            retention: { mode: 'persistent' }, submission: { id, source: { kind: 'conversation', ownerId: 's', id } } } };
}

async function fixture() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/test');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 0 });
    kernel.registerStorageResolver({ kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) });
    await kernel.initialize(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    cleanup.push(async () => { kernel.dispose(); await kernel.waitIdle(); });
    const store = new InstructionQueueStore(kernel), index = createInstructionQueueSessions(fs);
    let ready = false;
    const submit = vi.fn(async (_sessionId: string, _item: unknown) => { ready = false; return 'run'; });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ports: InstructionQueuePorts = { store, host: createSessionHost({ logger }), assertWritable: vi.fn(async () => {}),
        branch: vi.fn(async () => 'main'), ready: async () => ready, submit, recover: vi.fn(async () => 'uncertain' as const),
        mark: id => index.mark(id), unmark: id => index.unmark(id), changed: vi.fn() };
    const queues = new SessionInstructionQueues(ports);
    cleanup.push(async () => queues.dispose());
    return { kernel, store, index, ports, queues, submit, logger, setReady: (value: boolean) => { ready = value; } };
}

it('persists edits and dispatches the selected order once, with frozen input and no frontend', async () => {
    const f = await fixture(), mutable = input('a');
    await f.queues.enqueue('s', mutable); mutable.text = 'changed later'; mutable.overrides!.connectionId = 'changed';
    for (const id of ['b', 'c', 'd']) await f.queues.enqueue('s', input(id));
    const edit = async (action: object) => f.queues.edit('s', { ...action, expectedRevision: (await f.queues.get('s')).revision } as never);
    await edit({ action: 'reorder', ids: ['c', 'a', 'b', 'd'] });
    await edit({ action: 'remove', id: 'd' });
    await edit({ action: 'merge', ids: ['b', 'a'] });
    expect((await f.queues.get('s')).items.map(item => item.text)).toEqual(['c', 'a\n\nb']);
    expect(await f.index.sessions()).toEqual(['s']);
    expect(f.submit).not.toHaveBeenCalled();
    f.setReady(true); for (let i = 0; i < 5; i++) f.queues.wake('s');
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    f.setReady(true); f.queues.settled('s', 'completed', 'c');
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(2));
    expect(f.submit.mock.calls[1]).toMatchObject(['s', { id: 'a', text: 'a\n\nb', overrides: { connectionId: 'chosen' } }]);
    f.queues.settled('s', 'completed', 'a');
    await vi.waitFor(async () => expect((await f.queues.get('s')).items).toEqual([]));
    await f.queues.whenIdle(); expect(await f.index.sessions()).toEqual([]);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain('a\\n\\nb');
});

it('freezes backend model defaults once while keeping duplicate acceptance stable', async () => {
    const f = await fixture(); let selected = 'first';
    f.ports.prepare = vi.fn(async (_id, item) => ({ ...item, connectionBinding: { connectionId: selected, defaults: { chat: selected } } }));
    await f.queues.enqueue('s', input('frozen'));
    selected = 'second';
    await f.queues.enqueue('s', input('frozen'));
    expect(f.ports.prepare).toHaveBeenCalledOnce();
    await f.queues.enqueue('s', input('other'));
    await expect(f.queues.edit('s', { action: 'merge', ids: ['frozen', 'other'], expectedRevision: (await f.queues.get('s')).revision })).rejects.toMatchObject({ code: 'QUEUE_INCOMPATIBLE' });
    f.setReady(true); f.queues.wake('s');
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.submit.mock.calls[0][1]).toMatchObject({ connectionBinding: { connectionId: 'first', defaults: { chat: 'first' } } });
});

it('rejects stale edits, incompatible merges and edits of an already claimed instruction', async () => {
    const f = await fixture(); await f.queues.enqueue('s', input('a'));
    const old = await f.queues.get('s');
    await f.queues.enqueue('s', { ...input('b'), agentId: 'different' });
    await expect(f.queues.edit('s', { action: 'remove', id: 'a', expectedRevision: old.revision })).rejects.toMatchObject({ code: 'QUEUE_CONFLICT' });
    let queue = await f.queues.get('s');
    await expect(f.queues.edit('s', { action: 'merge', ids: ['a', 'b'], expectedRevision: queue.revision })).rejects.toMatchObject({ code: 'QUEUE_INCOMPATIBLE' });
    f.setReady(true); f.queues.wake('s');
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    queue = await f.queues.get('s');
    await expect(f.queues.edit('s', { action: 'remove', id: 'a', expectedRevision: queue.revision })).rejects.toMatchObject({ code: 'QUEUE_CONFLICT' });
});

it('uses durable CAS to prevent two queue owners from dispatching the same instruction', async () => {
    const f = await fixture(); await f.queues.enqueue('s', input('once'));
    const competitor = new SessionInstructionQueues({ ...f.ports, ready: async () => true });
    cleanup.push(async () => competitor.dispose());
    f.setReady(true); f.queues.wake('s'); await competitor.restore('s');
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect((await f.queues.get('s')).items[0].state).toBe('dispatching');
});

it('retains acceptance receipts after deletion and rejects identity reuse with different content', async () => {
    const f = await fixture(); await f.queues.enqueue('s', input('once'));
    await f.queues.edit('s', { action: 'remove', id: 'once', expectedRevision: (await f.queues.get('s')).revision });
    expect(await f.queues.enqueue('s', input('once'))).toBe('once');
    expect((await f.queues.get('s')).items).toEqual([]);
    await expect(f.queues.enqueue('s', input('once', 'different content'))).rejects.toMatchObject({ code: 'QUEUE_CONFLICT' });
    expect(await f.queues.view('s')).not.toHaveProperty('accepted');
});

it('restores pending work and quarantines an interrupted dispatch without repeating a paid request', async () => {
    const f = await fixture(); await f.queues.enqueue('s', input('a')); await f.queues.enqueue('s', input('b'));
    f.setReady(true); f.queues.wake('s');
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()); f.queues.dispose();
    const recovered = new SessionInstructionQueues({ ...f.ports, ready: async () => true });
    cleanup.push(async () => recovered.dispose());
    await recovered.restore('s');
    await vi.waitFor(async () => expect((await recovered.get('s')).items[0].state).toBe('uncertain'));
    const queue = await recovered.get('s'); expect(queue.paused).toBe(true);
    await expect(recovered.edit('s', { action: 'retry', id: 'a', expectedRevision: queue.revision })).rejects.toMatchObject({ code: 'QUEUE_INVALID' });
    expect(f.submit).toHaveBeenCalledOnce();
});

it('retains admission errors for explicit retry and pauses after aborting the current execution', async () => {
    const f = await fixture(); await f.queues.enqueue('s', input('a')); await f.queues.enqueue('s', input('b'));
    f.submit.mockRejectedValueOnce(new Error('Connection is disabled'));
    f.setReady(true); f.queues.wake('s');
    await vi.waitFor(async () => expect((await f.queues.get('s')).items[0]).toMatchObject({ state: 'failed', error: 'Connection is disabled' }));
    let queue = await f.queues.get('s'); expect(queue.paused).toBe(true);
    await f.queues.edit('s', { action: 'retry', id: 'a', expectedRevision: queue.revision });
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(2));
    f.ports.recover = vi.fn(async () => 'failed');
    f.setReady(true); f.queues.settled('s', 'aborted', 'a');
    await vi.waitFor(async () => expect((await f.queues.get('s')).items.map(item => item.id)).toEqual(['b']));
    queue = await f.queues.get('s'); expect(queue).toMatchObject({ paused: true, reason: 'aborted' });
    expect(f.submit).toHaveBeenCalledTimes(2);
});

it('checks write authority for edits and pauses on branch changes before invoking execution', async () => {
    const f = await fixture(); await f.queues.enqueue('s', input('a'));
    const queue = await f.queues.get('s');
    f.ports.assertWritable = vi.fn(async () => { throw Object.assign(new Error('Other host owns this session'), { code: 'QUEUE_READ_ONLY' }); });
    await expect(f.queues.edit('s', { action: 'remove', id: 'a', expectedRevision: queue.revision })).rejects.toMatchObject({ code: 'QUEUE_READ_ONLY' });
    expect((await f.queues.get('s')).items).toHaveLength(1);
    f.ports.assertWritable = vi.fn(async () => {});
    f.ports.branch = vi.fn(async () => 'other'); f.setReady(true); f.queues.wake('s');
    await vi.waitFor(async () => expect(await f.queues.view('s')).toMatchObject({ paused: true, reason: 'branch-changed' }));
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalledWith('Session instruction queue', expect.objectContaining({
        operation: 'session.instructions', stage: 'edit.remove', outcome: 'failure', code: 'QUEUE_READ_ONLY', durationMs: expect.any(Number),
    }));
});

it('rejects corrupt queue storage instead of treating it as an empty queue', async () => {
    const f = await fixture();
    const session = await f.kernel.openSession('s');
    await session.setShared('conversation/instructions', { schemaVersion: 999, sessionId: 's', paused: false, items: [] });
    await expect(f.queues.view('s')).rejects.toMatchObject({ code: 'QUEUE_STORAGE_INVALID' });
    expect(f.submit).not.toHaveBeenCalled();
});

it('does not carry an empty failed queue pause into a later explicit send after recovery', async () => {
    const f = await fixture(); f.setReady(true);
    await f.queues.enqueue('s', input('first')); expect(f.submit).toHaveBeenCalledOnce(); f.queues.dispose();
    const recovered = new SessionInstructionQueues({ ...f.ports, ready: async () => true, recover: async () => 'failed' });
    cleanup.push(async () => recovered.dispose()); await recovered.restore('s'); await recovered.whenIdle();
    expect(await recovered.view('s')).toMatchObject({ paused: false, items: [] });
    await recovered.enqueue('s', input('later')); expect(f.submit).toHaveBeenCalledTimes(2);
});

it('enforces the instruction limit after host materialization without persisting or executing the request', async () => {
    const f = await fixture(); f.setReady(true);
    f.ports.capture = async (_id, item) => ({ ...item, text: 'x'.repeat(1024 * 1024) });
    await expect(f.queues.enqueue('s', input('large'))).rejects.toMatchObject({ code: 'QUEUE_LIMIT' });
    expect((await f.queues.get('s')).items).toEqual([]); expect(f.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('xxxx');
});
