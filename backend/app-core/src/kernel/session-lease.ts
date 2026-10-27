import { FSError, pathUtils, type IFileSystem } from '@itookit/vfs-core';

export type SessionOwnerKind = 'cli' | 'tauri' | 'web';

export interface SessionLeaseOwner {
    id: string;
    kind: SessionOwnerKind;
}

export interface SessionLeaseRecord {
    sessionId: string;
    ownerId: string;
    ownerKind: SessionOwnerKind;
    fencingToken: number;
    leaseUntil: number;
    heartbeatAt: number;
}

export interface SessionLeaseOptions {
    /** Profile-relative seqfile used for all Session leases. */
    path?: string;
    /** Default lease duration. */
    ttlMs?: number;
    /**
     * Explicit cross-host clock-error budget (default 0 = single host or one clock source).
     * Takeover requires `leaseUntil + skewMs`, so a host whose clock runs fast cannot take
     * over a live Session lease from a host whose clock runs slow.
     */
    skewMs?: number;
    /** Injectable clock for tests. */
    now?: () => number;
}

const DEFAULT_PATH = '/var/lib/kernel/session-leases.seq';
const DEFAULT_TTL_MS = 60_000;

/** Single-owner-per-Session lease stored in the shared NestOS SeqFiles. */
export class SessionLeaseStore {
    private readonly path: string;
    private readonly ttlMs: number;
    private readonly skewMs: number;
    private readonly now: () => number;
    /** Lease storage exists once per store; the heartbeat must not stat it every renew. */
    private ensured?: Promise<void>;

    constructor(private readonly fs: IFileSystem, options: SessionLeaseOptions = {}) {
        this.path = options.path ?? DEFAULT_PATH;
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.skewMs = options.skewMs ?? 0;
        if (!Number.isSafeInteger(this.skewMs) || this.skewMs < 0) throw new Error('skewMs must be a non-negative safe integer');
        this.now = options.now ?? Date.now;
    }

    async init(): Promise<void> {
        if (!this.fs.meta.seq?.transaction) throw new Error('Session leases require transactional SeqFiles');
        const ensured = this.ensured ??= this.ensureFile();
        try {
            await ensured;
        } catch (error) {
            // A failed ensure must be retried by the next caller instead of caching the failure.
            if (this.ensured === ensured) this.ensured = undefined;
            throw error;
        }
    }

    private async ensureFile(): Promise<void> {
        if (!await this.fs.driver.exists(this.path)) {
            await this.fs.driver.createFile({ name: pathUtils.basename(this.path), parentPath: pathUtils.dirname(this.path), type: 'seqfile', recursive: true });
        }
    }

    async inspect(sessionId: string): Promise<SessionLeaseRecord | null> {
        await this.init();
        const raw = await this.fs.meta.seq!.getEntry(this.path, key(sessionId));
        return raw ? parse(raw) : null;
    }

    async acquire(sessionId: string, owner: SessionLeaseOwner): Promise<SessionLeaseRecord | null> {
        return (await this.acquireMany([sessionId], owner)).get(sessionId) ?? null;
    }

    /** One observed read and atomic commit; refused Sessions never enter the write set. */
    async acquireMany(sessionIds: readonly string[], owner: SessionLeaseOwner): Promise<Map<string, SessionLeaseRecord>> {
        const ids = [...new Set(sessionIds)];
        const keys = ids.map(key);
        if (!ids.length) return new Map();
        await this.init();
        const seq = this.fs.meta.seq!;
        if (!seq.transaction) throw new Error('Session leases require transactional SeqFiles');
        return seq.transaction(async tx => {
            const entries = await tx.getEntries(this.path, keys);
            const acquired = new Map<string, SessionLeaseRecord>();
            for (const id of ids) {
                const raw = entries[key(id)], current = raw ? parse(raw) : null, now = this.now();
                if (current && current.ownerId !== owner.id && current.leaseUntil + this.skewMs > now) continue;
                const record: SessionLeaseRecord = { sessionId: id, ownerId: owner.id, ownerKind: owner.kind,
                    fencingToken: (current?.fencingToken ?? 0) + 1, leaseUntil: now + this.ttlMs, heartbeatAt: now };
                // The transaction validates the observed batch before committing any lease.
                await tx.setEntry(this.path, key(id), JSON.stringify(record));
                acquired.set(id, record);
            }
            return acquired;
        });
    }

    async renew(lease: SessionLeaseRecord): Promise<SessionLeaseRecord | null> {
        await this.init();
        const seq = this.fs.meta.seq!;
        if (!seq.transaction) throw new Error('Session leases require transactional SeqFiles');
        return seq.transaction(async tx => {
            const raw = await tx.getEntry(this.path, key(lease.sessionId));
            const current = raw ? parse(raw) : null;
            if (!current || current.ownerId !== lease.ownerId || current.fencingToken !== lease.fencingToken) return null;
            const now = this.now();
            if (current.leaseUntil <= now) return null;
            const next = { ...current, leaseUntil: now + this.ttlMs, heartbeatAt: now };
            const changed = await tx.compareAndSet(this.path, key(lease.sessionId), {
                expected: raw,
                value: JSON.stringify(next),
            });
            return changed ? next : null;
        });
    }

    async release(lease: SessionLeaseRecord): Promise<boolean> {
        await this.init();
        const seq = this.fs.meta.seq!;
        if (!seq.transaction) throw new Error('Session leases require transactional SeqFiles');
        return seq.transaction(async tx => {
            const raw = await tx.getEntry(this.path, key(lease.sessionId));
            const current = raw ? parse(raw) : null;
            const now = this.now();
            if (!current || current.ownerId !== lease.ownerId || current.fencingToken !== lease.fencingToken
                || current.leaseUntil <= now) return false;
            return tx.compareAndSet(this.path, key(lease.sessionId), {
                expected: raw,
                value: JSON.stringify({ ...current, leaseUntil: 0, heartbeatAt: now }),
            });
        });
    }
}

function key(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid Session lease identity');
    return `lease/${sessionId}`;
}

function parse(raw: string): SessionLeaseRecord {
    const value = JSON.parse(raw) as SessionLeaseRecord;
    if (!value || typeof value.sessionId !== 'string' || typeof value.ownerId !== 'string'
        || !['cli', 'tauri', 'web'].includes(value.ownerKind)
        || !Number.isSafeInteger(value.fencingToken) || !Number.isFinite(value.leaseUntil)) {
        throw new Error('Invalid Session lease record');
    }
    return value;
}

/** Renew existing ownership without reentering recovery or acquiring a different owner's Session. */
export async function renewSessionWriteLease(sessionId: string, held: Map<string, SessionLeaseRecord>,
    renew: (lease: SessionLeaseRecord) => Promise<SessionLeaseRecord | null>): Promise<void> {
    const current = held.get(sessionId);
    if (!current) throw new FSError('EACCES', 'Session write lease is not held');
    const renewed = await renew(current);
    const latest = held.get(sessionId);
    if (!renewed || renewed.sessionId !== sessionId || renewed.ownerId !== current.ownerId || renewed.fencingToken !== current.fencingToken
        || latest?.ownerId !== current.ownerId || latest.fencingToken !== current.fencingToken)
        throw new FSError('EACCES', 'Session write lease was lost');
    held.set(sessionId, renewed);
}
