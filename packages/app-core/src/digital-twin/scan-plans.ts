import { matchesRules } from './scan-rules';
import type { TwinSourceIndex } from './source-index';
import { randomUUID } from '@itookit/common';
import { TWIN_KINDS, type TwinSourceData, type TwinSettings } from './domain';
import { scanInput, type TwinScanPlan, type TwinScanPlanInput, type TwinScanRun } from './scan-domain';
import { TwinScanStore, retry, type ScanSchedule } from './scan-store';
import { write, type TwinDataRecord } from './records';
import { TwinSources } from './sources';

export class TwinScanPlans {
    constructor(readonly store: TwinScanStore, private readonly sources: TwinSources, private readonly index?: TwinSourceIndex) {}
    async save(id: string | null, revision: string | null, input: TwinScanPlanInput): Promise<string> {
        const data = await this.input(input), current = id ? await this.store.records.get<TwinScanPlan>('scan-plan', id) : null;
        if ((id && !current) || (current?.revision ?? null) !== revision) throw new Error('TWIN_REVIEW_CONFLICT');
        const connectionFingerprint = await this.sources.fingerprint(data.connectionId);
        const sources = await this.boundSources(data.rules ? [] : data.sourceIds, data.connectionId, connectionFingerprint);
        id ??= randomUUID();
        const schedule = await this.schedule(id);
        await this.store.commit([write('scan-plan', id, { ...data, connectionFingerprint,
            createdAt: current?.data.createdAt ?? this.store.now(), updatedAt: this.store.now() }, revision),
            write('checkpoint', scheduleId(id), { planRevision: '', nextAt: data.trigger === 'manual' ? 0 : this.store.now(), signature: '' }, schedule?.revision ?? null)],
        sources.map(source => ({ family: 'source', id: source.id, expectedRevision: source.revision })));
        return id;
    }
    async initializeDefault(): Promise<void> {
        if (await this.store.records.get('checkpoint', 'scan-rules-initialized')) return;
        const settings = (await this.store.records.get<TwinSettings>('settings', 'pot'))!;
        if (!settings.data.connectionId) return;
        const writes = [write('checkpoint', 'scan-rules-initialized', { initialized: true }, null)];
        if (!(await this.store.records.list<TwinScanPlan>('scan-plan')).some(plan => plan.data.rules)) {
            const id = randomUUID(), connectionFingerprint = await this.sources.fingerprint(settings.data.connectionId).catch(() => '');
            if (!connectionFingerprint) return;
            const data: TwinScanPlan = { name: 'Default', rules: { include: [], exclude: [] }, sourceIds: [],
                connectionId: settings.data.connectionId, connectionFingerprint, kinds: [...TWIN_KINDS], mode: 'analyze',
                trigger: 'interval', intervalMinutes: 30, tokenLimit: settings.data.tokenLimit, enabled: true, autoConfirm: true,
                createdAt: this.store.now(), updatedAt: this.store.now() };
            writes.push(write('scan-plan', id, data, null), write('checkpoint', scheduleId(id), { planRevision: '', nextAt: this.store.now(), signature: '' }, null));
        }
        try { await this.store.commit(writes, [{ family: 'settings', id: settings.id, expectedRevision: settings.revision }]); }
        catch (error) { if (!await this.store.records.get('checkpoint', 'scan-rules-initialized')) throw error; }
    }
    async refreshBindings(): Promise<Array<{ id: string; revision: string }>> {
        const settings = (await this.store.records.get<TwinSettings>('settings', 'pot'))!.data;
        if (!settings.connectionId) return [];
        const fingerprint = await this.sources.fingerprint(settings.connectionId).catch(() => '');
        if (!fingerprint) return [];
        const changed: Array<{ id: string; revision: string }> = [];
        for (const plan of await this.store.records.list<TwinScanPlan>('scan-plan')) {
            if (!plan.data.rules || (plan.data.connectionId === settings.connectionId && plan.data.connectionFingerprint === fingerprint)) continue;
            await this.save(plan.id, plan.revision, plan.data);
            changed.push({ id: plan.id, revision: (await this.store.records.get('scan-plan', plan.id))!.revision });
        }
        return changed;
    }
    private async input(input: TwinScanPlanInput): Promise<TwinScanPlanInput> {
        if (!input.rules) return scanInput(input);
        const settings = (await this.store.records.get<TwinSettings>('settings', 'pot'))!.data;
        if (!settings.connectionId) throw new Error('TWIN_CONNECTION_REQUIRED');
        return scanInput({ ...input, sourceIds: [], connectionId: settings.connectionId ?? '', tokenLimit: settings.tokenLimit });
    }
    async selected(plan: TwinScanPlan): Promise<TwinDataRecord<TwinSourceData>[]> {
        if (!plan.rules) return this.boundSources(plan.sourceIds, plan.connectionId, plan.connectionFingerprint);
        return (await this.store.records.list<TwinSourceData>('source')).filter(source => source.data.managed && source.data.enabled
            && source.data.status === 'available' && source.data.resource && matchesRules(source.data.resource, plan.rules!)
            && source.data.connectionFingerprint === plan.connectionFingerprint);
    }
    async boundSources(ids: string[], connectionId: string, fingerprint: string) {
        const sources = await Promise.all(ids.map(id => this.store.records.get<TwinSourceData>('source', id)));
        if (sources.some(source => !source?.data.enabled || source.data.connectionId !== connectionId
            || source.data.connectionFingerprint !== fingerprint)) throw new Error('TWIN_SCAN_SOURCE_DENIED');
        return sources as TwinDataRecord<TwinSourceData>[];
    }
    async schedule(id: string) {
        const schedule = await this.store.records.get<ScanSchedule>('checkpoint', scheduleId(id));
        if (schedule && (typeof schedule.data.planRevision !== 'string' || typeof schedule.data.signature !== 'string'
            || !Number.isSafeInteger(schedule.data.nextAt) || schedule.data.nextAt < 0)) throw new Error('TWIN_INVALID_SCAN_SCHEDULE');
        return schedule;
    }
    async enqueue(planId: string, trigger: TwinScanRun['trigger'] = 'manual', signature = '', refresh = true): Promise<string> {
        if (refresh) await this.index?.sync();
        return retry(async () => {
            const plan = await this.store.records.get<TwinScanPlan>('scan-plan', planId);
            if (!plan?.data.enabled) throw new Error('TWIN_SCAN_PLAN_DISABLED');
            if (await this.sources.fingerprint(plan.data.connectionId) !== plan.data.connectionFingerprint) throw new Error('TWIN_CONNECTION_CHANGED');
            const sources = await this.selected(plan.data);
            const settings = (await this.store.records.get<TwinSettings>('settings', 'pot'))!.data;
            return this.insert(planId, plan.revision, { ...plan.data, tokenLimit: plan.data.rules ? settings.tokenLimit : plan.data.tokenLimit, sourceIds: sources.map(source => source.id) }, trigger, false, signature);
        });
    }
    async enqueueSource(id: string): Promise<string> {
        const source = await this.store.records.get<TwinSourceData>('source', id);
        if (!source?.data.enabled) throw new Error('TWIN_SOURCE_DENIED');
        return retry(() => this.insert('', '', { name: source.data.label || source.data.target, sourceIds: [id],
            connectionId: source.data.connectionId, connectionFingerprint: source.data.connectionFingerprint,
            kinds: [...TWIN_KINDS], mode: 'analyze', tokenLimit: 10000000 }, 'manual', true));
    }
    private async insert(planId: string, planRevision: string, data: Pick<TwinScanPlan, 'name' | 'sourceIds' | 'connectionId' | 'connectionFingerprint' | 'kinds' | 'mode' | 'tokenLimit' | 'rules' | 'autoConfirm'>,
        trigger: TwinScanRun['trigger'], singleBatch: boolean, signature = ''): Promise<string> {
        const queue = await this.store.queue(), active = await this.store.active();
        const existing = active.find(run => planId ? run.data.planId === planId : !run.data.planId && run.data.sourceIds[0] === data.sourceIds[0]);
        if (existing) return existing.id;
        if (queue.runIds.length >= 100) throw new Error('TWIN_SCAN_QUEUE_LIMIT');
        const id = randomUUID(), run: TwinScanRun = { name: data.name, sourceIds: data.sourceIds, connectionId: data.connectionId,
            connectionFingerprint: data.connectionFingerprint, kinds: data.kinds, mode: data.mode, tokenLimit: data.tokenLimit,
            ...(data.rules ? { rules: data.rules, autoConfirm: data.autoConfirm } : {}), planId, planRevision, state: 'queued', trigger, singleBatch,
            completedSourceIds: [], reservedTokens: 0, spentTokens: 0, createdAt: this.store.now(), startedAt: 0, finishedAt: 0, owner: '', fence: 0, error: '' };
        const writes = [write('scan-run', id, run, null), write('checkpoint', 'scan-queue', { runIds: [...queue.runIds, id] }, queue.record?.revision ?? null)];
        if (planId) {
            const plan = (await this.store.records.get<TwinScanPlan>('scan-plan', planId))!, schedule = await this.schedule(planId);
            writes.push(write('checkpoint', scheduleId(planId), { planRevision, nextAt: this.store.now() + plan.data.intervalMinutes * 60000, signature }, schedule?.revision ?? null));
        }
        await this.store.commit(writes, planId ? [{ family: 'scan-plan', id: planId, expectedRevision: planRevision }] : []);
        return id;
    }
}
export const scheduleId = (id: string) => `scan-schedule:${id}`;
