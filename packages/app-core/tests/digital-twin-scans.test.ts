import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, FSError } from '@itookit/vfs-core';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { sha256HexSync } from '@itookit/llm-context';
import { DigitalTwinService, SeqTwinStore, TWIN_KINDS, type TwinScanPlanInput } from '../src';
import type { TwinExtractionPort } from '../src/digital-twin/extraction';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function setup(kind: 'memory' | 'indexeddb') {
    const backend = kind === 'memory' ? new MemoryBackend() : new IndexedDBBackend({ dbName: crypto.randomUUID() });
    const { manager } = await createVFS({ rootBackend: backend }); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), texts = new Map([['a', 'Alpha preference and fact'], ['b', 'Beta preference and fact']]);
    let now = 100000, active = 0, maximum = 0;
    const extractor: TwinExtractionPort = { run: vi.fn(async (job, text, attached) => {
        active++; maximum = Math.max(maximum, active);
        try { await attached('task-' + job.sessionId); await Promise.resolve();
            return { candidates: ['fact', 'preference'].map(kind => ({ content: `${text.slice(0, 20)} ${kind} ${job.offset}`,
                kind: kind as 'fact' | 'preference', subject: 'self', project: 'Alpha', eventTime: '', quote: text.slice(0, 10) })), tokens: 2000 };
        } finally { active--; }
    }), cancel: vi.fn(async () => {}), cleanup: vi.fn(async () => {}) };
    const deps = { fs, extractor, scanHost: { kind: 'test', now: () => now, leaseMs: 100 }, connectionFingerprint: async () => 'route',
        reader: { read: async (spec: { target: string }) => {
            const text = texts.get(spec.target); if (text === undefined) throw new FSError('ENOENT', 'missing');
            return { text, hash: sha256HexSync(text), nativeIdentity: spec.target };
        }, sessions: async () => [] }, deleteSession: async () => {} };
    const service = new DigitalTwinService(deps); closes.push(() => service.dispose());
    const a = await service.addSource({ kind: 'file', target: 'a', label: 'A' }, 'model');
    const b = await service.addSource({ kind: 'file', target: 'b', label: 'B' }, 'model');
    const input = (sourceIds: string[], patch: Partial<TwinScanPlanInput> = {}): TwinScanPlanInput => ({ name: 'Plan', sourceIds,
        connectionId: 'model', kinds: [...TWIN_KINDS], mode: 'analyze', trigger: 'manual', intervalMinutes: 1,
        tokenLimit: 50000, enabled: true, ...patch });
    const pause = async (paused: boolean) => {
        const settings = (await service.snapshot()).settings;
        await service.configure({ paused }, settings.revision);
    };
    return { fs, service, a, b, input, texts, extractor, pause, maximum: () => maximum, advance: (ms: number) => { now += ms; },
        reopen: () => { const host = new DigitalTwinService(deps); closes.push(() => host.dispose()); return host; } };
}

describe.each(['memory', 'indexeddb'] as const)('scan plans on %s', kind => {
    it('upgrades the known previous layout without resetting identity, memory or forget tombstones', async () => {
        const host = await setup(kind);
        const retained = await host.service.addMemory({ content: 'Retained during scan upgrade' });
        const forgotten = await host.service.addMemory({ content: 'Forgotten before scan upgrade' });
        await host.service.forget(forgotten);
        const store = await SeqTwinStore.open(host.fs, 'personal', 'admin'), before = await store.inspect();
        await host.fs.meta.seq!.setEntry('/var/lib/digital-twin/personal/authority.seq', 'twin', JSON.stringify({ ...before, layoutVersion: 2 }));
        await expect(store.inspect()).rejects.toThrow('Unsupported Twin layout');
        const upgraded = await SeqTwinStore.open(host.fs, 'personal', 'admin');
        expect(await upgraded.inspect()).toEqual(before);
        expect((await upgraded.read({ family: 'memory', id: retained }))!.payload.content).toBe('Retained during scan upgrade');
        expect(await upgraded.read({ family: 'memory', id: forgotten })).toBeNull();
    });
    it('does not open storage or start work after disposal races an initialization check', async () => {
        const host = await setup(kind), other = host.reopen(); let release!: (exists: boolean) => void;
        const exists = host.fs.driver.exists.bind(host.fs.driver);
        const pending = new Promise<boolean>(resolve => { release = resolve; }); let first = true;
        const check = vi.spyOn(host.fs.driver, 'exists').mockImplementation(path => {
            if (first && path === '/var/lib/digital-twin/personal/authority.seq') { first = false; return pending; }
            return exists(path);
        });
        const opens = vi.spyOn(host.fs.driver, 'createFile');
        try {
            const pumping = other.scanOnce(); await other.dispose(); release(true); await pumping;
            expect(opens).not.toHaveBeenCalled(); expect(host.extractor.run).not.toHaveBeenCalled();
        } finally { release(true); check.mockRestore(); opens.mockRestore(); }
    });
    it('queues multiple plans, serializes extraction and reuses overlapping committed progress', async () => {
        const host = await setup(kind), { service, a, b } = host;
        const first = await service.saveScanPlan(null, null, host.input([a, b]));
        const second = await service.saveScanPlan(null, null, host.input([b], { name: 'Overlap' }));
        await host.pause(true);
        const r1 = await service.runScanPlan(first), r2 = await service.runScanPlan(second);
        await service.scanOnce(); expect((await service.snapshot()).scans.runs.every(run => run.data.state === 'queued')).toBe(true);
        await host.pause(false); await service.waitScanRun(r1); await service.waitScanRun(r2);
        const snapshot = await service.snapshot();
        expect(host.extractor.run).toHaveBeenCalledTimes(2); expect(host.maximum()).toBe(1);
        expect(snapshot.scans.runs.map(run => run.data.spentTokens)).toEqual([4000, 0]);
        expect(snapshot.memories.every(memory => memory.data.state === 'candidate')).toBe(true);
        expect(snapshot.scans.runs[0].data.completedSourceIds).toEqual([a, b]);
    });
    it('keeps extraction-kind checkpoints independent and does not confuse filtered scans with full coverage', async () => {
        const host = await setup(kind);
        const fact = await host.service.saveScanPlan(null, null, host.input([host.a], { kinds: ['fact'] }));
        const preference = await host.service.saveScanPlan(null, null, host.input([host.a], { kinds: ['preference'] }));
        await host.service.waitScanRun(await host.service.runScanPlan(fact));
        expect((await host.service.snapshot()).memories.map(memory => memory.data.kind)).toEqual(['fact']);
        await host.service.waitScanRun(await host.service.runScanPlan(preference));
        await host.service.waitScanRun(await host.service.runScanPlan(fact));
        expect(host.extractor.run).toHaveBeenCalledTimes(2);
        const snapshot = await host.service.snapshot();
        expect(snapshot.memories.map(memory => memory.data.kind)).toEqual(['fact', 'preference']);
        expect(snapshot.sources.find(source => source.id === host.a)!.data.analyzedHash).toBe('');
    });
    it('stops at a per-run budget and resumes committed segments through a new run', async () => {
        const host = await setup(kind); host.texts.set('a', 'x'.repeat(9000));
        const id = await host.service.saveScanPlan(null, null, host.input([host.a], { tokenLimit: 9000 }));
        const r1 = await host.service.runScanPlan(id);
        await expect(host.service.waitScanRun(r1)).rejects.toThrow('SCAN_BUDGET_EXHAUSTED');
        let snapshot = await host.service.snapshot();
        expect(snapshot.sources.find(source => source.id === host.a)!.data.offset).toBe(4000);
        expect(snapshot.scans.runs[0].data).toMatchObject({ state: 'paused', spentTokens: 2000, reservedTokens: 0 });
        await host.service.saveScanPlan(id, snapshot.scans.plans[0].revision, host.input([host.a], { tokenLimit: 20000 }));
        await host.service.waitScanRun(await host.service.runScanPlan(id));
        snapshot = await host.service.snapshot(); expect(host.extractor.run).toHaveBeenCalledTimes(3);
        expect(snapshot.settings.data.spentTokens).toBe(6000);
        expect(snapshot.sources.find(source => source.id === host.a)!.data.offset).toBe(9000);
    });
    it('rejects a late result after a plan is paused and retains unknown provider reservation', async () => {
        const host = await setup(kind); let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        const original = host.extractor.run;
        vi.mocked(host.extractor.run).mockImplementationOnce(async (...args) => { await args[2]('slow-task'); await waiting; return original(...args); });
        const id = await host.service.saveScanPlan(null, null, host.input([host.a]));
        const runId = await host.service.runScanPlan(id);
        await vi.waitFor(async () => expect((await host.service.snapshot()).jobs[0]?.data.state).toBe('running'));
        await host.service.setScanPlanEnabled(id, (await host.service.snapshot()).scans.plans[0].revision, false);
        release(); await host.service.scanOnce();
        const snapshot = await host.service.snapshot();
        expect(snapshot.scans.runs.find(run => run.id === runId)!.data.state).toBe('cancelled');
        expect(snapshot.memories).toHaveLength(0); expect(snapshot.settings.data.reservedTokens).toBeGreaterThan(0);
    });
    it('coalesces missed interval triggers and only runs change plans when the source signature changes', async () => {
        const host = await setup(kind);
        await host.service.saveScanPlan(null, null, host.input([host.a], { trigger: 'interval' }));
        await host.service.saveScanPlan(null, null, host.input([host.b], { trigger: 'changes' }));
        await host.service.scanOnce(); expect((await host.service.snapshot()).scans.runs).toHaveLength(2);
        host.advance(600000); await host.service.scanOnce();
        expect((await host.service.snapshot()).scans.runs).toHaveLength(3); expect(host.extractor.run).toHaveBeenCalledTimes(2);
        host.texts.set('b', 'Beta changed preference'); host.advance(60000); await host.service.scanOnce();
        expect((await host.service.snapshot()).scans.runs).toHaveLength(5); expect(host.extractor.run).toHaveBeenCalledTimes(3);
    });
    it('reconciles deletion while analysis is paused and deletes plans without deleting generated memories', async () => {
        const host = await setup(kind), id = await host.service.saveScanPlan(null, null, host.input([host.a]));
        await host.service.waitScanRun(await host.service.runScanPlan(id));
        const candidate = (await host.service.snapshot()).memories[0]; await host.service.review(candidate.id, candidate.revision, 'confirm');
        const check = await host.service.saveScanPlan(null, null, host.input([host.a], { mode: 'reconcile', trigger: 'interval', name: 'Check only' }));
        await host.pause(true); host.texts.delete('a'); await host.service.scanOnce();
        let snapshot = await host.service.snapshot(); expect(snapshot.sources.find(source => source.id === host.a)!.data.status).toBe('deleted');
        expect(snapshot.scans.runs.find(run => run.data.planId === check)!.data.state).toBe('succeeded');
        expect(snapshot.memories.find(memory => memory.id === candidate.id)!.supported).toBe(false);
        await host.service.removeScanPlan(id, snapshot.scans.plans.find(plan => plan.id === id)!.revision);
        snapshot = await host.service.snapshot(); expect(snapshot.memories).toHaveLength(2);
        expect(snapshot.scans.plans.map(plan => plan.id)).toEqual([check]);
    });
    it('uses the shared host fence, recovers an interrupted run and rejects the old host result', async () => {
        const host = await setup(kind); let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; }), original = host.extractor.run;
        vi.mocked(host.extractor.run).mockImplementationOnce(async (...args) => { await args[2]('slow-task'); await waiting; return original(...args); });
        const planId = await host.service.saveScanPlan(null, null, host.input([host.a]));
        await host.service.runScanPlan(planId);
        await vi.waitFor(async () => expect((await host.service.snapshot()).jobs[0]?.data.state).toBe('running'));
        const other = host.reopen(); await other.scanOnce(); expect(host.extractor.run).toHaveBeenCalledTimes(1);
        host.advance(101); await other.scanOnce();
        expect((await other.snapshot()).scans.runs[0].data.state).toBe('interrupted');
        release(); await host.service.scanOnce();
        expect((await other.snapshot()).memories).toHaveLength(0);
        expect((await other.snapshot()).settings.data.reservedTokens).toBeGreaterThan(0);
    });
    it('persists queued work across reopen, requires source grants and rejects stale plan edits', async () => {
        const host = await setup(kind);
        await expect(host.service.saveScanPlan(null, null, host.input(['missing']))).rejects.toThrow('SOURCE_DENIED');
        const id = await host.service.saveScanPlan(null, null, host.input([host.a]));
        const revision = (await host.service.snapshot()).scans.plans[0].revision;
        await host.service.saveScanPlan(id, revision, host.input([host.a], { name: 'Changed' }));
        await expect(host.service.saveScanPlan(id, revision, host.input([host.a]))).rejects.toThrow('REVIEW_CONFLICT');
        await host.pause(true); const run = await host.service.runScanPlan(id); await host.service.scanOnce();
        await host.service.dispose(); const other = host.reopen();
        await other.configure({ paused: false }, (await other.snapshot()).settings.revision);
        await other.waitScanRun(run); expect((await other.snapshot()).scans.runs[0].data.state).toBe('succeeded');
    });
});
