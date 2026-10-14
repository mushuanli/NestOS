import { expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { FSError, MemoryBackend, createFileSystemSource } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { mockPiAgentDiscovery } from './helpers/mcp-discovery';
import { RemoteMountStore } from '../src/projects/remote-mount-store';
import { createSessionBrowser, folderBrowserPath } from '../src/session/session-browser';

async function configureMCP(runtime: Awaited<ReturnType<typeof createApplicationRuntime>>) {
    const descriptor = {version:1,httpEndpoint:'https://office.test',fileProtocol:'fs-agent-http-v1',serverId:'office-node',harness:true};
    const fetch = mockPiAgentDiscovery(descriptor);
    try {
        const draft = {id:'office',name:'Office',transport:'http' as const,endpoint:'https://office.test/mcp',apiKey:'fixture-api-key-at-least-24-bytes'};
        await runtime.agentService.saveMCPServer({...draft,...await runtime.agentService.testMCPServer(draft)});
    } finally {fetch.mockRestore();}
}

async function fixture(backend = new MemoryBackend() as MemoryBackend | IndexedDBBackend) {
    const provider = {setCredential:vi.fn(),open:vi.fn(),dispose:vi.fn()};
    const runtime = await createApplicationRuntime({backend,ownerKind:'web',remoteSourceProvider:provider});
    await configureMCP(runtime);
    const project = (await runtime.projects.list())[0];
    const store = new RemoteMountStore(await runtime.vfs.openFileSystem('/'));
    await store.load();
    const mount = {mountId:'mount',at:'/reference',root:'/',alias:'docs',access:'ro' as const,connectionId:'office',
        endpoint:'https://office.test',credentialRef:'mcp-office',serverId:'office-node'};
    await store.save({version:1,revision:1,projects:{[project.project.id]:[mount]}});
    await runtime.projects.remoteMounts!.init();
    return {runtime,provider,project,store,mount};
}

it('keeps a workbench project visible when revoking its bindings fails and cleans them on retry',async () => {
    const {runtime,provider} = await fixture();
    const backend = new MemoryBackend(); await backend.init();
    provider.open.mockImplementation(async () => createFileSystemSource({backend,viewId:'server-fixture',access:'ro'}));
    const browser = await createSessionBrowser({repository:runtime.sessionRepository,files:runtime.sessionFiles,
        kernel:runtime.kernel.kernel,projects:runtime.projects});
    try {
        const project = await runtime.projects.createRemote('Workbench remote',null,'office','/docs','ro');
        const id = await runtime.sessionRepository.createSession('Keep until cleanup',await runtime.projects.sessionFolder(project));
        const forget = vi.spyOn(runtime.projects.remoteMounts!,'forgetProject').mockRejectedValueOnce(new FSError('EIO','Grant storage unavailable'));
        await expect(browser.fs.driver.delete([folderBrowserPath(project.path)],{recursive:true})).rejects.toMatchObject({code:'EIO'});
        expect(forget).toHaveBeenCalledWith(project.project.id);
        expect((await runtime.projects.list()).some(item => item.project.id === project.project.id)).toBe(true);
        expect((await runtime.sessionRepository.listFolders()).some(item => item.path === project.path)).toBe(true);
        expect(await runtime.sessionRepository.getManifest(id)).toMatchObject({title:'Keep until cleanup'});
        expect(runtime.projects.remoteMounts!.list(project.project.id)).toHaveLength(1);
        await browser.fs.driver.delete([folderBrowserPath(project.path)],{recursive:true});
        forget.mockRestore();
        expect((await runtime.projects.list()).some(item => item.project.id === project.project.id)).toBe(false);
        expect(runtime.projects.remoteMounts!.list(project.project.id)).toEqual([]);
        expect((await runtime.configuration.inspectMCPDeletion(['office'])).references.some(ref => ref.projectId === project.project.id)).toBe(false);
    } finally {await browser.dispose(); await runtime.dispose();}
});

it('repairs orphan remote roots on restart while retaining offline project identities',async () => {
    const backend = new IndexedDBBackend({dbName:`remote-delete-recovery-${crypto.randomUUID()}`});
    const {runtime,provider:connected,store,project,mount} = await fixture(backend);
    const server = new MemoryBackend(); await server.init();
    connected.open.mockImplementation(async () => createFileSystemSource({backend:server,viewId:'server-fixture',access:'ro'}));
    const live = await runtime.projects.createRemote('Offline remote',null,'office','/docs','ro');
    const liveMounts = runtime.projects.remoteMounts!.list(live.project.id);
    // A missing navigation entry alone is not proof that a project was deleted.
    await runtime.sessionRepository.deleteFolder(live.path,true);
    await store.load();
    const id = 'deleted-before-upgrade';
    await store.save({version:1,revision:2,projects:{[id]:[{...mount,mountId:'orphan',at:'/'}],
        [project.project.id]:[mount],[live.project.id]:liveMounts}});
    await runtime.dispose();
    const provider = {setCredential:vi.fn(),open:vi.fn().mockRejectedValue(new Error('Server offline')),dispose:vi.fn()};
    const reopened = await createApplicationRuntime({backend,ownerKind:'web',remoteSourceProvider:provider});
    try {
        expect(reopened.projects.remoteMounts!.list(id)).toEqual([]);
        expect(reopened.projects.remoteMounts!.list(project.project.id)).toHaveLength(1);
        expect(reopened.projects.remoteMounts!.list(live.project.id)).toHaveLength(1);
        expect((await reopened.projects.list()).some(project => project.project.id === live.project.id)).toBe(true);
        expect(provider.open).not.toHaveBeenCalled();
        const persisted = new RemoteMountStore(await reopened.vfs.openFileSystem('/'));
        expect((await persisted.load())!.projects[id]).toBeUndefined();
    } finally {await reopened.dispose();}
});

it('retains bindings when project identity storage cannot be read',async () => {
    const {runtime,store,mount} = await fixture();
    try {
        await store.save({version:1,revision:2,projects:{orphan:[{...mount,at:'/'}]}});
        const remote = runtime.projects.remoteMounts!;
        await remote.init();
        const lookup = vi.spyOn(runtime.projects,'storedProjectIds').mockRejectedValueOnce(new FSError('EIO','Identity storage unavailable'));
        await expect(runtime.configuration.inspectMCPDeletion(['office'])).rejects.toMatchObject({code:'EIO'});
        expect(remote.list('orphan')).toHaveLength(1);
        expect((await store.load())!.projects.orphan).toHaveLength(1);
        lookup.mockRestore();
    } finally {await runtime.dispose();}
});

it('repairs deleted remote identities without probing the server or removing attached local mounts',async () => {
    const {runtime,provider,store,project:local} = await fixture();
    const backend = new MemoryBackend(); await backend.init();
    provider.open.mockImplementation(async () => createFileSystemSource({backend,viewId:'server-fixture',access:'ro'}));
    try {
        const project = await runtime.projects.createRemote('Deleted remote',null,'office','/docs','ro');
        const remote = runtime.projects.remoteMounts!, bindings = remote.list(project.project.id);
        // Reproduce an old interrupted deletion: both local identities and navigation are gone.
        await runtime.sessionRepository.deleteFolder(project.path,true);
        await runtime.projects.removeProjectSource(project);
        expect((await runtime.projects.list()).some(item => item.project.id === project.project.id)).toBe(false);
        expect(remote.list(project.project.id)).toHaveLength(1);
        provider.open.mockClear();
        provider.open.mockRejectedValue(new Error('Server offline'));
        const impact = await runtime.configuration.inspectMCPDeletion(['office']);
        expect(impact.references).toMatchObject([{projectId:local.project.id,at:'/reference'}]);
        expect(remote.list(project.project.id)).toEqual([]);
        expect(provider.open).not.toHaveBeenCalled();
        expect((await store.load())!.projects[project.project.id]).toBeUndefined();
        // Startup reconciliation also permits subsequent direct MCP deletion.
        await store.save({version:1,revision:99,projects:{[project.project.id]:bindings}});
        await remote.init();
        await remote.reconcileMCPReferences();
        await runtime.agentService.deleteMCPServer('office');
        expect(remote.list(project.project.id)).toEqual([]);
        expect(await runtime.agentService.getMCPServers()).toEqual([]);
    } finally {await runtime.dispose();}
});

it('previews references and removes local bindings only after explicit force confirmation',async () => {
    const {runtime,provider,project} = await fixture();
    try {
        const impact = await runtime.configuration.inspectMCPDeletion(['office']);
        expect(impact.references).toMatchObject([{connectionId:'office',projectId:project.project.id,at:'/reference'}]);
        await expect(runtime.configuration.deleteMCPServers({revision:impact.revision,force:false})).rejects.toMatchObject({code:'EBUSY'});
        expect(runtime.projects.remoteMounts!.list(project.project.id)).toHaveLength(1);
        await runtime.configuration.deleteMCPServers({revision:impact.revision,force:true});
        expect(await runtime.agentService.getMCPServers()).toEqual([]);
        expect(runtime.projects.remoteMounts!.list(project.project.id)).toEqual([]);
        expect((await runtime.projects.list()).some(item => item.project.id === project.project.id)).toBe(true);
        expect(provider.open).not.toHaveBeenCalled();
    } finally {await runtime.dispose();}
});

it('rejects a deletion preview when a reference is added after inspection',async () => {
    const {runtime,project,store,mount} = await fixture();
    try {
        const impact = await runtime.configuration.inspectMCPDeletion(['office']);
        await store.save({version:1,revision:2,projects:{[project.project.id]:[mount,{...mount,mountId:'late',at:'/late'}]}});
        await runtime.projects.remoteMounts!.init();
        await expect(runtime.configuration.deleteMCPServers({revision:impact.revision,force:true})).rejects.toMatchObject({code:'EBUSY'});
        expect(await runtime.agentService.getMCPServers()).toHaveLength(1);
        expect(runtime.projects.remoteMounts!.list(project.project.id)).toHaveLength(2);
    } finally {await runtime.dispose();}
});
it('keeps a deletion preview valid when only live MCP connection observations change', async () => {
    const {runtime} = await fixture();
    const original = runtime.agentService.getMCPServers.bind(runtime.agentService);
    let observedAt = 1;
    const observation = vi.spyOn(runtime.agentService, 'getMCPServers').mockImplementation(async () => (await original()).map(server => ({...server,
        status: 'connected' as const, connectionState: {status: 'connected' as const, checkedAt: observedAt++, issues: []}})));
    try {
        const impact = await runtime.configuration.inspectMCPDeletion(['office']);
        await runtime.configuration.deleteMCPServers({revision: impact.revision, force: true});
        expect(await original()).toEqual([]);
    } finally { observation.mockRestore(); await runtime.dispose(); }
});

it('deletes local remote projects and local conversations while retaining server data and local projects',async () => {
    const {runtime,provider,project} = await fixture();
    const backend = new MemoryBackend(); await backend.init();
    await backend.write('/native.txt',new TextEncoder().encode('server data'));
    // Closing a client connection must not erase the fixture's server storage.
    const close = vi.spyOn(backend,'close').mockResolvedValue();
    provider.open.mockImplementation(async () => createFileSystemSource({backend,viewId:'server-fixture',access:'ro'}));
    const removeServerData = vi.spyOn(backend,'delete');
    try {
        const remoteProject = await runtime.projects.createRemote('Remote Work',null,'office','/docs','ro');
        const id = await runtime.sessionRepository.createSession('Local notes',await runtime.projects.sessionFolder(remoteProject));
        const impact = await runtime.configuration.inspectMCPDeletion(['office']);
        expect(impact.projects).toMatchObject([{id:remoteProject.project.id,name:'Remote Work',localSessions:[{id,title:'Local notes'}]}]);
        await runtime.configuration.deleteMCPServers({revision:impact.revision,force:true});
        expect((await runtime.projects.list()).some(item => item.project.id === remoteProject.project.id)).toBe(false);
        expect((await runtime.projects.list()).some(item => item.project.id === project.project.id)).toBe(true);
        expect((await runtime.sessionRepository.listFolders()).some(item => item.path === remoteProject.path)).toBe(false);
        await expect(runtime.sessionRepository.getManifest(id)).rejects.toMatchObject({code:'ENOENT'});
        expect(await runtime.agentService.getMCPServers()).toEqual([]);
        expect(removeServerData).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(await backend.read('/native.txt'))).toBe('server data');
    } finally {await runtime.dispose(); close.mockRestore(); await backend.close();}
});

it('requires a new preview if a local conversation is added to a remote project',async () => {
    const {runtime,provider} = await fixture();
    const backend = new MemoryBackend(); await backend.init();
    provider.open.mockImplementation(async () => createFileSystemSource({backend,viewId:'server-fixture',access:'ro'}));
    try {
        const project = await runtime.projects.createRemote('Remote Work',null,'office','/docs','ro');
        const impact = await runtime.configuration.inspectMCPDeletion(['office']);
        await runtime.sessionRepository.createSession('Late notes',await runtime.projects.sessionFolder(project));
        await expect(runtime.configuration.deleteMCPServers({revision:impact.revision,force:true})).rejects.toMatchObject({code:'EBUSY'});
        expect((await runtime.projects.list()).some(item => item.project.id === project.project.id)).toBe(true);
        expect(await runtime.agentService.getMCPServers()).toHaveLength(1);
    } finally {await runtime.dispose();}
});
