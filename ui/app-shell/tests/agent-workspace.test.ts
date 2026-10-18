// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {bindApplicationBackend} from '@itookit/app-core/host';
import {folderBrowserPath, resolveBrowserTarget, projectConversationsPath} from '@itookit/app-contracts';
import {SessionWorkbench} from '../src/projects/SessionWorkbench';
import {AgentProjectPreferences} from '../src/projects/agent-project-preferences';
import {createAgentEditorFactory} from '../../llm-ui-adapter/src/settings';
import type {EditorOptions} from '@itookit/ui-common';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();});
async function setup() {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const backend = bindApplicationBackend(runtime), sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async (_container: HTMLElement, _options: EditorOptions) => ({destroy: async () => {}, focus() {}, commands: {selectDraftAgent: vi.fn()}}) as never);
    const agentFactory = createAgentEditorFactory(runtime.agentService);
    const navigate = vi.fn(async (request: {target: string; resourceId?: string}) => {if (request.target === 'chat') await workbench.openResource(request.resourceId!);});
    const workbench = new SessionWorkbench({backend, sidebar, container: main, repository: runtime.sessionRepository,
        files: runtime.sessionFiles, projects: runtime.projects, kernel: runtime.kernel.kernel, factory, fileFactory: factory, onSelect() {}, hostContext: {navigate},
        agents: {resourceId: id => runtime.agentService.getAgentResourceId(id), read: id => runtime.agentService.getAgentConfig(id), createEditor: agentFactory}});
    cleanup.push(() => workbench.destroy()); await workbench.start();
    return {runtime, backend, workbench, sidebar, main, navigate, factory};
}
it('opens agent settings inside the workbench, saves its default project, and filters only sessions', async () => {
    const f = await setup(), project = await f.runtime.projects.create('Writing');
    const agent = (await f.runtime.agentService.getAgents())[0], folder = await f.runtime.projects.sessionFolder(project);
    await f.runtime.sessionRepository.createSession('Created by this agent', folder, null, undefined, {agentId: agent.id});
    await f.runtime.sessionRepository.createSession('Different agent', folder, null, undefined, {agentId: 'other'});
    await f.workbench.openResource('@agent/' + encodeURIComponent(agent.id));
    expect(f.main.querySelector('.agent-config-editor')).not.toBeNull(); expect(f.navigate).not.toHaveBeenCalled();
    const select = f.main.querySelector<HTMLSelectElement>('[data-field="agent-default-project"]')!;
    select.value = project.project.id; select.dispatchEvent(new Event('change', {bubbles: true}));
    f.main.querySelector<HTMLButtonElement>('[data-action="show-agent-sessions"]')!.click();
    const root = folderBrowserPath(project.path);
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe(root));
    expect(await new AgentProjectPreferences(f.backend).read(agent.id)).toBe(project.project.id);
    const browser = (f.workbench as any).browser, rows = await browser.fs.driver.getChildren(root);
    expect(rows.some((row: any) => resolveBrowserTarget(row.path).kind === 'favorites')).toBe(true);
    expect(rows.some((row: any) => resolveBrowserTarget(row.path).kind === 'project-files')).toBe(true);
    const sessions = await browser.fs.driver.getChildren(projectConversationsPath(project.path));
    expect(sessions.filter((row: any) => resolveBrowserTarget(row.path).kind === 'session').map((row: any) => row.metadata.title)).toEqual(['Created by this agent']);
    expect(f.sidebar.querySelector('.workbench-agent-filter')?.textContent).toContain(agent.name);
    await new AgentProjectPreferences(f.backend).save('other', (await f.runtime.projects.personal()).project.id);
    expect(await new AgentProjectPreferences(f.backend).read(agent.id)).toBe(project.project.id);
    const clear = f.sidebar.querySelector<HTMLButtonElement>('.workbench-agent-filter button')!; clear.click();
    await vi.waitFor(() => expect(f.sidebar.querySelector<HTMLElement>('.workbench-agent-filter')!.hidden).toBe(true));
    const all = await browser.fs.driver.getChildren(projectConversationsPath(project.path));
    expect(all.filter((row: any) => resolveBrowserTarget(row.path).kind === 'session')).toHaveLength(2);
});
it('provides project selection on drafts and keeps each project draft independent', async () => {
    const f = await setup(), first = await f.runtime.projects.personal(), second = await f.runtime.projects.create('Second');
    const draft = await f.runtime.projects.drafts.open(first.project.id, await f.runtime.projects.sessionFolder(first)); await draft.save!('First draft');
    await f.workbench.startSessionDraft(folderBrowserPath(first.path));
    const controls = f.factory.mock.calls.at(-1)![1].sessionDraft!;
    expect(controls.executorScope).toBe('local'); expect((await controls.scope!.choices()).map(row => row.id)).toContain(second.project.id);
    await controls.scope!.select(second.project.id, 'default');
    expect(f.workbench.getActiveResourceId()).toBe('draft:' + second.project.id);
    expect((await f.runtime.projects.drafts.open(first.project.id, await f.runtime.projects.sessionFolder(first))).initialData).toBe('First draft');
    expect(f.factory.mock.calls.at(-1)![1].sessionDraft!.scope!.id).toBe(second.project.id);
});
