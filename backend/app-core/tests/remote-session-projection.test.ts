import { expect, it, vi } from 'vitest';
import { createFileSystemSource, createFileSystemView, MemoryBackend } from '@itookit/vfs-core';
import { resolveBrowserTarget, remoteSessionPath } from '../src/session/browser-routes';
import { RemoteSessionProjection } from '../src/session/remote-session-projection';
import type { ProjectService } from '../src/projects/project-service';
import type { HarnessSession } from '@itookit/piagent-driver';
import { t } from '@itookit/common';
const project = {path:'/Project', name:'Project', project:{id:'p'}};
function setup(root = true) {
    const peer = {profiles:vi.fn(async () => ({profiles:[{id:'native',kind:'codex',projectRuntime:true,capabilities:{history:true,create:true}}]})),
        list:vi.fn(async (_profile: string, _query?: {cursor?: string}, _options?: unknown): Promise<{sessions:Array<Pick<HarnessSession, 'id' | 'title' | 'updatedAt' | 'createdAt'>>;nextCursor:string|null}> =>
            ({sessions:[{id:'same',title:'Native session',updatedAt:42}],nextCursor:'a/b+='})),
        inspect:vi.fn(async (_profile: string, id: string) => ({session: {id, title: 'First request', createdAt: 1791458500000, updatedAt: 1791458565000}})), close:vi.fn(async () => {})};
    const projects = {forFolder:async () => project, remoteMounts:{list:() => [{at:root ? '/' : '/reference',connectionId:'server',serverProjectId:'remote-p'}],projectHarness:vi.fn(async () => peer)}} as unknown as ProjectService;
    return {projection:new RemoteSessionProjection(projects),projects,peer};
}
it('routes remote identities independently of local session IDs and round-trips pagination cursors', () => {
    const path = remoteSessionPath('/Project','profile one','same');
    expect(resolveBrowserTarget(path)).toMatchObject({kind:'remote',folder:'/Project',profileId:'profile one',nativeSessionId:'same'});
    expect(resolveBrowserTarget(remoteSessionPath('/Project','native')+'/@page/a%2Fb%2B%3D')).toMatchObject({cursor:'a/b+='});
    expect(resolveBrowserTarget(remoteSessionPath('/Project','native')+'/@page:a%2Fb%2B%3D')).toMatchObject({cursor:'a/b+='});
    for (const suffix of ['/@evil','/@page','/@page:','/@page:%00','/s/extra','/%2F','/%00']) expect(() => resolveBrowserTarget(remoteSessionPath('/Project','native')+suffix)).toThrow();
});
it('only exposes sessions for a complete project binding, not a reference-directory mount', async () => {
    const scoped = setup(false); expect(await scoped.projection.root('/Project')).toEqual([]);
    const fixture = setup(); expect((await fixture.projection.root('/Project'))[0].metadata.remoteHarness).toBe(true);
    expect(await fixture.projection.root('/Project/child')).toEqual([]);
});
it('projects read-only session rows and a navigable next page without copying native histories', async () => {
    const {projection,peer} = setup(), path = remoteSessionPath('/Project','native');
    const nodes = await projection.list(path,resolveBrowserTarget(path) as never);
    expect(nodes.map(n => n.metadata.title)).toContain('Native session');
    expect(nodes.every(n => n.metadata._readOnly)).toBe(true);
    expect(nodes.every(n => n.metadata._fileDetails === false)).toBe(true);
    expect(resolveBrowserTarget(nodes.at(-1)!.path)).toMatchObject({cursor:'a/b+='}); expect(peer.close).toHaveBeenCalledOnce();
});
it('preserves readable labels, independent timestamps and newest-first ordering without changing native identities', async () => {
    const {projection, peer} = setup(), path = remoteSessionPath('/Project', 'native');
    peer.list.mockResolvedValue({sessions: [{id: 'old', title: ' First request ', createdAt: 1791458500000, updatedAt: 1791458565000},
        {id: 'new', title: 'Latest request', createdAt: 1791458550000, updatedAt: 1791458570000},
        {id: 'opaque-id', title: ' ', updatedAt: null}], nextCursor: null});
    const nodes = await projection.list(path, resolveBrowserTarget(path) as never);
    expect(nodes.slice(2).map(node => node.metadata.title)).toEqual(['Latest request', 'First request', t('harness.untitledSession')]);
    expect(nodes[3]).toMatchObject({createdAt: 1791458500000, modifiedAt: 1791458565000});
    expect(nodes[4]).toMatchObject({name: 'opaque-id', createdAt: 0, modifiedAt: 0});
    const stat = await projection.stat(nodes[3].path, resolveBrowserTarget(nodes[3].path) as never);
    expect(stat).toEqual(nodes[3]);
});
it('returns a disabled offline row rather than failing project navigation', async () => {
    const {projection,peer} = setup(), path = remoteSessionPath('/Project'); peer.profiles.mockRejectedValue(new Error('offline'));
    const nodes = await projection.list(path,resolveBrowserTarget(path) as never); expect(nodes[0].metadata._disabled).toBe(true);
});
it('lists multiple native history pages through a mounted VFS without escaping the listed parent', async () => {
    const {projection,peer} = setup(), path = remoteSessionPath('/Project','native');
    peer.list.mockImplementation(async (_profile, query) => query?.cursor === 'next/%'
        ? {sessions:[{id:'oldest',title:'Oldest native session',updatedAt:10}],nextCursor:null}
        : query?.cursor ? {sessions:[{id:'older',title:'Older native session',updatedAt:21}],nextCursor:'next/%'}
        : {sessions:[{id:'same',title:'Native session',updatedAt:42}],nextCursor:'a/b+='});
    const backend = new MemoryBackend();
    backend.stat = async path => projection.stat(path,resolveBrowserTarget(path) as never);
    backend.list = async path => projection.list(path,resolveBrowserTarget(path) as never);
    const source = await createFileSystemSource({backend,viewId:'native-history',access:'ro',tags:false});
    const view = createFileSystemView({viewId:'mounted-native-history',mounts:[{mountId:'history',at:'/history',root:path,access:'ro',fs:source.fs}]});
    try {
        const first = await view.driver.getChildren('/history');
        const more = first.find(node => node.name.startsWith('@page:'))!;
        expect(more).toBeDefined(); expect(more.parentPath).toBe('/history');
        const second = await view.driver.getChildren(more.path);
        expect(second.find(node => node.metadata.title === 'Older native session')).toBeDefined();
        expect(second.every(node => node.parentPath === more.path)).toBe(true);
        expect(peer.list).toHaveBeenLastCalledWith('native',{cursor:'a/b+='},expect.anything());
        const original = path + second.find(node => node.metadata.title === 'Older native session')!.path.slice('/history'.length);
        expect(resolveBrowserTarget(original)).toMatchObject({kind:'remote',profileId:'native',nativeSessionId:'older'});
        const third = await view.driver.getChildren(second.find(node => node.type === 'directory')!.path);
        expect(third.map(node => node.metadata.title)).toEqual(['Oldest native session']);
        expect(peer.list).toHaveBeenLastCalledWith('native',{cursor:'next/%'},expect.anything());
    } finally { await view.dispose(); await source.dispose(); }
});
