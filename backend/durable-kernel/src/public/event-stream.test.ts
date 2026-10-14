import { expect, it, vi } from 'vitest';
import type { Kernel } from '../application/kernel';
import type { EventEnvelope } from '../domain/types';
import { eventStream } from './event-stream';

const event = (sequence: number): EventEnvelope => ({ sequence, sessionId: 's', taskId: 't', type: 'agent.event', occurredAt: 0 });

it('reads Task pages without scanning Session history and preserves sequence cursors', async () => {
    const taskEventPage = vi.fn().mockResolvedValueOnce({ items: [event(5), event(20)], nextAfterIndex: 2, throughIndex: 4 })
        .mockResolvedValueOnce({ items: [event(30), event(100)], throughIndex: 4 })
        .mockResolvedValueOnce({ items: [], throughIndex: 4 });
    const eventList = vi.fn(() => { throw new Error('Whole Session scan'); });
    const kernel = { taskEventPage, eventList, task: async () => ({ status: 'succeeded' }) } as unknown as Kernel;
    const received: number[] = [];
    for await (const item of eventStream(kernel, 's', 't', 20)) received.push(item.sequence);
    expect(received).toEqual([30, 100]);
    expect(eventList).not.toHaveBeenCalled();
    expect(taskEventPage.mock.calls.map(call => call[2].afterIndex)).toEqual([0, 2, 4]);
});

it('drains the terminal tail and handles a retained event window', async () => {
    const taskEventPage = vi.fn().mockResolvedValueOnce({ items: [event(100)], throughIndex: 12, firstAvailableIndex: 12 })
        .mockResolvedValueOnce({ items: [event(105)], nextAfterIndex: 13, throughIndex: 14 })
        .mockResolvedValueOnce({ items: [event(110)], throughIndex: 14 });
    const received: number[] = [];
    for await (const item of eventStream({ taskEventPage, task: async () => ({ status: 'succeeded' }) } as unknown as Kernel, 's', 't', 0)) received.push(item.sequence);
    expect(received).toEqual([100, 105, 110]);
    expect(taskEventPage.mock.calls.map(call => call[2].afterIndex)).toEqual([0, 12, 13]);
});
