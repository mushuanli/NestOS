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
    it('keeps zero finite by default and lets unlimited rules extract while preserving usage accounting', async () => {
        const host = await setup(kind); host.put('note.md', 'first fact');
        await host.service.configure({ tokenLimit: 0 }, (await host.service.getSettings()).revision);
        const id = await host.rule();
        await expect(host.run(id)).rejects.toThrow('TWIN_BUDGET_EXHAUSTED');
        expect(host.extractor.run).not.toHaveBeenCalled();
        await host.service.configure({ budgetUnlimited: true }, (await host.service.getSettings()).revision);
        await host.run(id);
        const snapshot = await host.service.snapshot();
        expect(snapshot.settings.data).toMatchObject({ tokenLimit: 0, budgetUnlimited: true, spentTokens: 10, reservedTokens: 0 });
        expect(snapshot.scans.runs.find(run => run.data.state === 'succeeded')!.data)
            .toMatchObject({ tokenLimit: 0, budgetUnlimited: true, spentTokens: 10, reservedTokens: 0 });
        await host.service.configure({ budgetUnlimited: false }, (await host.service.getSettings()).revision);
        host.put('note.md', 'second fact');
        await expect(host.run(id)).rejects.toThrow('TWIN_BUDGET_EXHAUSTED');
        expect(host.extractor.run).toHaveBeenCalledTimes(1);
    });
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
        expect(plan.data.rules).toEqual({ include: ['file:**/*.email', 'resource:file/%2Fhome%2Fadmin%2Femails%2F**'], exclude: [] }); expect(plan.data.intervalMinutes).toBe(30);
        await first.removeScanPlan(plan.id, plan.revision);
        const reopened = new DigitalTwinService(deps);
        try { expect((await reopened.snapshot()).scans.plans).toHaveLength(0); }
        finally { await reopened.dispose(); }
    } finally { await second.dispose(); await first.dispose(); await manager.dispose(); }
});
it('starts discovery automatically before the twin page or storage has ever been opened', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }), fs = await manager.openFileSystem('/');
    const resource: TwinDiscoveredSource = { kind: 'file', projectId: 'alpha', path: 'note.email', target: 'note.email', label: 'Note' };
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

it('supports ignore-style paths, anchored directories and non-file scopes', () => {
    const resource: TwinDiscoveredSource = { kind: 'file', projectId: 'alpha', target: 'file', label: '', path: 'src/drafts/note.md' };
    expect(matchesRules(resource, { include: [], exclude: ['drafts/'] })).toBe(false);
    expect(matchesRules(resource, { include: [], exclude: ['drafts'] })).toBe(false);
    expect(matchesRules(resource, { include: [], exclude: ['/drafts/'] })).toBe(true);
    expect(matchesRules({ ...resource, path: 'drafts/note.md' }, { include: [], exclude: ['/drafts/'] })).toBe(false);
    expect(matchesRules({ ...resource, path: 'logs/build.log' }, { include: [], exclude: ['*.log'] })).toBe(false);
    expect(matchesRules({ ...resource, kind: 'session' }, { include: [], exclude: ['**'] })).toBe(true);
});

it('keeps focus-specific progress while sharing identical extraction work', async () => {
    const host = await setup('memory'); host.put('note.md', 'A supported fact');
    const create = (focus: string) => host.service.saveScanRule(null, null, { name: focus, focus, include: [], exclude: [], intervalMinutes: 30, enabled: true });
    const first = await create('Decisions'), same = await create('Decisions'), second = await create('Commitments');
    await host.run(first); await host.run(same); await host.run(second);
    expect(host.extractor.run).toHaveBeenCalledTimes(2);
    expect(host.extractor.run.mock.calls.map(([job]) => job.scanScope.focus)).toEqual(['Decisions', 'Commitments']);
    const plan = (await host.service.snapshot()).scans.plans.find(item => item.id === first)!;
    await host.service.saveScanRule(first, plan.revision, { name: 'New focus', focus: 'People', include: [], exclude: [], intervalMinutes: 30, enabled: true });
    await host.run(first); expect(host.extractor.run).toHaveBeenCalledTimes(3);
    expect((await host.service.snapshot()).memories).toHaveLength(1);
});

it('retains knowledge on pause and deletion, then excludes it globally', async () => {
    const host = await setup('memory'); host.put('note.md', 'Retained fact');
    const id = await host.rule(); await host.run(id);
    let snapshot = await host.service.snapshot(), plan = snapshot.scans.plans[0];
    await host.service.setScanPlanEnabled(id, plan.revision, false);
    snapshot = await host.service.snapshot();
    expect(snapshot.memories[0]).toMatchObject({ supported: true, retained: true });
    const calls = host.extractor.run.mock.calls.length;
    host.advance(); await host.service.scanOnce(); expect(host.extractor.run).toHaveBeenCalledTimes(calls);
    plan = snapshot.scans.plans[0]; await host.service.removeScanPlan(id, plan.revision);
    snapshot = await host.service.snapshot(); expect(snapshot.memories[0].supported).toBe(true);
    await host.service.configure({ globalExclude: ['*.md'] }, snapshot.settings.revision);
    snapshot = await host.service.snapshot(); expect(snapshot.memories[0].supported).toBe(false);
    expect(snapshot.graph.nodes).toHaveLength(0);
});

it('automatically builds third-party profiles with explicit evidence and stable identities across edits', async () => {
    const host = await setup('memory'); host.put('note.md', 'Alex leads Alpha');
    host.extractor.run.mockImplementation(async (_job, text, attached) => {
        await attached('task'); return { candidates: [{ content: text, kind: 'fact', subject: 'Alex', project: 'alpha', eventTime: '', quote: text }], tokens: 10 };
    });
    const id = await host.rule(); await host.run(id);
    const before = (await host.service.snapshot()).graph.nodes.find(node => node.kind === 'person')!;
    host.put('note.md', 'Alex reviews Alpha'); await host.run(id);
    const after = (await host.service.snapshot()).graph.nodes.find(node => node.kind === 'person')!;
    expect(after.id).toBe(before.id); expect(after.memoryIds).toHaveLength(1);
});

it('matches local and remote directory ignores and native or remote conversation names', () => {
    const file: TwinDiscoveredSource = { kind: 'file', target: 'project://p/docs/a.md', projectId: 'p', path: 'docs/a.md', label: 'a.md', location: 'local', directoryPath: '/home/me/private/docs/a.md' };
    expect(matchesRules(file, { include: [], exclude: ['local:/home/me/private/'] })).toBe(false);
    expect(matchesRules(file, { include: [], exclude: ['remote:docs/'] })).toBe(true);
    expect(matchesRules({ ...file, location: 'remote', directoryPath: '/archive/docs/a.md' }, { include: [], exclude: ['remote:/archive/'] })).toBe(false);
    for (const kind of ['session', 'harness-session'] as const) {
        const session = { ...file, kind, label: '私人记录 2026', sessionId: 'opaque-id' };
        expect(matchesRules(session, { include: [], exclude: ['session-name:私人*'] })).toBe(false);
        expect(matchesRules(session, { include: ['session:私人*'], exclude: [] })).toBe(true);
        expect(matchesRules(session, { include: [], exclude: ['local:**'] })).toBe(true);
    }
    expect(ruleLines(['local:/home/me/private/', 'remote:/archive/', 'session-name:私人*'])).toHaveLength(3);
});

it('allows another rule to include a locally ignored source while global ignores override every rule', async () => {
    const host = await setup('indexeddb'); host.put('private.md', 'private fact'); host.put('work.md', 'work fact');
    await host.service.saveScanRule(null, null, { name: 'Work only', include: [], exclude: ['private.md'], intervalMinutes: 30, enabled: true });
    expect((await host.service.snapshot()).sources.map(source => source.data.target)).toEqual(['work.md']);
    const id = await host.rule(); await host.run(id);
    expect((await host.service.snapshot()).sources.find(source => source.data.target === 'private.md')?.data.enabled).toBe(true);
    await host.service.configure({ globalExclude: ['private.md'] }, (await host.service.snapshot()).settings.revision);
    expect((await host.service.snapshot()).sources.find(source => source.data.target === 'private.md')?.data.enabled).toBe(false);
});

it('ignores named local and remote conversations before extraction without blocking other conversations', async () => {
    const host = await setup('indexeddb');
    host.put('私人本地', 'Local private', 'session'); host.put('私人远程', 'Remote private', 'harness-session'); host.put('工作', 'Work', 'session');
    const rule = await host.rule([], ['session-name:私人*']); await host.run(rule);
    expect((await host.service.snapshot()).sources.map(source => source.data.label)).toEqual(['工作']);
    expect(host.extractor.run).toHaveBeenCalledTimes(1);
});

it('classifies nested remote mounts using their remote directory rather than the local project directory', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: '/docs', name: 'a.md', content: 'Local', recursive: true });
    await fs.driver.createFile({ parentPath: '/linked/private', name: 'b.md', content: 'Remote', recursive: true });
    const project = { path: '/p', name: 'P', project: { id: 'p', directory: '/home/me/project', source: { kind: 'local' } } };
    const projects = { list: async () => [project], openFiles: async () => ({ fs, dispose: async () => {} }),
        remoteMounts: { list: () => [{ at: '/linked', root: '/archive' }] } } as unknown as ProjectService;
    const { TwinProjectCatalog } = await import('../src/digital-twin/project-catalog');
    const catalog = await new TwinProjectCatalog(projects, { list: async () => [] } as any).discover();
    const local = catalog.resources.find(resource => resource.path === 'docs/a.md')!;
    const remote = catalog.resources.find(resource => resource.path === 'linked/private/b.md')!;
    expect(local).toMatchObject({ location: 'local', directoryPath: '/home/me/project/docs/a.md' });
    expect(remote).toMatchObject({ location: 'remote', directoryPath: '/archive/private/b.md' });
    expect(matchesRules(remote, { include: [], exclude: ['remote:/archive/private/'] })).toBe(false);
});
