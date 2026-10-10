import { randomUUID } from '@itookit/common';
import { sha256HexSync } from '@itookit/llm-context';
import { memoryData, type TwinMemoryData, type TwinSourceData } from './domain';
import type { TwinRecordRef } from './contracts';
import { TwinRecords, write, type TwinDataRecord } from './records';

export class TwinKnowledge {
    constructor(private readonly records: TwinRecords) {}

    async manual(input: Partial<TwinMemoryData>): Promise<string> {
        await this.capacity();
        const id = randomUUID(), evidenceId = randomUUID();
        const data = memoryData({ ...input, independent: true, state: 'active', evidenceIds: [evidenceId],
            sourceId: '', sourceHash: '', sourceIncarnation: '', quote: '' });
        await this.records.store.commit({ operationId: randomUUID(),
            expectedForgetEpoch: (await this.records.store.inspect()).forgetEpoch, writes: [
                write('memory', id, data, null), write('evidence', evidenceId,
                    { kind: 'user-statement', memoryId: id, content: data.content, recordedAt: Date.now() }, null),
            ] });
        return id;
    }

    async review(id: string, revision: string, action: 'confirm' | 'reject' | 'dispute' | 'correct',
        patch: Partial<TwinMemoryData> = {}): Promise<void> {
        const current = await this.records.get<TwinMemoryData>('memory', id);
        if (!current || current.revision !== revision) throw new Error('TWIN_REVIEW_CONFLICT');
        if (action !== 'correct' && Object.keys(patch).length) throw new Error('TWIN_INVALID_REVIEW_PATCH');
        const editable = Object.fromEntries(Object.entries(patch).filter(([key]) =>
            ['content', 'kind', 'subject', 'project', 'eventTime', 'goalStatus', 'successCondition', 'deadline'].includes(key)));
        const independent = action === 'correct', decisionId = randomUUID();
        const state = action === 'reject' ? 'rejected' : action === 'dispute' ? 'disputed' : 'active';
        const data = memoryData({ ...current.data, ...editable, state, recordedAt: current.data.recordedAt,
            ...(independent ? { independent: true, subjectId: patch.subject === undefined || patch.subject === current.data.subject ? current.data.subjectId
                : patch.subject === 'self' ? 'self' : `user:${patch.subject}`, sourceId: '', sourceHash: '', sourceIncarnation: '', quote: '',
                evidenceIds: [...current.data.evidenceIds, decisionId] } : {}) });
        const conditions = await this.supportCondition(current.data, independent || action !== 'confirm');
        const writes = [write('memory', id, data, revision), write('review', decisionId,
            { memoryId: id, revision, action, time: Date.now(), statement: independent ? data.content : '' }, null)];
        if (independent) writes.push(write('evidence', decisionId, { kind: 'user-statement', memoryId: id, content: data.content }, null));
        await this.records.store.commit({ operationId: decisionId,
            expectedForgetEpoch: (await this.records.store.inspect()).forgetEpoch, writes, conditions });
    }

    async forget(id: string): Promise<void> { await this.forgetMany([id]); }

    async forgetMany(ids: string[]): Promise<void> {
        const memories = (await this.records.list<TwinMemoryData>('memory')).filter(memory => ids.includes(memory.id));
        if (memories.length) await this.invalidate(memories);
    }

    async removeSource(id: string, revision: string): Promise<void> {
        const source = await this.records.get<TwinSourceData>('source', id);
        if (!source || source.revision !== revision) throw new Error('TWIN_REVIEW_CONFLICT');
        const memories = (await this.records.list<TwinMemoryData>('memory')).filter(memory => memory.data.sourceId === id && !memory.data.independent);
        const evidence = (await this.records.list<{ sourceId?: string }>('evidence')).filter(item => item.data.sourceId === id);
        await this.invalidate(memories, [{ family: 'source', id }, ...evidence.map(item => ({ family: 'evidence' as const, id: item.id }))],
            [{ family: 'source', id, expectedRevision: revision }]);
    }

    private async invalidate(memories: TwinDataRecord<TwinMemoryData>[], extra: TwinRecordRef[] = [],
        conditions: Array<TwinRecordRef & { expectedRevision: string | null }> = []): Promise<void> {
        const selected = new Set(memories.map(memory => memory.id));
        const reviews = (await this.records.list<{ memoryId: string }>('review')).filter(item => selected.has(item.data.memoryId));
        const references = [...extra, ...memories.flatMap(memory => [{ family: 'memory' as const, id: memory.id },
            ...memory.data.evidenceIds.map(id => ({ family: 'evidence' as const, id }))]),
            ...reviews.map(item => ({ family: 'review' as const, id: item.id }))];
        const records = [...new Map(references.map(ref => [`${ref.family}/${ref.id}`, ref])).values()];
        const operationId = randomUUID();
        await this.records.store.startForget({ operationId, expectedForgetEpoch: (await this.records.store.inspect()).forgetEpoch,
            conditions: [...conditions, ...memories.map(memory => ({ family: 'memory' as const, id: memory.id, expectedRevision: memory.revision }))], records });
        await this.finishCleanup(operationId);
    }

    async recoverCleanup(): Promise<void> {
        let pending = await this.records.store.pendingCleanup();
        while (pending.length) {
            for (const operation of pending) await this.finishCleanup(operation.operationId);
            pending = await this.records.store.pendingCleanup();
        }
    }

    private async finishCleanup(operationId: string): Promise<void> {
        let operation = await this.records.store.cleanBatch(operationId, 100);
        while (operation.state !== 'completed') operation = await this.records.store.cleanBatch(operationId, 100);
    }

    async suppress(id: string, revision: string): Promise<void> {
        const current = await this.records.get<TwinMemoryData>('memory', id);
        if (!current || current.revision !== revision) throw new Error('TWIN_REVIEW_CONFLICT');
        const key = sha256HexSync(JSON.stringify([current.data.subjectId, current.data.kind, current.data.content]));
        const rule = await this.records.get('suppression', key);
        await this.records.save('suppression', key, { match: key }, rule?.revision ?? null);
        await this.forget(id);
    }

    private async capacity(): Promise<void> {
        if ((await this.records.list('memory')).length >= 500) throw new Error('TWIN_MEMORY_LIMIT');
    }

    private async supportCondition(data: TwinMemoryData, skip: boolean) {
        if (skip || data.independent) return [];
        const source = await this.records.get<TwinSourceData>('source', data.sourceId);
        if (!source || !supported(data, source)) throw new Error('TWIN_SOURCE_STALE');
        return [{ family: 'source' as const, id: source.id, expectedRevision: source.revision }];
    }
}

export function supported(memory: TwinMemoryData, source: TwinDataRecord<TwinSourceData> | null): boolean {
    return memory.independent || Boolean(source?.data.enabled && source.data.status === 'available'
        && source.data.hash === memory.sourceHash && source.data.incarnation === memory.sourceIncarnation);
}
