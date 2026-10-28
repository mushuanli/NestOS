import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {SeqTwinStore} from '../src/digital-twin/seq-twin-store';
import {TwinRecords} from '../src/digital-twin/records';
import {meterPeriod, reserveMeter, settleMeter} from '../src/digital-twin/metering';
import type {TwinAnalysisJob} from '../src/digital-twin/domain';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {vi.useRealTimers(); for (const close of cleanup.splice(0)) await close();});
async function setup() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const records = new TwinRecords(await SeqTwinStore.open(await manager.openFileSystem('/'), 'meter', 'owner'));
    let sequence = 0;
    const commit = async (writes: Awaited<ReturnType<typeof reserveMeter>>) => {
        if (!writes.length) return;
        await records.store.commit({operationId: 'meter-' + ++sequence, expectedForgetEpoch: 0, writes});
    };
    const job = {sessionId: 's', meterPeriod: '2026-10', reservedTokens: 100, createdAt: 1} as TwinAnalysisJob;
    return {records, commit, job};
}
it('reserves against concurrent usage and settles exactly once with a conflict on changed usage', async () => {
    const {records, commit, job} = await setup();
    await commit(await reserveMeter(records, 'a', job, 150));
    await expect(reserveMeter(records, 'b', job, 150)).rejects.toThrow('TWIN_MONTHLY_BUDGET_EXHAUSTED');
    await commit(await settleMeter(records, 'a', job, 30));
    expect((await records.get<any>('meter-period', '2026-10'))!.data).toEqual({spentTokens: 30, reservedTokens: 0});
    expect(await settleMeter(records, 'a', job, 30)).toEqual([]);
    await expect(settleMeter(records, 'a', job, 31)).rejects.toThrow('TWIN_METER_SETTLEMENT_CONFLICT');
});
it('keeps unknown usage reserved and settles into the original period after month rollover', async () => {
    const {records, commit, job} = await setup();
    await commit(await reserveMeter(records, 'a', job, 100));
    await commit(await settleMeter(records, 'a', job));
    expect((await records.get<any>('meter-entry', 'a'))!.data).toMatchObject({state: 'pending', reservedTokens: 100});
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:01Z'));
    expect(meterPeriod()).toBe('2026-11');
    await commit(await reserveMeter(records, 'b', {...job, meterPeriod: meterPeriod()}, 100));
    await commit(await settleMeter(records, 'a', job, 40, 'estimated'));
    expect((await records.get<any>('meter-period', '2026-10'))!.data).toEqual({spentTokens: 40, reservedTokens: 0});
    expect((await records.get<any>('meter-period', '2026-11'))!.data).toEqual({spentTokens: 0, reservedTokens: 100});
    expect((await records.get<any>('meter-entry', 'a'))!.data.usageKind).toBe('estimated');
});
it('uses conditional writes so concurrent reservations cannot both spend the last allowance', async () => {
    const {records, commit, job} = await setup();
    const first = await reserveMeter(records, 'a', job, 100), second = await reserveMeter(records, 'b', job, 100);
    await commit(first); await expect(commit(second)).rejects.toThrow();
    expect(await records.get('meter-entry', 'b')).toBeNull();
});
