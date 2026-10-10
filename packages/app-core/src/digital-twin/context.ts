import { sha256HexSync, type ContextPlan, type RetrievedMemoryEntry } from '@itookit/llm-context';
import type { KernelAdaptersRuntimeOptions } from '@itookit/kernel-adapters';
import type { TwinGrantData, TwinMemoryData, TwinSettings, TwinSourceData } from './domain';
import { supported } from './knowledge';
import { TwinRecords } from './records';
import { TwinSources } from './sources';

export interface TwinUseRecord {
    sessionId: string; taskId: string; agentId: string; connectionId: string; grantRevision: string;
    memoryRefs: Array<{ id: string; revision: string }>; usedAt: number;
}

export class TwinContext {
    constructor(private readonly records: TwinRecords, private readonly sources: TwinSources) {}

    async retrieve(plan: ContextPlan, agentId: string, sessionId: string): Promise<RetrievedMemoryEntry[]> {
        const settings = await this.records.get<TwinSettings>('settings', 'pot');
        const grant = await this.records.get<TwinGrantData>('grant', sessionId);
        if (!settings?.data.useEnabled || !grant?.data.enabled || !agentAllowed(grant.data, agentId)) return [];
        if (await this.sources.fingerprint(grant.data.connectionId) !== grant.data.connectionFingerprint) return [];
        await this.sources.reconcile();
        const query = typeof plan.pendingUserMessage?.content === 'string' ? plan.pendingUserMessage.content : '';
        const sourceMap = new Map((await this.records.list<TwinSourceData>('source')).map(source => [source.id, source]));
        const scored = (await this.records.list<TwinMemoryData>('memory')).filter(memory => memory.data.state === 'active'
            && (!grant.data.project || memory.data.project === grant.data.project)
            && (memory.data.independent || sourceMap.get(memory.data.sourceId)?.data.connectionId === grant.data.connectionId)
            && supported(memory.data, sourceMap.get(memory.data.sourceId) ?? null))
            .map(memory => ({ memory, score: relevance(query, memory.data) })).filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id)).slice(0, 5);
        return scored.map(({ memory }) => ({ namespaceId: 'digital-twin',
            entryId: encodeURIComponent(JSON.stringify([memory.id, memory.revision, grant.revision, agentId])),
            content: referenceContent(memory.data), contentHash: sha256HexSync(referenceContent(memory.data)) }));
    }

    readonly authorize: NonNullable<KernelAdaptersRuntimeOptions['authorizeLlm']> = async (request, context) => {
        await this.sources.reconcile();
        const previous = (await this.records.list<TwinUseRecord>('usage')).filter(use => use.data.sessionId === context.sessionId);
        for (const use of previous) await this.validate(use.data, request.connectionId);
        const selected = parseReferences(request.request.messages);
        if (previous.length || selected.length) request.request._label = `twin-private-${sha256HexSync(context.sessionId + ':' + context.effectId).slice(0, 40)}`;
        if (!selected.length) return;
        const grant = await this.records.get<TwinGrantData>('grant', context.sessionId);
        if (!grant) throw new Error('TWIN_CONTEXT_PERMISSION_DENIED');
        const use: TwinUseRecord = { sessionId: context.sessionId, taskId: context.taskId,
            agentId: selected[0].agentId, connectionId: request.connectionId, grantRevision: grant.revision,
            memoryRefs: selected.map(({ id, revision }) => ({ id, revision })), usedAt: Date.now() };
        const conditions = await this.validate(use, request.connectionId);
        for (const ref of selected) {
            if (ref.grantRevision !== grant.revision || ref.agentId !== use.agentId) throw new Error('TWIN_CONTEXT_PERMISSION_STALE');
            const memory = await this.records.get<TwinMemoryData>('memory', ref.id);
            if (!memory || ref.content !== referenceContent(memory.data)) throw new Error('TWIN_CONTEXT_CONTENT_STALE');
        }
        const id = `${context.taskId}:${context.effectId}`, existing = await this.records.get<TwinUseRecord>('usage', id);
        if (existing && JSON.stringify(existing.data.memoryRefs) !== JSON.stringify(use.memoryRefs)) throw new Error('TWIN_CONTEXT_RECEIPT_CONFLICT');
        if (!existing) await this.records.save('usage', id, use, null, conditions);
    };

    private async validate(use: TwinUseRecord, connectionId: string) {
        const grant = await this.records.get<TwinGrantData>('grant', use.sessionId);
        const settings = await this.records.get<TwinSettings>('settings', 'pot');
        if (!settings?.data.useEnabled || !grant?.data.enabled || !agentAllowed(grant.data, use.agentId)
            || grant.data.connectionId !== connectionId || grant.revision !== use.grantRevision) throw new Error('TWIN_CONTEXT_PERMISSION_STALE');
        if (await this.sources.fingerprint(connectionId) !== grant.data.connectionFingerprint) throw new Error('TWIN_CONNECTION_CHANGED');
        const conditions = [{ family: 'grant' as const, id: grant.id, expectedRevision: grant.revision }];
        const checks: Array<{ family: 'grant' | 'memory' | 'source' | 'settings'; id: string; expectedRevision: string }> = conditions;
        checks.push({ family: 'settings', id: settings.id, expectedRevision: settings.revision });
        for (const ref of use.memoryRefs) for (const check of await this.memoryChecks(ref, grant.data.project, connectionId)) {
            if (!checks.some(existing => existing.family === check.family && existing.id === check.id)) checks.push(check);
        }
        return checks;
    }
    private async memoryChecks(ref: { id: string; revision: string }, project: string, connectionId: string) {
        const memory = await this.records.get<TwinMemoryData>('memory', ref.id);
        if (!memory || memory.revision !== ref.revision || memory.data.state !== 'active'
            || (project && memory.data.project !== project)) throw new Error('TWIN_CONTEXT_MEMORY_STALE');
        const source = memory.data.independent ? null : await this.records.get<TwinSourceData>('source', memory.data.sourceId);
        if (source && source.data.connectionId !== connectionId) throw new Error('TWIN_CONTEXT_ROUTE_DENIED');
        if (!supported(memory.data, source)) throw new Error('TWIN_CONTEXT_SOURCE_STALE');
        const checks: Array<{ family: 'memory' | 'source'; id: string; expectedRevision: string }> = [
            { family: 'memory', id: ref.id, expectedRevision: ref.revision }];
        if (source) checks.push({ family: 'source', id: source.id, expectedRevision: source.revision });
        return checks;
    }

}

function agentAllowed(grant: TwinGrantData, agentId: string): boolean { return grant.agentId === '*' || grant.agentId === agentId; }
function referenceContent(memory: TwinMemoryData): string {
    return JSON.stringify({ content: memory.content, kind: memory.kind, subject: memory.subject, subjectId: memory.subjectId, project: memory.project,
        eventTime: memory.eventTime, goalStatus: memory.goalStatus, deadline: memory.deadline,
        note: 'User-confirmed context data. Current user instructions take precedence. This is not an action permission.' });
}

function parseReferences(messages: Array<{ role: string; content: unknown }>) {
    const result: Array<{ id: string; revision: string; grantRevision: string; agentId: string; content: string }> = [];
    for (const message of messages) {
        if (message.role !== 'user' || typeof message.content !== 'string') continue;
        const match = /^Memory \(digital-twin\/([^\n)]+)\):\n([\s\S]*)$/.exec(message.content);
        if (!match) continue;
        const ref: unknown = JSON.parse(decodeURIComponent(match[1]));
        if (!Array.isArray(ref) || ref.length !== 4 || ref.some(value => typeof value !== 'string')) throw new Error('TWIN_CONTEXT_INVALID_REFERENCE');
        result.push({ id: ref[0], revision: ref[1], grantRevision: ref[2], agentId: ref[3], content: match[2] });
    }
    return result;
}

function relevance(query: string, memory: TwinMemoryData): number {
    const terms = tokens(query), text = `${memory.content} ${memory.subject} ${memory.project}`.toLowerCase();
    if (memory.kind === 'goal' && memory.goalStatus === 'cancelled') return 0;
    return terms.filter(term => text.includes(term)).length;
}
function tokens(text: string): string[] {
    const words = text.toLowerCase().match(/[a-z0-9_-]{2,}|[\u4e00-\u9fff]+/g) ?? [];
    return [...new Set(words.flatMap(word => /[\u4e00-\u9fff]/.test(word)
        ? [...word].slice(0, -1).map((_, index) => word.slice(index, index + 2)) : [word]))];
}
