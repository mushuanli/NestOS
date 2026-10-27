// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {bindApplicationBackend} from '@itookit/app-core/host';
import {folderBrowserPath, projectConversationsPath, projectConversationEntryPath} from '@itookit/app-contracts';
import {SessionWorkbench} from '../src/projects/SessionWorkbench';
import {observeNavigationVisibility} from '../src/navigation/navigation-visibility';
import {FlowCommand, createFlowRevision} from '@itookit/llm-flow';
import {sessionDirectoryStorage} from '@itookit/llm-session';
import type {VFSUIShell} from '@itookit/vfs-ui';
import type {WorkbenchSnapshot} from '../src/workbench/state';

const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

async function setup(sidebarView: string, initialResource?: string) {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const backend = bindApplicationBackend(runtime), workbenchView = vi.spyOn(backend, 'workbenchView'), toolboxView = vi.spyOn(backend, 'toolboxView');
    const navigation = vi.spyOn(runtime.projects.sessions, 'navigation'), onSelect = vi.fn();
    const workspace = document.createElement('section'), layout = document.createElement('div'), sidebar = document.createElement('aside'), main = document.createElement('main');
    workspace.className = 'workspace-view active'; layout.className = 'mm-layout'; sidebar.className = 'mm-sidebar';
    workspace.append(layout); layout.append(sidebar, main); document.body.append(workspace);
    let state: WorkbenchSnapshot = {version: 1, sidebarView};
    const factory = vi.fn(async (mount: HTMLElement) => {const text = document.createElement('textarea'); text.value = 'Keep this draft'; mount.append(text); return {destroy: async () => {}, focus() {}, commands: {selectDraftAgent: vi.fn()}} as never;});
    const workbench = new SessionWorkbench({backend, sidebar, container: main, initialResource, repository: runtime.sessionRepository,
        files: runtime.sessionFiles, projects: runtime.projects, kernel: runtime.kernel.kernel, factory, fileFactory: factory, onSelect,
        workbenchState: {load: () => state, save: value => {state = value;}},
        agents: {resourceId: id => runtime.agentService.getAgentResourceId(id), read: id => runtime.agentService.getAgentConfig(id), createEditor: factory}});
    cleanup.push(() => workbench.destroy()); await workbench.start();
    cleanup.push(observeNavigationVisibility(layout, sidebar, visible => {void workbench.setNavigationVisible(visible);}));
    const select = async (kind: string) => {
        sidebar.querySelector<HTMLButtonElement>(`[data-sidebar-view="${kind}"]`)!.click(); await workbench.setNavigationVisible(true);
    };
    return {runtime, workbench, workbenchView, toolboxView, navigation, onSelect, sidebar, main, factory, select};
}

it('defers resource navigation for a restored agent view and refreshes changes only when resources return', async () => {
    const f = await setup('agents');
    await vi.waitFor(() => expect(f.sidebar.querySelector('.workbench-agents [data-item-id]')).not.toBeNull());
    expect(f.workbenchView).toHaveBeenCalledWith(expect.objectContaining({initialNavigation: false}));
    expect(f.navigation).not.toHaveBeenCalled(); expect(f.toolboxView).toHaveBeenCalledOnce();
    await f.select('navigation'); expect(f.navigation).toHaveBeenCalled();
    await f.select('agents'); f.navigation.mockClear();
    const project = await f.runtime.projects.create('Created while hidden');
    await (f.workbench as unknown as {refresh(): Promise<void>}).refresh();
    expect(f.navigation).not.toHaveBeenCalled();
    await f.select('navigation'); expect(f.navigation).toHaveBeenCalled();
    expect(f.sidebar.querySelector('.workbench-sidebar__navigation')?.textContent).toContain(project.name);
});

it('does not read agents before selection or change the active draft and project when switching views', async () => {
    const f = await setup('navigation'); expect(f.toolboxView).not.toHaveBeenCalled();
    const project = await f.runtime.projects.create('Writing'), path = folderBrowserPath(project.path);
    await f.workbench.openResource(path); await (f.workbench as unknown as {fileNavigation: Promise<void>}).fileNavigation;
    await f.workbench.startSessionDraft(path);
    const active = f.workbench.getActiveResourceId(), scope = f.workbench.getNavigationScope();
    const field = f.main.querySelector('textarea')!, count = f.factory.mock.calls.length; f.onSelect.mockClear();
    await f.select('agents'); await vi.waitFor(() => expect(f.sidebar.querySelector('.workbench-agents [data-item-id]')).not.toBeNull());
    await f.select('navigation');
    expect(f.workbench.getActiveResourceId()).toBe(active); expect(f.workbench.getNavigationScope()).toBe(scope);
    expect(f.main.contains(field)).toBe(true); expect(field.value).toBe('Keep this draft');
    expect(f.factory).toHaveBeenCalledTimes(count); expect(f.onSelect).not.toHaveBeenCalled();
});

it('continues refreshing the current directory when resources are hidden during an in-flight refresh', async () => {
    const f = await setup('navigation'), project = await f.runtime.projects.create('Active directory');
    const folder = await f.runtime.projects.sessionFolder(project), path = projectConversationsPath(project.path);
    await f.workbench.openResource(path); await (f.workbench as unknown as {fileNavigation: Promise<void>}).fileNavigation;
    await (f.workbench as unknown as {refresh(): Promise<void>}).refresh();
    const browser = (f.workbench as unknown as {browser: {invalidateNavigation(): Promise<void>}}).browser;
    let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
    const original = browser.invalidateNavigation.bind(browser);
    const invalidation = vi.spyOn(browser, 'invalidateNavigation').mockImplementationOnce(async () => {await gate; await original();});
    const refreshing = (f.workbench as unknown as {refresh(): Promise<void>}).refresh();
    try {
        await vi.waitFor(() => expect(invalidation).toHaveBeenCalledOnce());
        await f.select('agents');
        await f.runtime.sessionRepository.createSession('Created during resource refresh', folder);
        release(); await refreshing;
        expect(f.workbench.getActiveResourceId()).toBe(path);
        expect(f.main.querySelector('.workbench-tabs__panel:not([hidden])')?.textContent).toContain('Created during resource refresh');
    } finally {release(); await refreshing;}
});

it('selects the agent sidebar before loading navigation for an explicit agent settings deep link', async () => {
    const f = await setup('navigation', '@agent/example-agent');
    expect(f.workbenchView).toHaveBeenCalledWith(expect.objectContaining({initialNavigation: false}));
    expect(f.navigation).not.toHaveBeenCalled();
    expect(f.sidebar.querySelector('[data-sidebar-view="agents"]')?.getAttribute('aria-selected')).toBe('true');
});

it('projects a real Flow run activity without reloading the sidebar tree and retains structural updates', async () => {
    const f = await setup('navigation'), project = await f.runtime.projects.create('Flow activity');
    const folder = await f.runtime.projects.sessionFolder(project), id = await f.runtime.sessionRepository.createSession('Flow run', folder);
    await f.runtime.kernel.kernel.createSession({id, storage: sessionDirectoryStorage(id)});
    const path = `${folderBrowserPath(folder)}/${id}`;
    await f.workbench.openResource(folderBrowserPath(project.path)); await (f.workbench as any).fileNavigation;
    await f.workbench.openResource(path); await (f.workbench as any).fileNavigation; await (f.workbench as any).refresh();
    const ui = (f.workbench as any).sidebarUI as VFSUIShell, browser = (f.workbench as any).browser;
    expect(ui.getNode(projectConversationEntryPath(projectConversationsPath(project.path, {recent: true}), path))).toBeDefined();
    const reload = vi.spyOn(ui, 'refresh'), invalidate = vi.spyOn(browser, 'invalidateNavigation');
    const projects = vi.spyOn((f.workbench as any).projectNavigation, 'refresh'), metadata = vi.spyOn(ui, 'updateNodeMetadata');
    const snapshot = ui.getSnapshot(), scroll = f.sidebar.querySelector<HTMLElement>('.vfs-node-list__body')!;
    expect(scroll).not.toBeNull(); scroll.scrollTop = 75;
    const notifications: string[] = [], stop = f.runtime.kernel.kernel.onChanged(event => {
        if (event.sessionId === id && event.taskId && event.reason !== 'content') notifications.push(event.taskId);
    }); cleanup.push(stop);
    const flow = createFlowRevision({id: 'sidebar-activity' as never, name: 'Sidebar activity', draftVersion: 1,
        updatedAt: 0, layout: {}, nodes: [{id: 'value' as never, name: 'Value', plugin: 'builtin.transform',
            pluginVersion: '1.0.0', inputs: {}, config: {value: 'done'}}], edges: []}, 1);
    const run = await f.runtime.commandBus.execute<{taskId: string}>(FlowCommand.RunStart, {sessionId: id, flow});
    await vi.waitFor(async () => expect((await f.runtime.kernel.kernel.task(id, run.taskId)).status).toBe('succeeded'));
    await vi.waitFor(() => expect(metadata).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({custom: expect.objectContaining({
        sessionActivity: expect.objectContaining({latestExit: expect.objectContaining({status: 'succeeded'})}),
    })})));
    expect(notifications.length).toBeGreaterThan(3); expect(reload).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled(); expect(projects).not.toHaveBeenCalled();
    expect(ui.getSnapshot().expandedIds).toEqual(snapshot.expandedIds); expect(scroll.scrollTop).toBe(75);
    await f.runtime.sessionRepository.createSession('New structural session', folder);
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(f.sidebar.textContent).toContain('New structural session');
});
