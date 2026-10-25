import { traceBoot } from '@itookit/common';
import type { Kernel } from '@itookit/durable-kernel';
import { SessionLeaseStore, type SessionLeaseRecord, type SessionOwnerKind } from '../kernel/session-lease';
import { summarizeRecovery, type RecoverySample } from './recovery-trace';
import { mapConcurrent } from '../utils/map-concurrent';

type RecoveryKernel = Pick<Kernel, 'listSessions' | 'recoverSessions' | 'recoverSession'>;
type Owner = { id: string; kind: SessionOwnerKind };
type BeforeRecovery = (id: string, ensureLeases: (ids: string[]) => Promise<void>) => Promise<void>;
const BOOT_RECONCILIATION_CONCURRENCY = 10;
const BOOT_LEASE_BATCH_SIZE = 100;
export interface SessionRecovery {
    leases: Map<string, SessionLeaseRecord>;
    /** Acquire and recover before admitting writes; concurrent requests share one recovery. */
    acquireLater(sessionId: string): Promise<boolean>;
    /** Lease for structural writes (create/delete/move); waits out the boot sweep of that Session. */
    acquireMetadataLease(sessionId: string): Promise<boolean>;
    startBackground(): void;
    release(): Promise<void>;
}

class LeasedRecovery implements SessionRecovery {
    readonly leases = new Map<string, SessionLeaseRecord>();
    private readonly ready = new Set<string>();
    private readonly pending = new Map<string, Promise<boolean>>();
    private readonly renewals = new Map<string, Promise<boolean>>();
    private readonly heartbeat: ReturnType<typeof setInterval>;
    private sweep?: Promise<void>;
    private swept?: Set<string>;
    private released = false;
    private scanning?: Promise<void>;
    private readonly acquisitions = new Map<string, Promise<boolean>>();
    constructor(private kernel: RecoveryKernel, private store: SessionLeaseStore, private owner: Owner,
        heartbeatMs: number, private beforeRecover?: BeforeRecovery, private excluded = new Set<string>()) {
        this.heartbeat = setInterval(() => {
            for (const id of this.leases.keys()) void this.renew(id).catch(error => console.warn(`[Lease] renew failed for Session ${id}`, error));
        }, heartbeatMs);
    }

    async boot(): Promise<void> {
        const ids: string[] = [];
        for await (const session of this.kernel.listSessions()) if (!this.excluded.has(session.id)) ids.push(session.id);
        for (let offset = 0; offset < ids.length; offset += BOOT_LEASE_BATCH_SIZE) {
            const batch = ids.slice(offset, offset + BOOT_LEASE_BATCH_SIZE);
            const acquired = await this.store.acquireMany(batch, this.owner);
            for (const [id, lease] of acquired) this.leases.set(id, lease);
            for (const id of batch) if (!acquired.has(id)) await this.reportRefused(id);
        }
        const leased = await mapConcurrent(ids.filter(id => this.leases.has(id)), BOOT_RECONCILIATION_CONCURRENCY, async id => {
            await this.beforeRecover?.(id, ids => this.ensureReconciliationLeases(ids));
            return id;
        });
        // Recovery is proportional to the catalog, so the host paints first and every write waits
        // for it through acquireLater; only lease acquisition and host reconciliation block boot.
        if (leased.length) this.startSweep(leased);
    }

    /** Online recovery is per Session and respects Task/Effect leases in other active Sessions. */
    startBackground(): void {
        if (this.scanning || this.released) return;
        this.scanning = this.scanOnline();
        void this.scanning.catch(error => console.warn('[Lease] Background scan failed; Sessions recover on access', error));
    }
    private async scanOnline(): Promise<void> {
        const ids: string[] = [];
        for await (const session of this.kernel.listSessions()) {
            if (this.released) return;
            if (!this.excluded.has(session.id)) ids.push(session.id);
        }
        await mapConcurrent(ids, 2, async id => {
            if (this.released) return;
            try { await this.acquireLater(id); }
            catch (error) { console.warn(`[Lease] Background recovery failed for ${id}`, error); }
        });
    }
    private async ensureReconciliationLeases(ids: string[]): Promise<void> {
        for (const id of ids) {
            if (this.released || this.excluded.has(id) || !(await this.renew(id) || await this.acquire(id)))
                throw new Error(`Session is owned by another host: ${id}`);
        }
    }

    private startSweep(leased: string[]): void {
        this.swept = new Set(leased);
        const sweep = this.recoverLeased(leased);
        this.sweep = sweep;
        void sweep.catch(error => {
            console.error('[Lease] Session recovery failed; writes stay blocked until a Session recovers on demand', error);
            // Later writes retry the affected Session online instead of failing on a stale sweep.
            if (this.sweep === sweep) this.sweep = undefined;
        });
    }

    /** Recovery is proportional to the leased catalog; report the per-Session split at boot. */
    private async recoverLeased(leased: string[]): Promise<void> {
        const samples: RecoverySample[] = [];
        try {
            await traceBoot(`recoverLeasedSessions (${leased.length} sessions, background)`,
                () => this.kernel.recoverSessions(leased,
                    { takeover: true, onSessionRecovered: (sessionId, timing) => { samples.push({ sessionId, ...timing }); } }));
            if (!this.released) for (const id of leased) if (this.leases.has(id)) this.ready.add(id);
        } finally {
            if (samples.length) console.log(`[Boot]   ↳ ${summarizeRecovery(samples)}`);
        }
    }

    /** Wait for the boot sweep before touching a Session it is still restoring. */
    private async settleSweep(id: string): Promise<void> {
        if (this.sweep && this.swept?.has(id)) await this.sweep;
    }

    async acquireMetadataLease(id: string): Promise<boolean> {
        if (this.released) return false;
        // Structural writes must not race the sweep; a failed sweep still leaves the lease gate.
        await this.settleSweep(id).catch(() => {});
        if (this.pending.has(id)) await this.pending.get(id);
        if (this.released || this.excluded.has(id)) return false;
        return await this.renew(id) || await this.acquire(id);
    }

    acquireLater(id: string): Promise<boolean> {
        if (this.released || this.excluded.has(id)) return Promise.resolve(false);
        const current = this.pending.get(id);
        if (current) return current;
        const work = this.prepare(id);
        this.pending.set(id, work);
        void work.finally(() => { if (this.pending.get(id) === work) this.pending.delete(id); }).catch(() => {});
        return work;
    }

    private async prepare(id: string): Promise<boolean> {
        // Captured before any await: a write that arrives while the sweep is pending must observe
        // that sweep's outcome, even when it settles during the lease renewal below.
        const sweep = this.sweep;
        if (await this.renew(id) && this.ready.has(id)) return !this.released;
        if (this.released) return false;
        // A Session leased at boot is recovered by the sweep; waiting here keeps its writes
        // refused until recovery finishes, and surfaces a sweep failure to the writer. A failed
        // or unfruitful sweep falls through to online recovery of this Session alone.
        if (sweep && !this.ready.has(id) && this.swept?.has(id)) {
            await sweep;
            if (this.ready.has(id)) return !this.released;
        }
        if (!await this.renew(id) && !await this.acquire(id)) return false;
        try {
            await this.beforeRecover?.(id, ids => this.ensureReconciliationLeases(ids));
            if (this.released) return false;
            // Online recovery respects existing Task/Effect leases; it never fences work in other Sessions.
            await this.kernel.recoverSession(id);
            if (this.released || !await this.renew(id)) return false;
            this.ready.add(id);
            return true;
        } catch (error) {
            this.ready.delete(id);
            const lease = this.leases.get(id);
            this.leases.delete(id);
            if (lease) await this.store.release(lease);
            throw error;
        }
    }

    private acquire(id: string): Promise<boolean> {
        const current = this.acquisitions.get(id);
        if (current) return current;
        const work = this.acquireLease(id);
        this.acquisitions.set(id, work);
        void work.finally(() => { if (this.acquisitions.get(id) === work) this.acquisitions.delete(id); }).catch(() => {});
        return work;
    }
    private async acquireLease(id: string): Promise<boolean> {
        const lease = await this.store.acquire(id, this.owner);
        if (!lease) {
            await this.reportRefused(id);
            return false;
        }
        this.leases.set(id, lease);
        return true;
    }

    private async reportRefused(id: string): Promise<void> {
        const held = await this.store.inspect(id);
        console.warn(`[Shell] Session ${id} is owned by ${held?.ownerKind}:${held?.ownerId} until ${held ? new Date(held.leaseUntil).toISOString() : 'unknown'}; leaving it read-only`);
    }

    private renew(id: string): Promise<boolean> {
        const existing = this.renewals.get(id);
        if (existing) return existing;
        const work = this.renewLease(id);
        this.renewals.set(id, work);
        void work.finally(() => { if (this.renewals.get(id) === work) this.renewals.delete(id); }).catch(() => {});
        return work;
    }

    private async renewLease(id: string): Promise<boolean> {
        const lease = this.leases.get(id);
        if (!lease) return false;
        try {
            const renewed = await this.store.renew(lease);
            if (this.leases.get(id)?.fencingToken !== lease.fencingToken) return false;
            if (renewed) { this.leases.set(id, renewed); return true; }
            this.leases.delete(id); this.ready.delete(id);
            console.warn(`[Lease] ownership lost for Session ${id}; writes require reacquisition`);
            return false;
        } catch (error) {
            this.leases.delete(id); this.ready.delete(id);
            throw error;
        }
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        clearInterval(this.heartbeat);
        // The sweep must finish before its leases are released; a failed sweep was reported to
        // every blocked writer already and must not break teardown.
        await Promise.allSettled([...(this.scanning ? [this.scanning] : []), ...(this.sweep ? [this.sweep] : []), ...this.pending.values(), ...this.renewals.values(), ...this.acquisitions.values()]);
        const results = await Promise.allSettled([...this.leases.values()].map(lease => this.store.release(lease)));
        this.leases.clear(); this.ready.clear();
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Session lease cleanup failed');
    }
}

/**
 * Boot acquires leases and reconciles each host's workspace, then recovers the leased Sessions in
 * the background: the host paints immediately and `acquireLater` refuses writes until it finishes.
 * Later acquisition recovers only the selected Session online.
 */
export async function recoverSessionsWithLeases(kernel: RecoveryKernel, leaseStore: SessionLeaseStore, owner: Owner,
    heartbeatMs = 10_000, beforeRecover?: BeforeRecovery, excluded = new Set<string>(), background: boolean | 'deferred' = false): Promise<SessionRecovery> {
    const recovery = new LeasedRecovery(kernel, leaseStore, owner, heartbeatMs, beforeRecover, excluded);
    if (background) { if (background === true) recovery.startBackground(); return recovery; }
    try { await recovery.boot(); return recovery; }
    catch (error) {
        try { await recovery.release(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Session recovery and lease cleanup failed'); }
        throw error;
    }
}
