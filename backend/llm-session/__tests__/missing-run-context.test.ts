import { expect, it, vi } from 'vitest';
import { SessionRunCoordinator } from '../src/session/session-run-coordinator';

it('clears queued state when the execution loses its Session context', async () => {
    const onStatusChange = vi.fn();
    const runs = new SessionRunCoordinator({} as never, {} as never, {} as never, {} as never,
        { onStatusChange, getSessionContext: () => null } as never, {} as never, {} as never, {} as never);
    const task = { id: 't', sessionId: 's' }, runtime = { currentTaskId: 't' };
    (runs as any).active.set('s', task);
    await (runs as any).execute(task, runtime);
    expect(onStatusChange).toHaveBeenCalledWith('s', 'failed');
    expect(runtime.currentTaskId).toBeUndefined();
    expect((runs as any).active.size).toBe(0);
});
