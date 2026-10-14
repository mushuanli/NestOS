// @file: llm-flow/src/flow/scheduler-lease.ts
// Run 级调度所有权：让同一 Run 在任何时刻只有一个宿主在推进调度。
//
// 记录写在 Session shared `flow.run.<rootTaskId>.scheduler-owner`，带 epoch 与到期时间。
// 接管只在旧租约到期后发生（不能凭“我更快”强夺仍在心跳的拥有者），fencing 由每次调度
// 步进前的 assertOwned 完成：epoch 变化即停止推进，旧拥有者的后续写入不会推进业务状态。

import { KernelErrorCode, type SharedLeaseCondition, type JsonValue, type SessionHandle } from '@itookit/durable-kernel';

export interface SchedulerLeaseRecord {
    version: 1;
    ownerId: string;
    /** 每次成功接管递增；同一 owner 续租不变。 */
    epoch: number;
    expiresAt: number;
    /** Permanent tombstone: this Run must never acquire a new scheduler. */
    deleted?: true;
}

/** 抛给调度循环的哨兵错误：本宿主已不是该 Run 的调度者，应停止推进而不是把 Run 判失败。 */
export class SchedulerOwnershipLostError extends Error {
    constructor(readonly epoch: number) {
        super(`Flow scheduler ownership lost (epoch ${epoch})`);
        this.name = 'SchedulerOwnershipLostError';
    }
}

export function isSchedulerOwnershipLost(error: unknown): error is SchedulerOwnershipLostError {
    return error instanceof SchedulerOwnershipLostError
        || (error instanceof Error && 'code' in error && error.code === KernelErrorCode.STALE_SHARED_LEASE);
}

export interface SchedulerLeaseOptions {
    /** 租约有效期，默认 30s；到期后其他宿主可接管。 */
    ttlMs?: number;
    /**
     * 明确的跨主机时钟误差约束（默认 0，仅本机/同时钟源部署）。
     * 接管要求旧租约到期后再经过 skewMs，避免快时钟宿主抢走慢时钟宿主的活租约。
     */
    skewMs?: number;
    /** 测试或宿主指定身份；默认随机生成。 */
    ownerId?: string;
    /** 时钟注入，便于测试到期与接管。 */
    now?(): number;
}

export interface SchedulerLease {
    readonly ownerId: string;
    readonly epoch: number;
    readonly condition: SharedLeaseCondition;
    /** 每次调度步进前调用；租约丢失（被接管/过期）时抛错。 */
    assertOwned(): Promise<void>;
    /** 主动放弃所有权，使后续 resume 无需等待到期。 */
    release(): Promise<void>;
}

/** Session shared key holding the Run's scheduler ownership record. */
export const schedulerOwnerKey = (rootTaskId: string): string => `flow.run.${rootTaskId}.scheduler-owner`;

export async function acquireSchedulerLease(
    session: SessionHandle,
    rootTaskId: string,
    options: SchedulerLeaseOptions = {},
): Promise<SchedulerLease> {
    const key = schedulerOwnerKey(rootTaskId);
    const ttlMs = Math.max(1_000, options.ttlMs ?? 30_000);
    const skewMs = options.skewMs ?? 0;
    if (!Number.isSafeInteger(skewMs) || skewMs < 0) throw new Error('skewMs must be a non-negative safe integer');
    const now = (): number => options.now?.() ?? Date.now();
    const ownerId = options.ownerId ?? createOwnerId();
    for (let attempt = 0; attempt < 5; attempt++) {
        const saved = await session.getShared(key);
        const current = parseSchedulerLeaseRecord(saved?.value);
        if (saved && !current) throw new Error('Invalid scheduler lease record');
        if (current?.deleted) throw new Error('Run has been deleted');
        if (current && current.ownerId !== ownerId && current.expiresAt > 0 && current.expiresAt + skewMs > now()) {
            const until = new Date(current.expiresAt + skewMs).toISOString();
            throw new Error(`Run is scheduled by ${current.ownerId} until ${until};`
                + (skewMs > 0 ? ` takeover waits for the configured ${skewMs}ms clock skew budget;` : '')
                + ' wait for the lease to expire or stop the other host');
        }
        const record: SchedulerLeaseRecord = {
            version: 1, ownerId, epoch: (current?.epoch ?? 0) + 1, expiresAt: now() + ttlMs,
        };
        try {
            await session.setShared(key, record as unknown as JsonValue, { expectedVersion: saved?.version ?? null });
            return createLease(session, key, record, ttlMs, now);
        } catch (error) {
            // Another host took over between read and write; retry with its epoch.
            if (attempt === 4) throw error;
        }
    }
    throw new Error('Scheduler lease acquisition failed');
}

function createLease(session: SessionHandle, key: string, record: SchedulerLeaseRecord, ttlMs: number, now: () => number): SchedulerLease {
    return new OwnedSchedulerLease(session, key, record, ttlMs, now);
}

class OwnedSchedulerLease implements SchedulerLease {
    private released = false;
    private lost = false;
    private readonly heartbeat: ReturnType<typeof setInterval>;
    readonly condition: SharedLeaseCondition;
    get ownerId(): string { return this.record.ownerId; }
    get epoch(): number { return this.record.epoch; }

    constructor(private readonly session: SessionHandle, private readonly key: string,
        private readonly record: SchedulerLeaseRecord, private readonly ttlMs: number, private readonly now: () => number) {
        this.condition = Object.freeze({ key, ownerId: record.ownerId, epoch: record.epoch });
        this.heartbeat = setInterval(() => { void this.renew(); }, Math.max(250, Math.floor(ttlMs / 3)));
        (this.heartbeat as unknown as { unref?: () => void }).unref?.();
    }

    private matches(current?: SchedulerLeaseRecord): current is SchedulerLeaseRecord {
        return !!current && !current.deleted && current.ownerId === this.ownerId && current.epoch === this.epoch;
    }

    private async renew(): Promise<void> {
        if (this.released || this.lost) return;
        const saved = await this.session.getShared(this.key).catch(() => undefined);
        const current = parseSchedulerLeaseRecord(saved?.value);
        if (this.released || this.lost || !this.matches(current) || current.expiresAt <= this.now()) {
            this.lost = true; return;
        }
        await this.session.setShared(this.key, { ...current, expiresAt: this.now() + this.ttlMs } as unknown as JsonValue,
            { expectedVersion: saved?.version ?? null, lease: this.condition }).catch(error => {
                if (isSchedulerOwnershipLost(error)) this.lost = true;
            });
    }

    async assertOwned(): Promise<void> {
        const current = parseSchedulerLeaseRecord((await this.session.getShared(this.key))?.value);
        if (this.released || this.lost || !this.matches(current) || current.expiresAt <= this.now()) {
            this.lost = true;
            throw new SchedulerOwnershipLostError(this.epoch);
        }
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        clearInterval(this.heartbeat);
        const saved = await this.session.getShared(this.key).catch(() => undefined);
        const current = parseSchedulerLeaseRecord(saved?.value);
        if (!this.matches(current)) return;
        await this.session.setShared(this.key, { ...current, expiresAt: 0 } as unknown as JsonValue,
            { expectedVersion: saved?.version ?? null }).catch(() => undefined);
    }
}

export function parseSchedulerLeaseRecord(value: JsonValue | undefined): SchedulerLeaseRecord | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, JsonValue>;
    const ownerId = record.ownerId, epoch = record.epoch, expiresAt = record.expiresAt;
    if (record.version !== 1 || (record.deleted !== undefined && record.deleted !== true)) return undefined;
    if (typeof ownerId !== 'string' || !ownerId) return undefined;
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) return undefined;
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0) return undefined;
    return { version: 1, ownerId, epoch, expiresAt, ...(record.deleted === true ? { deleted: true as const } : {}) };
}

function createOwnerId(): string {
    return `scheduler-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Compete with scheduler acquisition on the same CAS record, retaining deletion across failures. */
export async function markSchedulerRunDeleted(
    session: Pick<SessionHandle, 'getShared' | 'setShared'>,
    rootTaskId: string,
    options: Pick<SchedulerLeaseOptions, 'skewMs' | 'now'> = {},
): Promise<void> {
    const skewMs = options.skewMs ?? 0;
    if (!Number.isSafeInteger(skewMs) || skewMs < 0) throw new Error('skewMs must be a non-negative safe integer');
    const key = schedulerOwnerKey(rootTaskId);
    for (let attempt = 0; attempt < 5; attempt++) {
        const saved = await session.getShared(key);
        const current = parseSchedulerLeaseRecord(saved?.value);
        if (saved && !current) throw new Error('Invalid scheduler lease record; deletion refused');
        if (current?.deleted) return;
        if (current && current.expiresAt > 0 && current.expiresAt + skewMs > (options.now?.() ?? Date.now())) {
            throw new Error(`Run is scheduled by ${current.ownerId} until ${new Date(current.expiresAt + skewMs).toISOString()}; deletion refused`);
        }
        const epoch = (current?.epoch ?? 0) + 1;
        if (!Number.isSafeInteger(epoch)) throw new Error('Scheduler epoch exhausted');
        try {
            await session.setShared(key, { version: 1, ownerId: 'deleted', epoch, expiresAt: 0, deleted: true },
                { expectedVersion: saved?.version ?? null });
            return;
        } catch (error) { if (attempt === 4) throw error; }
    }
}
