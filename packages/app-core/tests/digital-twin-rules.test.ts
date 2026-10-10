import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { randomUUID } from '@itookit/common';
import { sha256HexSync } from '@itookit/llm-context';
import { DigitalTwinService, type TwinDiscoveredSource, type TwinSourceCatalog } from '../src';
import { matchesRules, ruleLines } from '../src/digital-twin/scan-rules';
import { publicHarnessText, readHarness, discoverHarness } from '../src/digital-twin/harness-reader';
import type { ProjectService, ProjectFolder } from '../src/projects/project-service';
import type { HarnessClient } from '@itookit/piagent-driver';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function setup(kind: 'memory' | 'indexeddb') {
    const backend = kind === 'memory' ? new MemoryBackend() : new IndexedDBBackend({ dbName: randomUUID() });
    const { manager } = await createVFS({ rootBackend: backend }); closes.push(() => manager.dispose());
    let now = 100000, offline = false, route = 'route';
    const entries = new Map<string, { resource: TwinDiscoveredSource; text: string; identity: string }>();
    const put = (target: string, text: string, type: TwinDiscoveredSource['kind'] = 'file', identity = target) => entries.set(target,
        { resource: { kind: type, target, projectId: 'alpha', path: target, sessionId: target, profileId: type === 'harness-session' ? 'codex' : undefined, label: target }, text, identity });
    const discover = vi.fn(async (): Promise<TwinSourceCatalog> => ({ resources: offline ? [] : [...entries.values()].map(item => item.resource),
        projects: ['alpha'], completeScopes: offline ? [] : ['alpha/file', 'alpha/session', 'alpha/harness-session'], errors: offline ? ['alpha/file'] : [] }));
    const extractor = { run: vi.fn(async (_job, text, attached) => { await attached('kernel-task'); return {
        candidates: [{ content: text, kind: 'fact' as const, subject: 'self', project: 'alpha', eventTime: '', quote: text }], tokens: 10 }; }),
        cancel: vi.fn(async () => {}), cleanup: vi.fn(async () => {}) };
    const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'), extractor, reader: {
        discover, sessions: async () => [], read: async spec => {
            if (offline) throw new Error('offline'); const entry = entries.get(spec.target); if (!entry) throw new Error('unavailable');
            return { text: entry.text, hash: sha256HexSync(entry.text), nativeIdentity: entry.identity };
        } }, deleteSession: async () => {}, connectionFingerprint: async () => route, scanHost: { kind: 'test', now: () => now } });
    closes.push(() => service.dispose());
    await service.configure({ connectionId: 'model' }, (await service.snapshot()).settings.revision);
    const rule = (include: string[] = [], exclude: string[] = []) => service.saveScanRule(null, null, { name: 'Rule', include, exclude, intervalMinutes: 1, enabled: true });
    const run = async (id: string) => { const runId = await service.runScanPlan(id); await service.waitScanRun(runId); };
    return { service, put, rule, run, entries, discover, extractor, setRoute: (value: string) => { route = value; }, advance: () => { now += 60001; }, setOffline: (value: boolean) => { offline = value; } };
}
it('matches typed scopes, root globs, directory patterns, comments and exclusions', () => {
    const file: TwinDiscoveredSource = { kind: 'file', projectId: 'alpha', path: 'docs/note.md', target: 'file', label: '' };
    expect(matchesRules(file, { include: ['file:**/*.md'], exclude: [] })).toBe(true);
    expect(matchesRules({ ...file, path: 'note.md' }, { include: ['file:**/*.md'], exclude: [] })).toBe(true);
    expect(matchesRules(file, { include: ['project:alpha'], exclude: ['file:docs/'] })).toBe(false);
    expect(matchesRules(file, { include: ['session:**'], exclude: [] })).toBe(false);
    expect(matchesRules({ ...file, kind: 'harness-session', profileId: 'codex', sessionId: 's' }, { include: ['session:harness/codex/*'], exclude: [] })).toBe(true);
    expect(ruleLines(['# comment', ' ', 'file:**/*.md', 'file:**/*.md'])).toEqual(['file:**/*.md']);
    for (const line of ['unknown:**', 'file:../secret', '!file:**', 'file:[a]']) expect(() => ruleLines([line])).toThrow('TWIN_INVALID_SCAN_RULE');
});
describe.each(['memory', 'indexeddb'] as const)('automatic rules on %s', kind => {
    it('discovers new sources and invalidates modified, deleted, replaced and excluded evidence while preserving manual memories', async () => {
        const host = await setup(kind); host.put('note.md', 'first');
        const id = await host.rule(); await host.run(id);
        expect(host.extractor.run).toHaveBeenCalledTimes(1);
        const original = (await host.service.snapshot()).memories[0]; expect(original.data.state).toBe('active');
        await host.run(id); expect(host.extractor.run).toHaveBeenCalledTimes(1);
        host.put('added.md', 'added'); host.advance(); await host.service.scanOnce();
        expect((await host.service.snapshot()).sources).toHaveLength(2);
        host.put('note.md', 'second'); await host.run(id);
        expect((await host.service.snapshot()).memories.find(memory => memory.id === original.id)!.supported).toBe(false);
        const manual = await host.service.addMemory({ content: 'Independent correction' });
        host.entries.delete('note.md'); await host.run(id);
        expect((await host.service.snapshot()).sources.find(source => source.data.target === 'note.md')!.data.status).toBe('deleted');
        host.put('note.md', 'second', 'file', 'replacement'); await host.run(id);
        expect(host.extractor.run).toHaveBeenCalledTimes(4);
        const settings = (await host.service.snapshot()).settings;
        await host.service.configure({ globalExclude: ['file:**'] }, settings.revision);
        const snapshot = await host.service.snapshot();
        expect(snapshot.memories.filter(memory => memory.supported).map(memory => memory.id)).toEqual([manual]);
    });
    it('combines multiple rules, previews without mutation, and does not infer deletion from failed enumeration', async () => {
        const host = await setup(kind); host.put('note.md', 'document'); host.put('s', 'conversation', 'session');
        const preview = await host.service.previewScanRule({ include: ['file:**/*.md'], exclude: [] });
        expect(preview.resources).toHaveLength(1); expect((await host.service.snapshot()).sources).toHaveLength(0);
        const files = await host.rule(['file:**'], ['file:note.md']); const sessions = await host.rule(['session:native/**']);
        expect((await host.service.snapshot()).sources.map(source => source.data.kind)).toEqual(['session']);
        const additional = await host.rule(['project:alpha']); await host.run(additional);
        expect((await host.service.snapshot()).sources).toHaveLength(2);
        const plan = (await host.service.snapshot()).scans.plans.find(item => item.id === additional)!;
        await host.service.setScanPlanEnabled(plan.id, plan.revision, false);
        expect((await host.service.snapshot()).sources.find(source => source.data.kind === 'file')!.data.enabled).toBe(false);
        await host.run(files); await host.run(sessions);
        host.setOffline(true); host.advance(); await host.service.scanOnce();
        const snapshot = await host.service.snapshot();
        expect(snapshot.sources.every(source => source.data.status !== 'deleted')).toBe(true);
        expect(snapshot.scans.discovery.errors).toContain('alpha/file');
    });
    it('refreshes global model bindings and resumes extraction without editing each rule', async () => {
        const host = await setup(kind); host.put('note.md', 'fact'); const id = await host.rule(); await host.run(id);
        const original = (await host.service.snapshot()).scans.plans[0];
        host.setRoute('updated-route'); host.advance(); await host.service.scanOnce();
        const snapshot = await host.service.snapshot();
        expect(snapshot.scans.plans[0].revision).not.toBe(original.revision);
        expect(snapshot.scans.plans[0].data.connectionFingerprint).toBe('updated-route');
        expect(host.extractor.run).toHaveBeenCalledTimes(2);
        expect(snapshot.memories.filter(memory => memory.supported)).toHaveLength(1);
    });
    it('rejects a late result after a global exclusion takes effect', async () => {
        const host = await setup(kind); host.put('note.md', 'private after revocation'); const id = await host.rule();
        let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
        host.extractor.run.mockImplementationOnce(async () => { await pending; return { candidates: [{ content: 'late', kind: 'fact', subject: 'self', project: 'alpha', eventTime: '', quote: 'private' }], tokens: 10 }; });
        const runId = await host.service.runScanPlan(id), waiting = host.service.waitScanRun(runId).catch(error => error);
        await vi.waitFor(() => expect(host.extractor.run).toHaveBeenCalled());
        await host.service.configure({ globalExclude: ['file:**'] }, (await host.service.snapshot()).settings.revision);
        release(); await waiting;
        expect((await host.service.snapshot()).memories).toHaveLength(0);
    });
});
it('reads paginated harness history without resuming and keeps only visible user/assistant messages', async () => {
    const session = { id: 's', title: 'Harness', cwd: null, status: 'idle', updatedAt: 10, createdAt: 1, resumable: true };
    const first = { session, turns: [{ id: 't', items: [{ type: 'userMessage', text: 'User fact' }, { type: 'reasoning', text: 'SECRET' }, { type: 'commandExecution', text: 'SECRET_TOOL' }] }], nextCursor: 'next' };
    const second = { session, turns: [{ id: 't2', items: [{ type: 'agentMessage', content: [{ type: 'output_text', text: 'Assistant suggestion' }, { type: 'reasoning', text: 'SECRET' }] }] }] };
    expect(publicHarnessText(first)).not.toContain('SECRET');
    const client = { read: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second), close: vi.fn(async () => {}) } as unknown as HarnessClient;
    const projects = { remoteMounts: { list: () => [], projectHarness: async () => client } } as unknown as ProjectService;
    const result = await readHarness(projects, JSON.stringify(['alpha', 'codex', 's']));
    expect(result.text).toContain('User fact'); expect(result.text).toContain('Assistant suggestion'); expect(result.text).not.toContain('SECRET');
    expect(client.read).toHaveBeenCalledTimes(2); expect(client.close).toHaveBeenCalledTimes(1);
});
it('does not mark a partially enumerated harness profile complete', async () => {
    const client = { profiles: async () => ({ profiles: [{ id: 'codex', projectRuntime: true, capabilities: { history: true } }] }),
        list: vi.fn().mockResolvedValueOnce({ sessions: [{ id: 's', title: 'S' }], nextCursor: 'next' }).mockRejectedValue(new Error('offline')),
        close: vi.fn(async () => {}) } as unknown as HarnessClient;
    const projects = { remoteMounts: { list: () => [{ at: '/', connectionId: 'c', serverProjectId: 'p' }], projectHarness: async () => client } } as unknown as ProjectService;
    const catalog: TwinSourceCatalog = { projects: ['alpha'], resources: [], completeScopes: [], errors: [] };
    await discoverHarness(projects, { project: { id: 'alpha' } } as ProjectFolder, catalog);
    expect(catalog.completeScopes).toEqual([]); expect(catalog.errors).toEqual(['alpha/harness-session']); expect(client.close).toHaveBeenCalledTimes(1);
});
it('enumerates and reads actual project directories and native sessions through their existing services', async () => {
    const { createApplicationRuntime } = await import('../src/runtime/create-application-runtime');
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web', digitalTwinAutoStart: false });
    try {
        const project = await runtime.projects.personal(), source = await runtime.projects.openFiles(project.path);
        await source.fs.driver.createFile({ parentPath: '/docs', name: 'note.md', content: 'Personal project fact', recursive: true });
        await source.fs.driver.createFile({ parentPath: '/node_modules', name: 'hidden.md', content: 'Dependency', recursive: true });
        await source.fs.driver.createFile({ parentPath: '/docs', name: 'binary.png', content: 'Binary', recursive: true });
        const id = await runtime.sessionRepository.createSession('Project conversation', project.path + '/@sessions');
        const { RoundLog } = await import('@itookit/llm-session');
        await new RoundLog(runtime.sessionRepository, id).append('main', { id: 'r', kind: 'chat', historyParentIds: [], origin: 'user', status: 'completed', createdAt: 1,
            input: [{ role: 'user', content: 'Native project fact' }], output: [{ role: 'assistant', content: 'Visible suggestion' }] });
        const { MindosTwinSourceReader } = await import('../src/digital-twin/source-reader');
        const fs = await runtime.vfs.openFileSystem('/'), reader = new MindosTwinSourceReader(fs, runtime.sessionRepository, runtime.projects);
        const catalog = await reader.discover();
        const document = catalog.resources.find(resource => resource.path === 'docs/note.md')!;
        expect(document.projectId).toBe(project.project.id); expect(catalog.resources.some(resource => resource.path?.includes('node_modules'))).toBe(false);
        expect(catalog.resources.some(resource => resource.path?.endsWith('.png'))).toBe(false);
        expect(catalog.resources.find(resource => resource.target === id)!.projectId).toBe(project.project.id);
        expect((await reader.read(document)).text).toBe('Personal project fact');
        const version = await reader.probe(document); await source.fs.driver.writeContent('/docs/note.md', 'Changed fact');
        expect(await reader.probe(document)).not.toBe(version);
        expect((await reader.read(document)).text).toBe('Changed fact');
        expect((await reader.read(catalog.resources.find(resource => resource.target === id)!)).text).toContain('Native project fact');
        await source.dispose();
    } finally { await runtime.dispose(); }
});
it('creates one default rule atomically and does not recreate it after deletion', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }), fs = await manager.openFileSystem('/');
    const deps = { fs, defaultConnection: async () => 'model', reader: {
        read: vi.fn(), sessions: async () => [], discover: async () => ({ projects: [], resources: [], completeScopes: [], errors: [] }) },
        extractor: { run: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() }, deleteSession: vi.fn() };
    const first = new DigitalTwinService(deps), second = new DigitalTwinService(deps);
    try {
        await Promise.all([first.snapshot(), second.snapshot()]);
        const plan = (await first.snapshot()).scans.plans[0];
        expect((await first.snapshot()).scans.plans).toHaveLength(1);
        expect(plan.data.rules).toEqual({ include: [], exclude: [] }); expect(plan.data.intervalMinutes).toBe(30);
        await first.removeScanPlan(plan.id, plan.revision);
        const reopened = new DigitalTwinService(deps);
        try { expect((await reopened.snapshot()).scans.plans).toHaveLength(0); }
        finally { await reopened.dispose(); }
    } finally { await second.dispose(); await first.dispose(); await manager.dispose(); }
});
it('starts discovery automatically before the twin page or storage has ever been opened', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }), fs = await manager.openFileSystem('/');
    const resource: TwinDiscoveredSource = { kind: 'file', projectId: 'alpha', path: 'note.md', target: 'note.md', label: 'Note' };
    const discover = vi.fn(async () => ({ projects: ['alpha'], resources: [resource], completeScopes: ['alpha/file'], errors: [] }));
    const run = vi.fn(async (_job, _text, attached) => { await attached('kernel-task'); return {
        candidates: [{ content: 'Auto fact', kind: 'fact' as const, subject: 'self', project: 'alpha', eventTime: '', quote: 'Auto fact' }], tokens: 10 }; });
    const service = new DigitalTwinService({ fs, defaultConnection: async () => 'model', reader: { discover,
        read: async () => ({ text: 'Auto fact', hash: sha256HexSync('Auto fact'), nativeIdentity: 'file' }), sessions: async () => [] },
        extractor: { run, cancel: async () => {}, cleanup: async () => {} }, deleteSession: async () => {} });
    try {
        expect(await fs.driver.exists('/var/lib/digital-twin/personal/authority.seq')).toBe(false);
        service.start(); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        await vi.waitFor(async () => expect((await service.snapshot()).memories[0]?.data.state).toBe('active'));
        expect(discover).toHaveBeenCalled();
    } finally { await service.dispose(); await manager.dispose(); }
});
