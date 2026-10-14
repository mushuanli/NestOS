import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { DigitalTwinService } from '../src/digital-twin/service';
import { knowledgeGraph, relatedMemories } from '../src/digital-twin/graph';
import { memoryData, type TwinAnalysisJob } from '../src/digital-twin/domain';
import { extractionPrompt, parseCandidates } from '../src/digital-twin/extraction';

it('projects only supported facts and retains typed relations with evidence references', () => {
    const facts = [
        { id: 'one', supported: true, data: memoryData({ content: 'Alex leads Alpha', subject: 'Alex', subjectId: 'user:a', project: 'Alpha', relation: { predicate: 'leads', target: 'Alpha', targetKind: 'project' } }) },
        { id: 'two', supported: true, data: memoryData({ content: 'Alex promised a draft', subject: 'Alex', subjectId: 'user:b', kind: 'commitment' }) },
        { id: 'hidden', supported: false, data: memoryData({ content: 'Old fact', subject: 'Hidden' }) },
        { id: 'candidate', supported: true, data: memoryData({ content: 'Unconfirmed', subject: 'Candidate', state: 'candidate' }) },
    ];
    const graph = knowledgeGraph(facts);
    expect(graph.nodes.filter(node => node.kind === 'person')).toHaveLength(2);
    expect(graph.nodes.some(node => ['Hidden', 'Candidate'].includes(node.name))).toBe(false);
    expect(graph.edges.find(edge => edge.predicate === 'leads')?.memoryIds).toEqual(['one']);
    expect(relatedMemories(graph, 'What is happening with Alpha?')).toEqual(new Set(['one']));
    expect(knowledgeGraph([])).toEqual({ nodes: [], edges: [] });
});

it('persists explicit person merges without merging equal names automatically', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const deps = { fs: await manager.openFileSystem('/'), reader: { sessions: async () => [], read: vi.fn() },
        extractor: { run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() }, deleteSession: vi.fn() };
    const service = new DigitalTwinService(deps);
    try {
        const a = await service.addMemory({ subject: 'Alex', subjectId: 'user:a', content: 'Works on Alpha' });
        const b = await service.addMemory({ subject: 'Alex', subjectId: 'user:b', content: 'Prefers email' });
        const before = (await service.snapshot()).graph;
        expect(before.nodes).toHaveLength(2);
        await service.mergePeople(before.nodes[0].id, before.nodes[1].id);
        const reopened = new DigitalTwinService(deps);
        try {
            const after = (await reopened.snapshot()).graph;
            expect(after.nodes).toHaveLength(1); expect(after.nodes[0].memoryIds.sort()).toEqual([a, b].sort());
            await reopened.forget(a); await reopened.forget(b);
            expect((await reopened.snapshot()).graph.nodes).toHaveLength(0);
        } finally { await reopened.dispose(); }
    } finally { await service.dispose(); await manager.dispose(); }
});

it('passes the rule focus into extraction and validates explicit relation output', () => {
    const job = { scanScope: { kinds: ['relationship'], focus: 'Responsibilities' } } as TwinAnalysisJob;
    expect(extractionPrompt(job)).toContain('Responsibilities');
    const candidate = { content: 'Alex leads Alpha', subject: 'Alex', kind: 'relationship', project: 'Alpha', eventTime: '', quote: 'Alex leads Alpha',
        relation: { predicate: 'leads', target: 'Alpha', targetKind: 'project' } };
    expect(parseCandidates(JSON.stringify({ candidates: [candidate] }), candidate.quote)[0].relation).toEqual(candidate.relation);
    expect(() => parseCandidates(JSON.stringify({ candidates: [{ ...candidate, relation: { ...candidate.relation, targetKind: 'unknown' } }] }), candidate.quote)).toThrow('TWIN_INVALID_RELATION');
});
