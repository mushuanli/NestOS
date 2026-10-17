import { expect, it, vi } from 'vitest';
import { ConversationViews } from '../src/runtime/conversation-views';

function fixture() {
    const listeners = new Set<() => void>(); let running = true;
    const view = { sessionManager: {
        onGlobalEvent: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getAllSessions: () => [{ status: running ? 'running' : 'idle' }], unbindSession: vi.fn(),
    }, commandBus: {}, dispose: vi.fn(async () => {}) };
    const releaseDrafts = vi.fn(async () => {}), owner = new ConversationViews(), lease = owner.own(view as never, releaseDrafts);
    return { owner, lease, view, releaseDrafts, complete: () => { running = false; for (const listener of listeners) listener(); } };
}

it('detaches a closed browser while retaining execution and draft projection until completion', async () => {
    const f = fixture();
    await f.lease.dispose(); expect(f.view.sessionManager.unbindSession).toHaveBeenCalledOnce();
    expect(f.view.dispose).not.toHaveBeenCalled(); expect(f.releaseDrafts).not.toHaveBeenCalled();
    f.complete(); await vi.waitFor(() => expect(f.view.dispose).toHaveBeenCalledOnce());
    expect(f.releaseDrafts).toHaveBeenCalledOnce(); await f.lease.dispose(); await f.owner.close();
    expect(f.view.dispose).toHaveBeenCalledOnce();
});

it('waits for in-flight projection cleanup before destroying the conversation view', async () => {
    const f = fixture(); let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    f.releaseDrafts.mockImplementationOnce(() => gate);
    await f.lease.dispose(); f.complete(); await vi.waitFor(() => expect(f.releaseDrafts).toHaveBeenCalledOnce());
    expect(f.view.dispose).not.toHaveBeenCalled();
    const closing = f.owner.close(); finish(); await closing; expect(f.view.dispose).toHaveBeenCalledOnce();
});
