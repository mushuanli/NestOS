import { diagnosticDetail } from './diagnostics';
import type { TwinSourceIndex } from './source-index';
import { sha256HexSync } from '@itookit/llm-context';
import type { TwinAnalysisJob, TwinSettings, TwinSourceData } from './domain';
import type { TwinAnalysis } from './analysis';
import { type TwinScanPlan, type TwinScanRun, type TwinScanScope, scanError } from './scan-domain';
import { TwinScanStore, conflict } from './scan-store';
import { TwinScanPlans, scheduleId } from './scan-plans';
import { TwinSources } from './sources';
import {write, type TwinDataRecord} from './records';

export interface TwinCollectionRunner {
    collect(run: TwinDataRecord<TwinScanRun>, attached: (taskId: string) => Promise<void>): Promise<import('@itookit/app-contracts').TwinCollectionProgress | void>;
    cancel(run: TwinDataRecord<TwinScanRun>): Promise<void>;
}
/** One online host coordinates scans; extraction still runs as native durable tasks. */
export class TwinScanWorker {
    private pumping?: Promise<void>;
    private stopped = false;
    private error = '';
    private renewing?: Promise<void>;
    constructor(private readonly store: TwinScanStore, private readonly plans: TwinScanPlans,
        private readonly sources: TwinSources, private readonly analysis: TwinAnalysis, private readonly changed: () => void, private readonly index?: TwinSourceIndex, private readonly maintenance: () => Promise<void> = async () => {}, private readonly collection?: TwinCollectionRunner) {}
    status() { return { host: this.store.host, online: !this.stopped, error: this.error }; }
    pump(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        return this.pumping ??= this.execute().catch(error => { this.error = scanError(error); this.changed(); })
            .finally(() => { this.pumping = undefined; });
    }
    async dispose(): Promise<void> {
        this.stopped = true;
        for (const job of await this.store.records.list<TwinAnalysisJob>('job')) {
            if (job.data.scanScope && ['queued', 'running'].includes(job.data.state)) {
                const run = await this.store.records.get<TwinScanRun>('scan-run', job.data.scanScope.runId);
                if (run?.data.owner === this.store.owner) await this.analysis.cancel(job.id);
            }
        }
        for (const run of await this.store.active()) if (run.data.collection && run.data.owner === this.store.owner) await this.collection?.cancel(run);
        await this.pumping;
        await this.store.release();
    }
    async cancel(id: string): Promise<void> {
        const run = await this.store.records.get<TwinScanRun>('scan-run', id);
        await this.store.finish(id, 'cancelled'); this.changed();
        if (run?.data.collection) await this.collection?.cancel(run);
        for (const job of await this.store.records.list<TwinAnalysisJob>('job')) {
            if (job.data.scanScope?.runId === id && ['queued', 'running'].includes(job.data.state)) await this.analysis.cancel(job.id);
        }
    }
    private async execute(): Promise<void> {
        const fence = await this.store.acquire();
        if (fence === null) return;
        this.error = '';
        const heartbeat = setInterval(() => { this.renewing ??= this.heartbeat(fence).finally(() => { this.renewing = undefined; }); }, Math.max(1000, this.store.leaseMs / 3));
        try {
            await this.recover(fence);
            await this.maintenance();
            for (const plan of await this.plans.refreshBindings()) {
                for (const run of await this.store.active()) if (run.data.planId === plan.id && run.data.planRevision !== plan.revision) await this.cancel(run.id);
            }
            // Reconciliation remains active when analysis or a plan is paused.
            if (await this.discoveryDue()) await this.index?.sync();
            await this.sources.reconcile(false);
            await this.schedule();
            while (!this.stopped) {
                const settings = await this.store.records.get<TwinSettings>('settings', 'pot');
                const run = (await this.store.active()).find(item => item.data.state === 'queued' && (!settings?.data.paused || item.data.mode === 'reconcile'));
                if (!run) break;
                await this.run(run, fence);
            }
        } finally { clearInterval(heartbeat); await this.renewing; await this.store.release(); this.changed(); }
    }
    private async discoveryDue(): Promise<boolean> {
        if ((await this.store.active()).some(run => run.data.rules && run.data.state === 'queued')) return true;
        for (const plan of await this.store.records.list<TwinScanPlan>('scan-plan')) {
            if (plan.data.rules && plan.data.mode !== 'collect' && ['interval', 'changes'].includes(plan.data.trigger) && plan.data.enabled && ((await this.plans.schedule(plan.id))?.data.nextAt ?? 0) <= this.store.now()) return true;
        }
        return false;
    }
    private async heartbeat(fence: number): Promise<void> {
        try { await this.store.renew(fence); }
        catch (error) { this.error = scanError(error); }
    }
    private async recover(fence: number): Promise<void> {
        for (const run of await this.store.active()) {
            if (run.data.state === 'running' && (run.data.owner !== this.store.owner || run.data.fence !== fence)) {
                if (run.data.collection) await this.collection?.cancel(run);
                await this.store.finish(run.id, 'interrupted', 'TWIN_SCAN_INTERRUPTED', fence);
                for (const job of await this.store.records.list<TwinAnalysisJob>('job')) {
                    if (job.data.scanScope?.runId === run.id && ['queued', 'running'].includes(job.data.state)) {
                        try { await this.analysis.cancel(job.id); } catch (error) { this.error = scanError(error); }
                    }
                }
                this.changed();
            }
        }
    }
    private async schedule(): Promise<void> {
        for (const plan of await this.store.records.list<TwinScanPlan>('scan-plan')) {
            if (!plan.data.enabled || ['manual', 'event'].includes(plan.data.trigger)) continue;
            const schedule = await this.plans.schedule(plan.id);
            if (schedule && schedule.data.nextAt > this.store.now()) continue;
            try {
                const sources = await this.plans.selected(plan.data);
                const signature = sha256HexSync(JSON.stringify(sources.map(source => source ?
                [source.id, source.data.hash, source.data.incarnation, source.data.enabled, source.data.status] : null)));
                if (plan.data.collection || plan.data.trigger === 'interval' || schedule?.data.signature !== signature) await this.plans.enqueue(plan.id, plan.data.trigger, signature, false);
                else await this.store.records.save('checkpoint', scheduleId(plan.id), { ...schedule!.data,
                    nextAt: this.store.now() + plan.data.intervalMinutes * 60000 }, schedule!.revision);
            } catch (error) { if (!conflict(error)) this.error = scanError(error); }
        }
    }
    private async run(record: TwinDataRecord<TwinScanRun>, fence: number): Promise<void> {
        try {
            await this.store.records.save('scan-run', record.id, { ...record.data, state: 'running', owner: this.store.owner,
                fence, startedAt: this.store.now() }, record.revision, [await this.store.fence(fence)]);
            this.changed();
            if (record.data.collection) await this.collectSources(record.id, fence);
            if (record.data.mode !== 'collect') await this.scanSources(record.id, { runId: record.id, planId: record.data.planId,
                planRevision: record.data.planRevision, sourceId: '', fence, kinds: record.data.kinds, focus: record.data.focus, executor: record.data.executor, maxOutputTokens: record.data.maxOutputTokens });
            await this.store.finish(record.id, this.stopped ? 'interrupted' : 'succeeded', this.stopped ? 'TWIN_SCAN_INTERRUPTED' : '', fence);
        } catch (error) {
            if (scanError(error) === 'TWIN_SCAN_LEASE_LOST') throw error;
            const code = scanError(error), paused = /BUDGET_EXHAUSTED|ANALYSIS_PAUSED/.test(code);
            await this.store.finish(record.id, this.stopped ? 'interrupted' : paused ? 'paused' : 'failed', this.stopped ? 'TWIN_SCAN_INTERRUPTED' : code, fence, diagnosticDetail(error));
        }
        this.changed();
    }
    private async collectSources(id: string, fence: number): Promise<void> {
        const run = (await this.store.records.get<TwinScanRun>('scan-run', id))!;
        if (!this.collection) throw new Error('TWIN_SCANNER_EXECUTOR_UNAVAILABLE');
        const progress = await this.collection.collect(run, async taskId => {
            const latest = (await this.store.records.get<TwinScanRun>('scan-run', id))!;
            if (latest.data.state !== 'running') throw new Error('TWIN_SCAN_CANCELLED');
            await this.store.records.save('checkpoint', 'collection-task:' + id, {taskId}, null, [await this.store.fence(fence)]);
        });
        await this.store.fence(fence);
        if (run.data.mode !== 'collect') {await this.index?.sync(); await this.sources.reconcile(false);}
        const latest = (await this.store.records.get<TwinScanRun>('scan-run', id))!;
        if (latest.data.state !== 'running') throw new Error('TWIN_SCAN_CANCELLED');
        const plan = await this.store.records.get<TwinScanPlan>('scan-plan', latest.data.planId);
        if (!plan?.data.enabled || plan.revision !== latest.data.planRevision) throw new Error('TWIN_SCAN_PLAN_STALE');
        const selected = await this.plans.selected(plan.data);
        const writes = [write('scan-run', id, {...latest.data, ...(progress ? {collectionProgress: progress} : {}), sourceIds: selected.map(source => source.id)}, latest.revision)];
        if (progress?.complete === false && plan.data.trigger === 'interval') {
            const schedule = await this.plans.schedule(plan.id);
            if (schedule) writes.push(write('checkpoint', schedule.id, {...schedule.data, nextAt: Math.min(schedule.data.nextAt, this.store.now() + 15000)}, schedule.revision));
        }
        await this.store.commit(writes, [await this.store.fence(fence), {family: 'scan-plan', id: plan.id, expectedRevision: plan.revision}]);
    }
    private async scanSources(id: string, scope: TwinScanScope): Promise<void> {
        const run = (await this.store.records.get<TwinScanRun>('scan-run', id))!;
        if (scope.planId) {
            const plan = await this.store.records.get<TwinScanPlan>('scan-plan', scope.planId);
            if (!plan?.data.enabled || plan.revision !== scope.planRevision) throw new Error('TWIN_SCAN_PLAN_STALE');
        }
        if (await this.sources.fingerprint(run.data.connectionId) !== run.data.connectionFingerprint) throw new Error('TWIN_CONNECTION_CHANGED');
        if (!run.data.rules) await this.plans.boundSources(run.data.sourceIds, run.data.connectionId, run.data.connectionFingerprint);
        for (const sourceId of run.data.sourceIds) {
            if (this.stopped) return;
            const selected = await this.store.records.get<TwinSourceData>('source', sourceId);
            if (run.data.rules && (!selected?.data.enabled || selected.data.status !== 'available')) continue;
            await this.scanSource(sourceId, scope, run.data.mode, run.data.singleBatch);
            const latest = (await this.store.records.get<TwinScanRun>('scan-run', id))!;
            if (latest.data.state !== 'running') throw new Error('TWIN_SCAN_CANCELLED');
            const source = await this.store.records.get<TwinSourceData>('source', sourceId);
            const complete = run.data.mode === 'reconcile' || (source && (await this.analysis.progress(source, scope)).complete);
            if (complete) await this.store.records.save('scan-run', id, { ...latest.data,
                completedSourceIds: [...new Set([...latest.data.completedSourceIds, sourceId])] }, latest.revision, [await this.store.fence(scope.fence)]);
            this.changed();
        }
    }
    private async scanSource(id: string, scope: TwinScanScope, mode: TwinScanRun['mode'], singleBatch: boolean): Promise<void> {
        scope = { ...scope, sourceId: id };
        if (mode === 'reconcile') { await this.sources.checkOne(id); return; }
        for (;;) {
            const run = await this.store.records.get<TwinScanRun>('scan-run', scope.runId);
            if (this.stopped || run?.data.state !== 'running') throw new Error('TWIN_SCAN_CANCELLED');
            await this.store.fence(scope.fence);
            const { source } = await this.sources.readCurrent(id);
            if ((await this.analysis.progress(source, scope)).complete) return;
            await this.analysis.run(id, scope);
            if (singleBatch) return;
        }
    }
}
