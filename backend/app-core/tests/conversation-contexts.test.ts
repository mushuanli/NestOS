import { afterEach, expect, it, vi } from 'vitest';
import { ConversationContexts } from '../src/runtime/conversation-contexts';
import { conversationIdle } from '../src/runtime/conversation-idle';
import { SessionCommand } from '@itookit/llm-session/contracts';

const hosts: ConversationContexts[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); vi.useRealTimers(); });
function fixture(options: { maxIdle?: number; canRelease?: (id: string) => Promise<boolean> } = {}) {
    let now = 0;
    const created: Array<{ sessionManager: any; commandBus: any; dispose: ReturnType<typeof vi.fn> }> = [];
    const create = vi.fn(async () => {
        const context = { sessionManager: { getSnapshot: () => ({ status: 'idle', isRunning: false }), onEvent: vi.fn(), onGlobalEvent: vi.fn() },
            commandBus: { execute: vi.fn(async () => {}), list: () => [] }, dispose: vi.fn(async () => {}) };
        created.push(context); return context;
    });
    const host = new ConversationContexts(create, async () => false, { idleMs: 100, now: () => now, ...options }); hosts.push(host);
    return { host, create, created, advance: () => { now += 101; } };
}

it('shares a host context across leases and keeps it until every view releases it', async () => {
    const f = fixture(), [first, second] = await Promise.all([f.host.open('one'), f.host.open('one')]);
    expect(f.create).toHaveBeenCalledOnce(); expect(first.sessionManager).toBe(second.sessionManager);
    expect(f.created[0].commandBus.execute).toHaveBeenCalledWith(SessionCommand.Bind, { sessionId: 'one', createMissing: false });
    await first.dispose(); await first.dispose(); f.advance(); await f.host.collect(); expect(f.created[0].dispose).not.toHaveBeenCalled();
    await second.dispose(); f.advance(); await f.host.collect(); expect(f.created[0].dispose).toHaveBeenCalledOnce();
    await f.host.open('one'); expect(f.create).toHaveBeenCalledTimes(2);
});

it('bounds the idle cache while retaining executions until the host confirms they are safe to release', async () => {
    let running = true; const f = fixture({ maxIdle: 0, canRelease: async () => !running });
    const lease = await f.host.open('busy'); await lease.dispose(); f.advance(); await f.host.collect();
    expect(f.created[0].dispose).not.toHaveBeenCalled(); running = false;
    await f.host.collect(); expect(f.created[0].dispose).toHaveBeenCalledOnce();
});

it('does not collect a context reacquired while the idle check is in flight', async () => {
    let finish!: (value: boolean) => void;
    const gate = new Promise<boolean>(resolve => { finish = resolve; });
    const f = fixture({ canRelease: () => gate }), first = await f.host.open('one');
    await first.dispose(); f.advance(); const collecting = f.host.collect(); await Promise.resolve();
    const reopened = await f.host.open('one'); finish(true); await collecting;
    expect(f.create).toHaveBeenCalledOnce(); expect(f.created[0].dispose).not.toHaveBeenCalled(); await reopened.dispose();
});

it('rejects a view opened during shutdown and still releases its partially prepared context', async () => {
    const f = fixture(); let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    f.create.mockImplementationOnce(async () => { await gate; return { sessionManager: {} as any, commandBus: { execute: vi.fn(async () => {}), list: () => [] }, dispose: vi.fn(async () => {}) }; });
    const opened = f.host.open('one'); const rejected = expect(opened).rejects.toMatchObject({ code: 'EIO' });
    const closing = f.host.close(); finish(); await rejected; await closing;
    expect((await f.create.mock.results[0].value).dispose).toHaveBeenCalledOnce();
});

it('retains terminal tasks with unfinished external effects', async () => {
    const task = { status: 'cancelled', effects: { effect: { id: 'effect', status: 'cancelled', cleanupPending: true } } };
    const kernel = { listSessionTasks: vi.fn(async () => [task]) };
    expect(await conversationIdle(kernel as never, 'one')).toBe(false);
    task.effects.effect.cleanupPending = false; expect(await conversationIdle(kernel as never, 'one')).toBe(true);
    task.status = 'waiting'; expect(await conversationIdle(kernel as never, 'one')).toBe(false);
});
