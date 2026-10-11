import type { TwinSourceIndex } from './source-index';
import { randomUUID } from '@itookit/common';
import type { TwinAnalysis } from './analysis';
import type { TwinSettings } from './domain';
import type { TwinScanPlan, TwinScanPlanInput, TwinScanRun } from './scan-domain';
import { SCAN_TERMINAL } from './scan-domain';
import { TwinScanPlans } from './scan-plans';
import { TwinScanStore } from './scan-store';
import { TwinScanWorker } from './scan-worker';
import { TwinSources } from './sources';

export class TwinScans {
    readonly plans: TwinScanPlans;
    private readonly worker: TwinScanWorker;
    constructor(readonly store: TwinScanStore, sources: TwinSources, analysis: TwinAnalysis, private readonly changed: () => void, private readonly index?: TwinSourceIndex, maintenance?: () => Promise<void>) {
        this.plans = new TwinScanPlans(store, sources, index);
        this.worker = new TwinScanWorker(store, this.plans, sources, analysis, changed, index, maintenance);
    }
    async snapshot() {
        const lease = await this.store.lease();
        return { discovery: this.index?.status() ?? { errors: [] }, plans: await this.store.records.list<TwinScanPlan>('scan-plan'), runs: await this.store.records.list<TwinScanRun>('scan-run'),
            schedules: await Promise.all((await this.store.records.list<TwinScanPlan>('scan-plan')).map(async plan => ({
                planId: plan.id, nextAt: (await this.plans.schedule(plan.id))?.data.nextAt ?? 0 }))),
            worker: { ...this.worker.status(), ownerHost: lease && lease.data.until > this.store.now() ? lease.data.host : '', leaseUntil: lease?.data.until ?? 0 } };
    }
    async save(id: string | null, revision: string | null, input: TwinScanPlanInput, sync = true): Promise<string> {
        const result = await this.plans.save(id, revision, input);
        if (id) await this.cancelPlan(id, (await this.store.records.get('scan-plan', id))!.revision);
        if (sync) await this.index?.sync(); this.changed(); return result;
    }
    async enable(id: string, revision: string, enabled: boolean, sync = true): Promise<void> {
        const plan = await this.store.records.get<TwinScanPlan>('scan-plan', id);
        if (!plan || plan.revision !== revision) throw new Error('TWIN_REVIEW_CONFLICT');
        if (enabled) await this.plans.save(id, revision, { ...plan.data, enabled });
        else await this.store.records.save('scan-plan', id, { ...plan.data, enabled }, revision);
        await this.cancelPlan(id, enabled ? (await this.store.records.get('scan-plan', id))!.revision : undefined); if (sync) await this.index?.sync(); this.changed();
    }
    async remove(id: string, revision: string): Promise<void> {
        await this.store.records.store.startForget({ operationId: `scan-plan-${randomUUID()}`,
            expectedForgetEpoch: (await this.store.records.store.inspect()).forgetEpoch,
            records: [{ family: 'scan-plan', id }], conditions: [{ family: 'scan-plan', id, expectedRevision: revision }] });
        await this.cancelPlan(id); await this.index?.sync(); this.changed();
    }
    private async cancelPlan(id: string, exceptRevision?: string): Promise<void> {
        for (const run of await this.store.active()) if (run.data.planId === id && run.data.planRevision !== exceptRevision) await this.worker.cancel(run.id);
    }
    async refreshModels(): Promise<void> {
        for (const plan of await this.plans.refreshBindings()) await this.cancelPlan(plan.id, plan.revision);
    }
    async enqueue(id: string): Promise<string> { const runId = await this.plans.enqueue(id); this.changed(); return runId; }
    async analyzeSource(id: string): Promise<void> {
        if ((await this.store.records.get<TwinSettings>('settings', 'pot'))?.data.paused) throw new Error('TWIN_ANALYSIS_PAUSED');
        const runId = await this.plans.enqueueSource(id); this.changed();
        await this.wait(runId);
    }
    async wait(id: string): Promise<void> {
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
            await this.worker.pump();
            const run = await this.store.records.get<TwinScanRun>('scan-run', id);
            if (!run) throw new Error('TWIN_SCAN_RUN_MISSING');
            if (SCAN_TERMINAL.includes(run.data.state)) {
                if (run.data.state !== 'succeeded') throw new Error(run.data.error || 'TWIN_SCAN_CANCELLED');
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('TWIN_SCAN_WAIT_TIMEOUT');
    }
    pump() { return this.worker.pump(); }
    cancel(id: string) { return this.worker.cancel(id); }
    dispose() { return this.worker.dispose(); }
}
