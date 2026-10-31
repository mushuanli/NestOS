import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {DigitalTwinService} from '../src/digital-twin/service';
import {collectionProgress} from '../src/digital-twin/collection-progress';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});

it.each(['manual', 'interval'] as const)('persists a successful batch and continues %s collectors without model calls or rapid loops', async trigger => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    let now = 100000, batch = 0;
    const extractor = {run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn()};
    const twin = new DigitalTwinService({fs: await manager.openFileSystem('/'), scanHost: {kind: 'test', now: () => now},
        reader: {read: vi.fn(), sessions: async () => []}, extractor, deleteSession: async () => {}}); cleanup.push(() => twin.dispose());
    const collect = vi.fn(async () => ({version: 1 as const, complete: ++batch === 2, processed: batch * 2, batchCount: 0}));
    twin.setCollector({collect, validate: () => {}, cancelCollection: async () => {}});
    const plan = await twin.saveScanRule(null, null, {name: 'Batch collector', mode: 'collect', trigger, intervalMinutes: 30, enabled: true,
        include: [], exclude: [], collection: {target: {kind: 'tool', id: 'fixture.collect', version: '1', digest: 'fixed'}}});
    const first = await twin.runScanPlan(plan); await twin.waitScanRun(first);
    const snapshot = await twin.snapshot(), record = snapshot.scans.runs.find(item => item.id === first)!;
    expect(record.data).toMatchObject({state: 'succeeded', collectionProgress: {complete: false, processed: 2, batchCount: 0}, spentTokens: 0});
    const schedule = snapshot.scans.schedules.find(item => item.planId === plan)!;
    expect(schedule.nextAt).toBe(now + (trigger === 'interval' ? 15000 : 1800000));
    await twin.scanOnce(); expect(collect).toHaveBeenCalledTimes(1);
    if (trigger === 'interval') {now += 15000; await twin.scanOnce();} else await twin.waitScanRun(await twin.runScanPlan(plan));
    expect(collect).toHaveBeenCalledTimes(2); expect(extractor.run).not.toHaveBeenCalled();
    expect((await twin.snapshot()).scans.runs.some(item => item.data.collectionProgress?.complete)).toBe(true);
    if (trigger === 'interval') expect((await twin.snapshot()).scans.schedules.find(item => item.planId === plan)!.nextAt).toBe(now + 1800000);
});
it('reads the versioned progress receipt from direct and Flow outputs without exposing cursors or business fields', () => {
    const progress = {version: 1, complete: false, processed: 5, pageToken: 'PRIVATE_CURSOR'};
    expect(collectionProgress({outputs: {result: {content: {collection: progress}}}})).toEqual({version: 1, complete: false, processed: 5});
    expect(collectionProgress({nodes: {__flow_return: {outputs: {result: {content: {result: {collection: progress}}}}}}})?.complete).toBe(false);
    expect(collectionProgress({collection: {name: 'Business field'}})).toBeUndefined();
    expect(collectionProgress({collection: {...progress, batchCount: 0}})).toEqual({version: 1, complete: false, processed: 5, batchCount: 0});
    expect(() => collectionProgress({collection: {...progress, batchCount: -1}})).toThrow('TWIN_COLLECTION_RESULT_INVALID');
    expect(() => collectionProgress({collection: {...progress, processed: -1}})).toThrow('TWIN_COLLECTION_RESULT_INVALID');
});
