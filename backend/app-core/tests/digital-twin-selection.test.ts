import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { sha256HexSync } from '@itookit/llm-context';
import { DigitalTwinService, type TwinDiscoveredSource, type TwinSelectionTarget } from '../src';
import { extractionPrompt } from '../src/digital-twin/extraction';
import { selectionPattern } from '../src/digital-twin/selection';
import { matchesLine } from '../src/digital-twin/scan-rules';
import { discoverWorkspaces } from '../src/digital-twin/workspace-catalog';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function setup(kind: 'memory' | 'indexeddb') {
    const { manager } = await createVFS({ rootBackend: kind === 'memory' ? new MemoryBackend() : new IndexedDBBackend({ dbName: crypto.randomUUID() }) });
    closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/');
    const resources: TwinDiscoveredSource[] = [
        { kind: 'file', projectId: 'p', target: 'project://p/mail.email', path: 'mail.email', label: 'Mail' },
        { kind: 'file', projectId: 'p', target: 'project://p/notes/a.md', path: 'notes/a.md', label: 'Note' },
        { kind: 'session', projectId: 'p', target: 's1', label: 'Local' },
        { kind: 'harness-session', projectId: 'p', target: '["p","codex","remote"]', label: 'Remote' },
    ];
    const run = vi.fn(async (_job, text, attached) => { await attached('task'); return { candidates: [
        { kind: 'fact' as const, subject: 'self', content: text, quote: text, project: '', eventTime: '' },
        { kind: 'event' as const, subject: 'self', content: text, quote: text, project: '', eventTime: '' },
    ], tokens: 10 }; });
    const read = vi.fn(async (source: TwinSelectionTarget) => ({ text: source.target, hash: sha256HexSync(source.target), nativeIdentity: source.target }));
    const service = new DigitalTwinService({ fs, defaultConnection: async () => 'configured-model', reader: { sessions: async () => [], read,
        discover: async () => ({ resources, projects: ['p'], completeScopes: ['p/file', 'p/session', 'p/harness-session'], errors: [] }) },
        extractor: { run, cancel: async () => {}, cleanup: async () => {} }, deleteSession: async () => {} });
    closes.push(() => service.dispose()); return { service, resources, run, read, fs };
}
describe.each(['memory', 'indexeddb'] as const)('explicit twin membership on %s', kind => {
    it('only scans mail automatically, then immediately scans selected local and remote sessions', async () => {
        const host = await setup(kind); await host.service.scanOnce();
        expect((await host.service.snapshot()).sources.map(source => source.data.target)).toEqual([host.resources[0].target]);
        for (const source of host.resources.slice(2)) {
            await host.service.selectSource(source, 'profile');
            await vi.waitFor(async () => expect((await host.service.selectionInfo(source)).memories).toHaveLength(1));
        }
        expect(host.run.mock.calls.every(([job]) => job.connectionId === 'configured-model')).toBe(true);
    });
    it('overrides broad types, removes derived information and can be explicitly added again', async () => {
        const host = await setup(kind), source = host.resources[0];
        await host.service.snapshot(); await host.service.selectSource(source, 'profile');
        await vi.waitFor(async () => expect((await host.service.selectionInfo(source)).memories).toHaveLength(1));
        expect((await host.service.selectionInfo(source)).memories[0].data.kind).toBe('fact');
        await host.service.addMemory({ content: 'Independent statement' });
        await host.service.removeSelection(source); await host.service.scanOnce();
        expect((await host.service.selectionInfo(source)).memories).toHaveLength(0);
        expect((await host.service.snapshot()).memories.map(memory => memory.data.content)).toEqual(['Independent statement']);
        await host.service.selectSource(source, 'events');
        await vi.waitFor(async () => expect((await host.service.selectionInfo(source)).memories).toHaveLength(1));
        expect((await host.service.selectionInfo(source)).memories[0].data.kind).toBe('event');
    });
    it('keeps corrected results associated across reopen and clears them on explicit removal', async () => {
        const host = await setup(kind), source = host.resources[1];
        await host.service.selectSource(source, 'profile');
        await vi.waitFor(async () => expect((await host.service.selectionInfo(source)).memories).toHaveLength(1));
        const initial = (await host.service.selectionInfo(source)).memories[0];
        await host.service.review(initial.id, initial.revision, 'correct', { content: 'User correction' });
        const corrected = (await host.service.selectionInfo(source)).memories[0];
        expect(corrected.data).toMatchObject({ content: 'User correction', independent: true, originSourceId: initial.data.sourceId, sourceId: '' });
        await expect(host.service.review(initial.id, initial.revision, 'correct', { content: 'Stale edit' })).rejects.toThrow('TWIN_REVIEW_CONFLICT');
        await host.service.scanOnce();
        expect((await host.service.selectionInfo(source)).memories[0].data.content).toBe('User correction');
        await host.service.addMemory({ content: 'Unrelated personal note' });
        const retained = (await host.service.snapshot()).memories.filter(memory => memory.id !== corrected.id).map(memory => memory.id).sort();
        await host.service.removeSelection(source);
        expect((await host.service.selectionInfo(source)).memories).toHaveLength(0);
        expect((await host.service.snapshot()).memories.map(memory => memory.id).sort()).toEqual(retained);
    });
    it('freezes configured names into the dispatched extraction prompt', async () => {
        const host = await setup(kind), settings = (await host.service.snapshot()).settings;
        await host.service.configure({ userName: 'Alice', userAliases: ['alice@example.com'] }, settings.revision);
        await host.service.selectSource(host.resources[1], 'profile');
        await vi.waitFor(() => expect(host.run).toHaveBeenCalled());
        const job = host.run.mock.calls.at(-1)![0];
        expect(extractionPrompt(job)).toContain('Alice'); expect(extractionPrompt(job)).toContain('alice@example.com');
        expect(extractionPrompt(job)).toContain('ambiguous');
    });
});
it('uses literal source identity for directory selection, including wildcard characters', () => {
    const target = { kind: 'file' as const, target: 'project://p/a*/', directory: true, label: '' };
    const pattern = selectionPattern(target);
    const resource = { kind: 'file' as const, projectId: 'p', target: 'project://p/a*/file.md', label: '' };
    expect(matchesLine(resource, pattern)).toBe(true);
    expect(matchesLine({ ...resource, target: 'project://p/abc/file.md' }, pattern)).toBe(false);
    expect(matchesLine({ ...resource, target: 'project://other/a*/file.md' }, pattern)).toBe(false);
});
it('discovers real mail and note workspace documents without exposing protected files', async () => {
    const host = await setup('memory');
    for (const name of ['emails', 'notes']) await host.fs.driver.createFile({ parentPath: `/home/admin/${name}`, name: 'a.md', content: name, recursive: true });
    await host.fs.driver.createFile({ parentPath: '/home/admin/emails', name: 'private.email', content: 'secret', metadata: { isProtected: true } });
    const catalog = { resources: [] as TwinDiscoveredSource[], projects: [] as string[], completeScopes: [] as string[], errors: [] as string[] };
    await discoverWorkspaces(host.fs, catalog);
    expect(catalog.resources.map(source => source.target)).toEqual(['/home/admin/emails/a.md', '/home/admin/notes/a.md']);
    expect(catalog.errors).toEqual([]);
});
it('rejects a late extraction result after removal and keeps raw sources readable', async () => {
    const host = await setup('indexeddb'), source = host.resources[1];
    await host.service.scanOnce(); host.run.mockClear();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = host.run.getMockImplementation()!;
    host.run.mockImplementation(async (...args) => { await pending; return original(...args); });
    await host.service.selectSource(source, 'profile');
    await vi.waitFor(() => expect(host.run).toHaveBeenCalledTimes(1));
    try { await host.service.removeSelection(source); } finally { release(); }
    await host.service.scanOnce();
    expect((await host.service.selectionInfo(source)).memories).toHaveLength(0);
    expect((await host.read(source)).text).toBe(source.target);
});
it('does not wait for discovery when a menu selection is saved', async () => {
    const host = await setup('memory'); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    host.read.mockImplementation(async source => { await pending; return { text: source.target, hash: sha256HexSync(source.target), nativeIdentity: source.target }; });
    try {
        await host.service.selectSource(host.resources[1], 'profile');
        const info = await host.service.selectionInfo(host.resources[1]);
        expect(info.plan?.data.enabled).toBe(true); expect(host.run).not.toHaveBeenCalled();
    } finally { release(); await host.service.scanOnce(); }
});
it('migrates only the untouched old catch-all default and leaves custom rules intact', async () => {
    const { TwinRecords } = await import('../src/digital-twin/records');
    const { SeqTwinStore } = await import('../src/digital-twin/seq-twin-store');
    const { TwinScanStore } = await import('../src/digital-twin/scan-store');
    const { migrateMailDefault } = await import('../src/digital-twin/default-rules');
    const { TWIN_KINDS } = await import('../src/digital-twin/domain');
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); closes.push(() => manager.dispose());
    const records = new TwinRecords(await SeqTwinStore.open(await manager.openFileSystem('/'), 'personal', 'admin'));
    const data = { name: 'Default', rules: { include: [], exclude: [] }, sourceIds: [], connectionId: 'model', connectionFingerprint: 'model',
        kinds: [...TWIN_KINDS], mode: 'analyze', trigger: 'interval', intervalMinutes: 30, tokenLimit: 100000, enabled: true, autoConfirm: true,
        createdAt: 1, updatedAt: 1 };
    await records.save('scan-plan', 'seeded', data, null);
    await records.save('scan-plan', 'custom', { ...data, name: 'My rules' }, null);
    const store = new TwinScanStore(records, 'test'); await migrateMailDefault(store); await migrateMailDefault(store);
    expect((await records.get<typeof data>('scan-plan', 'seeded'))!.data.rules.include).toContain('file:**/*.email');
    expect((await records.get<typeof data>('scan-plan', 'custom'))!.data.rules.include).toEqual([]);
});
