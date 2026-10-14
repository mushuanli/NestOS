import { knowledgeGraph, relatedMemories, type TwinEntityAlias } from './graph';
import { sha256HexSync, type ContextPlan, type RetrievedMemoryEntry } from '@itookit/llm-context';
import type { KernelAdaptersRuntimeOptions } from '@itookit/kernel-adapters';
import type { TwinMemoryData, TwinSettings, TwinSourceData } from './domain';
import { supported } from './knowledge';
import { TwinRecords } from './records';
import { TwinSources } from './sources';

/** grantRevision is a legacy storage field now holding the global policy fingerprint. */
export interface TwinUseRecord {
    sessionId: string; taskId: string; agentId: string; connectionId: string; grantRevision: string;
    memoryRefs: Array<{ id: string; revision: string }>; usedAt: number;
}

export class TwinContext {
    constructor(private readonly records: TwinRecords, private readonly sources: TwinSources) {}

    async retrieve(plan: ContextPlan, agentId: string, _sessionId: string): Promise<RetrievedMemoryEntry[]> {
        const settings = await this.records.get<TwinSettings>('settings', 'pot');
        if (!settings?.data.useEnabled) return [];
        const query = typeof plan.pendingUserMessage?.content === 'string' ? plan.pendingUserMessage.content : '';
        const sourceMap = new Map((await this.records.list<TwinSourceData>('source')).map(source => [source.id, source]));
        const ignored = new Set((await Promise.all([...sourceMap.values()].map(async source => await this.sources.excluded(source.data, settings.data.globalExclude ?? []) ? source.id : ''))).filter(Boolean));
        const eligible = (await this.records.list<TwinMemoryData>('memory')).filter(memory => memory.data.state === 'active'
            && (memory.data.independent || !ignored.has(memory.data.sourceId))
            && supported(memory.data, sourceMap.get(memory.data.sourceId) ?? null));
        const aliases = new Map((await this.records.list<TwinEntityAlias>('entity')).map(alias => [alias.id, alias.data]));
        const related = relatedMemories(knowledgeGraph(eligible.map(memory => ({ ...memory, supported: true })), aliases), query);
        const scored = eligible.map(memory => ({ memory, score: relevance(query, memory.data) + (related.has(memory.id) ? 1 : 0) })).filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id)).slice(0, 5);
        await this.reconcileReferences(scored.map(({ memory }) => ({ id: memory.id })));
        const current = await Promise.all(scored.map(async ({ memory }) => ({ memory, valid: supported(memory.data,
            memory.data.independent ? null : await this.records.get<TwinSourceData>('source', memory.data.sourceId)) })));
        return current.filter(item => item.valid).map(({ memory }) => ({ namespaceId: 'digital-twin',
            entryId: encodeURIComponent(JSON.stringify([memory.id, memory.revision, policyRevision(settings.data), agentId])),
            content: referenceContent(memory.data), contentHash: sha256HexSync(referenceContent(memory.data)) }));
    }

    readonly authorize: NonNullable<KernelAdaptersRuntimeOptions['authorizeLlm']> = async (request, context) => {
        const previous = (await this.records.list<TwinUseRecord>('usage')).filter(use => use.data.sessionId === context.sessionId);
        const selected = parseReferences(request.request.messages);
        await this.reconcileReferences([...selected, ...previous.flatMap(use => use.data.memoryRefs)]);
        for (const use of previous) await this.validate(use.data);
        if (previous.length || selected.length) request.request._label = `twin-private-${sha256HexSync(context.sessionId + ':' + context.effectId).slice(0, 40)}`;
        if (!selected.length) return;
        const settings = await this.records.get<TwinSettings>('settings', 'pot');
        if (!settings?.data.useEnabled) throw new Error('TWIN_CONTEXT_PERMISSION_DENIED');
        const revision = policyRevision(settings.data);
        const use: TwinUseRecord = { sessionId: context.sessionId, taskId: context.taskId,
            agentId: selected[0].agentId, connectionId: request.connectionId, grantRevision: revision,
            memoryRefs: selected.map(({ id, revision }) => ({ id, revision })), usedAt: Date.now() };
        const conditions = await this.validate(use);
        for (const ref of selected) {
            const memory = await this.records.get<TwinMemoryData>('memory', ref.id);
            if (!memory || ref.content !== referenceContent(memory.data)) throw new Error('TWIN_CONTEXT_CONTENT_STALE');
        }
        const id = `${context.taskId}:${context.effectId}`, existing = await this.records.get<TwinUseRecord>('usage', id);
        if (existing && JSON.stringify(existing.data.memoryRefs) !== JSON.stringify(use.memoryRefs)) throw new Error('TWIN_CONTEXT_RECEIPT_CONFLICT');
        if (!existing) await this.records.save('usage', id, use, null, conditions);
    };

    private async reconcileReferences(refs: Array<{ id: string }>): Promise<void> {
        const checked = new Set<string>();
        for (const ref of refs) {
            const memory = await this.records.get<TwinMemoryData>('memory', ref.id);
            if (!memory || memory.data.independent || checked.has(memory.data.sourceId)) continue;
            checked.add(memory.data.sourceId);
            const source = await this.records.get<TwinSourceData>('source', memory.data.sourceId);
            if (source?.data.enabled) await this.sources.checkOne(source.id);
        }
    }
    private async validate(use: TwinUseRecord) {
        const settings = await this.records.get<TwinSettings>('settings', 'pot');
        if (!settings?.data.useEnabled) throw new Error('TWIN_CONTEXT_PERMISSION_STALE');
        const checks: Array<{ family: 'memory' | 'source' | 'settings'; id: string; expectedRevision: string }> = [
            { family: 'settings', id: settings.id, expectedRevision: settings.revision }];
        for (const ref of use.memoryRefs) for (const check of await this.memoryChecks(ref)) {
            if (!checks.some(existing => existing.family === check.family && existing.id === check.id)) checks.push(check);
        }
        return checks;
    }
    private async memoryChecks(ref: { id: string; revision: string }) {
        const memory = await this.records.get<TwinMemoryData>('memory', ref.id);
        if (!memory || memory.revision !== ref.revision || memory.data.state !== 'active') throw new Error('TWIN_CONTEXT_MEMORY_STALE');
        const source = memory.data.independent ? null : await this.records.get<TwinSourceData>('source', memory.data.sourceId);
        if (source && await this.sources.excluded(source.data)) throw new Error('TWIN_CONTEXT_SOURCE_IGNORED');
        if (!supported(memory.data, source)) throw new Error('TWIN_CONTEXT_SOURCE_STALE');
        const checks: Array<{ family: 'memory' | 'source'; id: string; expectedRevision: string }> = [
            { family: 'memory', id: ref.id, expectedRevision: ref.revision }];
        if (source) checks.push({ family: 'source', id: source.id, expectedRevision: source.revision });
        return checks;
    }

}

function policyRevision(settings: TwinSettings): string {
    return 'global:' + sha256HexSync(JSON.stringify([settings.useEnabled, settings.globalExclude ?? []]));
}
function referenceContent(memory: TwinMemoryData): string {
    return JSON.stringify({ content: memory.content, kind: memory.kind, subject: memory.subject, subjectId: memory.subjectId, project: memory.project,
        eventTime: memory.eventTime, goalStatus: memory.goalStatus, deadline: memory.deadline,
        note: 'Evidence-backed context data; automatic extraction may contain errors. Current user instructions take precedence. This is not an action permission.' });
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
