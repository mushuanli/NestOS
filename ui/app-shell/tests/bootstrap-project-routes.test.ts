import { initTestApp } from './helpers/application';
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryMountService, SessionFilesService, ProjectService, folderBrowserPath, type ApplicationRuntime } from '@itookit/app-core';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { defaultEditorFactory } from '@itookit/mdx-adapter';
import type { WorkspaceConfig } from '../src/types';

vi.mock('../src/ThemeService', () => ({
    themeService: { init: vi.fn(async () => {}), destroy: vi.fn(), setMode: vi.fn(async () => {}) },
    ThemeMode: undefined,
}));

vi.mock('@itookit/mdx-adapter', () => ({
    defaultEditorFactory: vi.fn(async () => ({ destroy: vi.fn(async () => {}) })),
}));

vi.mock('@itookit/kernel-adapters', () => ({
    createSessionSkillControls: vi.fn(() => ({})),
}));

vi.mock('@itookit/app-settings', () => ({
    createSettingsNavigation: vi.fn(() => ({})),
    createSettingsFactory: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
    SkillsEngine: class { async dispose() {} },
}));


import { initApp } from '../src/bootstrap';
import { parseWorkspaceHash } from '../src/navigation/workspace-route';

const workspace: WorkspaceConfig = { elementId: 'llm-workspace', workspaceName: 'chats', slug: 'chat', type: 'chat', title: 'Chat' };
const documentName = '新译林9A Unit 3 重点短语句子背诵版.prj';

async function fixture() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    await root.driver.createFile({ parentPath: '/home/admin/projects', name: documentName, content: 'original study notes' });
    const runtime = { vfs: manager, llmDriver: {}, agentService: { getConnections: async () => [], getSystemPrompt: async () => null, saveSystemPrompt: vi.fn() },
        sessionRepository: repository, sessionFiles: files, directoryMounts: mounts, projects,
        flowEngine: { engine: {} }, kernel: { kernel: { onChanged: () => () => {}, async *listSessions() {} }, sessions: {} },
        sessionManager: { onGlobalEvent: () => () => {} }, commandBus: {} } as unknown as ApplicationRuntime;
    const ui = { createChatEditor: () => defaultEditorFactory, createAgentEditor: () => defaultEditorFactory,
        createFlowEditor: () => defaultEditorFactory, createSkillEditor: () => defaultEditorFactory,
        createAIContextMenu: () => ({}), createFlowContextMenu: () => ({}), llmUiEditors: {} };
    return { root, projects, repository, async start(overrides: Record<string, unknown> = {}) {
        document.body.innerHTML = '<div id="llm-workspace" class="workspace-view"></div>';
        return initTestApp({   services: runtime, workspaces: [workspace], defaultSlug: 'chat', routeAliases: { projects: 'llm-workspace' }, ui: ui as any, ...overrides });
    }, async dispose() { await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose(); } };
}

beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});
afterEach(() => { document.body.replaceChildren(); delete document.body.dataset.appStarting; history.replaceState(null, '', '/'); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('saved project routes at bootstrap', () => {
    it('keeps the workbench running when a saved file refers only to a stale project cache', async () => {
        const f = await fixture();
        await f.repository.createFolder('/Legacy parent', { id: 'legacy-parent', directory: '/home/admin' });
        const route = folderBrowserPath('/Legacy parent') + '/@files/' + documentName;
        history.replaceState(null, '', '#/chat/' + encodeURIComponent(route));
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let app;
        try {
            app = await f.start();
            expect(document.body.textContent).toContain('此地址无效或内容已不存在');
            expect(document.querySelector('.project-workbench__tree')).not.toBeNull();
            expect(defaultEditorFactory).not.toHaveBeenCalled();
            expect(warning).not.toHaveBeenCalled();
            expect(await f.root.driver.readContent('/home/admin/projects/' + documentName, { encoding: 'utf-8' })).toBe('original study notes');
        } finally { await app?.destroy(); await f.dispose(); warning.mockRestore(); }
    });
    it('reports an overlapping legacy .prj root without failing startup or copying its data', async () => {
        const f = await fixture();
        history.replaceState(null, '', '#/projects/' + encodeURIComponent('/' + documentName));
        let app;
        try {
            app = await f.start();
            expect(document.querySelector('[role="alert"]')?.textContent).toContain('重叠');
            expect(defaultEditorFactory).not.toHaveBeenCalled();
            expect((await f.projects.list()).filter(p => p.project.directory === '/home/admin/projects')).toHaveLength(0);
            expect(await f.root.driver.readContent('/home/admin/projects/' + documentName, { encoding: 'utf-8' })).toBe('original study notes');
        } finally { await app?.destroy(); await f.dispose(); }
    });
    it.each(['#/chat/%2Fbad.prj', '#/chat/missing-session', '#/chat/%ZZ'])('keeps the app usable for %s', async hash => {
        const f = await fixture(); history.replaceState(null, '', hash);
        let app;
        try {
            app = await f.start();
            expect(location.hash).toBe('#/chat');
            expect(document.body.textContent).toContain('此地址无效或内容已不存在');
            expect(document.querySelector('.workbench-sidebar__navigation select option[value="@new-project"]')).not.toBeNull();
        } finally { await app?.destroy(); await f.dispose(); }
    });
    it('reports the workspace shell before the editor so a host can reveal nav, sidebar, then content', async () => {
        const f = await fixture();
        const order: string[] = [];
        let editor: HTMLElement | undefined;
        const app = await f.start({
            onWorkspaceReady: (parts: { editor: HTMLElement }) => { order.push('workspace'); editor = parts.editor; },
            onEditorReady: () => order.push('editor'),
        });
        try {
            expect(order[0]).toBe('workspace');
            expect(order).toContain('editor');
            // The reported editor area already sits next to the rendered Session sidebar.
            expect(editor?.classList.contains('mm-editor-area')).toBe(true);
            expect(editor?.previousElementSibling?.classList.contains('mm-sidebar')).toBe(true);
        } finally { await app.destroy(); await f.dispose(); }
    });

    it('reveals the sidebar before opening a deep-linked document', async () => {
        const f = await fixture();
        const project = (await f.projects.current())!;
        await f.root.driver.createFile({ parentPath: project.project.directory, name: documentName, content: 'original study notes' });
        history.replaceState(null, '', '#/chat/' + encodeURIComponent(folderBrowserPath(project.path) + '/@files/' + documentName));
        const phases: string[] = [];
        const app = await f.start({
            onWorkspaceMounted: () => {
                phases.push('shell');
                expect(document.querySelector('.mm-sidebar')).not.toBeNull();
                expect(document.querySelector('.project-workbench__tree')).toBeNull();
            },
            onWorkspaceReady: () => {
                phases.push('sidebar');
                expect(document.querySelector('.project-workbench__tree')).not.toBeNull();
                expect(defaultEditorFactory).not.toHaveBeenCalled();
            },
            onSidebarInteractive: () => {
                phases.push('interactive');
                expect(defaultEditorFactory).not.toHaveBeenCalled();
            },
            onEditorReady: () => phases.push('editor'),
        });
        try { expect(phases).toEqual(['shell', 'sidebar', 'interactive', 'editor']); }
        finally { await app.destroy(); await f.dispose(); }
    });

    it('reveals a restored target only after its first resource navigation finishes', async () => {
        const f = await fixture(), project = (await f.projects.current())!;
        await f.root.driver.createFile({ parentPath: project.project.directory, name: documentName, content: 'original study notes' });
        history.replaceState(null, '', '#/chat/' + encodeURIComponent(folderBrowserPath(project.path) + '/@files/' + documentName));
        document.body.dataset.appStarting = '';
        const app = await f.start({
            onShellReady: () => expect(document.body.hasAttribute('data-app-starting')).toBe(true),
            onWorkspaceReady: () => expect(document.querySelector<HTMLElement>('.mm-layout')?.dataset.workspaceOpening).toBe('true'),
        });
        try {
            expect(document.body.hasAttribute('data-app-starting')).toBe(false);
            expect(document.querySelector<HTMLElement>('.mm-layout')?.dataset.workspaceOpening).toBeUndefined();
            expect(defaultEditorFactory).toHaveBeenCalled();
        } finally {await app.destroy(); await f.dispose();}
    });

    it('keeps nested paths and decodes the shell URI envelope only once', () => {
        const resource = '/folder:%E9%A1%B9%E7%9B%AE/@files/a?branch=b';
        expect(parseWorkspaceHash('#/chat/' + encodeURIComponent(resource), 'chat')).toEqual({ slug: 'chat', resource });
        expect(parseWorkspaceHash('#/chat/folder:Project/@files/notes.md', 'chat').resource).toBe('folder:Project/@files/notes.md');
    });

    it('returns to all projects when entering a cached workbench without an explicit resource', async () => {
        const f = await fixture(), project = (await f.projects.current())!;
        history.replaceState(null, '', '#/chat/' + encodeURIComponent(folderBrowserPath(project.path)));
        const app = await f.start();
        try {
            const selector = document.querySelector<HTMLSelectElement>('.workbench-project-navigation select')!;
            await vi.waitFor(() => expect(selector.value).toBe(folderBrowserPath(project.path)));
            await app.navigate('chat'); expect(selector.value).toBe('/');
            expect(parseWorkspaceHash(location.hash, 'chat').resource).toBe('/');
        } finally { await app.destroy(); await f.dispose(); }
    });
});

it.each(['chat', 'workbench'])('opens legacy and canonical workspace links through the Workbench route: %s', async slug => {
    const f = await fixture(); history.replaceState(null, '', '#/' + slug + '/%2F');
    const app = await f.start({workspaces: [{...workspace, slug: 'workbench', title: 'Workbench'}], defaultSlug: 'workbench'});
    try {
        expect(document.querySelector('.workbench-directory')).not.toBeNull();
        expect(parseWorkspaceHash(location.hash, 'workbench')).toEqual({slug: 'workbench', resource: '/'});
        await app.navigate('chat'); expect(parseWorkspaceHash(location.hash, 'workbench').slug).toBe('workbench');
    } finally {await app.destroy(); await f.dispose();}
});
