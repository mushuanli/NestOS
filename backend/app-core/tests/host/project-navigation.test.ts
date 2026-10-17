import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime, type ApplicationRuntime } from '../../src/runtime/create-application-runtime';
import { bindApplicationBackend, bindLocalApplicationServices } from '../../src/host';

let runtime: ApplicationRuntime | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });
async function setup() {
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false });
    return runtime;
}

it('prepares project navigation and opaque group loading without scanning other Session histories', async () => {
    const app = await setup(), project = await app.projects.create('Work');
    const folder = await app.projects.sessionFolder(project), session = await app.projects.sessions.create('Phone', folder);
    const summaries = vi.spyOn(app.sessionRepository, 'listSummaries');
    const view = await app.projects.navigation({ path: '/folder:Stale/' + session });
    expect(view.project?.project.id).toBe(project.project.id);
    expect(view.path).toContain(session);
    expect(view.loadPaths).toEqual(['/folder:Work/folder:%40sessions']);
    expect(summaries).not.toHaveBeenCalled();
    const backend = bindApplicationBackend(bindLocalApplicationServices(app));
    const workbench = await backend.workbenchView({ initialNavigation: false });
    try {
        const rows = await workbench.browser.fs.driver.getChildren('/folder:Work');
        expect(rows.find(row => row.path === view.loadPaths[0])?.metadata.navigationTransparent).toBe(true);
        expect((await workbench.browser.fs.driver.getChildren(view.loadPaths[0])).map(row => row.metadata.title)).toContain('Phone');
    } finally { await workbench.browser.dispose(); }
});

it('keeps project identity across rename and falls back to the project after Session deletion', async () => {
    const app = await setup(), project = await app.projects.create('Old');
    const session = await app.projects.sessions.create('Draft', await app.projects.sessionFolder(project));
    await app.projects.renameProject(project.path, '/New');
    const view = await app.projects.navigation({ path: '/' + session, projectId: project.project.id });
    expect(view.project?.path).toBe('/New');
    expect(view.path).toContain('/folder:New/');
    expect((await app.projects.navigation({ path: '/missing-session', projectId: project.project.id })).path).toBe('/folder:New');
});

it('publishes a newly created Session with its initial draft already persisted', async () => {
    const app = await setup(), backend = bindApplicationBackend(bindLocalApplicationServices(app));
    const observed: Array<Promise<unknown>> = [];
    const stop = app.sessionRepository.subscribe(() => {
        observed.push(app.sessionRepository.list().then(async rows => Promise.all(rows.map(row => app.sessionRepository.getUIState(row.id)))));
    });
    try {
        const session = await backend.createSessionDraft({ title: 'Quoted file', inputText: 'Keep this input' });
        expect((await app.sessionRepository.getUIState(session))?.branchDrafts?.main?.inputText).toBe('Keep this input');
        expect((await Promise.all(observed)).flat()).toContainEqual({ branchDrafts: { main: { inputText: 'Keep this input' } } });
        await expect(backend.createSessionDraft({ title: 'Deleted source', inputText: 'Retained', source: { projectFolder: '/deleted' } }))
            .rejects.toMatchObject({ code: 'ENOENT' });
        expect(await app.sessionRepository.list()).toHaveLength(1);
    } finally { stop(); }
});
