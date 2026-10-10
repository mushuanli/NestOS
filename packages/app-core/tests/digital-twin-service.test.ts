import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { randomUUID } from '@itookit/common';
import { sha256HexSync, type ContextPlan } from '@itookit/llm-context';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import { DigitalTwinService } from '../src/digital-twin/service';
import { SeqTwinStore } from '../src/digital-twin/seq-twin-store';
import type { TwinExtractionPort } from '../src/digital-twin/extraction';
import type { TwinSourceContent } from '../src/digital-twin/domain';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); });
const context = (sessionId = 'consumer', effectId = 'effect') => ({ sessionId, taskId: 'task', effectId }) as EffectExecutionContext;
const plan = (query: string) => ({ pendingUserMessage: { content: query } }) as ContextPlan;

async function setup(kind: 'memory' | 'indexeddb') {
    const backend = kind === 'memory' ? new MemoryBackend() : new IndexedDBBackend({ dbName: randomUUID() });
    const { manager } = await createVFS({ rootBackend: backend }); releases.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    let text = '我希望项目 Alpha 使用 TypeScript。', route = 'original', inaccessible = false;
    const reader = { read: vi.fn(async (): Promise<TwinSourceContent> => {
        if (inaccessible) throw new Error('unavailable');
        return { text, hash: sha256HexSync(text), nativeIdentity: 'document-incarnation' };
    }), sessions: async () => [{ id: 'consumer', title: 'Consumer' }, { id: 'other', title: 'Other' }] };
    const extractor: TwinExtractionPort = { run: vi.fn(async (_job, _text, attached) => {
        await attached('extraction-task'); return { candidates: [{ content: '项目 Alpha 使用 TypeScript', kind: 'preference',
            subject: 'self', project: 'Alpha', eventTime: '', quote: text }], tokens: 120 };
    }), cancel: vi.fn(async () => {}), cleanup: vi.fn(async () => {}) };
    const deleteSession = vi.fn(async () => {});
    const deps = { fs, reader, extractor, deleteSession, executionExists: async (_session: string, task: string) => task === 'known-task', connectionFingerprint: async () => route };
    const service = new DigitalTwinService(deps);
    const sourceId = await service.addSource({ kind: 'file', target: '/home/admin/minds/context.md', label: 'Context' }, 'model');
    const grant = () => service.grant({ sessionId: 'consumer', agentId: 'agent', connectionId: 'model', enabled: true, project: '' }, null);
    const request = (entries: Awaited<ReturnType<DigitalTwinService['retrieve']>>) => ({ resourceHandleId: 'llm', connectionId: 'model',
        request: { messages: entries.map(entry => ({ role: 'user' as const, content: `Memory (${entry.namespaceId}/${entry.entryId}):\n${entry.content}` })) } });
    return { fs, service, sourceId, grant, request, extractor, deleteSession,
        reopen: () => new DigitalTwinService(deps), change: (value: string) => { text = value; },
        reroute: () => { route = 'changed'; }, unavailable: () => { inaccessible = true; } };
}

describe.each(['memory', 'indexeddb'] as const)('Digital twin loop on %s', kind => {
    it('initializes, scans, reviews and forgets without native crypto.randomUUID', async () => {
        const getRandomValues = vi.fn(globalThis.crypto.getRandomValues.bind(globalThis.crypto));
        vi.stubGlobal('crypto', { getRandomValues });
        try {
            const host = await setup(kind), service = host.service;
            expect((await service.snapshot()).settings.data.tokenLimit).toBe(100000);
            const planId = await service.saveScanPlan(null, null, { name: 'Compatible scan', sourceIds: [host.sourceId],
                connectionId: 'model', kinds: ['preference'], mode: 'analyze', trigger: 'manual', intervalMinutes: 1,
                tokenLimit: 50000, enabled: true });
            const runId = await service.runScanPlan(planId); await service.waitScanRun(runId);
            const candidate = (await service.snapshot()).memories[0];
            await service.review(candidate.id, candidate.revision, 'confirm');
            const manualId = await service.addMemory({ content: 'Compatible manual memory' });
            await service.forget(candidate.id); await service.forget(manualId);
            const plan = (await service.snapshot()).scans.plans[0];
            await service.removeScanPlan(plan.id, plan.revision);
            const reopened = host.reopen();
            expect((await reopened.snapshot()).memories).toHaveLength(0);
            expect((await reopened.snapshot()).scans.plans).toHaveLength(0);
            await reopened.dispose(); expect(getRandomValues).toHaveBeenCalled();
        } finally { vi.unstubAllGlobals(); }
    });
    it('keeps candidates out of context, requires an explicit consumer grant, and records only supplied references', async () => {
        const { service, sourceId, grant, request } = await setup(kind);
        await service.analyze(sourceId);
        const snapshot = await service.snapshot(), candidate = snapshot.memories[0];
        expect(candidate.data.state).toBe('candidate'); expect(snapshot.settings.data.spentTokens).toBe(120);
        expect(await service.retrieve(plan('Alpha TypeScript'), 'agent', 'consumer')).toEqual([]);
        await service.review(candidate.id, candidate.revision, 'confirm');
        expect(await service.retrieve(plan('Alpha TypeScript'), 'agent', 'consumer')).toEqual([]);
        await grant();
        expect(await service.retrieve(plan('unrelated astronomy'), 'agent', 'consumer')).toEqual([]);
        expect(await service.retrieve(plan('Alpha TypeScript'), 'agent', 'other')).toEqual([]);
        const entries = await service.retrieve(plan('Alpha TypeScript'), 'agent', 'consumer'); expect(entries).toHaveLength(1);
        await service.authorizeLlm(request([]), context()); expect((await service.snapshot()).uses).toHaveLength(0);
        await service.authorizeLlm(request(entries), context()); await service.authorizeLlm(request(entries), context());
        expect((await service.snapshot()).uses).toHaveLength(1);
        await service.review(candidate.id, (await service.snapshot()).memories[0].revision, 'correct', { content: 'Alpha 改用 Rust' });
        await expect(service.authorizeLlm(request([]), context('consumer', 'next-exchange'))).rejects.toThrow('MEMORY_STALE');
    });

    it('invalidates confirmed evidence after source change, revocation, unreadability and connection replacement', async () => {
        const host = await setup(kind); await host.service.analyze(host.sourceId); await host.grant();
        let memory = (await host.service.snapshot()).memories[0]; await host.service.review(memory.id, memory.revision, 'confirm');
        const selected = await host.service.retrieve(plan('Alpha TypeScript'), 'agent', 'consumer');
        host.change('新的来源内容');
        await expect(host.service.authorizeLlm(host.request(selected), context())).rejects.toThrow('SOURCE_STALE');
        expect(await host.service.retrieve(plan('Alpha TypeScript'), 'agent', 'consumer')).toEqual([]);
        memory = (await host.service.snapshot()).memories[0];
        await host.service.review(memory.id, memory.revision, 'correct', { content: '我确认 Alpha 使用 TypeScript' });
        expect(await host.service.retrieve(plan('Alpha TypeScript'), 'agent', 'consumer')).toHaveLength(1);
        const fresh = await host.service.retrieve(plan('Alpha TypeScript'), 'agent', 'consumer');
        host.reroute();
        await expect(host.service.authorizeLlm(host.request(fresh), context())).rejects.toThrow('CONNECTION_CHANGED');
    });

    it('blocks historical use after grant revocation, settings disable and forget, including reopen', async () => {
        const host = await setup(kind); const id = await host.service.addMemory({ content: 'Alpha 使用 TypeScript', kind: 'fact' }); await host.grant();
        await host.service.authorizeLlm(host.request(await host.service.retrieve(plan('Alpha TypeScript'), 'agent', 'consumer')), context());
        expect(await host.service.forgetPreview(id)).toEqual(['consumer']);
        const snapshot = await host.service.snapshot();
        await host.service.grant({ ...snapshot.grants[0].data, enabled: false }, snapshot.grants[0].revision);
        await expect(host.service.authorizeLlm(host.request([]), context())).rejects.toThrow('PERMISSION_STALE');
        const result = await host.service.forget(id);
        expect(result.retainedSessions).toEqual(['consumer']);
        expect((await host.reopen().snapshot()).memories).toHaveLength(0);
        const store = await SeqTwinStore.open(host.fs, 'personal', 'admin');
        expect(await store.read({ family: 'evidence', id: snapshot.memories[0].data.evidenceIds[0] })).toBeNull();
        const versions: string[] = [];
        await host.fs.meta.seq!.walkEntries('/var/lib/digital-twin/personal/knowledge.seq', entry => { versions.push(entry.value); return true; });
        expect(versions.join('')).not.toContain('Alpha 使用 TypeScript');
    });

    it('preserves reservation for unknown usage, suppresses repeat candidates, and refuses stale confirmation patches', async () => {
        const host = await setup(kind);
        vi.mocked(host.extractor.run).mockRejectedValueOnce(new Error('network outcome unknown'));
        await expect(host.service.analyze(host.sourceId)).rejects.toThrow('TWIN_SCAN_FAILED');
        expect((await host.service.snapshot()).settings.data.reservedTokens).toBeGreaterThan(0);
        await host.service.analyze(host.sourceId);
        const candidate = (await host.service.snapshot()).memories[0];
        await expect(host.service.review(candidate.id, candidate.revision, 'confirm', { content: 'forged support' })).rejects.toThrow('INVALID_REVIEW_PATCH');
        await host.service.suppress(candidate.id, candidate.revision);
        host.change('我希望项目 Alpha 使用 TypeScript。 补充');
        await host.service.analyze(host.sourceId);
        expect((await host.service.snapshot()).memories).toHaveLength(0);
    });

    it('forgets exact project scopes while retaining independent other records and links existing executions without inferring completion', async () => {
        const host = await setup(kind);
        const first = await host.service.addMemory({ content: 'Alpha launch', kind: 'goal', project: 'Alpha', subject: 'person-a' });
        await host.service.addMemory({ content: 'Alpha decision', kind: 'decision', project: 'Alpha', subject: 'person-b' });
        const other = await host.service.addMemory({ content: 'Beta context', kind: 'fact', project: 'Beta', subject: 'person-a' });
        const goal = (await host.service.snapshot()).memories.find(memory => memory.id === first)!;
        await host.service.linkExecution(first, goal.revision, { sessionId: 'consumer', taskId: 'known-task' });
        const linked = (await host.service.snapshot()).memories.find(memory => memory.id === first)!;
        expect(linked.data.goalStatus).toBe('draft'); expect(linked.data.executionRefs).toHaveLength(1);
        await expect(host.service.linkExecution(first, linked.revision, { sessionId: 'consumer', taskId: 'unknown-task' })).rejects.toThrow('INVALID_GOAL_REFERENCE');
        expect((await host.service.forgetScopePreview({ project: 'Alpha' })).ids).toHaveLength(2);
        await host.service.forgetScope({ project: 'Alpha' });
        expect((await host.service.snapshot()).memories.map(memory => memory.id)).toEqual([other]);
    });

    it('removes sources and dependent candidates while retaining independent user statements', async () => {
        const host = await setup(kind); await host.service.analyze(host.sourceId);
        const independent = await host.service.addMemory({ content: '独立用户陈述', kind: 'fact' });
        const snapshot = await host.service.snapshot();
        await host.service.removeSource(host.sourceId, snapshot.sources[0].revision);
        const after = await host.service.snapshot();
        expect(after.sources).toHaveLength(0); expect(after.memories.map(memory => memory.id)).toEqual([independent]);
    });

    it('stops committing a late model response after source revocation or forget epoch changes', async () => {
        const host = await setup(kind); let resolve!: (value: any) => void;
        vi.mocked(host.extractor.run).mockImplementationOnce(async (_job, _text, attached) => {
            await attached('late'); return new Promise(done => { resolve = done; });
        });
        const running = host.service.analyze(host.sourceId);
        await vi.waitFor(() => expect(resolve).toBeDefined());
        const source = (await host.service.snapshot()).sources[0];
        await host.service.setSourceEnabled(source.id, source.revision, false);
        resolve({ candidates: [{ content: 'Alpha', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'Alpha' }], tokens: 10 });
        await expect(running).rejects.toThrow('CANCELLED');
        expect((await host.service.snapshot()).memories).toHaveLength(0);
    });
});
