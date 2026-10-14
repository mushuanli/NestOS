import { describe, expect, it } from 'vitest';
import { createContextContentStore, contextKey } from '../content/store';
import { createContextService } from './service';
import { createContextEngine } from '../window/engine';
import type { ContextPrepareInput, PreparedContext } from '../domain/durable';

function fixture() {
    const blobs = new Map<string, string>();
    const records = new Map<string, { version: number; value: unknown }>();
    const content = createContextContentStore({ get: async id => blobs.get(id) ?? null,
        putIfAbsent: async (id, value) => { if (!blobs.has(id)) blobs.set(id, value); } });
    const service = () => createContextService({ content, records: { get: async key => records.get(key)?.value },
        summarize: async () => 'Preserve the original goal; inspect the remaining errors.' });
    const commit = (prepared: PreparedContext) => {
        for (const write of prepared.writes) {
            if ((records.get(write.key)?.version ?? null) !== write.expectedVersion) throw new Error('CAS conflict');
        }
        for (const write of prepared.writes) records.set(write.key, { value: write.value, version: (records.get(write.key)?.version ?? 0) + 1 });
    };
    return { blobs, content, records, service, commit };
}
const initial: ContextPrepareInput = { contextId: 'task', operationId: 'prepare-1',
    request: { model: 'test', tools: [] }, messages: [{ role: 'system', content: 'Keep rules' }, { role: 'user', content: 'Original goal' }] };

describe('durable context', () => {
    it('rejects live attachment data before any content publication', async () => {
        const f = fixture();
        await expect(f.service().prepare({ ...initial, messages: [{ role: 'user', content: 'image',
            attachments: [{ type: 'image', source: new ArrayBuffer(8) }] }] })).rejects.toThrow('resolve live attachments');
        expect(f.blobs.size).toBe(0);
    });
    it('publishes immutable requests before head commit and restores identical bytes after restart', async () => {
        const f = fixture();
        const result = await f.service().prepare(initial);
        expect(await f.service().inspect('task')).toBeNull();
        f.commit(result);
        const restored = await f.service().request(result.cursor);
        expect(restored.request.messages.map(({ tags: _tags, ...message }) => message)).toEqual(initial.messages);
        expect((await f.service().prepare(initial)).writes).toEqual([]);
        await expect(f.service().prepare({ ...initial, messages: [{ role: 'user', content: 'changed' }] })).rejects.toThrow('identity was reused');
        expect((await f.service().inspect('task'))?.digest).toBe(restored.digest);
    });

    it('rejects stale candidates without advancing head or publishing receipts', async () => {
        const f = fixture(); const first = await f.service().prepare(initial); f.commit(first);
        const next = { ...initial, previous: first.cursor, messages: [{ role: 'assistant' as const, content: 'progress' }] };
        const left = await f.service().prepare({ ...next, operationId: 'left' });
        const right = await f.service().prepare({ ...next, operationId: 'right' });
        f.commit(left);
        expect(() => f.commit(right)).toThrow('CAS conflict');
        expect(f.records.has(contextKey('task', 'receipt/right'))).toBe(false);
        expect((await f.service().inspect('task'))?.revision).toBe(2);
    });

    it('keeps source history retrievable across three window rotations', async () => {
        const f = fixture(); let current = await f.service().prepare(initial); f.commit(current);
        for (let i = 0; i < 3; i++) {
            current = await f.service().prepare({ ...initial, operationId: `next-${i}`, previous: current.cursor,
                policy: { maxMessages: 2, keepRecent: 1, strategy: 'summary-tail' },
                messages: [{ role: 'assistant', content: `evidence-${i}` }, { role: 'user', content: `follow-up-${i}` }] });
            f.commit(current);
        }
        const view = await f.service().inspect('task');
        expect(view?.generation).toBe(3);
        expect(view?.request.messages.some(message => message.content === 'Keep rules')).toBe(true);
        expect(view?.request.messages.at(-1)?.content).toBe('follow-up-2');
        expect(view?.request.messages.some(message => message.content === 'Original goal')).toBe(true);
        expect(view?.notes?.revision).toBe(3);
        const history = await f.service().history('task', { query: 'Original goal' });
        expect(history.items[0].message.content).toBe('Original goal');
    });

    it('requires evidence and a matching revision for checkpoint reset', async () => {
        const f = fixture(); const first = await f.service().prepare(initial); f.commit(first);
        const old = await f.service().request(first.cursor);
        const next = { ...initial, operationId: 'reset', previous: first.cursor,
            messages: [{ role: 'assistant' as const, content: 'progress' }],
            notes: { revision: 1, basedOnRevision: 0, text: 'Continue inspecting', evidence: [old.history] } };
        await expect(f.service().prepare(next)).rejects.toThrow('current notes');
        const valid = await f.service().prepare({ ...next, notes: { ...next.notes, basedOnRevision: 1 } });
        f.commit(valid);
        expect((await f.service().inspect('task'))?.explanation.strategy).toBe('checkpoint-reset');
    });

    it('externalizes Unicode output without exceeding the byte bound and verifies content on read', async () => {
        const f = fixture(); const original = '证据🙂'.repeat(1_000_000);
        const result = await f.service().admitOutput(original, 1024);
        expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(1024);
        expect(await f.content.read(result.contentRef!)).toBe(original);
        const second = await f.service().admitOutput(original, 1024);
        expect(second.contentRef).toEqual(result.contentRef);
        expect(f.blobs.size).toBe(1);
        f.blobs.set(result.contentRef!.id, 'corrupt');
        await expect(f.service().read(result.contentRef!)).rejects.toThrow('missing or corrupt');
    });

    it('archives a large final answer without making it the next model request', async () => {
        const f = fixture(); const first = await f.service().prepare(initial); f.commit(first);
        const final = await f.service().prepare({ ...initial, previous: first.cursor, operationId: 'final', archiveOnly: true,
            messages: [{ role: 'assistant', content: 'answer'.repeat(100_000) }] });
        f.commit(final);
        expect((await f.service().inspect('task'))?.request).toEqual((await f.service().request(first.cursor)).request);
        expect((await f.service().history('task', { query: 'answer' })).items).toHaveLength(1);
    });

    it('counts schemas and retains complete tool groups and developer rules', () => {
        const engine = createContextEngine();
        const messages = [{ role: 'developer' as const, content: 'policy' }, { role: 'user' as const, content: 'goal' },
            { role: 'assistant' as const, content: '', tool_calls: [{ id: 'c', type: 'function' as const, function: { name: 'read', arguments: '{}' } }] },
            { role: 'tool' as const, tool_call_id: 'c', content: 'result' }];
        expect(engine.select(messages, {}, { maxMessages: 1 }).messages).toEqual(messages);
        expect(() => engine.select(messages, { tools: ['x'.repeat(5000)] }, { maxMessages: 2, maxInputTokens: 500 })).toThrow('Required context');
        expect(() => engine.select(messages.slice(0, -1), {})).toThrow('missing results');
    });
});
