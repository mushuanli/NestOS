import { expect, it, vi } from 'vitest';
import type { EffectExecutionContext, Kernel } from '@itookit/durable-kernel';
import { createHarnessCleanupState } from '../src/projects/harness-cleanup-state';
import { harnessExecutionJournalKey } from '../src/projects/harness-execution';
import { renewSessionWriteLease, type SessionLeaseRecord } from '../src/kernel/session-lease';

it('limits cancellation recovery to one journal and preserves shared-state CAS versions', async () => {
    const context = { sessionId: 'session', taskId: 'task', effectId: 'effect' } as EffectExecutionContext;
    const getShared = vi.fn(async () => undefined), setShared = vi.fn(async () => ({ version: 2, value: { phase: 'cancelled' } }));
    const openSession = vi.fn(async () => ({ getShared, setShared })), ensureWritable = vi.fn(async () => {});
    const factory = createHarnessCleanupState(() => ({ openSession } as unknown as Kernel), ensureWritable);
    const state = await factory(context), key = harnessExecutionJournalKey(context);
    await state.get(key); await state.set(key, { phase: 'cancelled' }, 1);
    expect(openSession).toHaveBeenCalledWith('session');
    expect(setShared).toHaveBeenCalledWith(key, { phase: 'cancelled' }, { expectedVersion: 1 });
    expect(ensureWritable).toHaveBeenCalledTimes(3);
    await expect(state.get('another-journal')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(state.set('another-journal', {})).rejects.toMatchObject({ code: 'EACCES' });
    await expect(state.get('harness.context.bindings')).rejects.toMatchObject({code: 'EACCES'});
    await expect(state.set('harness.context.bindings', {})).rejects.toMatchObject({code: 'EACCES'});
    expect(getShared).toHaveBeenCalledOnce(); expect(setShared).toHaveBeenCalledOnce();
});

it('renews only an already-held cleanup lease without invoking recovery or acquisition', async () => {
    const lease: SessionLeaseRecord = { sessionId: 'session', ownerId: 'host', ownerKind: 'cli',
        fencingToken: 2, heartbeatAt: 0, leaseUntil: 100 };
    const held = new Map([['session', lease]]), renew = vi.fn(async current => ({ ...current, leaseUntil: 200 }));
    await renewSessionWriteLease('session', held, renew);
    expect(held.get('session')?.leaseUntil).toBe(200); expect(renew).toHaveBeenCalledWith(lease);
    await expect(renewSessionWriteLease('missing', held, renew)).rejects.toMatchObject({ code: 'EACCES' });
    expect(renew).toHaveBeenCalledOnce();
});

it('keeps cleanup pending when lease renewal or its concurrent fencing identity is lost', async () => {
    const lease: SessionLeaseRecord = { sessionId: 'session', ownerId: 'host', ownerKind: 'cli',
        fencingToken: 2, heartbeatAt: 0, leaseUntil: 100 };
    const held = new Map([['session', lease]]);
    await expect(renewSessionWriteLease('session', held, async () => null)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(renewSessionWriteLease('session', held, async current => {
        held.set('session', { ...lease, fencingToken: 3 }); return current;
    })).rejects.toMatchObject({ code: 'EACCES' });
    expect(held.get('session')?.fencingToken).toBe(3);
});

it('refuses cleanup reads and writes after the application loses Session ownership', async () => {
    const context = { sessionId: 'session', taskId: 'task', effectId: 'effect' } as EffectExecutionContext;
    const getShared = vi.fn(), setShared = vi.fn(), openSession = vi.fn(async () => ({ getShared, setShared }));
    const factory = createHarnessCleanupState(() => ({ openSession } as unknown as Kernel), async () => { throw new Error('lease lost'); });
    await expect(factory(context)).rejects.toThrow('lease lost');
    expect(openSession).not.toHaveBeenCalled();
    expect(getShared).not.toHaveBeenCalled(); expect(setShared).not.toHaveBeenCalled();
});

it('rechecks ownership on every journal access after creating a cleanup scope', async () => {
    const context = {sessionId: 'session', taskId: 'task', effectId: 'effect'} as EffectExecutionContext;
    const getShared = vi.fn(), setShared = vi.fn(), ensureWritable = vi.fn(async () => {});
    const openSession = vi.fn(async () => ({getShared, setShared}));
    const state = await createHarnessCleanupState(() => ({openSession} as unknown as Kernel), ensureWritable)(context);
    ensureWritable.mockRejectedValue(new Error('lease lost'));
    await expect(state.get(harnessExecutionJournalKey(context))).rejects.toThrow('lease lost');
    await expect(state.set(harnessExecutionJournalKey(context), {})).rejects.toThrow('lease lost');
    expect(getShared).not.toHaveBeenCalled(); expect(setShared).not.toHaveBeenCalled();
});
