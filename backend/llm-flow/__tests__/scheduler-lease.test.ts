import { afterEach, describe, expect, it, vi } from 'vitest';
import { markSchedulerRunDeleted, acquireSchedulerLease, isSchedulerOwnershipLost, schedulerOwnerKey } from '../src/flow/scheduler-lease';

/** Minimal versioned shared-state session, enough for the lease protocol. */
function fakeSession() {
    const entries = new Map<string, { value: unknown; version: number }>();
    return {
        entries,
        async getShared(key: string) { return entries.get(key); },
        async setShared(key: string, value: unknown, options?: { expectedVersion?: number | null }) {
            const current = entries.get(key);
            const expected = options?.expectedVersion ?? null;
            if ((current?.version ?? null) !== expected) throw new Error('Shared version conflict');
            entries.set(key, { value, version: (current?.version ?? 0) + 1 });
        },
    };
}

describe('acquireSchedulerLease', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('records ownership and refuses a live owner', async () => {
        const session = fakeSession();
        const first = await acquireSchedulerLease(session as never, 'root', { ownerId: 'host-a', now: () => 1_000 });
        expect(first).toMatchObject({ ownerId: 'host-a', epoch: 1 });
        expect(session.entries.get(schedulerOwnerKey('root'))?.value)
            .toEqual({ version: 1, ownerId: 'host-a', epoch: 1, expiresAt: 31_000 });
        await expect(acquireSchedulerLease(session as never, 'root', { ownerId: 'host-b', now: () => 1_000 }))
            .rejects.toThrow('scheduled by host-a');
        await first.release();
    });

    it('takes over only after the owner lease expires and increments the epoch', async () => {
        const session = fakeSession();
        await acquireSchedulerLease(session as never, 'root', { ownerId: 'host-a', ttlMs: 5_000, now: () => 0 });
        await expect(acquireSchedulerLease(session as never, 'root', { ownerId: 'host-b', now: () => 4_999 }))
            .rejects.toThrow('scheduled by host-a');
        const second = await acquireSchedulerLease(session as never, 'root', { ownerId: 'host-b', now: () => 5_001 });
        expect(second.epoch).toBe(2);
        await second.release();
    });

    it.each([-1, 0.5, NaN, Infinity])('rejects invalid skew allowance %s', async skewMs => {
        await expect(acquireSchedulerLease(fakeSession() as never, 'root', { skewMs })).rejects.toThrow('skewMs');
    });

    it('hands over an explicitly released lease without waiting out skew', async () => {
        const session = fakeSession();
        const first = await acquireSchedulerLease(session as never, 'root', { ownerId: 'a', now: () => 0 });
        await first.release();
        const second = await acquireSchedulerLease(session as never, 'root', { ownerId: 'b', skewMs: 5_000, now: () => 0 });
        expect(second.epoch).toBe(2);
        await second.release();
    });

    it('applies an explicit clock skew budget before taking over an expired lease', async () => {
        const session = fakeSession();
        await acquireSchedulerLease(session as never, 'root', { ownerId: 'host-a', ttlMs: 5_000, now: () => 0 });
        // Local time says the lease expired, but a host whose clock runs fast must not
        // steal it before the owner's clock could have reached the deadline.
        await expect(acquireSchedulerLease(session as never, 'root',
            { ownerId: 'host-b', skewMs: 5_000, now: () => 5_001 }))
            .rejects.toThrow('clock skew budget');
        await expect(acquireSchedulerLease(session as never, 'root',
            { ownerId: 'host-b', skewMs: 5_000, now: () => 9_999 }))
            .rejects.toThrow('scheduled by host-a until');
        const takeover = await acquireSchedulerLease(session as never, 'root',
            { ownerId: 'host-b', skewMs: 5_000, now: () => 10_001 });
        expect(takeover).toMatchObject({ ownerId: 'host-b', epoch: 2 });
        await takeover.release();
    });

    it('keeps the skew budget off (and takeover unchanged) by default', async () => {
        const session = fakeSession();
        await acquireSchedulerLease(session as never, 'root', { ownerId: 'host-a', ttlMs: 5_000, now: () => 0 });
        const takeover = await acquireSchedulerLease(session as never, 'root', { ownerId: 'host-b', now: () => 5_001 });
        expect(takeover.epoch).toBe(2);
        await takeover.release();
    });

    it('fences an owner whose epoch was replaced and lets release hand over immediately', async () => {
        const session = fakeSession();
        const first = await acquireSchedulerLease(session as never, 'root', { ownerId: 'host-a', ttlMs: 60_000, now: () => 0 });
        await expect(first.assertOwned()).resolves.toBeUndefined();
        await first.release();
        const second = await acquireSchedulerLease(session as never, 'root', { ownerId: 'host-b', now: () => 1 });
        expect(second.epoch).toBe(2);
        await expect(first.assertOwned()).rejects.toSatisfy(isSchedulerOwnershipLost);
        // Releasing a fenced lease must not disturb the new owner.
        await first.release();
        expect((session.entries.get(schedulerOwnerKey('root'))?.value as { ownerId: string }).ownerId).toBe('host-b');
        await expect(second.assertOwned()).resolves.toBeUndefined();
    });

    it('rejects an expired owner without a successor and never revives it on heartbeat', async () => {
        vi.useFakeTimers();
        let now = 0;
        const session = fakeSession();
        const lease = await acquireSchedulerLease(session as never, 'root', { ttlMs: 3000, now: () => now });
        now = 2999;
        await expect(lease.assertOwned()).resolves.toBeUndefined();
        now = 3000;
        await expect(lease.assertOwned()).rejects.toSatisfy(isSchedulerOwnershipLost);
        await vi.advanceTimersByTimeAsync(1000);
        expect(session.entries.get(schedulerOwnerKey('root'))?.value).toMatchObject({ expiresAt: 3000 });
        now = 1000;
        await expect(lease.assertOwned()).rejects.toSatisfy(isSchedulerOwnershipLost);
        await lease.release();
    });

    it('does not renew after expiry even when no ownership check has run', async () => {
        vi.useFakeTimers();
        let now = 0;
        const session = fakeSession();
        const lease = await acquireSchedulerLease(session as never, 'root', { ttlMs: 3000, now: () => now });
        now = 4000;
        await vi.advanceTimersByTimeAsync(1000);
        expect(session.entries.get(schedulerOwnerKey('root'))?.value).toMatchObject({ expiresAt: 3000 });
        await expect(lease.assertOwned()).rejects.toSatisfy(isSchedulerOwnershipLost);
        await lease.release();
    });

    it('rejects a released lease before a successor appears', async () => {
        const lease = await acquireSchedulerLease(fakeSession() as never, 'root', { now: () => 0 });
        await lease.release();
        await expect(lease.assertOwned()).rejects.toSatisfy(isSchedulerOwnershipLost);
    });

    it('renews the lease while the host is alive', async () => {
        vi.useFakeTimers();
        let now = 0;
        const session = fakeSession();
        const lease = await acquireSchedulerLease(session as never, 'root',
            { ownerId: 'host-a', ttlMs: 3_000, now: () => now });
        expect((session.entries.get(schedulerOwnerKey('root'))?.value as { expiresAt: number }).expiresAt).toBe(3_000);
        now = 2_500;
        await vi.advanceTimersByTimeAsync(1_000);
        expect((session.entries.get(schedulerOwnerKey('root'))?.value as { expiresAt: number }).expiresAt).toBe(5_500);
        await lease.release();
        const after = session.entries.get(schedulerOwnerKey('root'))?.value as { expiresAt: number };
        expect(after.expiresAt).toBe(0);
    });
});

it.each([false, true])('serializes deletion and takeover and retains the tombstone (takeover first: %s)', async takeoverFirst => {
    const session = fakeSession();
    const lease = await acquireSchedulerLease(session as never, 'root', { ownerId: 'old', now: () => 0 });
    await lease.release();
    const deletion = () => markSchedulerRunDeleted(session as never, 'root', { now: () => 100 });
    const takeover = () => acquireSchedulerLease(session as never, 'root', { ownerId: 'new', now: () => 100 });
    const outcomes = await Promise.allSettled(takeoverFirst ? [takeover(), deletion()] : [deletion(), takeover()]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const winner = outcomes[takeoverFirst ? 0 : 1];
    if (winner.status === 'fulfilled' && winner.value) {
        await expect(markSchedulerRunDeleted(session as never, 'root', { now: () => 100 })).rejects.toThrow('scheduled');
        await winner.value.release();
        await markSchedulerRunDeleted(session as never, 'root', { now: () => 100 });
    }
    await markSchedulerRunDeleted(session as never, 'root', { now: () => 100_000 });
    await expect(acquireSchedulerLease(session as never, 'root', { now: () => 100_000 })).rejects.toThrow('deleted');
    expect(session.entries.get(schedulerOwnerKey('root'))?.value).toMatchObject({ deleted: true, expiresAt: 0 });
});

it('refuses deletion during clock allowance and rejects unsupported records', async () => {
    const session = fakeSession();
    session.entries.set(schedulerOwnerKey('root'), { version: 1,
        value: { version: 1, ownerId: 'other', epoch: 1, expiresAt: 1000 } });
    await expect(markSchedulerRunDeleted(session as never, 'root', { now: () => 1199, skewMs: 200 })).rejects.toThrow('scheduled');
    await markSchedulerRunDeleted(session as never, 'root', { now: () => 1200, skewMs: 200 });
    session.entries.set(schedulerOwnerKey('invalid'), { version: 1, value: { version: 2 } });
    await expect(markSchedulerRunDeleted(session as never, 'invalid')).rejects.toThrow('Invalid');
    await expect(acquireSchedulerLease(session as never, 'invalid')).rejects.toThrow('Invalid');
});
