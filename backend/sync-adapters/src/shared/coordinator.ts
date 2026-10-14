import { assertSync, nextDecimal, randomId, SyncError, type CoordinationGuard, type Coordinator } from '@itookit/vfs-sync';
import type { LeaseAccess, Lease } from './lease';

export interface LeaseOptions { leaseMs?: number; heartbeatMs?: number; retryMs?: number; timeoutMs?: number; now?: () => number }

/** The host transaction serializes admission; every application mutation must fence ownership. */
export class LeaseCoordinator implements Coordinator {
    private readonly now: () => number;
    private readonly leaseMs: number;
    private readonly heartbeatMs: number;
    private readonly retryMs: number;
    private readonly timeoutMs: number;
    constructor(private readonly access: LeaseAccess, options: LeaseOptions = {}) {
        this.now = options.now ?? Date.now; this.leaseMs = options.leaseMs ?? 30000;
        this.heartbeatMs = options.heartbeatMs ?? 10000; this.retryMs = options.retryMs ?? 100;
        this.timeoutMs = options.timeoutMs ?? 60000;
        assertSync([this.leaseMs, this.heartbeatMs, this.retryMs, this.timeoutMs].every(Number.isSafeInteger), 'INVALID_COORDINATION_OPTIONS');
        assertSync(this.leaseMs > this.heartbeatMs && this.heartbeatMs > 0 && this.retryMs > 0 && this.timeoutMs > 0, 'INVALID_COORDINATION_OPTIONS');
    }
    async exclusive<T>(key: string, action: (guard?: CoordinationGuard) => Promise<T>): Promise<T> {
        const field = 'lease:' + key, owner = randomId(), started = Date.now();
        let lease: Lease | undefined;
        while (!(lease = await this.acquire(field, owner))) {
            if (Date.now() - started >= this.timeoutMs) throw new SyncError('SYNC_COORDINATION_BUSY');
            await new Promise(resolve => setTimeout(resolve, this.retryMs));
        }
        const guard = this.access.guard(field, lease, this.now);
        let lost = false;
        const timer = setInterval(() => { void this.change(field, lease!, false).catch(() => { lost = true; }); }, this.heartbeatMs);
        try { const result = await action(guard); assertSync(!lost, 'SYNC_COORDINATION_LOST'); await guard.check(); return result; }
        finally { clearInterval(timer); await this.change(field, lease, true).catch(() => {}); }
    }
    private acquire(field: string, owner: string): Promise<Lease | undefined> {
        return this.access.transaction(async records => {
            const previous = await records.read(field);
            if (previous && previous.expiresAt > this.now()) return undefined;
            const lease = { owner, fence: nextDecimal(previous?.fence ?? '0'), expiresAt: this.now() + this.leaseMs };
            await records.write(field, lease); return lease;
        });
    }
    private change(field: string, expected: Lease, release: boolean): Promise<void> {
        return this.access.transaction(async records => {
            const current = await records.read(field);
            assertSync(current?.owner === expected.owner && current.fence === expected.fence, 'SYNC_COORDINATION_LOST');
            assertSync(release || current.expiresAt > this.now(), 'SYNC_COORDINATION_LOST');
            await records.write(field, { ...current, expiresAt: release ? 0 : this.now() + this.leaseMs });
        });
    }
}
