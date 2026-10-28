import { userIdentity } from './identity';
import { extractionPrompt } from './extraction';
import { selectionPattern, selectionKinds, type TwinSelectionTarget, type TwinSelectionType } from './selection';
import { createModuleLogger, randomUUID } from '@itookit/common';
import { knowledgeGraph, type TwinEntityAlias } from './graph';
import { TwinSourceIndex } from './source-index';
import { scanRules, ruleLines, matchesLine, matchesRules, type TwinScanRuleInput, type TwinScanRules } from './scan-rules';
import type { IFileSystem } from '@itookit/vfs-core';
import { sha256HexSync, type ContextPlan } from '@itookit/llm-context';
import type { KernelAdaptersRuntimeOptions } from '@itookit/kernel-adapters';
import { TwinAnalysis } from './analysis';
import { TwinContext, type TwinUseRecord } from './context';
import { TWIN_KINDS } from './domain';
import type { TwinMemoryData, TwinSettings, TwinSourceSpec, TwinSourceData, TwinSourceReader, TwinAnalysisJob } from './domain';
import type { TwinExtractionPort } from './extraction';
import { TwinKnowledge, supported } from './knowledge';
import { write, TwinRecords, type TwinDataRecord } from './records';
import { SeqTwinStore } from './seq-twin-store';
import { TwinSources } from './sources';
import { TwinScans } from './scans';
import { TwinScanStore, retry } from './scan-store';
import { createScanGuard } from './scan-guard';
import type { TwinScanPlanInput, TwinScanPlan } from './scan-domain';

interface TwinServices { records: TwinRecords; sources: TwinSources; knowledge: TwinKnowledge; context: TwinContext; analysis: TwinAnalysis; scans: TwinScans; index: TwinSourceIndex; }
export interface TwinWorkspaceBinding {
    twinId: string;
    ownerId: string;
    /** Trusted host checks membership and authority; never supplied by model output or RPC payloads. */
    authorize(): Promise<void>;
}
export interface DigitalTwinDependencies {
    workspace?: TwinWorkspaceBinding;
    fs: IFileSystem; reader: TwinSourceReader; extractor: TwinExtractionPort;
    deleteSession(sessionId: string): Promise<void>;
    defaultConnection?(): Promise<string>;
    executionExists?(sessionId: string, taskId: string): Promise<boolean>;
    connectionFingerprint?(connectionId: string): Promise<string>;
    scanHost?: { kind: string; now?: () => number; leaseMs?: number };
}

/** Application-owned, host-bound workspace service. No authority is inferred from source text or model output. */
export class DigitalTwinService {
    private opening?: Promise<TwinServices>;
    private initializationStage = 'idle';
    diagnostics() { return { initialization: this.initializationStage }; }
    private listeners = new Set<() => void>();
    private scanTimer?: ReturnType<typeof setInterval>;
    private disposed = false;
    private readonly workspace?: TwinWorkspaceBinding;
    constructor(private readonly deps: DigitalTwinDependencies) {
        if (deps.workspace && (!/^[a-zA-Z0-9_-]{1,128}$/.test(deps.workspace.twinId)
            || !deps.workspace.ownerId?.trim() || typeof deps.workspace.authorize !== 'function')) throw new Error('TWIN_WORKSPACE_INVALID');
        this.workspace = deps.workspace ? {...deps.workspace} : undefined;
    }
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
        if (!this.disposed) { await this.resolveDefaultModel(services); await services.scans.pump(); }
    }
    async dispose(): Promise<void> {
        this.disposed = true; clearInterval(this.scanTimer); this.scanTimer = undefined;
        if (this.opening) await (await this.opening).scans.dispose();
        this.listeners.clear();
    }

    async snapshot(progress: (stage: string) => void = () => {}) {
        const read = <T>(stage: string, action: () => Promise<T>) => { progress(stage); return action(); };
        const services = await read('services.initialize', () => this.services());
        const sources = await read('records.source', () => services.records.list<TwinSourceData>('source'));
        const byId = new Map(sources.map(source => [source.id, source]));
        const memories = (await read('records.memory', () => services.records.list<TwinMemoryData>('memory'))).map(memory => ({ ...memory,
            retained: Boolean(byId.get(memory.data.sourceId)?.data.retained), supported: supported(memory.data, byId.get(memory.data.sourceId) ?? null) }));
        const aliases = new Map((await read('records.entity', () => services.records.list<TwinEntityAlias>('entity'))).map(alias => [alias.id, alias.data]));
        const jobs = await read('records.job', () => services.records.list<TwinAnalysisJob>('job'));
        const identity = (await services.records.get<TwinSettings>('settings', 'pot'))!.data;
        return { prompt: extractionPrompt(identity), graph: knowledgeGraph(memories, aliases), cleanupError: jobs.find(job => job.data.cleanupError)?.data.cleanupError ?? '',
            pendingCleanup: await read('records.pendingCleanup', () => services.records.store.pendingCleanup()),
            sources: sources.map(source => ({ ...source, observedAt: services.sources.observedAt(source.id) ?? source.data.checkedAt })), memories,
            settings: (await read('records.settings', () => services.records.get<TwinSettings>('settings', 'pot')))!,
            jobs,
            uses: await read('records.usage', () => services.records.list<TwinUseRecord>('usage')),
            sessions: await read('sessions.list', () => this.deps.reader.sessions()),
            scans: await read('scans.snapshot', () => services.scans.snapshot()) };
    }

    async mergePeople(from: string, to: string): Promise<void> {
        const records = (await this.services()).records;
        const lock = await records.get('checkpoint', 'entity-merge');
        const graph = (await this.snapshot()).graph;
        if (from === to || [from, to].some(id => !graph.nodes.some(node => node.id === id && node.kind === 'person' && !node.aliases.includes('self')))) throw new Error('TWIN_INVALID_ENTITY_MERGE');
        const current = await records.get<TwinEntityAlias>('entity', from);
        await records.store.commit({ operationId: randomUUID(), expectedForgetEpoch: (await records.store.inspect()).forgetEpoch, writes: [
            write('entity', from, { targetId: to }, current?.revision ?? null),
            write('checkpoint', 'entity-merge', { updatedAt: Date.now() }, lock?.revision ?? null),
        ] }); this.notify();
    }

    async previewSource(spec: TwinSourceSpec) { await this.authorizeWorkspace(); return this.deps.reader.read(spec); }
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
    async selectionInfo(target: TwinSelectionTarget) {
        const pattern = selectionPattern(target), snapshot = await this.snapshot();
        const sources = snapshot.sources.filter(source => matchesLine(source.data.resource ?? { ...source.data, projectId: '' }, pattern));
        const ids = new Set(sources.map(source => source.id));
        const plan = snapshot.scans.plans.find(plan => plan.data.rules?.selection && plan.data.rules.include[0] === pattern);
        const resource = sources[0]?.data.resource ?? { ...target, projectId: '', path: target.target };
        const ignored = (snapshot.settings.data.globalExclude ?? []).some(line => line === pattern || matchesLine(resource, line));
        const included = !ignored && (Boolean(plan?.data.enabled) || sources.some(source => source.data.enabled)
            || snapshot.scans.plans.some(plan => plan.data.enabled && plan.data.rules && matchesRules(resource, plan.data.rules)));
        return { sources, plan, included, memories: snapshot.memories.filter(memory => ids.has(memory.data.sourceId) || ids.has(memory.data.originSourceId ?? '')),
            runs: snapshot.scans.runs.filter(run => run.data.planId === plan?.id || run.data.sourceIds.some(id => ids.has(id))),
            jobs: snapshot.jobs.filter(job => ids.has(job.data.sourceId)), settings: snapshot.settings,
            nextScanAt: snapshot.scans.schedules.find(schedule => schedule.planId === plan?.id)?.nextAt ?? 0,
            ignored, worker: snapshot.scans.worker,
            discoveryErrors: snapshot.scans.discovery.errors };
    }
    async selectSource(target: TwinSelectionTarget, type: TwinSelectionType): Promise<void> {
        const services = await this.services(), pattern = selectionPattern(target), info = await this.selectionInfo(target);
        await services.scans.save(info.plan?.id ?? null, info.plan?.revision ?? null, { name: target.label.slice(0, 200) || target.kind,
            rules: { include: [pattern], exclude: [], selection: true }, kinds: selectionKinds(type), sourceIds: [], connectionId: '',
            mode: 'analyze', trigger: 'interval', intervalMinutes: 30, tokenLimit: 0, enabled: true, autoConfirm: true }, false);
        await this.setSelectionIgnored(pattern, false);
        this.notify(); void this.scanOnce().then(() => this.scanOnce()).catch(() => {});
    }
    async removeSelection(target: TwinSelectionTarget): Promise<void> {
        const services = await this.services(), pattern = selectionPattern(target);
        await this.setSelectionIgnored(pattern, true);
        const info = await this.selectionInfo(target);
        if (info.plan?.data.enabled) await services.scans.enable(info.plan.id, info.plan.revision, false, false);
        for (const source of info.sources) {
            for (const job of info.jobs.filter(job => job.data.sourceId === source.id && ['queued', 'running'].includes(job.data.state))) await services.analysis.cancel(job.id);
            const current = await services.records.get<TwinSourceData>('source', source.id);
            if (current) await services.knowledge.removeSource(current.id, current.revision, true);
        }
        await services.knowledge.forgetMany(info.memories.filter(memory => memory.data.originSourceId).map(memory => memory.id));
        this.notify();
    }
    private async setSelectionIgnored(pattern: string, ignored: boolean): Promise<void> {
        const { records } = await this.services();
        await retry(async () => {
            const settings = (await records.get<TwinSettings>('settings', 'pot'))!;
            const excludes = (settings.data.globalExclude ?? []).filter(line => line !== pattern);
            await records.save('settings', 'pot', { ...settings.data,
                globalExclude: ruleLines(ignored ? [...excludes, pattern] : excludes) }, settings.revision);
        });
    }
    async previewScanRule(rules: TwinScanRules) { return (await this.services()).index.preview(scanRules(rules)); }
    async saveScanRule(id: string | null, revision: string | null, input: TwinScanRuleInput) {
        const rules = scanRules(input);
        const previous = id ? await (await this.services()).records.get<TwinScanPlan>('scan-plan', id) : null;
        if (previous?.data.rules?.selection && JSON.stringify(previous.data.rules.include) === JSON.stringify(rules.include)) rules.selection = true;
        return this.saveScanPlan(id, revision, { name: input.name, focus: input.focus, rules, sourceIds: [], connectionId: '',
            kinds: input.kinds ?? [...TWIN_KINDS], mode: 'analyze', trigger: input.trigger ?? previous?.data.trigger ?? 'interval', intervalMinutes: input.intervalMinutes,
            runTokenLimit: input.runTokenLimit === null ? undefined : input.runTokenLimit ?? previous?.data.runTokenLimit,
            tokenLimit: 0, enabled: input.enabled, autoConfirm: input.autoConfirm ?? previous?.data.autoConfirm ?? true });
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
    async getSettings(): Promise<TwinDataRecord<TwinSettings>> {
        return (await (await this.services()).records.get<TwinSettings>('settings', 'pot'))!;
    }
    async configure(patch: Partial<Pick<TwinSettings, 'tokenLimit' | 'budgetUnlimited' | 'paused' | 'useEnabled' | 'connectionId' | 'globalExclude' | 'userName' | 'userAliases'>>, revision: string) {
        const records = (await this.services()).records, settings = (await records.get<TwinSettings>('settings', 'pot'))!;
        const data = { ...settings.data, ...Object.fromEntries(Object.entries(patch).filter(([key]) =>
            ['tokenLimit', 'budgetUnlimited', 'paused', 'useEnabled', 'connectionId', 'globalExclude', 'userName', 'userAliases'].includes(key))) };
        Object.assign(data, userIdentity(data));
        if (typeof data.paused !== 'boolean' || typeof data.useEnabled !== 'boolean') throw new Error('TWIN_INVALID_SETTINGS');
        if (!Number.isSafeInteger(data.tokenLimit) || data.tokenLimit < 0) throw new Error('TWIN_INVALID_BUDGET');
        if (data.budgetUnlimited !== undefined && typeof data.budgetUnlimited !== 'boolean') throw new Error('TWIN_INVALID_BUDGET');
        if (patch.connectionId !== undefined && (typeof patch.connectionId !== 'string' || !patch.connectionId.trim())) throw new Error('TWIN_CONNECTION_REQUIRED');
        if (data.globalExclude !== undefined) data.globalExclude = ruleLines(data.globalExclude);
        const services = await this.services();
        if (patch.connectionId) await services.sources.fingerprint(patch.connectionId);
        await records.save('settings', 'pot', data, revision);
        if (patch.connectionId) await services.scans.refreshModels();
        await this.initializeRules(services.scans);
        await services.index.sync(); this.notify();
        if (this.scanTimer) void this.scanOnce().catch(() => {});
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

    readonly authorizeMedia: NonNullable<KernelAdaptersRuntimeOptions['authorizeMedia']> = (request, context) =>
        this.authorizeLlm({ ...request, request: { model: request.request.model,
            messages: (request.request.operation === 'image.generate' ? [request.request.prompt]
                : [request.request.input, ...(request.request.instructions ? [request.request.instructions] : [])])
                .map(content => ({ role: 'user' as const, content })),
        } }, context);

    private async resolveDefaultModel(services: TwinServices): Promise<void> {
        const settings = (await services.records.get<TwinSettings>('settings', 'pot'))!;
        if (settings.data.connectionId || !this.deps.defaultConnection) return;
        const connectionId = await this.deps.defaultConnection().catch(() => '');
        if (connectionId) await this.configure({ connectionId }, settings.revision);
    }

    private async authorizeWorkspace(): Promise<void> {
        if (!this.workspace) return;
        const started = Date.now();
        try { await this.workspace.authorize(); }
        catch (error) {
            createModuleLogger('twin-workspace').warn('twin.workspace.authorize', {operationId: randomUUID(),
                stage: 'authorization', result: 'failure', code: 'TWIN_WORKSPACE_ACCESS_DENIED', durationMs: Date.now() - started});
            throw error;
        }
    }

    private async initialized(): Promise<boolean> {
        return Boolean(this.opening) || this.deps.fs.driver.exists(`/var/lib/digital-twin/${this.workspace?.twinId ?? 'personal'}/authority.seq`);
    }
    private async services(): Promise<TwinServices> {
        await this.authorizeWorkspace();
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
        this.initializationStage = 'storage.open';
        const records = new TwinRecords(await SeqTwinStore.open(this.deps.fs, this.workspace?.twinId ?? 'personal', this.workspace?.ownerId ?? 'admin', stage => { this.initializationStage = stage; }));
        this.initializationStage = 'settings.initialize';
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
        const guard = createScanGuard(scanStore);
        const analysis = new TwinAnalysis(records, sources, this.deps.extractor, () => this.notify(), async (scope, charge) => {
            await this.authorizeWorkspace();
            return guard(scope, charge);
        });
        const knowledge = new TwinKnowledge(records);
        const scans = new TwinScans(scanStore, sources, analysis, () => this.notify(), index, async () => {
            await knowledge.recoverCleanup(); await analysis.recoverCleanup();
        });
        this.initializationStage = 'scan-rules.initialize';
        await this.initializeRules(scans);
        this.initializationStage = 'ready';
        return { records, sources, index, knowledge, context: new TwinContext(records, sources),
            analysis, scans };
    }
    private async initializeRules(scans: TwinScans): Promise<void> {
        if (this.deps.reader.discover && this.deps.defaultConnection) await scans.plans.initializeDefault();
    }
}
