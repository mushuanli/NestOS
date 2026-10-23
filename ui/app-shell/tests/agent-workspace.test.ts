// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {bindApplicationBackend} from '@itookit/app-core/host';
import {folderBrowserPath, resolveBrowserTarget, projectConversationsPath} from '@itookit/app-contracts';
import {SessionWorkbench} from '../src/projects/SessionWorkbench';
import {AgentProjectPreferences} from '../src/projects/agent-project-preferences';
import {createAgentEditorFactory} from '../../llm-ui-adapter/src/settings';
import {SessionDraftEditor} from '../../llm-ui-adapter/src/shell/drafts/SessionDraftEditor';
import type {EditorOptions} from '@itookit/ui-common';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();});
async function setup({realDraft = false, mobile = false} = {}) {
    vi.stubGlobal('matchMedia', () => ({matches: mobile, addEventListener() {}, removeEventListener() {}}));
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const backend = bindApplicationBackend(runtime), sidebar = document.createElement('div'), main = document.createElement('div');
    const layout = document.createElement('div'); layout.className = 'mm-layout'; layout.append(sidebar, main); document.body.append(layout);
    const factory = vi.fn(async (container: HTMLElement, options: EditorOptions) => {
        if (!realDraft || !options.sessionDraft) return {destroy: async () => {}, focus() {}, commands: {selectDraftAgent: vi.fn()}} as never;
        const editor = new SessionDraftEditor(container, runtime.agentService, options as never); await editor.init(container); return editor as never;
    });
    const agentFactory = createAgentEditorFactory(runtime.agentService);
    const navigate = vi.fn(async (request: {target: string; resourceId?: string}) => {if (request.target === 'chat') await workbench.openResource(request.resourceId!);});
    const workbench = new SessionWorkbench({backend, sidebar, container: main, repository: runtime.sessionRepository,
        files: runtime.sessionFiles, projects: runtime.projects, kernel: runtime.kernel.kernel, factory, fileFactory: factory, onSelect() {}, hostContext: {navigate},
        agents: {resourceId: id => runtime.agentService.getAgentResourceId(id), read: id => runtime.agentService.getAgentConfig(id), createEditor: agentFactory}});
    cleanup.push(() => workbench.destroy()); await workbench.start();
    return {runtime, backend, workbench, sidebar, main, layout, navigate, factory};
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

it('saves agent settings and project before opening chat without replacing its existing draft', async () => {
    const f = await setup({realDraft: true, mobile: true}), project = await f.runtime.projects.create('Writing');
    const agent = (await f.runtime.agentService.getAgents())[0], route = '@agent/' + encodeURIComponent(agent.id);
    const folder = await f.runtime.projects.sessionFolder(project), draft = await f.runtime.projects.drafts.open(project.project.id, folder);
    const bytes = new TextEncoder().encode('Keep the attachment').buffer, attachmentId = await draft.attachments.put(bytes);
    const files = [{id: attachmentId, name: 'notes.txt', type: 'text/plain', lastModified: 1}];
    await draft.save!(JSON.stringify({version: 2, config: {text: '保留原来的输入', agentId: 'default', settings: {}}, files}));
    const saveAgent = vi.spyOn(f.runtime.agentService, 'saveAgent'), createSession = vi.spyOn(f.runtime.sessionRepository, 'createSession');
    await f.workbench.openResource(route);
    const configuration = f.main.querySelector<HTMLElement>('.agent-config-editor')!;
    expect(configuration.dataset.editorMobileNavigation).toBe('embedded');
    expect(configuration.querySelector('[data-agent-compact-navigation] .workbench-compact-navigation')).not.toBeNull();
    const name = configuration.querySelector<HTMLInputElement>('[name="name"]')!;
    name.value = 'Updated writer'; name.dispatchEvent(new Event('input', {bubbles: true}));
    const select = configuration.querySelector<HTMLSelectElement>('[data-field="agent-default-project"]')!;
    select.value = project.project.id; select.dispatchEvent(new Event('change', {bubbles: true}));
    const start = configuration.querySelector<HTMLButtonElement>('[data-agent-start-chat]')!;
    start.click(); start.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('draft:' + project.project.id));
    await vi.waitFor(async () => {
        const stored = await f.runtime.projects.drafts.open(project.project.id, folder);
        expect(JSON.parse(stored.initialData!)).toMatchObject({config: {text: '保留原来的输入', agentId: agent.id}, files});
    });
    expect(saveAgent).toHaveBeenCalledOnce();
    expect(await f.runtime.agentService.getAgentConfig(agent.id)).toMatchObject({name: 'Updated writer'});
    expect(await new AgentProjectPreferences(f.backend).read(agent.id)).toBe(project.project.id);
    expect(f.main.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value).toBe('保留原来的输入');
    expect(new TextDecoder().decode(await draft.attachments.read(attachmentId))).toBe('Keep the attachment');
    expect(createSession).not.toHaveBeenCalled(); expect(f.factory).toHaveBeenCalledOnce();
    expect(f.layout.dataset.mobileView).toBe('detail'); expect(configuration.isConnected).toBe(true);
    expect(configuration.closest<HTMLElement>('.workbench-tabs__panel')!.hidden).toBe(true);
    await f.workbench.openResource(route);
    expect(f.main.querySelector('.agent-config-editor')).toBe(configuration); expect(name.value).toBe('Updated writer');
});

it('keeps the configuration draft and reports the save failure before opening any chat', async () => {
    const f = await setup(), agent = (await f.runtime.agentService.getAgents())[0], route = '@agent/' + encodeURIComponent(agent.id);
    await f.workbench.openResource(route);
    const configuration = f.main.querySelector<HTMLElement>('.agent-config-editor')!;
    const name = configuration.querySelector<HTMLInputElement>('[name="name"]')!;
    const save = vi.spyOn(f.runtime.agentService, 'saveAgent').mockRejectedValue(new Error('Storage is read-only'));
    name.value = 'Keep the edited name'; name.dispatchEvent(new Event('input', {bubbles: true}));
    const start = configuration.querySelector<HTMLButtonElement>('[data-agent-start-chat]')!;
    try {
        start.click();
        await vi.waitFor(() => expect(configuration.querySelector('[data-agent-chat-status]')!.textContent).toContain('Storage is read-only'));
        expect(f.workbench.getActiveResourceId()).toBe(route); expect(f.factory).not.toHaveBeenCalled();
        expect(name.value).toBe('Keep the edited name'); expect(start.disabled).toBe(false);
        expect(configuration.closest<HTMLElement>('.workbench-tabs__panel')!.hidden).toBe(false);
    } finally {save.mockRestore(); await f.workbench.openResource(route);}
});

it('does not open a late agent launch after the workspace is hidden during preference reads', async () => {
    const f = await setup(), agent = (await f.runtime.agentService.getAgents())[0], route = '@agent/' + encodeURIComponent(agent.id);
    await f.workbench.openResource(route);
    let release!: () => void; const pending = new Promise<void>(resolve => {release = resolve;});
    const read = f.backend.readUiDocuments.bind(f.backend);
    const reads = vi.spyOn(f.backend, 'readUiDocuments').mockImplementation(async keys => {
        if (keys.some(key => key.startsWith('mindos_agent_project_'))) await pending;
        return read(keys);
    });
    const start = f.main.querySelector<HTMLButtonElement>('[data-agent-start-chat]')!;
    try {
        start.click(); await vi.waitFor(() => expect(reads).toHaveBeenCalled());
        await f.workbench.setVisible(false); release();
        await vi.waitFor(() => expect(start.disabled).toBe(false));
        expect(f.factory).not.toHaveBeenCalled(); expect(f.workbench.getActiveResourceId()).toBe(route);
        expect(f.main.querySelector('[data-tab-id^="draft:"]')).toBeNull();
    } finally {release(); reads.mockRestore(); await f.workbench.setVisible(true);}
});

it('returns to the retained configuration and shows an editor opening error without a failed empty tab', async () => {
    const f = await setup(), agent = (await f.runtime.agentService.getAgents())[0], route = '@agent/' + encodeURIComponent(agent.id);
    await f.workbench.openResource(route);
    const configuration = f.main.querySelector<HTMLElement>('.agent-config-editor')!, scope = f.workbench.getNavigationScope();
    const start = configuration.querySelector<HTMLButtonElement>('[data-agent-start-chat]')!;
    f.factory.mockRejectedValueOnce(new Error('Draft editor is unavailable'));
    start.click();
    await vi.waitFor(() => expect(configuration.querySelector('[data-agent-chat-status]')!.textContent).toContain('Draft editor is unavailable'));
    expect(f.workbench.getActiveResourceId()).toBe(route); expect(f.workbench.getNavigationScope()).toBe(scope);
    expect(configuration.closest<HTMLElement>('.workbench-tabs__panel')!.hidden).toBe(false);
    expect(f.main.querySelector('[data-tab-id^="draft:"]')).toBeNull(); expect(f.main.querySelectorAll('[data-tab-id]')).toHaveLength(1);
    expect(start.disabled).toBe(false); start.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toMatch(/^draft:/));
    expect(f.factory).toHaveBeenCalledTimes(2);
});

it('keeps a newer configuration active when an earlier chat launch is resolving its folder', async () => {
    const f = await setup(), agents = await f.runtime.agentService.getAgents();
    const route = '@agent/' + encodeURIComponent(agents[0].id), next = '@agent/' + encodeURIComponent(agents[1].id);
    await f.workbench.openResource(route);
    let release!: () => void; const pending = new Promise<void>(resolve => {release = resolve;});
    const forFolder = f.runtime.projects.forFolder.bind(f.runtime.projects);
    const folders = vi.spyOn(f.runtime.projects, 'forFolder').mockImplementationOnce(async folder => {await pending; return forFolder(folder);});
    const start = f.main.querySelector<HTMLButtonElement>('[data-agent-start-chat]')!;
    try {
        start.click(); await vi.waitFor(() => expect(folders).toHaveBeenCalled());
        await f.workbench.openResource(next); release();
        await vi.waitFor(() => expect(start.disabled).toBe(false));
        expect(f.workbench.getActiveResourceId()).toBe(next); expect(f.factory).not.toHaveBeenCalled();
        expect(f.main.querySelector('[data-tab-id^="draft:"]')).toBeNull();
        expect(f.main.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden]) .agent-config-editor')
            ?.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe(agents[1].name);
    } finally {release(); folders.mockRestore();}
});
