import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, FSError, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import type { ProjectFolder } from '@itookit/app-contracts/services';
import { ProjectDefaults } from '../src/projects/project-defaults';

let manager: IVFSManager, root: IFileSystem;
beforeEach(async () => { ({ manager } = await createVFS({rootBackend: new MemoryBackend()})); root = await manager.openFileSystem('/'); });
afterEach(async () => { await manager.dispose(); });
const folder = (id: string, kind: 'local' | 'remote' = 'local'): ProjectFolder => ({path: '/' + id, name: id, parentPath: null,
    updatedAt: 0, project: {id, directory: '/home/admin/projects/' + id, source: {kind}}});
function setup(projects: ProjectFolder[] = []) {
    const create = vi.fn(async () => { const project = folder('personal'); projects.push(project); return project; });
    const defaults = new ProjectDefaults(root, async () => projects, create, project => project.project.source?.kind === 'local');
    return {defaults, projects, create};
}
it('creates one personal project only for an empty catalog, including concurrent startup', async () => {
    const f = setup();
    const selected = await Promise.all([f.defaults.ensure(), f.defaults.ensure()]);
    expect(selected.map(project => project?.project.id)).toEqual(['personal', 'personal']);
    expect(f.create).toHaveBeenCalledOnce(); expect((await f.defaults.get())?.project.id).toBe('personal');
});
it('uses an existing local project without adopting a special label or creating another project', async () => {
    const f = setup([folder('existing'), {...folder('legacy'), name: '个人项目'}]);
    expect((await f.defaults.ensure())?.project.id).toBe('existing');
    expect(f.create).not.toHaveBeenCalled();
});
it('replaces a deleted default with another existing local project without recreating it', async () => {
    const f = setup([folder('removed'), folder('remaining')]);
    await f.defaults.set('removed'); f.projects.shift();
    expect((await f.defaults.ensure())?.project.id).toBe('remaining');
    expect(f.create).not.toHaveBeenCalled();
});
it('does not create a personal project when only remote projects exist', async () => {
    const f = setup([folder('remote', 'remote')]);
    expect(await f.defaults.ensure()).toBeUndefined(); expect(f.create).not.toHaveBeenCalled();
});
it('rejects missing or remote defaults and preserves the previous valid selection', async () => {
    const f = setup([folder('local'), folder('remote', 'remote')]); await f.defaults.set('local');
    await expect(f.defaults.set('missing')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(f.defaults.set('remote')).rejects.toMatchObject({code: 'EINVAL'});
    expect((await f.defaults.get())?.project.id).toBe('local');
});
it('keeps a persisted explicit default when a new policy instance starts', async () => {
    const f = setup([folder('first'), folder('chosen')]); await f.defaults.set('chosen');
    expect((await setup(f.projects).defaults.ensure())?.project.id).toBe('chosen');
});
it('creates a replacement after deleting the last local default even if remote projects remain', async () => {
    const f = setup([folder('local'), folder('remote', 'remote')]); await f.defaults.set('local');
    const replacement = await f.defaults.remove('local', async () => { f.projects.shift(); });
    expect(replacement?.project.id).toBe('personal'); expect(f.create).toHaveBeenCalledWith(true);
    expect((await f.defaults.get())?.project.id).toBe('personal');
});
it('selects another local project immediately after default deletion and leaves other deletions alone', async () => {
    const f = setup([folder('local'), folder('next'), folder('other')]); await f.defaults.set('local');
    await f.defaults.remove('other', async () => { f.projects.pop(); });
    expect((await f.defaults.get())?.project.id).toBe('local');
    await f.defaults.remove('local', async () => { f.projects.shift(); });
    expect((await f.defaults.get())?.project.id).toBe('next'); expect(f.create).not.toHaveBeenCalled();
});
it('recovers a missing default after interruption without requiring a successful deletion callback', async () => {
    const f = setup([folder('local'), folder('remote', 'remote')]); await f.defaults.set('local'); f.projects.shift();
    expect((await f.defaults.ensure())?.project.id).toBe('personal'); expect(f.create).toHaveBeenCalledWith(true);
});
it('keeps the previous default after a failed persistence attempt and permits retry', async () => {
    const f = setup([folder('first'), folder('next')]); await f.defaults.set('first');
    const write = vi.spyOn(root.driver, 'writeContent').mockRejectedValueOnce(new FSError('EIO', 'Default storage unavailable'));
    await expect(f.defaults.set('next')).rejects.toMatchObject({code: 'EIO'});
    expect((await f.defaults.get())?.project.id).toBe('first');
    write.mockRestore(); await f.defaults.set('next');
    expect((await f.defaults.get())?.project.id).toBe('next');
});
