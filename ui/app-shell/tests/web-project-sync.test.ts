// @vitest-environment node
import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { IndexedDBSyncStore } from '@itookit/sync-adapters';
import { createPiAgentDriver } from '@itookit/piagent-driver';
import { webcrypto } from 'node:crypto';
import { randomId } from '@itookit/vfs-sync';
import type { ProjectService } from '@itookit/app-core';
import { createApplicationRuntime, ProjectSyncService, RemoteConnectionUnavailableError } from '@itookit/app-core';
import { initialState } from '../../../tests/helpers/sync';
import type { StoredFilePlan } from '@itookit/vfs-sync';
import { WebProjectSync } from '../../../apps/web-app/src/sync';

vi.mock('@itookit/app-shell', async () => ({ showProjectSyncSetup: (await import('../src/projects/sync/setup')).showProjectSyncSetup }));

async function server(directoryProjects = false, apiKey = false) {
    const directory = await mkdtemp(join(tmpdir(), 'web-project-sync-')), config = join(directory, 'server.toml');
    const auth = apiKey ? 'api_key = "fixed-network-api-key-at-least-24-bytes"' : 'username = "owner"\npassword_env = "SYNC_TEST_PASSWORD"';
    await writeFile(config, `listen = "127.0.0.1:0"\nexecution = false\n${auth}\n[sync]\nenabled = true\nroot = ${JSON.stringify(join(directory, 'store'))}\n`);
    if (directoryProjects) {
        await mkdir(join(directory,'exports/target'),{recursive:true});
        const original=await readFile(config,'utf-8');
        await writeFile(config,`server_id = "web-directory-test"\n${original}\n[projects]\nroot = ${JSON.stringify(join(directory,'catalog'))}\n[[exports]]\nalias = "home"\npath = ${JSON.stringify(join(directory,'exports'))}\naccess = "rw"\n`);
    }
    const child = spawn('cargo' , ['run', '--quiet', '--offline', '--manifest-path', resolve('../../tools/pi-agent/Cargo.toml'), '--', config],
        { env: { ...process.env, SYNC_TEST_PASSWORD: 'test-secret' }, stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(child, 'exit');
    const close = async () => { child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); };
    try {
        const endpoint = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('startup timeout')), 60000); let output = '';
            child.stderr.on('data', bytes => { output += bytes; const match = output.match(/listening on (127\.0\.0\.1:\d+)/);
                if (match) { clearTimeout(timer); resolve('http://' + match[1]); } });
            child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error('server exited ' + code + ': ' + output)); });
        });
        return { endpoint, close, directory };
    } catch (error) { await close(); throw error; }
}
async function device(endpoint: string) {
    const backend = new IndexedDBBackend({ dbName: 'web-sync-' + randomId() }); await backend.init();
    const directory = '/home/admin/projects/local'; await backend.mkdir(directory);
    const http = createPiAgentDriver(); http.setCredential('saved', 'test-secret');
    const project = { name: 'Local', project: { id: 'local', directory } };
    const connection = () => ({id: 'server', name: 'Server', endpoint, username: 'owner', credentialRef: 'saved'});
    const projects = { get: async () => project, assertIndependent: async () => {}, remoteMounts: { list: () => [], connection,
        resolveConnection: async () => connection() } } as unknown as ProjectService;
    const sync = new WebProjectSync(backend, http); sync.projects = projects;
    return { backend, http, sync, project, projects, close: async () => { await sync.dispose(); await http.dispose(); await backend.close(); } };
}
it('reads stale sync status locally and unbinds it without resolving its deleted MCP', async () => {
    const a = await device('https://unused.test'), state = initialState();
    state.binding = {...state.binding, root: a.project.project.directory, sourceId: a.backend.storageAccess().identity,
        connectionId: '5776bbb8-649b-44ab-9f5f-aeeabf54f78e'};
    const store = new IndexedDBSyncStore(a.backend.storageAccess(), state.binding.bindingId); await store.initialize(state);
    await a.backend.write(state.binding.root + '/keep.md', new TextEncoder().encode('local content'));
    const missing = new RemoteConnectionUnavailableError({connectionId: state.binding.connectionId!, reason: 'mcp-not-found', revision: 1, configured: []}, []);
    const resolve = vi.spyOn(a.projects.remoteMounts!, 'resolveConnection').mockRejectedValue(missing);
    const transport = vi.spyOn(a.http, 'sync'), service = new ProjectSyncService(a.sync, a.sync.coordinator);
    try {
        for (let i = 0; i < 4; i++) expect((await service.status('local')).binding.connectionId).toBe(state.binding.connectionId);
        expect(resolve).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
        await service.unbind('local'); expect((await service.status('local')).binding.state).toBe('detached');
        expect(resolve).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(await a.backend.read(state.binding.root + '/keep.md'))).toBe('local content');
    } finally {await service.dispose(); await a.close(); vi.restoreAllMocks();}
});
it('retains unknown cloud receipts when offline unbinding cannot cancel an admitted command', async () => {
    const a = await device('https://unused.test'), state = initialState();
    state.binding = {...state.binding, root: a.project.project.directory, sourceId: a.backend.storageAccess().identity, connectionId: 'deleted'};
    state.pending = {command: {target: 'publish', body: {operationId: 'submitted', replicaId: state.binding.replicaId,
        opSeq: '1', authorityId: state.binding.authorityId, historyEpoch: state.binding.historyEpoch}}};
    state.nextSeq = '2';
    const store = new IndexedDBSyncStore(a.backend.storageAccess(), state.binding.bindingId); await store.initialize(state);
    const resolve = vi.spyOn(a.projects.remoteMounts!, 'resolveConnection').mockRejectedValue(new Error('MCP missing'));
    const service = new ProjectSyncService(a.sync, a.sync.coordinator);
    try {
        await expect(service.unbind('local')).rejects.toThrow('MCP missing');
        const after = await service.status('local'); expect(after.binding.state).toBe('detached'); expect(after.pending).toEqual(state.pending);
        expect(resolve).toHaveBeenCalledOnce(); expect(after.nextSeq).toBe(state.nextSeq);
    } finally {await service.dispose(); await a.close(); vi.restoreAllMocks();}
});
it('only resolves a sync client when an operation needs it and preserves its method receiver', async () => {
    const a = await device('https://unused.test'), state = initialState();
    state.binding = {...state.binding, root: a.project.project.directory, sourceId: a.backend.storageAccess().identity, connectionId: 'server'};
    const store = new IndexedDBSyncStore(a.backend.storageAccess(), state.binding.bindingId); await store.initialize(state);
    const resolve = vi.spyOn(a.projects.remoteMounts!, 'resolveConnection');
    const {HttpSyncClient} = await import('@itookit/sync-adapters');
    let receiver: unknown;
    vi.spyOn(HttpSyncClient.prototype, 'capabilities').mockImplementation(async function () {receiver = this; throw new Error('capability unavailable');});
    const service = new ProjectSyncService(a.sync, a.sync.coordinator);
    try {
        await service.status('local'); expect(resolve).not.toHaveBeenCalled();
        await expect(service.preview('local')).rejects.toThrow('capability unavailable');
        expect(resolve).toHaveBeenCalledOnce(); expect(receiver).toBeInstanceOf(HttpSyncClient);
    } finally {await service.dispose(); await a.close(); vi.restoreAllMocks();}
});
it('discovers pi-agent on the generic MCP connection without extra verification and binds its native project',async()=>{
    const running = await server(true,true);
    const backend = new IndexedDBBackend({dbName:'mcp-pi-agent-'+randomId()}), originalFetch = globalThis.fetch;
    const methods:string[] = [];
    const fetch = vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
        if (String(input).endsWith('/mcp') && typeof init?.body === 'string') methods.push(JSON.parse(init.body).method);
        return originalFetch(input,init);
    });
    const driver = createPiAgentDriver();
    const runtime = await createApplicationRuntime({backend,ownerKind:'web',remoteSourceProvider:driver});
    try {
        const draft = {id:'office',name:'Office',transport:'http' as const,endpoint:running.endpoint+'/mcp',apiKey:'fixed-network-api-key-at-least-24-bytes'};
        const discovery = await runtime.agentService.testMCPServer(draft);
        expect(discovery.extensions?.['itookit/pi-agent']).toMatchObject({serverId:'web-directory-test',projects:true});
        await runtime.agentService.saveMCPServer({...draft,...discovery});
        await runtime.agentService.saveMCPServer({...draft,...discovery,name:'Personal server'});
        expect(methods).toEqual(['server/discover','tools/list']);
        const remote = await runtime.projects.createRemote('Notes',null,draft.id,'/home/target','rw');
        expect(runtime.projects.remoteMounts!.list(remote.project.id)[0]).toMatchObject({connectionId:draft.id,root:'/target',access:'rw'});
        expect(runtime.projects.remoteMounts!.connection(draft.id)).toMatchObject({name:'Personal server',credentialRef:'mcp-office'});
        expect((await runtime.projects.list()).some(item=>item.project.id===remote.project.id)).toBe(true);
    } finally {await runtime.dispose();await driver.dispose();fetch.mockRestore();await backend.close();await running.close();}
},90000);
it('binds and syncs two devices without Web Locks, SubtleCrypto or randomUUID and restores bindings after reload', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const running = await server(), a = await device(running.endpoint), b = await device(running.endpoint);
    try {
        expect(await a.sync.inspect('server')).toEqual([]);
        await a.backend.write(a.project.project.directory + '/note.txt', new TextEncoder().encode('from A'));
        await a.sync.bind('local', 'server', 'shared', true);
        let session = await a.sync.open('local'); const initial = await session.store.read();
        expect(initial.setupPending).toBe(false); expect(initial.binding.connectionId).toBe('server');
        const preview = await session.preview() as StoredFilePlan; expect(preview.plan.actions.some(a => a.side === 'upload')).toBe(true);
        await session.execute(preview.id); expect((await b.sync.inspect('server')).map(p => p.projectId)).toEqual(['shared']);
        await expect(b.sync.bind('local', 'server', 'shared', true)).rejects.toThrow('PROJECT_EXISTS');
        expect(await IndexedDBSyncStore.list(b.backend.storageAccess())).toEqual([]);
        await b.sync.bind('local', 'server', 'shared', false); session = await b.sync.open('local');
        await session.execute((await session.preview() as StoredFilePlan).id);
        expect(new TextDecoder().decode(await b.backend.read(b.project.project.directory + '/note.txt'))).toBe('from A');
        const reload = new WebProjectSync(a.backend, a.http); reload.projects = a.projects;
        try { expect((await (await reload.open('local')).store.read()).binding.bindingId).toBe(initial.binding.bindingId); }
        finally { await reload.dispose(); }
        b.project.project.directory += '-moved'; await b.backend.mkdir(b.project.project.directory);
        await expect(session.preview()).rejects.toThrow('SYNC_SOURCE_CHANGED');
    } finally { await a.close(); await b.close(); await running.close(); vi.unstubAllGlobals(); }
}, 90000);

it('supports managed directories outside the default projects folder independently of their display name', async () => {
    const running = await server(), a = await device(running.endpoint);
    try {
        a.project.name = '项目'; a.project.project.directory = '/home/admin/workspaces/custom'; await a.backend.mkdir(a.project.project.directory);
        await a.backend.write(a.project.project.directory + '/note', new TextEncoder().encode('managed'));
        await a.sync.bind('local', 'server', 'custom', true);
        const state = await (await a.sync.open('local')).store.read(); expect(state.binding.root).toBe('/home/admin/workspaces/custom');
        a.project.name = '个人项目'; const session = await a.sync.open('local');
        expect((await session.store.read()).binding.bindingId).toBe(state.binding.bindingId);
        const preview = await session.preview() as StoredFilePlan; expect(preview.plan.actions.some(a => a.path === 'note')).toBe(true);
    } finally { await a.close(); await running.close(); }
}, 90000);

it('identifies remote export sources before contacting sync regardless of project name', async () => {
    const a = await device('https://unused.test'), requests = vi.spyOn(a.http, 'transport');
    vi.spyOn(a.projects.remoteMounts!, 'list').mockReturnValue([{ mountId: 'root', at: '/', root: '/', access: 'ro', alias: 'x1',
        endpoint: 'https://unused.test', username: 'owner', credentialRef: 'saved', connectionId: 'server' }]);
    try {
        for (const name of ['项目', '个人项目']) {
            a.project.name = name;
            await expect(a.sync.setup('local', new AbortController().signal)).rejects.toMatchObject({ code: 'SYNC_REMOTE_SOURCE_UNSUPPORTED' });
            await expect(a.sync.bind('local', 'server', 'cloud', true)).rejects.toThrow('/x1');
        }
        expect(requests).not.toHaveBeenCalled(); expect(await IndexedDBSyncStore.list(a.backend.storageAccess())).toEqual([]);
    } finally { await a.close(); vi.restoreAllMocks(); }
});

it('resumes binding after a committed project creation loses its response', async () => {
    const running = await server(), a = await device(running.endpoint); let lose = true;
    const { HttpSyncClient } = await import('@itookit/sync-adapters');
    const original = HttpSyncClient.prototype.execute;
    vi.spyOn(HttpSyncClient.prototype, 'execute').mockImplementation(async function(command) {
        const result = await original.call(this, command);
        if (lose && command.target === 'projects') { lose = false; throw new Error('lost response'); }
        return result;
    });
    try {
        await expect(a.sync.bind('local', 'server', 'recoverable', true)).rejects.toThrow('lost response');
        const before = (await IndexedDBSyncStore.list(a.backend.storageAccess()))[0]!;
        expect(before.setupPending).toBe(true); expect(before.pending).toBeDefined();
        await a.sync.bind('local', 'server', 'recoverable', false);
        const after = await (await a.sync.open('local')).store.read();
        expect(after.binding.bindingId).toBe(before.binding.bindingId); expect(after.pending).toBeUndefined(); expect(after.setupPending).toBe(false);
    } finally { await a.close(); await running.close(); vi.restoreAllMocks(); }
}, 90000);

it('materializes a published browser directory into a server project and fences native edits', async () => {
    const running=await server(true), a=await device(running.endpoint);
    const projects=a.http.projects({endpoint:running.endpoint,username:'owner',credentialRef:'saved'});
    try {
        await a.backend.write(a.project.project.directory+'/note.txt',new TextEncoder().encode('browser content'));
        await a.sync.bind('local','server','shared',true);
        const session=await a.sync.open('local');await session.store.update(s=>({...s,binding:{...s.binding,direction:'upload'}}));
        await session.execute((await session.preview()).id);const state=await session.store.read();
        const project=await projects.register({name:'Native',alias:'home',path:'target',access:'rw'});
        const directory=projects.directorySync();
        await directory.bind({bindingId:'browser-directory',projectId:project.id,revision:project.revision,
            syncProjectId:state.binding.projectId,datasetId:state.binding.datasetId,historyEpoch:state.binding.historyEpoch,target:''});
        const plan=await directory.preview('browser-directory');expect(plan.conflicts).toEqual([]);
        await directory.execute('browser-directory',plan.id);
        const destination=join(running.directory,'exports/target/note.txt');expect(await readFile(destination,'utf-8')).toBe('browser content');
        await writeFile(destination,'codex content');await a.backend.write(a.project.project.directory+'/note.txt',new TextEncoder().encode('browser changed'));
        await session.execute((await session.preview()).id);
        const conflict=await directory.preview('browser-directory');expect(conflict.conflicts).toEqual(['note.txt']);
        await expect(directory.execute('browser-directory',conflict.id)).rejects.toMatchObject({code:'SYNC_CONFLICT'});
        expect(await readFile(destination,'utf-8')).toBe('codex content');
        const comparison=await directory.compare('browser-directory',conflict.id,'note.txt');
        expect(comparison.dataset.content?.text).toBe('browser changed');expect(comparison.directory.content?.text).toBe('codex content');
        await directory.configure('browser-directory',1,'both');
        const both=await directory.preview('browser-directory');
        const resolved=await directory.resolve('browser-directory',both.id,{'note.txt':'directory'});
        expect(resolved.id).not.toBe(both.id);expect(resolved.conflicts).toEqual([]);
        await directory.execute('browser-directory',resolved.id);
        await session.store.update(s=>({...s,binding:{...s.binding,direction:'both',policyRevision:'2'}}));
        await a.backend.write(a.project.project.directory+'/note.txt',new TextEncoder().encode('browser draft'));
        const localConflict=await session.preview();
        const cached=await (await a.sync.open('local')).compare!(localConflict.id,'note.txt');
        expect(cached.local.content?.text).toBe('browser draft');expect(cached.remote.content?.text).toBe('codex content');
        const chosen=await session.resolve(localConflict.id,{'note.txt':'remote'});await session.execute(chosen.id);
        expect(new TextDecoder().decode(await a.backend.read(a.project.project.directory+'/note.txt'))).toBe('codex content');
    } finally {await projects.close();await a.close();await running.close();}
},90000);
