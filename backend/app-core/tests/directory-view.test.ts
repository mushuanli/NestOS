import {expect, it, vi} from 'vitest';
import {FSError, type FSNode, type IFileSystem} from '@itookit/vfs-core';
import type {ProjectService} from '@itookit/app-contracts/services';
import {readDirectoryView} from '../src/session/directory-view';

function fixture() {
    const node = (path: string, metadata: Record<string, unknown> = {}): FSNode => ({path, name: path.split('/').pop()!, parentPath: '/',
        type: 'directory', version: 1, createdAt: 0, modifiedAt: 0, tags: [], metadata});
    const root = node('/folder:Work'), files = node(root.path + '/@files'), conversation = node(root.path + '/@conversations');
    const recent = node(root.path + '/@recent-conversations', {navigationTransparent: true, directoryPath: conversation.path});
    const session = {...node(conversation.path + '/session'), type: 'file' as const, size: 0};
    const values = new Map([root, files, recent, conversation, session].map(value => [value.path, value]));
    const children = new Map([[root.path, [files, recent, node('/hidden', {navigationHidden: true})]], [conversation.path, [session]]]);
    const getNode = vi.fn(async (path: string) => values.get(path) ?? null), getChildren = vi.fn(async (path: string) => children.get(path) ?? []);
    const fs = {revision: 7, driver: {getNode, getChildren}} as unknown as IFileSystem;
    const project = {path: '/Work', name: 'Work', project: {id: 'work'}};
    const navigation = vi.fn(async () => ({path: root.path, projects: [project], loadPaths: [], offlineProjectIds: [], pendingDeletions: 0}));
    const projects = {navigation} as unknown as ProjectService;
    return {fs, projects, root, files, conversation, session, getNode, getChildren, navigation, project, children};
}
it('prepares the flattened directory and project once while keeping ordinary directories lazy', async () => {
    const f = fixture(), view = await readDirectoryView(f.fs, f.projects, f.root.path, {projectId: null});
    expect(view.nodes.map(row => row.path)).toEqual([f.files.path, f.session.path]);
    expect(view.project).toEqual(f.project); expect(view.navigation?.project).toBeUndefined();
    expect(f.navigation).toHaveBeenCalledOnce(); expect(f.navigation).toHaveBeenCalledWith({path: f.root.path, projectId: null});
    expect(f.getChildren.mock.calls.map(([path]) => path)).toEqual([f.root.path, f.conversation.path]);
    expect(view.directories).toHaveLength(2); expect(view.directories.every(row => !row.stale && row.revision === 7)).toBe(true);
    const group = view.directories.find(row => row.path === f.conversation.path)!;
    expect(group.nodes).toBeUndefined(); expect(group.entryIndices).toEqual([1]);
});
it('marks prepared metadata stale if its source changes during the read', async () => {
    const f = fixture(), original = f.getChildren.getMockImplementation()!;
    f.getChildren.mockImplementationOnce(async path => {const result = await original(path); Object.assign(f.fs, {revision: 8}); return result;});
    const view = await readDirectoryView(f.fs, f.projects, f.root.path);
    expect(view.directories.every(row => row.stale && row.revision === 8)).toBe(true);
});
it('rejects cyclic virtual containers and preserves real read failures', async () => {
    const f = fixture(); f.children.set(f.root.path, [{...f.files, metadata: {navigationTransparent: true, directoryPath: f.root.path}}]);
    await expect(readDirectoryView(f.fs, f.projects, f.root.path)).rejects.toMatchObject({code: 'ELOOP'});
    const error = new FSError('EACCES', 'Denied'); f.getChildren.mockRejectedValueOnce(error);
    await expect(readDirectoryView(f.fs, f.projects, f.root.path)).rejects.toBe(error);
});
