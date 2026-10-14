import { manageRemoteSession } from '../src/session/remote-session-management';
import { expect, it, vi } from 'vitest';
import { exportRemoteSession } from '../src/session/remote-session-export';
import { remoteSessionSources } from '../src/session/remote-session-sources';
import { remoteSessionPath, resolveBrowserTarget } from '../src/session/browser-routes';
import { resolveProjectFavorite } from '../src/projects/favorites/routes';
import type { ProjectService, ProjectFolder } from '../src/projects/project-service';

function fixture() {
    const project = {path: '/P', name: 'P', project: {id: 'p'}} as ProjectFolder;
    const mount = {at: '/', alias: 'root', root: '/source', connectionId: 'mcp', serverId: 'server', serverProjectId: 'native', serverProjectRevision: 1};
    const client = {read: vi.fn(async (_profile: string, _session: string, options: {cursor?: string}) =>
        ({session: {id: 's'}, turns: [{id: options.cursor ? 'old' : 'new'}], nextCursor: options.cursor ? null : 'older'})), close: vi.fn(async () => {})};
    const projects = {forFolder: async () => project, remoteMounts: {list: () => [mount], projectHarness: async () => client}} as unknown as ProjectService;
    return {projects, project, mount, client};
}
it('exports older native pages in order with complete identity and no executable bundle', async () => {
    const {projects, client} = fixture();
    const exported = JSON.parse((await exportRemoteSession(projects, '/P', 'codex', 's')).content);
    expect(exported).toMatchObject({version: 1, executable: false, toolDetail: 'summary', source: {connectionId: 'mcp', serverId: 'server', projectId: 'native', profileId: 'codex', sessionId: 's'}, turns: [{id: 'old'}, {id: 'new'}]});
    expect(client.read).toHaveBeenLastCalledWith('codex', 's', expect.objectContaining({cursor: 'older', toolDetail: 'summary'}));
    expect(client.close).toHaveBeenCalledOnce();
});
it('rejects native exports after a grant change and always releases their client', async () => {
    const {projects, client, mount} = fixture();
    client.read.mockImplementation(async () => { mount.serverProjectRevision++; return {session: {id: 's'}, turns: [], nextCursor: null}; });
    await expect(exportRemoteSession(projects, '/P', 'codex', 's')).rejects.toMatchObject({code: 'ECONFLICT'});
    expect(client.close).toHaveBeenCalledOnce();
});
it('never resolves a remote favorite through another server with the same native IDs', async () => {
    const {projects, mount} = fixture();
    projects.favorites = {list: async () => [{id: 'f', target: {kind: 'remote-session', connectionId: 'mcp', serverId: 'server', serverProjectId: 'native', profileId: 'codex', sessionId: 's'}}]} as never;
    expect((await resolveProjectFavorite(projects, {} as never, '/P', 'f')).path).toBe(remoteSessionPath('/P', 'codex', 's'));
    projects.favorites = {list: async () => [{id: 'f', target: {kind: 'remote-session', connectionId: 'mcp', serverId: 'server', serverProjectId: 'native', profileId: 'codex', sessionId: 's', archived: true}}]} as never;
    expect(resolveBrowserTarget((await resolveProjectFavorite(projects, {} as never, '/P', 'f')).path)).toMatchObject({archived: true});
    mount.serverId = 'other';
    await expect(resolveProjectFavorite(projects, {} as never, '/P', 'f')).rejects.toMatchObject({code: 'ECONFLICT'});
});
it('shows only attached native sources already registered under the exact remote identity', () => {
    const {projects, project, mount} = fixture(), source = {...project, path: '/Source', project: {id: 'source'}} as ProjectFolder;
    projects.remoteMounts!.list = id => id === 'p' ? [{...mount, at: '/ref', serverProjectId: undefined}, {at: '/plain'}] as never : [mount] as never;
    expect(remoteSessionSources(projects, project, [project, source])).toEqual([source]);
    projects.remoteMounts!.list = id => [{...mount, at: id === 'p' ? '/ref' : '/', serverId: id === 'p' ? 'other' : 'server'}] as never;
    expect(remoteSessionSources(projects, project, [source])).toEqual([]);
    expect(resolveBrowserTarget(remoteSessionPath('/P', 'codex', 's', true))).toMatchObject({archived: true, nativeSessionId: 's'});
});

it('manages native metadata through the journal and updates an existing favorite only after commitment', async () => {
    const {projects} = fixture();
    const result = {title: 'Renamed', archived: true};
    const controls = {read: vi.fn(async () => ({pending: false})), rename: vi.fn(async () => result), archive: vi.fn(async () => result), close: vi.fn(async () => {})};
    projects.remoteMounts!.projectConversation = vi.fn(async () => controls) as never;
    projects.favorites = {updateNativeSession: vi.fn(async () => {})} as never;
    await manageRemoteSession(projects, '/P', 'codex', 's', {kind: 'rename', name: 'Renamed'});
    expect(controls.rename).toHaveBeenCalledWith('Renamed'); expect(controls.close).toHaveBeenCalledOnce();
    expect(projects.favorites!.updateNativeSession).toHaveBeenCalledWith('p', expect.objectContaining({serverId: 'server', sessionId: 's'}), 'Renamed', true);
    controls.read.mockResolvedValue({pending: true});
    await expect(manageRemoteSession(projects, '/P', 'codex', 's', {kind: 'archive'})).rejects.toMatchObject({code: 'EBUSY'});
    expect(controls.archive).not.toHaveBeenCalled(); expect(controls.close).toHaveBeenCalledTimes(2);
});

it('cleans deleted native favorites after commitment and can finish local cleanup without replay', async () => {
    const {projects} = fixture(), result = {title: 'Removed', archived: true, pending: false, deletedSessionIds: ['s', 'child']};
    const controls = {read: vi.fn(async () => ({pending: false})), delete: vi.fn(async () => result), close: vi.fn(async () => {})};
    projects.remoteMounts!.projectConversation = vi.fn(async () => controls) as never;
    projects.favorites = {deleteNativeSessions: vi.fn(async () => {})} as never;
    await manageRemoteSession(projects, '/P', 'codex', 's', {kind: 'delete'});
    expect(projects.favorites!.deleteNativeSessions).toHaveBeenCalledWith('p', expect.objectContaining({connectionId: 'mcp', serverId: 'server', sessionId: 's'}), ['s', 'child']);
    controls.read.mockResolvedValue(result);
    await manageRemoteSession(projects, '/P', 'codex', 's', {kind: 'delete'});
    expect(controls.delete).toHaveBeenCalledOnce(); expect(controls.close).toHaveBeenCalledTimes(2);
});
