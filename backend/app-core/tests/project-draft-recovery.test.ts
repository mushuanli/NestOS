import { it, expect, vi } from 'vitest';
import { attachProjectDraftRecovery } from '../src/runtime/project-draft-recovery';

it('unsubscribes and drains in-flight reconciliation before closing storage', async () => {
    let receive!: (event: any) => void, finish!: () => void;
    const submitted = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const unsubscribe = vi.fn(), recover = vi.fn(async () => {});
    const close = await attachProjectDraftRecovery({ submitted, recover } as any, {
        onGlobalEvent: (listener: any) => { receive = listener; return unsubscribe; },
    } as any);
    receive({ type: 'session_registered', payload: { sessionId: 'ordinary' } });
    expect(submitted).not.toHaveBeenCalled();
    receive({ type: 'execution_task_projected', payload: { sessionId: 's', roundId: 'r' } });
    let closed = false; const closing = close().then(() => { closed = true; });
    await Promise.resolve(); expect(unsubscribe).toHaveBeenCalledOnce(); expect(closed).toBe(false);
    finish(); await closing; expect(closed).toBe(true);
});
