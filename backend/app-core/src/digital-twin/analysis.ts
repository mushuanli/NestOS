import {meterPeriod, reserveMeter, settleMeter} from './metering';
import { TWIN_EXTRACTION_OUTPUT_ESTIMATE, TWIN_EXTRACTION_PROMPT_RESERVE } from './extraction-estimates';
import { settleFailedJob } from './failure-accounting';
import { diagnosticDetail, traceAnalysis } from './diagnostics';
import { userIdentity, identityKey } from './identity';
import { extractionEnd } from './chunking';
import { randomUUID } from '@itookit/common';
import { sha256HexSync } from '@itookit/llm-context';
import { memoryData, TWIN_KINDS, type TwinAnalysisJob, type TwinSettings, type TwinSourceData } from './domain';
import type { TwinExtractionPort } from './extraction';
import { TwinRecords, write, type TwinDataRecord } from './records';
import { TwinSources } from './sources';
import type { TwinScanCheckpoint, TwinScanGuardPort, TwinScanScope, TwinScanPlan } from './scan-domain';
import { retry } from './scan-store';
import { readProgress } from './read-progress';

export class TwinAnalysis {
    private running = new Map<string, Promise<void>>();
    constructor(private readonly records: TwinRecords, private readonly sources: TwinSources, private readonly extractor: TwinExtractionPort,
        private readonly changed: () => void = () => {}, private readonly scanGuard?: TwinScanGuardPort) {}

    async run(sourceId: string, scope?: TwinScanScope): Promise<void> {
        const existing = this.running.get(sourceId);
        if (existing) return existing;
        const run = this.execute(sourceId, scope).finally(() => { this.running.delete(sourceId); });
        this.running.set(sourceId, run);
        return run;
    }

    async cancel(jobId: string): Promise<void> {
        const job = await retry(async () => {
            const current = await this.records.get<TwinAnalysisJob>('job', jobId);
            if (!current || !['queued', 'running'].includes(current.data.state)) return null;
            await this.records.save('job', jobId, { ...current.data, state: 'cancelled', finishedAt: Date.now() }, current.revision);
            return current;
        });
        if (!job) return;
        await this.extractor.cancel(job.data);
        await retry(async () => {
            const latest = await this.records.get<TwinAnalysisJob>('job', jobId);
            if (latest && latest.data.state === 'cancelled' && !latest.data.cancelConfirmed) {
                await this.records.save('job', jobId, { ...latest.data, cancelConfirmed: true }, latest.revision);
            }
        });
    }

    async authorize(sessionId: string, connectionId: string): Promise<void> {
        if (!sessionId.startsWith('twin-analysis-')) throw new Error('TWIN_ANALYSIS_PERMISSION_DENIED');
        const id = sessionId.slice('twin-analysis-'.length);
        const job = await readProgress(() => this.records.get<TwinAnalysisJob>('job', id),
            { sessionId, connectionId }, '', 'authorization_retry');
        if (!job || job.data.sessionId !== sessionId || !['queued', 'running'].includes(job.data.state)
            || job.data.connectionId !== connectionId) throw new Error('TWIN_ANALYSIS_PERMISSION_DENIED');
        if (!job.data.scanScope) throw new Error('TWIN_SCAN_LEGACY_JOB_REQUIRES_REVIEW');
        if (job.data.scanScope.sourceId !== job.data.sourceId) throw new Error('TWIN_SCAN_SOURCE_DENIED');
        if (job.data.scanScope) await this.guard(job.data.scanScope);
        const settings = await this.records.get<TwinSettings>('settings', 'pot');
        if (settings && identityKey(settings.data) !== identityKey(job.data)) throw new Error('TWIN_ANALYSIS_PERMISSION_STALE');
        if (settings?.data.paused) throw new Error('TWIN_ANALYSIS_PAUSED');
        const { source } = await this.sources.readCurrent(job.data.sourceId);
        if (source.revision !== job.data.sourceRevision || source.data.hash !== job.data.sourceHash || source.data.connectionId !== connectionId
            || (await this.records.store.inspect()).forgetEpoch !== job.data.epoch) throw new Error('TWIN_ANALYSIS_PERMISSION_STALE');
    }

    async recoverCleanup(): Promise<void> {
        for (const job of await this.records.list<TwinAnalysisJob>('job')) {
            if (!job.data.cleaned && !this.running.has(job.data.sourceId) && ['committed', 'failed', 'cancelled'].includes(job.data.state)) {
                if (job.data.state === 'cancelled' && !job.data.cancelConfirmed) await this.extractor.cancel(job.data);
                await this.cleanup(job);
            }
        }
    }

    private async cleanup(job: TwinDataRecord<TwinAnalysisJob>): Promise<void> {
        try {
            await this.extractor.cleanup(job.data);
            await this.records.save('job', job.id, { ...job.data, cleaned: true, cancelConfirmed: job.data.state === 'cancelled', cleanupError: '' }, job.revision);
        } catch (error) {
            const current = await this.records.get<TwinAnalysisJob>('job', job.id);
            if (current && !current.data.cleaned) await this.records.save('job', job.id, { ...current.data,
                cleanupError: safeError(error, 'TWIN_CLEANUP_FAILED') }, current.revision);
        }
    }

    async progress(source: TwinDataRecord<TwinSourceData>, scope?: TwinScanScope) {
        const identity = userIdentity((await this.records.get<TwinSettings>('settings', 'pot'))!.data);
        const checkpointId = scope && (identity.userName || identity.userAliases?.length || scope.focus || scope.kinds.length !== TWIN_KINDS.length) ? sha256HexSync(JSON.stringify([
            source.id, source.data.incarnation, source.data.hash, source.data.connectionFingerprint, scope.kinds, ...(identity.userName || identity.userAliases?.length ? [identityKey(identity)] : []), ...(scope.focus ? [scope.focus] : [])])) : '';
        const checkpoint = checkpointId ? await this.records.get<TwinScanCheckpoint>('scan-checkpoint', checkpointId) : null;
        return { checkpointId, checkpointRevision: checkpoint?.revision ?? null,
            offset: checkpointId ? checkpoint?.data.offset ?? 0 : source.data.offset,
            complete: checkpointId ? checkpoint?.data.complete ?? false : source.data.analyzedHash === source.data.hash };
    }

    private async execute(sourceId: string, scope?: TwinScanScope): Promise<void> {
        const { source, content } = await this.sources.readCurrent(sourceId);
        const progress = await this.progress(source, scope);
        if (progress.complete) return;
        if ((await this.records.list('memory')).length > 480) throw new Error('TWIN_MEMORY_LIMIT');
        const pending = (await this.records.list<TwinAnalysisJob>('job')).find(item => item.data.sourceId === sourceId
            && ['queued', 'running'].includes(item.data.state) && item.data.scanScope?.runId === scope?.runId);
        const job = pending ?? await retry(() => this.reserve(source, content.text, scope, progress));
        const text = content.text.slice(job.data.start ?? Math.max(0, job.data.offset - 256), job.data.end);
        try {
            const result = await this.extractor.run(job.data, text, id => this.attach(job.id, id), progress => this.requestProgress(job.id, progress));
            traceAnalysis(job.data, 'committing', { jobId: job.id, candidates: result.candidates.length });
            await retry(() => this.commitResult(job.id, source, result));
            traceAnalysis(job.data, 'committed', { jobId: job.id });
        } catch (error) {
            await this.fail(job.id, error);
            throw error;
        } finally {
            const latest = await this.records.get<TwinAnalysisJob>('job', job.id);
            if (latest && ['committed', 'failed', 'cancelled'].includes(latest.data.state)) await this.cleanup(latest);
        }
    }

    private async requestProgress(id: string, progress: import('./extraction-progress').TwinRequestProgress): Promise<void> {
        await retry(async () => {
            const job = await this.records.get<TwinAnalysisJob>('job', id);
            if (!job || !['queued', 'running'].includes(job.data.state)) return;
            await this.records.save('job', id, { ...job.data, ...progress }, job.revision);
        });
        this.changed();
    }

    private async reserve(source: TwinDataRecord<TwinSourceData>, text: string, scope: TwinScanScope | undefined,
        progress: Awaited<ReturnType<TwinAnalysis['progress']>>): Promise<TwinDataRecord<TwinAnalysisJob>> {
        const settings = await this.records.get<TwinSettings>('settings', 'pot');
        if (!settings || settings.data.paused) throw new Error('TWIN_ANALYSIS_PAUSED');
        const offset = progress.offset, end = extractionEnd(text, offset);
        const reservedTokens = new TextEncoder().encode(text.slice(offset, end) + (scope?.focus ?? '') + identityKey(settings.data)).length + TWIN_EXTRACTION_OUTPUT_ESTIMATE + TWIN_EXTRACTION_PROMPT_RESERVE;
        if (!settings.data.budgetUnlimited && settings.data.spentTokens + settings.data.reservedTokens + reservedTokens > settings.data.tokenLimit) throw new Error('TWIN_BUDGET_EXHAUSTED');
        const id = randomUUID(), epoch = (await this.records.store.inspect()).forgetEpoch;
        const guard = await this.guard(scope, { reserve: reservedTokens });
        const data: TwinAnalysisJob = { meterPeriod: meterPeriod(), sourceId: source.id, sourceRevision: source.revision, sourceHash: source.data.hash,
            ...userIdentity(settings.data), offset, start: offset, end, connectionId: source.data.connectionId, sessionId: `twin-analysis-${id}`, taskId: '', epoch,
            reservedTokens, createdAt: Date.now(), state: 'queued', error: '', ...(scope ? { scanScope: scope } : {}),
            checkpointId: progress.checkpointId, checkpointRevision: progress.checkpointRevision };
        await this.records.store.commit({ operationId: id, expectedForgetEpoch: epoch,
            conditions: [{ family: 'source', id: source.id, expectedRevision: source.revision }, ...guard.conditions], writes: [
                ...await reserveMeter(this.records, id, data, settings.data.monthlyTokenLimit),
                write('job', id, data, null), write('settings', 'pot', { ...settings.data,
                reservedTokens: settings.data.reservedTokens + reservedTokens }, settings.revision), ...guard.writes] });
        traceAnalysis(data, 'queued', { jobId: id, sourceId: source.id, start: offset, end, reservedTokens });
        this.changed();
        return (await this.records.get<TwinAnalysisJob>('job', id))!;
    }

    private async attach(jobId: string, taskId: string): Promise<void> {
        const job = (await this.records.get<TwinAnalysisJob>('job', jobId))!;
        if (!['queued', 'running'].includes(job.data.state)) throw new Error('TWIN_ANALYSIS_CANCELLED');
        if (job.data.taskId === taskId && job.data.state === 'running') return;
        await this.records.save('job', jobId, { ...job.data, taskId, startedAt: job.data.startedAt ?? Date.now(), state: 'running' }, job.revision);
        this.changed();
    }

    private async commitResult(jobId: string, source: TwinDataRecord<TwinSourceData>, result: Awaited<ReturnType<TwinExtractionPort['run']>>) {
        const job = (await this.records.get<TwinAnalysisJob>('job', jobId))!, settings = (await this.records.get<TwinSettings>('settings', 'pot'))!;
        if (identityKey(settings.data) !== identityKey(job.data)) throw new Error('TWIN_ANALYSIS_PERMISSION_STALE');
        if (source.revision !== job.data.sourceRevision) throw new Error('TWIN_ANALYSIS_PERMISSION_STALE');
        if (job.data.state !== 'running') throw new Error('TWIN_ANALYSIS_CANCELLED');
        const guard = await this.guard(job.data.scanScope, { settle: { reserved: job.data.reservedTokens, spent: result.tokens } });
        const writes = await this.candidateWrites(job.data, source, result.candidates);
        const complete = job.data.end >= source.data.characters;
        writes.push(job.data.checkpointId ? write('scan-checkpoint', job.data.checkpointId,
            { sourceId: source.id, sourceHash: source.data.hash, incarnation: source.data.incarnation, offset: job.data.end, complete } satisfies TwinScanCheckpoint,
            job.data.checkpointRevision ?? null) : write('source', source.id, { ...source.data, offset: job.data.end,
            analyzedHash: complete ? source.data.hash : '' }, source.revision), write('job', jobId,
            { ...job.data, reservedTokens: 0, actualTokens: result.tokens, state: 'committed', finishedAt: Date.now(), addedMemories: writes.filter(item => item.family === 'memory').length }, job.revision), write('settings', 'pot', { ...settings.data,
                reservedTokens: settings.data.reservedTokens - job.data.reservedTokens,
                spentTokens: settings.data.spentTokens + result.tokens }, settings.revision), ...guard.writes,
            ...await settleMeter(this.records, jobId, job.data, result.tokens, result.usageKind));
        await this.records.store.commit({ operationId: `result-${jobId}`, expectedForgetEpoch: job.data.epoch, writes,
            conditions: [...guard.conditions, { family: 'source', id: source.id, expectedRevision: source.revision }] });
    }

    private async candidateWrites(job: TwinAnalysisJob, source: TwinDataRecord<TwinSourceData>, candidates: Awaited<ReturnType<TwinExtractionPort['run']>>['candidates']) {
        const plan = job.scanScope?.planId ? await this.records.get<TwinScanPlan>('scan-plan', job.scanScope.planId) : null;
        const autoConfirm = Boolean(plan?.data.rules && plan.data.autoConfirm);
        const rules = new Set((await this.records.list('suppression')).map(rule => rule.id));
        const existing = new Set((await this.records.list('memory')).map(memory => memory.id));
        return candidates.filter(candidate => (!job.scanScope || job.scanScope.kinds.includes(candidate.kind)) && !suppressionKeys(source, candidate).some(key => rules.has(key))).flatMap(candidate => {
            const id = sha256HexSync(JSON.stringify([source.id, source.data.incarnation, candidate.subject, candidate.kind, candidate.content, ...(candidate.relation ? [candidate.relation] : [])]));
            if (existing.has(id)) return [];
            existing.add(id);
            const evidenceId = `${id}-evidence`;
            return [write('memory', id, memoryData({ ...candidate, state: autoConfirm && candidate.subject !== 'unknown' ? 'active' : 'candidate', independent: false,
                subjectId: subjectId(source, candidate.subject), entityScope: entityScope(source),
                projectId: source.data.resource && [source.data.resource.projectId, source.data.resource.projectName].includes(candidate.project) ? source.data.resource.projectId : undefined,
                sourceId: source.id, sourceHash: source.data.hash, sourceIncarnation: source.data.incarnation,
                evidenceIds: [evidenceId] }), null), write('evidence', evidenceId,
                    { kind: 'source', sourceId: source.id, hash: source.data.hash, incarnation: source.data.incarnation, quote: candidate.quote }, null)];
        });
    }

    private guard(scope?: TwinScanScope, charge?: import('./scan-domain').TwinScanCharge) {
        if (!scope) return Promise.resolve({ conditions: [], writes: [] });
        if (!this.scanGuard) throw new Error('TWIN_SCAN_PERMISSION_DENIED');
        return this.scanGuard(scope, charge);
    }

    private async fail(jobId: string, error: unknown): Promise<void> {
        const job = await this.records.get<TwinAnalysisJob>('job', jobId);
        if (!job || job.data.state === 'committed') return;
        await retry(() => settleFailedJob(this.records, jobId, error, safeError(error, 'TWIN_EXTRACTION_FAILED')));
        traceAnalysis(job.data, 'failed', { jobId, taskId: job.data.taskId, errorCode: safeError(error, 'TWIN_EXTRACTION_FAILED'), errorDetail: diagnosticDetail(error) || 'No failure message available' });
        // Unknown provider usage remains reserved. A failed call is never accounted as free.
    }
}

function safeError(error: unknown, fallback: string): string {
    return error instanceof Error && /^TWIN_[A-Z_]+$/.test(error.message) ? error.message : fallback;
}

function subjectId(source: TwinDataRecord<TwinSourceData>, subject: string): string {
    return subject === 'self' ? 'self' : `${entityScope(source)}:${subject}`;
}

function entityScope(source: TwinDataRecord<TwinSourceData>): string {
    return `source:${source.id}:${sha256HexSync(source.data.nativeIdentity)}`;
}

function suppressionKeys(source: TwinDataRecord<TwinSourceData>, candidate: import('./domain').TwinCandidate): string[] {
    const legacy = candidate.subject === 'self' ? 'self' : `source:${source.id}:${source.data.incarnation}:${candidate.subject}`;
    return [subjectId(source, candidate.subject), legacy].map(subject => sha256HexSync(JSON.stringify([subject, candidate.kind, candidate.content])));
}
