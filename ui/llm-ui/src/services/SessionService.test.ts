import { afterEach, expect, it, vi } from 'vitest';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { SessionCommand, type ISessionRepository, type SessionRepositoryChange } from '@itookit/llm-session/contracts';
import { SessionService } from './SessionService';

afterEach(() => { vi.useRealTimers(); });

it('supports repositories without load snapshots and reads preferences after branch selection', async () => {
    let branch = 'main';
    const manifest = vi.fn(async () => ({ title: 'Existing', currentBranch: branch }));
    const execute = vi.fn(async (command: string) => {
        if (command === 'vcs.branch.switch') branch = 'review';
        if (command === SessionCommand.GetSettings) return { executionMode: 'agent' };
        return { sessions: [], currentBranch: branch };
    });
    const service = new SessionService({ getManifest: manifest } as unknown as ISessionRepository,
        { execute } as unknown as ICommandBus);
    expect(await service.loadSession('s', 'Default', 'review')).toMatchObject({
        title: 'Existing', manifest: { currentBranch: 'review' }, settings: { executionMode: 'agent' },
        snapshot: { currentBranch: 'review' },
    });
    expect(manifest).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map(([name]) => name)).toEqual([
        SessionCommand.Bind, 'vcs.branch.switch', SessionCommand.GetSnapshot, SessionCommand.GetSettings,
    ]);
});

function cachedFixture() {
    const listeners: Array<(change?: SessionRepositoryChange) => void> = [];
    const unsubscribe = vi.fn();
    const getLoadState = vi.fn(async () => ({ manifest: { title: 'Existing' }, settings: { executionMode: 'agent' } }));
    const execute = vi.fn(async (command: string) => command === SessionCommand.Bind || command === SessionCommand.GetSnapshot
        ? { sessions: [], status: 'idle', isRunning: false } : undefined);
    const repository = {
        getLoadState,
        subscribe: (listener: (change?: SessionRepositoryChange) => void) => { listeners.push(listener); return unsubscribe; },
    } as unknown as ISessionRepository;
    return { service: new SessionService(repository, { execute } as unknown as ICommandBus), getLoadState, execute, listeners, unsubscribe };
}

it('reuses a loaded projection for a quick revisit but still rebinds the durable Session', async () => {
    const { service, getLoadState, execute } = cachedFixture();
    expect(await service.loadSession('s', 'fallback')).toMatchObject({ title: 'Existing' });
    expect(await service.loadSession('s', 'fallback')).toMatchObject({ title: 'Existing', settings: { executionMode: 'agent' } });
    expect(getLoadState).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.filter(([command]) => command === SessionCommand.Bind)).toHaveLength(2);
    service.dispose();
});

it('invalidates a cached projection when the repository reports a write', async () => {
    const { service, getLoadState, listeners } = cachedFixture();
    await service.loadSession('s', 'fallback');
    listeners.forEach(listener => listener({ kind: 'session', sessionId: 's' }));
    await service.loadSession('s', 'fallback');
    expect(getLoadState).toHaveBeenCalledTimes(2);
    // A change that cannot be attributed to a Session clears every projection.
    listeners.forEach(listener => listener(undefined));
    await service.loadSession('s', 'fallback');
    expect(getLoadState).toHaveBeenCalledTimes(3);
    service.dispose();
});

it('re-reads after the reuse window and unsubscribes on dispose', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T00:00:00Z'));
    const { service, getLoadState, unsubscribe } = cachedFixture();
    await service.loadSession('s', 'fallback');
    vi.setSystemTime(new Date('2026-09-24T00:00:06Z'));
    await service.loadSession('s', 'fallback');
    expect(getLoadState).toHaveBeenCalledTimes(2);
    service.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('re-reads after a branch switch because the projection belongs to the previous branch', async () => {
    const { service, getLoadState } = cachedFixture();
    await service.loadSession('s', 'fallback');
    await service.loadSession('s', 'fallback', 'review');
    await service.loadSession('s', 'fallback', 'review');
    expect(getLoadState).toHaveBeenCalledTimes(3);
    service.dispose();
});

it('consumes the activated backend read model without binding or reading the repository again', async () => {
    const { service, getLoadState, execute, unsubscribe } = cachedFixture();
    const initial = { sessionId: 's', title: 'Prepared', manifest: { currentBranch: 'review', title: 'Prepared' },
        snapshot: { sessionId: 's' }, settings: { executionMode: 'agent' } } as Parameters<SessionService['loadSession']>[3];
    expect(await service.loadSession('s', 'fallback', 'review', initial)).toBe(initial);
    expect(execute).not.toHaveBeenCalled(); expect(getLoadState).not.toHaveBeenCalled();
    await expect(service.loadSession('other', 'fallback', 'review', initial)).rejects.toThrow('identity');
    await expect(service.loadSession('s', 'fallback', 'main', initial)).rejects.toThrow('identity');
    service.dispose(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it('prefers the bound projection and avoids switching an already selected branch', async () => {
    const { service, execute, getLoadState } = cachedFixture();
    const view = { manifest: { title: 'Latest', currentBranch: 'review' }, settings: { executionMode: 'agent' } };
    execute.mockResolvedValue({ sessions: [], status: 'idle', isRunning: false, view } as never);
    expect(await service.loadSession('s', 'fallback', 'review')).toMatchObject({ title: 'Latest' });
    expect(execute.mock.calls.map(([command]) => command)).toEqual([SessionCommand.Bind]);
    expect(getLoadState).not.toHaveBeenCalled(); service.dispose();
});
