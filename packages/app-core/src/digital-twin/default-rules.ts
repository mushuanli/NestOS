import type { TwinScanStore } from './scan-store';
import type { TwinScanPlan } from './scan-domain';
import { TWIN_KINDS } from './domain';
import { write } from './records';

/** Narrow only the untouched, previously seeded catch-all; preserve custom rules. */
export async function migrateMailDefault(store: TwinScanStore): Promise<void> {
    if (await store.records.get('checkpoint', 'mail-default-v1')) return;
    const plans = await store.records.list<TwinScanPlan>('scan-plan');
    const untouched = plans.filter(({ data }) => data.name === 'Default' && data.rules && !data.rules.include.length
        && !data.rules.exclude.length && !data.focus && data.intervalMinutes === 30 && data.createdAt === data.updatedAt
        && data.kinds.length === TWIN_KINDS.length);
    const writes = untouched.map(plan => write('scan-plan', plan.id, { ...plan.data, name: 'Mail',
        rules: { include: ['file:**/*.email', 'resource:file/%2Fhome%2Fadmin%2Femails%2F**'], exclude: [] }, updatedAt: store.now() }, plan.revision));
    writes.push(write('checkpoint', 'mail-default-v1', { migrated: true }, null));
    try { await store.commit(writes); }
    catch (error) { if (!await store.records.get('checkpoint', 'mail-default-v1')) throw error; }
}
