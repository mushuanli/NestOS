import { TwinSourceIndex } from './source-index';
import { scanRules, ruleLines, type TwinScanRuleInput, type TwinScanRules } from './scan-rules';
import type { IFileSystem } from '@itookit/vfs-core';
import { sha256HexSync, type ContextPlan } from '@itookit/llm-context';
import type { KernelAdaptersRuntimeOptions } from '@itookit/kernel-adapters';
import { TwinAnalysis } from './analysis';
import { TwinContext, type TwinUseRecord } from './context';
import { TWIN_KINDS } from './domain';
import type { TwinGrantData, TwinMemoryData, TwinSettings, TwinSourceSpec, TwinSourceData, TwinSourceReader, TwinAnalysisJob } from './domain';
import type { TwinExtractionPort } from './extraction';
import { TwinKnowledge, supported } from './knowledge';
import { TwinRecords } from './records';
import { SeqTwinStore } from './seq-twin-store';
import { TwinSources } from './sources';
import { TwinScans } from './scans';
import { TwinScanStore } from './scan-store';
import { createScanGuard } from './scan-guard';
import type { TwinScanPlanInput } from './scan-domain';

interface TwinServices { records: TwinRecords; sources: TwinSources; knowledge: TwinKnowledge; context: TwinContext; analysis: TwinAnalysis; scans: TwinScans; index: TwinSourceIndex; }
export interface DigitalTwinDependencies {
    fs: IFileSystem; reader: TwinSourceReader; extractor: TwinExtractionPort;
    deleteSession(sessionId: string): Promise<void>;
    defaultConnection?(): Promise<string>;
    executionExists?(sessionId: string, taskId: string): Promise<boolean>;
    connectionFingerprint?(connectionId: string): Promise<string>;
    scanHost?: { kind: string; now?: () => number; leaseMs?: number };
}

/** Application-owned single-user service. No authority is inferred from source text or model output. */
export class DigitalTwinService {
    private opening?: Promise<TwinServices>;
    private listeners = new Set<() => void>();
    private scanTimer?: ReturnType<typeof setInterval>;
    private disposed = false;
    constructor(private readonly deps: DigitalTwinDependencies) {}
    onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    private notify() { for (const listener of this.listeners) listener(); }
    start(): void {
        if (this.scanTimer || this.disposed) return;
        this.scanTimer = setInterval(() => { void this.scanOnce().catch(() => {}); }, 15000);
        void this.scanOnce().catch(() => {});
    }
    async scanOnce(): Promise<void> {
        if (this.disposed) return;
        await this.initialized();
        if (this.disposed) return;
        const services = await this.services();
        if (!this.disposed) await services.scans.pump();
    }
    async dispose(): Promise<void> {
        this.disposed = true; clearInterval(this.scanTimer); this.scanTimer = undefined;
        if (this.opening) await (await this.opening).scans.dispose();
        this.listeners.clear();
    }

    async snapshot() {
        const services = await this.services();
        const cleanupError = await services.knowledge.recoverCleanup().then(() => '', () => 'TWIN_CLEANUP_FAILED');
        await services.sources.reconcile();
        await services.analysis.recoverCleanup();
        const sources = await services.records.list<TwinSourceData>('source');
        const byId = new Map(sources.map(source => [source.id, source]));
        const memories = (await services.records.list<TwinMemoryData>('memory')).map(memory => ({ ...memory,
            supported: supported(memory.data, byId.get(memory.data.sourceId) ?? null) }));
        return { cleanupError, pendingCleanup: await services.records.store.pendingCleanup(), sources: sources.map(source => ({ ...source, observedAt: services.sources.observedAt(source.id) ?? source.data.checkedAt })), memories, settings: (await services.records.get<TwinSettings>('settings', 'pot'))!,
            grants: await services.records.list<TwinGrantData>('grant'), jobs: await services.records.list<TwinAnalysisJob>('job'),
            uses: await services.records.list<TwinUseRecord>('usage'), sessions: await this.deps.reader.sessions(), scans: await services.scans.snapshot() };
    }

    previewSource(spec: TwinSourceSpec) { return this.deps.reader.read(spec); }
    async addSource(spec: TwinSourceSpec, connectionId: string) {
        const id = await (await this.services()).sources.add(spec, connectionId); this.notify(); return id;
    }
    async setSourceEnabled(id: string, revision: string, enabled: boolean) {
        const services = await this.services();
        await services.sources.setEnabled(id, revision, enabled); this.notify();
        if (!enabled) for (const job of await services.records.list<TwinAnalysisJob>('job')) {
            if (job.data.sourceId === id && ['queued', 'running'].includes(job.data.state)) await services.analysis.cancel(job.id);
        }
        this.notify();
    }
    async removeSource(id: string, revision: string) {
        const services = await this.services();
        await services.knowledge.removeSource(id, revision); this.notify();
        for (const job of await services.records.list<TwinAnalysisJob>('job')) {
            if (job.data.sourceId === id && ['queued', 'running'].includes(job.data.state)) await services.analysis.cancel(job.id);
        }
        this.notify();
    }
    async analyze(id: string) {
        const scans = (await this.services()).scans;
        const run = scans.analyzeSource(id); this.notify();
        try { await run; } finally { this.notify(); }
    }
    async cancelAnalysis(id: string) { await (await this.services()).analysis.cancel(id); this.notify(); }
    async previewScanRule(rules: TwinScanRules) { return (await this.services()).index.preview(scanRules(rules)); }
    async saveScanRule(id: string | null, revision: string | null, input: TwinScanRuleInput) {
        const rules = scanRules(input);
        return this.saveScanPlan(id, revision, { name: input.name, rules, sourceIds: [], connectionId: '',
            kinds: input.kinds ?? [...TWIN_KINDS], mode: 'analyze', trigger: 'interval', intervalMinutes: input.intervalMinutes,
            tokenLimit: 0, enabled: input.enabled, autoConfirm: true });
    }
    async saveScanPlan(id: string | null, revision: string | null, input: TwinScanPlanInput) {
        const result = await (await this.services()).scans.save(id, revision, input);
        if (this.scanTimer) void this.scanOnce().catch(() => {});
        return result;
    }
    async setScanPlanEnabled(id: string, revision: string, enabled: boolean) {
        await (await this.services()).scans.enable(id, revision, enabled);
    }
    async removeScanPlan(id: string, revision: string) { await (await this.services()).scans.remove(id, revision); }
    async runScanPlan(id: string): Promise<string> {
        const runId = await (await this.services()).scans.enqueue(id);
        void this.scanOnce().catch(() => {}); return runId;
    }
    async waitScanRun(id: string) { await (await this.services()).scans.wait(id); }
    async cancelScanRun(id: string) { await (await this.services()).scans.cancel(id); }
    async addMemory(input: Partial<TwinMemoryData>) {
        if (input.executionRefs?.length) throw new Error('TWIN_INVALID_GOAL_REFERENCE');
        const id = await (await this.services()).knowledge.manual(input); this.notify(); return id;
    }
    async review(id: string, revision: string, action: 'confirm' | 'reject' | 'dispute' | 'correct', patch?: Partial<TwinMemoryData>) {
        const services = await this.services(); await services.sources.reconcile();
        await services.knowledge.review(id, revision, action, patch); this.notify();
    }
    async linkExecution(id: string, revision: string, reference: { sessionId: string; taskId: string }): Promise<void> {
        const services = await this.services(), memory = await services.records.get<TwinMemoryData>('memory', id);
        if (!memory || memory.revision !== revision || memory.data.state !== 'active'
            || !['goal', 'commitment'].includes(memory.data.kind)) throw new Error('TWIN_INVALID_GOAL_REFERENCE');
        if (!reference || typeof reference.sessionId !== 'string' || typeof reference.taskId !== 'string') throw new Error('TWIN_INVALID_GOAL_REFERENCE');
        if (!(await this.deps.reader.sessions()).some(session => session.id === reference.sessionId)
            || !await this.deps.executionExists?.(reference.sessionId, reference.taskId)) throw new Error('TWIN_INVALID_GOAL_REFERENCE');
        const executionRefs = [...memory.data.executionRefs.filter(ref => ref.taskId !== reference.taskId || ref.sessionId !== reference.sessionId), reference];
        if (executionRefs.length > 20) throw new Error('TWIN_REFERENCE_LIMIT');
        await services.records.save('memory', id, { ...memory.data, executionRefs }, revision); this.notify();
    }
    async suppress(id: string, revision: string) { await (await this.services()).knowledge.suppress(id, revision); this.notify(); }
    forgetPreview(id: string) { return this.affectedSessions([id]); }
    private async affectedSessions(ids: string[]) {
        const uses = await (await this.services()).records.list<TwinUseRecord>('usage');
        const selected = new Set(ids);
        const sessions = new Set((await this.deps.reader.sessions()).map(session => session.id));
        return [...new Set(uses.filter(use => use.data.memoryRefs.some(ref => selected.has(ref.id)))
            .map(use => use.data.sessionId))].filter(session => sessions.has(session));
    }
    async forgetScopePreview(scope: { subjectId?: string; project?: string }) {
        if ((scope.subjectId !== undefined && typeof scope.subjectId !== 'string')
            || (scope.project !== undefined && typeof scope.project !== 'string')
            || (!scope.subjectId && !scope.project) || (scope.subjectId && scope.project)) throw new Error('TWIN_INVALID_FORGET_SCOPE');
        const records = (await this.services()).records;
        const ids = (await records.list<TwinMemoryData>('memory')).filter(memory => scope.subjectId
            ? memory.data.subjectId === scope.subjectId : memory.data.project === scope.project).map(memory => memory.id);
        const sessions = await this.affectedSessions(ids);
        return { ids, sessions };
    }
    async forgetScope(scope: { subjectId?: string; project?: string }, deleteSessions: string[] = []) {
        const preview = await this.forgetScopePreview(scope);
        await (await this.services()).knowledge.forgetMany(preview.ids);
        for (const session of preview.sessions.filter(id => deleteSessions.includes(id))) await this.deps.deleteSession(session);
        this.notify();
        return { retainedSessions: await this.affectedSessions(preview.ids) };
    }
    async forget(id: string, deleteSessions: string[] = []) {
        await (await this.services()).knowledge.forget(id);
        const affected = await this.forgetPreview(id);
        for (const session of affected.filter(session => deleteSessions.includes(session))) await this.deps.deleteSession(session);
        this.notify();
        return { retainedSessions: await this.forgetPreview(id) };
    }
    async configure(patch: Partial<Pick<TwinSettings, 'tokenLimit' | 'paused' | 'useEnabled' | 'connectionId' | 'globalExclude'>>, revision: string) {
        const records = (await this.services()).records, settings = (await records.get<TwinSettings>('settings', 'pot'))!;
        const data = { ...settings.data, ...Object.fromEntries(Object.entries(patch).filter(([key]) =>
            ['tokenLimit', 'paused', 'useEnabled', 'connectionId', 'globalExclude'].includes(key))) };
        if (typeof data.paused !== 'boolean' || typeof data.useEnabled !== 'boolean') throw new Error('TWIN_INVALID_SETTINGS');
        if (!Number.isSafeInteger(data.tokenLimit) || data.tokenLimit < 0) throw new Error('TWIN_INVALID_BUDGET');
        if (patch.connectionId !== undefined && (typeof patch.connectionId !== 'string' || !patch.connectionId.trim())) throw new Error('TWIN_CONNECTION_REQUIRED');
        if (data.globalExclude !== undefined) data.globalExclude = ruleLines(data.globalExclude);
        const services = await this.services();
        if (patch.connectionId) await services.sources.fingerprint(patch.connectionId);
        await records.save('settings', 'pot', data, revision);
        if (patch.connectionId) await services.scans.refreshModels();
        await this.initializeRules(services.scans);
        await services.index.sync(); this.notify();
    }
    async grant(data: TwinGrantData, expectedRevision: string | null) {
        if (typeof data?.sessionId !== 'string' || typeof data.agentId !== 'string' || data.agentId.length > 200
            || typeof data.connectionId !== 'string' || typeof data.project !== 'string' || data.project.length > 200
            || typeof data.enabled !== 'boolean') throw new Error('TWIN_INVALID_GRANT');
        const sessions = await this.deps.reader.sessions();
        if ((data.enabled && !sessions.some(session => session.id === data.sessionId)) || !data.agentId || !data.connectionId) throw new Error('TWIN_INVALID_GRANT');
        const services = await this.services();
        const current = await services.records.get<TwinGrantData>('grant', data.sessionId);
        const connectionFingerprint = data.enabled ? await services.sources.fingerprint(data.connectionId) : current?.data.connectionFingerprint ?? '';
        await services.records.save('grant', data.sessionId, { ...data, connectionFingerprint }, expectedRevision); this.notify();
    }
    async retrieve(plan: ContextPlan, agentId: string, sessionId: string) {
        if (!await this.initialized()) return [];
        return (await this.services()).context.retrieve(plan, agentId, sessionId);
    }
    readonly authorizeLlm: NonNullable<KernelAdaptersRuntimeOptions['authorizeLlm']> = async (request, context) => {
        if (!await this.initialized()) return;
        const services = await this.services();
        if (context.sessionId.startsWith('twin-analysis-')) {
            request.request._label = `twin-private-${sha256HexSync(context.sessionId + ':' + context.effectId).slice(0, 40)}`;
            await services.analysis.authorize(context.sessionId, request.connectionId);
        }
        else await services.context.authorize(request, context);
    };

    private async initialized(): Promise<boolean> {
        return Boolean(this.opening) || this.deps.fs.driver.exists('/var/lib/digital-twin/personal/authority.seq');
    }
    private services(): Promise<TwinServices> {
        if (!this.opening) {
            const opening = this.open().catch(error => {
                // A transient initialization failure must not poison later retries.
                if (this.opening === opening) this.opening = undefined;
                throw error;
            });
            this.opening = opening;
        }
        return this.opening;
    }
    private async open(): Promise<TwinServices> {
        const records = new TwinRecords(await SeqTwinStore.open(this.deps.fs, 'personal', 'admin'));
        if (!await records.get('settings', 'pot')) {
            await records.save('settings', 'pot', { tokenLimit: 100000, reservedTokens: 0,
                spentTokens: 0, paused: false, useEnabled: true, connectionId: await this.deps.defaultConnection?.().catch(() => '') ?? '', globalExclude: [] } satisfies TwinSettings, null).catch(async error => {
                if (!await records.get('settings', 'pot')) throw error;
            });
        }
        const settings = (await records.get<TwinSettings>('settings', 'pot'))!;
        if (settings.data.connectionId === undefined) await records.save('settings', 'pot', { ...settings.data,
            connectionId: await this.deps.defaultConnection?.().catch(() => '') ?? '', globalExclude: settings.data.globalExclude ?? [] }, settings.revision);
        const sources = new TwinSources(records, this.deps.reader, this.deps.connectionFingerprint ?? (async id => id));
        const index = new TwinSourceIndex(records, sources);
        const scanStore = new TwinScanStore(records, this.deps.scanHost?.kind ?? 'local', this.deps.scanHost?.now, this.deps.scanHost?.leaseMs);
        const analysis = new TwinAnalysis(records, sources, this.deps.extractor, () => this.notify(), createScanGuard(scanStore));
        const scans = new TwinScans(scanStore, sources, analysis, () => this.notify(), index);
        await this.initializeRules(scans);
        return { records, sources, index, knowledge: new TwinKnowledge(records), context: new TwinContext(records, sources),
            analysis, scans };
    }
    private async initializeRules(scans: TwinScans): Promise<void> {
        if (this.deps.reader.discover && this.deps.defaultConnection) await scans.plans.initializeDefault();
    }
}
