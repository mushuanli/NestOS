import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IVFSManager } from '@itookit/vfs-core';
import { Kernel } from './application/kernel';
import type { TaskRecord } from './domain/types';
import type { SeqFileKernelStore } from './infrastructure/seqfile/store';

let manager: IVFSManager, kernel: Kernel;
let internals: { poll(id: string): Promise<boolean>; nextWakeDelay(id: string): Promise<number | undefined>;
    schedulePoll(id: string): void; stopPoll(id: string): void; notify(id: string): void; store: SeqFileKernelStore; poller: { dispose(): void }; resourcePoller: { dispose(): void } };
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, maxConcurrent: 0, pollMs: 0 });
    kernel.registerStorageResolver({ kind: 'local', async resolve() { return { fs, rootPath: '/session' }; } });
    await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'local', locator: null } });
    await kernel.waitIdle();
    internals = kernel as unknown as typeof internals;
    internals.poller.dispose(); internals.resourcePoller.dispose();
    vi.spyOn(internals.store, 'sweep').mockResolvedValue(null);
});
afterEach(async () => { vi.restoreAllMocks(); kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); });

function waitingTask(): TaskRecord {
    return { id: 't', sessionId: 's', status: 'waiting', effects: {}, pendingEvents: [],
        wait: { type: 'timer', id: 'alarm', at: Date.now() + 10_000 } } as unknown as TaskRecord;
}

it('reuses an unchanged poll snapshot for wake calculation', async () => {
    const scan = vi.spyOn(internals.store, 'listTasks').mockResolvedValue([]);
    await internals.poll('s');
    const reads = scan.mock.calls.length;
    await internals.nextWakeDelay('s');
    expect(scan.mock.calls.length).toBe(reads);
});

it('reuses the sweep scan when no task changed during the tick', async () => {
    const waiting = waitingTask();
    vi.mocked(internals.store.sweep).mockResolvedValue([waiting]);
    const scan = vi.spyOn(internals.store, 'listTasks');
    await internals.poll('s');
    expect(scan).not.toHaveBeenCalled();
    expect(await internals.nextWakeDelay('s')).toBeGreaterThan(9000);
});

it('rechecks tasks when a commit invalidates the sweep scan', async () => {
    vi.mocked(internals.store.sweep).mockImplementation(async () => {
        internals.notify('s');
        return [];
    });
    const scan = vi.spyOn(internals.store, 'listTasks').mockResolvedValue([waitingTask()]);
    await internals.poll('s');
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await internals.nextWakeDelay('s')).toBeGreaterThan(9000);
});

it.each(['during-read', 'after-poll'])('observes a new timer notified %s instead of sleeping indefinitely', async timing => {
    // The timer already exists before wake calculation; do not create its deadline during the read.
    const waiting = waitingTask();
    const scan = vi.spyOn(internals.store, 'listTasks');
    scan.mockImplementationOnce(async () => {
        if (timing === 'during-read') internals.notify('s');
        return [];
    }).mockImplementation(async () => [waiting]);
    await internals.poll('s');
    if (timing === 'after-poll') internals.notify('s');
    const delay = await internals.nextWakeDelay('s');
    expect(delay).toBeDefined();
    expect(delay).toBeGreaterThan(9000);
    expect(delay).toBeLessThanOrEqual(10_000);
});

it.each(['schedulePoll', 'stopPoll'] as const)('invalidates a prior snapshot when %s changes polling', async operation => {
    const scan = vi.spyOn(internals.store, 'listTasks').mockResolvedValue([]);
    await internals.poll('s');
    scan.mockResolvedValue([waitingTask()]);
    internals[operation]('s');
    expect(await internals.nextWakeDelay('s')).toBeGreaterThan(9000);
});

it('consumes a cached snapshot only once', async () => {
    const scan = vi.spyOn(internals.store, 'listTasks').mockResolvedValue([]);
    await internals.poll('s');
    expect(await internals.nextWakeDelay('s')).toBeUndefined();
    scan.mockResolvedValue([waitingTask()]);
    expect(await internals.nextWakeDelay('s')).toBeGreaterThan(9000);
});

it('keeps an unchanged Session snapshot when another Session reports a change', async () => {
    const scan = vi.spyOn(internals.store, 'listTasks').mockResolvedValue([]);
    await internals.poll('s');
    const reads = scan.mock.calls.length;
    internals.notify('other-session');
    await internals.nextWakeDelay('s');
    expect(scan.mock.calls.length).toBe(reads);
});
