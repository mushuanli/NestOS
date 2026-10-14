import { randomUUID } from '@itookit/common';
import type { TwinRecordFamily, TwinRecordWrite } from './contracts';
import { TwinRecords, write, type TwinDataRecord } from './records';
import { identifiers, SCAN_TERMINAL, type TwinScanRun } from './scan-domain';

export interface ScanLease { owner: string; host: string; until: number; fence: number; }
export interface ScanSchedule { planRevision: string; nextAt: number; signature: string; }
type Condition = { family: TwinRecordFamily; id: string; expectedRevision: string | null };

/** The queue and host fence are domain records, not a second task execution engine. */
export class TwinScanStore {
    readonly owner = randomUUID();
    constructor(readonly records: TwinRecords, readonly host: string, readonly now: () => number = Date.now, readonly leaseMs = 60000) {}
    async commit(writes: TwinRecordWrite[], conditions: Condition[] = []): Promise<void> {
        await this.records.store.commit({ operationId: randomUUID(),
            expectedForgetEpoch: (await this.records.store.inspect()).forgetEpoch, writes, conditions });
    }
    async queue() {
        const record = await this.records.get<{ runIds: string[] }>('checkpoint', 'scan-queue');
        const runIds = record?.data.runIds ?? []; identifiers(runIds, 100, true);
        return { record, runIds };
    }
    async lease() {
        const record = await this.records.get<ScanLease>('checkpoint', 'scan-worker');
        if (record && (typeof record.data.owner !== 'string' || typeof record.data.host !== 'string'
            || !Number.isSafeInteger(record.data.until) || !Number.isSafeInteger(record.data.fence) || record.data.fence < 1)) throw new Error('TWIN_INVALID_SCAN_LEASE');
        return record;
    }
    async acquire(): Promise<number | null> {
        const lease = await this.lease();
        if (lease && lease.data.owner !== this.owner && lease.data.until > this.now()) return null;
        const fence = lease?.data.owner === this.owner && lease.data.until > this.now() ? lease.data.fence : (lease?.data.fence ?? 0) + 1;
        try {
            await this.records.save('checkpoint', 'scan-worker', { owner: this.owner, host: this.host, until: this.now() + this.leaseMs, fence }, lease?.revision ?? null);
            return fence;
        } catch (error) { if (conflict(error)) return null; throw error; }
    }
    /** Renew the same generation, including a delayed heartbeat if no other host took over. */
    async renew(fence: number): Promise<void> {
        await retry(async () => {
            const lease = await this.lease();
            if (!lease || lease.data.owner !== this.owner || lease.data.fence !== fence || lease.data.until === 0) throw new Error('TWIN_SCAN_LEASE_LOST');
            await this.records.save('checkpoint', lease.id, { ...lease.data, until: this.now() + this.leaseMs }, lease.revision);
        });
    }
    async release(): Promise<void> {
        const lease = await this.lease();
        if (lease?.data.owner === this.owner) await this.records.save('checkpoint', lease.id, { ...lease.data, until: 0 }, lease.revision);
    }
    async fence(fence: number): Promise<Condition> {
        let lease = await this.lease();
        if (lease?.data.owner === this.owner && lease.data.fence === fence && lease.data.until <= this.now()) {
            await this.renew(fence); lease = await this.lease();
        }
        if (!lease || lease.data.owner !== this.owner || lease.data.fence !== fence || lease.data.until <= this.now()) throw new Error('TWIN_SCAN_LEASE_LOST');
        return { family: 'checkpoint', id: lease.id, expectedRevision: lease.revision };
    }
    async active() {
        return retry(async () => {
            const { record, runIds } = await this.queue();
            const runs = await Promise.all(runIds.map(id => this.records.get<TwinScanRun>('scan-run', id)));
            if (runs.some(run => !run || SCAN_TERMINAL.includes(run.data.state))) {
                if ((await this.queue()).record?.revision !== record?.revision) throw new Error('Twin condition revision conflict');
                throw new Error('TWIN_INVALID_SCAN_QUEUE');
            }
            return runs as TwinDataRecord<TwinScanRun>[];
        });
    }
    async finish(id: string, state: TwinScanRun['state'], error = '', fence?: number, errorDetail = ''): Promise<void> {
        await retry(async () => {
            const run = await this.records.get<TwinScanRun>('scan-run', id), queue = await this.queue();
            if (!run || SCAN_TERMINAL.includes(run.data.state)) return;
            await this.commit([write('scan-run', id, { ...run.data, state, error, errorDetail, finishedAt: this.now() }, run.revision),
                write('checkpoint', 'scan-queue', { runIds: queue.runIds.filter(item => item !== id) }, queue.record?.revision ?? null)],
            fence === undefined ? [] : [await this.fence(fence)]);
        });
    }
}
export async function retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try { return await operation(); } catch (error) { if (attempt >= 4 || !conflict(error)) throw error; }
    }
}
export function conflict(error: unknown): boolean { return error instanceof Error && /Twin (revision|condition revision|forget epoch) conflict/.test(error.message); }
