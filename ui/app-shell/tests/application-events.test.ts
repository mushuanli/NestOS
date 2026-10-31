import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend, SeqEventJournal} from '@itookit/vfs-core';
import type {ApplicationEvents, ApplicationEventFact} from '@itookit/app-contracts/services';
import {ShellApplicationEvents, workspaceConsumesEvent} from '../src/lifecycle/application-events';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks();});
async function fixture(retain = 1000) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const journal = await SeqEventJournal.open<ApplicationEventFact>(await manager.openFileSystem('/'), '/events.seq', 'user-a', retain);
    const source: ApplicationEvents = {eventBaseline: vi.fn(() => journal.baseline()),
        readEvents: vi.fn((after, limit) => journal.read(after, limit)), onChange: vi.fn(listener => journal.onChange(listener)),
        listNotifications: vi.fn(), setNotificationRead: vi.fn()};
    const invalidate = vi.fn(), visible = {value: true};
    const bridge = new ShellApplicationEvents(source, invalidate, () => visible.value); cleanup.push(() => bridge.close());
    return {source, journal, bridge, invalidate, visible};
}

it('replays changes between baseline and first paint independently in two browsers without acknowledging notifications', async () => {
    const f = await fixture(), other = vi.fn();
    const second = new ShellApplicationEvents(f.source, other, () => true); cleanup.push(() => second.close());
    await f.bridge.prepare(); await second.prepare();
    await f.journal.append('during-opening', {type: 'repository.changed'});
    await f.bridge.start(); await second.start();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'repository.changed'});
    expect(other).toHaveBeenCalledExactlyOnceWith({type: 'repository.changed'});
    f.bridge.close(); await f.journal.append('later', {type: 'task.failed'}); await second.refresh();
    expect(other).toHaveBeenCalledTimes(2); expect(f.invalidate).toHaveBeenCalledOnce();
    expect(f.source.setNotificationRead).not.toHaveBeenCalled();
});

it('repairs lost hints on the visible polling interval and leaves hidden windows idle', async () => {
    vi.useFakeTimers(); const f = await fixture();
    vi.mocked(f.source.onChange).mockImplementation(() => () => {});
    await f.bridge.prepare(); await f.bridge.start();
    f.visible.value = false;
    await f.journal.append('missed', {type: 'node:created', resourceId: '/note.md'});
    const reads = vi.mocked(f.source.readEvents).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.source.readEvents).toHaveBeenCalledTimes(reads); expect(f.invalidate).not.toHaveBeenCalled();
    f.visible.value = true; await vi.advanceTimersByTimeAsync(15000);
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'node:created', resourceId: '/note.md'});
    f.bridge.close(); await vi.advanceTimersByTimeAsync(30000);
    expect(vi.getTimerCount()).toBe(0);
});

it('retries a failed initial subscription without losing its baseline or leaking error bodies', async () => {
    const f = await fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await f.bridge.prepare(); await f.journal.append('before-failure', {type: 'task.succeeded'});
    vi.mocked(f.source.readEvents).mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'}));
    await f.bridge.start(); expect(f.invalidate).not.toHaveBeenCalled();
    await f.bridge.refresh();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'task.succeeded'});
    expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_BODY');
});

it('reconciles preloaded snapshots once and recovers a failed baseline with a fresh reset', async () => {
    const f = await fixture();
    await f.bridge.prepare(true); await f.bridge.start();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'runtime.reset'});
    const other = await fixture();
    vi.mocked(other.source.eventBaseline).mockRejectedValueOnce({code: 'EIO'});
    await other.bridge.prepare(); await other.journal.append('unseen', {type: 'node:created'}); await other.bridge.start();
    expect(other.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'runtime.reset'});
    await other.journal.append('after-baseline', {type: 'node:deleted'}); await other.bridge.refresh();
    expect(other.invalidate).toHaveBeenLastCalledWith({type: 'node:deleted'});
});

it('resets an expired cursor and delivers reset markers once instead of replaying domain commands', async () => {
    const f = await fixture(2); await f.bridge.prepare();
    for (let n = 0; n < 3; n++) await f.journal.append(String(n), {type: 'task.succeeded'});
    await f.bridge.start();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'runtime.reset'});
    await f.journal.append('restart', {type: 'runtime.reset'}); await f.bridge.refresh();
    expect(f.invalidate).toHaveBeenCalledTimes(2);
});

it('closes safely while an initial read is pending', async () => {
    const f = await fixture(); await f.bridge.prepare();
    const read = f.source.readEvents.bind(f.source); let finish!: () => void;
    const gate = new Promise<void>(resolve => {finish = resolve;});
    vi.mocked(f.source.readEvents).mockImplementationOnce(async (...args) => {await gate; return read(...args);});
    const starting = f.bridge.start();
    f.bridge.close(); await f.journal.append('late', {type: 'task.failed'}); finish(); await starting;
    expect(f.invalidate).not.toHaveBeenCalled();
});

it('routes execution and scanner facts to their owning workspaces and resets every workspace', () => {
    expect(workspaceConsumesEvent('chat', {type: 'task.failed'})).toBe(true);
    expect(workspaceConsumesEvent('standard', {type: 'task.failed'})).toBe(false);
    expect(workspaceConsumesEvent('standard', {type: 'node:created'})).toBe(true);
    expect(workspaceConsumesEvent('twin', {type: 'scanner.changed'})).toBe(true);
    expect(workspaceConsumesEvent('toolbox', {type: 'scanner.changed'})).toBe(false);
    for (const kind of ['chat', 'standard', 'toolbox', 'twin']) expect(workspaceConsumesEvent(kind, {type: 'runtime.reset'})).toBe(true);
});

it('routes kanban facts to kanban views without treating notifications as execution commands', () => {
    expect(workspaceConsumesEvent('kanban', {type: 'kanban.escalated.unclaimed', notification: 'error'})).toBe(true);
    expect(workspaceConsumesEvent('kanban', {type: 'task.failed'})).toBe(false);
    expect(workspaceConsumesEvent('chat', {type: 'kanban.claim'})).toBe(false);
});
