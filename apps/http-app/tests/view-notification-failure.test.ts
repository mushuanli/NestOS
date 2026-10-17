import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {afterEach, expect, it, vi} from 'vitest';
import {ViewEventStream} from '../../node-host/src/http/view-event-stream';
import {ViewNotifications} from '../../node-host/src/http/view-notifications';

afterEach(() => vi.useRealTimers());
it('invalidates the view on refresh failure and never sends a later event across the missing sequence', async () => {
    vi.useFakeTimers(); let fail!: (error: Error) => void;
    const refresh = vi.fn(() => new Promise<never>((_resolve, reject) => {fail = reject;})), report = vi.fn();
    const stream = Object.assign(new EventEmitter(), {write: vi.fn(), end: vi.fn(), writableLength: 0});
    const journal = new ViewEventStream(); journal.attach(stream as unknown as ServerResponse);
    const queue = new ViewNotifications(() => journal, refresh, report);
    queue.enqueueView({sequence: 1, topic: 'files', value: undefined}); await vi.advanceTimersByTimeAsync(16);
    queue.enqueueView({sequence: 2, topic: 'files', value: undefined}); fail(new Error('Snapshot unavailable'));
    await vi.advanceTimersByTimeAsync(16);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message: 'Snapshot unavailable'}));
    expect(journal.destroyed).toBe(true); expect(journal.canResume(0)).toBe(false);
    expect(stream.end).toHaveBeenCalledOnce(); expect(stream.write).not.toHaveBeenCalled();
    queue.enqueueView({sequence: 3, topic: 'files', value: undefined}); await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); queue.close();
});
