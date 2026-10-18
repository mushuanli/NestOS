import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { conversationResourcePath, folderBrowserPath, projectConversationsPath, resolveBrowserTarget } from '@itookit/app-contracts';
import { createApplicationRuntime, type ApplicationRuntime } from '../src/runtime/create-application-runtime';
import { createSessionBrowser } from '../src/session/session-browser';

let app: ApplicationRuntime | undefined, browser: Awaited<ReturnType<typeof createSessionBrowser>> | undefined;
afterEach(async () => {await browser?.dispose(); await app?.dispose(); browser = undefined; app = undefined;});
async function setup() {
    app = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    const project = await app.projects.create('Mixed'), group = await app.projects.sessionFolder(project);
    const clock = vi.spyOn(Date, 'now');
    for (let i = 0; i < 20; i++) {
        clock.mockReturnValue(10000 - i * 4);
        const id = await app.projects.sessions.create(`MindOS ${i}`, group);
        await app.sessionRepository.updateManifest(id, {updatedAt: 10000 - i * 4});
    }
    clock.mockRestore();
    const profiles = ['codex', 'dsht', 'claudecode'].map(id => ({id, kind: id, projectRuntime: true, workspaces: [], capabilities: {history: true, create: true}}));
    const list = vi.fn(async (profile: string, query?: {cursor?: string}) => {
        const start = Number(query?.cursor ?? 0), end = Math.min(start + 7, 40), index = profiles.findIndex(p => p.id === profile) + 1;
        return {sessions: Array.from({length: end - start}, (_, n) => ({id: `same-${n + start}`, title: `${profile} ${n + start}`,
            updatedAt: 10000 - (n + start) * 4 - index, status: 'idle', cwd: null, resumable: true})), nextCursor: end < 40 ? String(end) : null};
    });
    const peer = {profiles: vi.fn(async () => ({profiles})), list, close: vi.fn(async () => {}), inspect: vi.fn()};
    const mounts = [{at: '/', connectionId: 'server', serverProjectId: 'native', access: 'rw', root: '/project', alias: 'docs'}];
    app.projects.remoteMounts = {list: (id: string) => id === project.project.id ? mounts : [], projectHarness: async () => peer,
        status: () => 'online', degraded: () => false, projectOffline: () => false, connections: () => []} as never;
    vi.spyOn(app.projects, 'workspaceReadOnly').mockResolvedValue(false);
    browser = await createSessionBrowser({repository: app.sessionRepository, projects: app.projects, files: app.sessionFiles, kernel: app.kernel.kernel});
    return {project, peer, mounts, fs: browser.fs};
}
const isSession = (path: string) => {const target = resolveBrowserTarget(path); return target.kind === 'session' || target.kind === 'remote' && !!target.nativeSessionId;};

it('projects fifteen mixed recent sessions and pages the complete collection through a contained VFS', async () => {
    const {project, peer, fs} = await setup(), root = folderBrowserPath(project.path), recentPath = projectConversationsPath(project.path, {recent: true});
    const rootRows = await fs.driver.getChildren(root);
    expect(rootRows.find(row => row.path === recentPath)?.metadata.navigationTransparent).toBe(true);
    const recent = await fs.driver.getChildren(recentPath), sessions = recent.filter(row => isSession(row.path));
    expect(sessions).toHaveLength(15); expect(peer.list).toHaveBeenCalledTimes(3); expect(peer.inspect).not.toHaveBeenCalled();
    expect(new Set(sessions.map(row => row.metadata.harnessKind))).toEqual(new Set(['mindos', 'codex', 'dsht', 'claudecode']));
    expect(sessions.map(row => row.modifiedAt)).toEqual(Array.from({length: 15}, (_, i) => 10000 - i));
    expect((await fs.driver.getNode(sessions[0]!.path))?.metadata.navigationTarget).toBe(conversationResourcePath(sessions[0]!.path));
    expect(recent.every(row => row.parentPath === recentPath)).toBe(true);
    const more = recent.find(row => row.metadata.conversationMore)!;
    expect(conversationResourcePath(more.path)).toBe(projectConversationsPath(project.path));
    const found: string[] = []; let path: string | undefined = conversationResourcePath(more.path);
    while (path) {
        const rows = await fs.driver.getChildren(path);
        expect(rows.every(row => row.parentPath === path)).toBe(true);
        const entries = rows.filter(row => isSession(row.path)); expect(entries.length).toBeLessThanOrEqual(50);
        found.push(...entries.map(row => conversationResourcePath(row.path)));
        path = rows.find(row => row.metadata.conversationMore)?.path;
    }
    expect(found).toHaveLength(140); expect(new Set(found).size).toBe(140);
    expect(peer.close.mock.calls.length).toBe(4);
});

it('keeps healthy harnesses visible after one failure and respects read-only creation capabilities', async () => {
    const {project, peer, mounts, fs} = await setup(), read = peer.list.getMockImplementation()!;
    peer.list.mockImplementation(async (profile, query) => {if (profile === 'codex') throw new Error('offline'); return read(profile, query);});
    const rows = await fs.driver.getChildren(projectConversationsPath(project.path, {recent: true}));
    expect(rows.filter(row => isSession(row.path))).toHaveLength(15);
    expect(rows.some(row => row.metadata._disabled)).toBe(true);
    expect(rows.some(row => row.metadata.harnessKind === 'dsht')).toBe(true);
    mounts[0]!.access = 'ro';
    const all = await fs.driver.getChildren(projectConversationsPath(project.path));
    expect(all.some(row => {const target = resolveBrowserTarget(row.path); return target.kind === 'remote' && target.draft;})).toBe(false);
});
