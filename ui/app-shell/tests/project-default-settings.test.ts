// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, ProjectService, SessionFilesService, folderBrowserPath } from '@itookit/app-core';
import { ProjectNavigation } from '../src/projects/ProjectNavigation';
import { t } from '@itookit/common';
import type { VFSNodeUI } from '@itookit/vfs-ui';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function setup() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/'), repository = new SessionRepository(root); await repository.init(); cleanup.push(() => repository.dispose());
    const files = new SessionFilesService(root); await files.initialize(); cleanup.push(() => files.dispose());
    const mounts = new DirectoryMountService(root, files); await mounts.init(); cleanup.push(() => mounts.dispose());
    const projects = new ProjectService(root, repository, mounts, files); cleanup.push(() => projects.dispose()); await projects.ensureStartup();
    const report = vi.fn(), navigation = new ProjectNavigation(projects, () => undefined, {createProject: vi.fn(), createSession: vi.fn(),
        createChild: vi.fn(), importItems: vi.fn(), exportItems: vi.fn(), retryDeletions: vi.fn(), contentChanged: vi.fn(), report});
    cleanup.push(() => navigation.destroy()); document.body.append(navigation.header);
    await navigation.sync('/'); return {projects, navigation, report};
}
it('selects the default from sidebar settings and pins it before other project rows and choices', async () => {
    const f = await setup(), other = await f.projects.create('AAA other'), chosen = await f.projects.create('ZZZ chosen');
    await f.navigation.refresh();
    f.navigation.header.querySelector<HTMLButtonElement>('[data-project-action="settings"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('#project-default-select')).not.toBeNull());
    const select = document.querySelector<HTMLSelectElement>('#project-default-select')!; select.value = chosen.project.id;
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(f.navigation.header.querySelector('select option:nth-child(2)')?.textContent).toContain('ZZZ chosen'));
    expect((await f.projects.getDefaultProject())?.project.id).toBe(chosen.project.id);
    const node = (project: typeof other): VFSNodeUI => ({id: folderBrowserPath(project.path), type: 'directory', kind: 'folder',
        metadata: {path: folderBrowserPath(project.path), title: project.name, parentPath: null, tags: [], custom: {projectId: project.project.id}}} as VFSNodeUI);
    const rows = f.navigation.navigationItems([node(other), node(chosen)]);
    expect(rows.map(row => row.id)).toEqual([folderBrowserPath(chosen.path), folderBrowserPath(other.path)]);
    expect(rows[0].metadata.title).toContain(t('project.default.badge'));
    expect(f.report).not.toHaveBeenCalled();
});
it('preserves the selected project and keeps settings open when persistence fails', async () => {
    const f = await setup(), original = await f.projects.getDefaultProject(), candidate = await f.projects.create('Candidate');
    vi.spyOn(f.projects, 'setDefaultProject').mockRejectedValue(new Error('Default storage unavailable'));
    f.navigation.header.querySelector<HTMLButtonElement>('[data-project-action="settings"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('#project-default-select')).not.toBeNull());
    document.querySelector<HTMLSelectElement>('#project-default-select')!.value = candidate.project.id;
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-toast--error')?.textContent).toContain('Default storage unavailable'));
    expect(document.querySelector('.settings-modal')).not.toBeNull();
    expect((await f.projects.getDefaultProject())?.project.id).toBe(original?.project.id);
});
it('offers local projects only and does not change the default when settings are cancelled', async () => {
    const f = await setup(), current = (await f.projects.getDefaultProject())!, candidate = await f.projects.create('Candidate');
    const catalog = await f.projects.list();
    vi.spyOn(f.projects, 'list').mockResolvedValue([...catalog, {...candidate, name: 'Remote only',
        project: {...candidate.project, id: 'remote-only', source: {kind: 'remote'}}}]);
    const save = vi.spyOn(f.projects, 'setDefaultProject');
    f.navigation.header.querySelector<HTMLButtonElement>('[data-project-action="settings"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('#project-default-select')).not.toBeNull());
    const select = document.querySelector<HTMLSelectElement>('#project-default-select')!;
    expect([...select.options].map(option => option.value)).not.toContain('remote-only');
    select.value = candidate.project.id;
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal')).toBeNull());
    expect(save).not.toHaveBeenCalled(); expect((await f.projects.getDefaultProject())?.project.id).toBe(current.project.id);
});
