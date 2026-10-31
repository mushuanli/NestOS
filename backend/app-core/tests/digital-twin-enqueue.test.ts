import {expect, it, vi} from 'vitest';
import {TwinScanPlans} from '../src/digital-twin/scan-plans';
import type {TwinScanStore} from '../src/digital-twin/scan-store';
import type {TwinSources} from '../src/digital-twin/sources';
import type {TwinSourceIndex} from '../src/digital-twin/source-index';

function fixture(mode: 'collect' | 'analyze', sync = vi.fn(async () => {})) {
    const plan = {id: 'plan', revision: 'r1', data: {mode, enabled: true, sourceIds: [], connectionId: 'model', connectionFingerprint: 'route', intervalMinutes: 30}};
    const commit = vi.fn(async () => {});
    const store = {records: {get: vi.fn(async (family, id) => family === 'scan-plan' ? plan : family === 'settings' ? {data: {tokenLimit: 100}} : null)},
        now: () => 1000, queue: async () => ({record: null, runIds: []}), active: async () => [], commit} as unknown as TwinScanStore;
    const sources = {fingerprint: vi.fn(async () => 'route')} as unknown as TwinSources;
    return {plans: new TwinScanPlans(store, sources, {sync} as unknown as TwinSourceIndex), sync, commit, plan};
}
it('enqueues pure collection without waiting for source discovery, and retains the plan revision condition', async () => {
    const f = fixture('collect', vi.fn(() => new Promise<void>(() => {})));
    const id = await f.plans.enqueue('plan');
    expect(id).toEqual(expect.any(String)); expect(f.sync).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({family: 'scan-run', payload: expect.objectContaining({mode: 'collect', state: 'queued'})})]),
        [{family: 'scan-plan', id: 'plan', expectedRevision: 'r1'}]);
});
it('waits for source indexing before enqueueing knowledge extraction', async () => {
    let release!: () => void;
    const f = fixture('analyze', vi.fn(() => new Promise<void>(resolve => {release = resolve;})));
    const pending = f.plans.enqueue('plan');
    await vi.waitFor(() => expect(f.sync).toHaveBeenCalledOnce());
    expect(f.commit).not.toHaveBeenCalled(); release(); await pending;
    expect(f.commit).toHaveBeenCalledOnce();
});
it('does not enqueue when indexing fails or a plan is disabled', async () => {
    const f = fixture('analyze', vi.fn(async () => {throw new Error('PRIVATE_FAILURE');}));
    await expect(f.plans.enqueue('plan')).rejects.toThrow('PRIVATE_FAILURE'); expect(f.commit).not.toHaveBeenCalled();
    f.plan.data.enabled = false;
    await expect(f.plans.enqueue('plan')).rejects.toThrow('TWIN_SCAN_PLAN_DISABLED'); expect(f.sync).toHaveBeenCalledOnce();
});
