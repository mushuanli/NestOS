import { initTestApp } from './helpers/application';
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAVIGATION_EVENTS } from '@itookit/common';
import { OcrService, SettingsService, type ApplicationRuntime } from '@itookit/app-core';
import { bindApplicationBackend } from '@itookit/app-core/host';
import { themeService } from '../src/ThemeService';
import type { WorkspaceConfig } from '../src/types';
import { fileContentFormat } from '../src/browser/file-format';

const visibility = vi.hoisted(() => vi.fn());
const lifecycle = vi.hoisted(() => ({ start: vi.fn(async () => {}), open: vi.fn(async (_id: string) => {}),
    destroy: vi.fn(async () => {}), configure: vi.fn(), selection: undefined as ((id: string) => void) | undefined }));

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
    SkillsEngine: class { dispose() {} },
}));

vi.mock('../src/core/Workbench', () => ({
    Workbench: class {
        constructor(config: any) { lifecycle.selection = config.onSessionChange; lifecycle.configure(config); }
        setVisible = visibility;
        start = lifecycle.start;
        destroy = lifecycle.destroy;
        openFile = lifecycle.open;
        createAndOpenFile = vi.fn(async () => 'new-id');
        getActiveFilePath = vi.fn(() => null);
        setNodeWaitingInput = vi.fn();
    },
}));

vi.mock('../src/projects/SessionWorkbench', () => ({
    SessionWorkbench: class {
        start = vi.fn(async () => {});
        destroy = vi.fn(async () => {});
        openResource = vi.fn(async () => {});
        createResource = vi.fn(async () => 'new-id');
        getActiveResourceId = vi.fn(() => null);
        setWaitingInput = vi.fn();
    },
}));

import { initApp } from '../src/bootstrap';

const workspace: WorkspaceConfig = {
    elementId: 'settings-workspace',
    workspaceName: 'settings',
    slug: 'settings',
    type: 'settings',
    title: 'Settings',
    supportedFileTypes: [],
    syncEnabled: false,
};

function makeRuntime(): ApplicationRuntime {
    return {
        vfs: { openFileSystem: vi.fn(async () => ({ driver: { exists: async () => false, createFile: vi.fn(), getNode: async () => null, getChildren: async () => [] } })) },
        llmDriver: {},
        agentService: { getConnections: vi.fn(async () => []), getSystemPrompt: async () => null, saveSystemPrompt: vi.fn() },
        sessionRepository: {},
        flowEngine: { engine: {} },
        sessionFiles: {},
        directoryMounts: {},
        projects: {},
        kernel: { kernel: {}, sessions: {} },
        sessionManager: { onGlobalEvent: vi.fn(() => () => {}) },
        commandBus: {},
        runCatalog: {},
        dispose: vi.fn(async () => {}),
    } as unknown as ApplicationRuntime;
}

afterEach(() => {
    document.body.innerHTML = '';
    history.replaceState(null, '', '/');
    vi.restoreAllMocks(); lifecycle.start.mockReset().mockResolvedValue(); lifecycle.open.mockReset().mockResolvedValue(); lifecycle.destroy.mockReset().mockResolvedValue();
});

describe('app-shell navigation listener cleanup', () => {
    it('does not handle navigation events after destroy()', async () => {
        const container = document.createElement('div');
        container.id = workspace.elementId;
        document.body.appendChild(container);

        const pushState = vi.spyOn(window.history, 'pushState');
        const handle = await initTestApp({
            services: makeRuntime(),
            workspaces: [workspace],
            ui: {
                createChatEditor: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
                createAgentEditor: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
                createFlowEditor: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
                createSkillEditor: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
                createAIContextMenu: vi.fn(() => ({})),
                createFlowContextMenu: vi.fn(() => ({})),
                llmUiEditors: {},
            },
        });

        document.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.NAVIGATE, {
            detail: { target: workspace.slug, resourceId: 'first', action: 'open' },
        }));
        await vi.waitFor(() => expect(pushState).toHaveBeenCalledTimes(1));

        await handle.destroy();

        document.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.NAVIGATE, {
            detail: { target: workspace.slug, resourceId: 'second', action: 'open' },
        }));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(pushState).toHaveBeenCalledTimes(1);
    });
});

it('notifies cached workspaces when nav visibility changes', async () => {
    visibility.mockClear();
    const other = { ...workspace, elementId: 'other-workspace', slug: 'other' };
    document.body.innerHTML = '<div id="settings-workspace"></div><div id="other-workspace"></div>';
    const factory = () => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }));
    const handle = await initTestApp({   services: makeRuntime(), workspaces: [workspace, other], defaultSlug: 'settings',
        ui: { createChatEditor: factory, createAgentEditor: factory, createFlowEditor: factory,
            createSkillEditor: factory, createAIContextMenu: () => ({}), createFlowContextMenu: () => ({}), llmUiEditors: {} } as any });
    try {
        await handle.navigate('other');
        expect(visibility).toHaveBeenCalledWith(false);
        visibility.mockClear();
        await handle.navigate('settings');
        expect(visibility.mock.calls).toEqual([[true], [false]]);
    } finally { await handle.destroy(); }
});

it('starts background services after a non-chat workspace is available', async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
    const runtime = makeRuntime();
    runtime.startBackground = vi.fn();
    document.body.innerHTML = '<div id="settings-workspace"></div>';
    const factory = () => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }));
    const handle = await initTestApp({   services: runtime, workspaces: [workspace], defaultSlug: 'settings',
        ui: { createChatEditor: factory, createAgentEditor: factory, createFlowEditor: factory,
            createSkillEditor: factory, createAIContextMenu: () => ({}), createFlowContextMenu: () => ({}), llmUiEditors: {} } as any });
    try {
        expect(runtime.startBackground).not.toHaveBeenCalled();
        callbacks.forEach(callback => callback(0));
        expect(runtime.startBackground).toHaveBeenCalledOnce();
    } finally { await handle.destroy(); vi.unstubAllGlobals(); }
});

it('opens an ordinary workspace without OCR, settings, flow installation or inactive filesystems', async () => {
    const ocr = vi.spyOn(OcrService.prototype, 'readSettings').mockRejectedValue(new Error('OCR must remain lazy'));
    const settings = vi.spyOn(SettingsService.prototype, 'init').mockRejectedValue(new Error('Settings must remain lazy'));
    const runtime = makeRuntime();
    const active = { ...workspace, elementId: 'minds-workspace', slug: 'minds', workspaceName: 'minds', type: 'standard' as const };
    const inactive = { ...active, elementId: 'inactive-workspace', slug: 'inactive', workspaceName: 'emails' };
    document.body.innerHTML = '<div id="minds-workspace"></div><div id="inactive-workspace"></div>';
    const factory = vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))), install = vi.fn();
    vi.mocked(themeService.init).mockClear();
    const handle = await initTestApp({ services: runtime, workspaces: [active, workspace, inactive], defaultSlug: 'minds',
        ui: { createChatEditor: factory, createAgentEditor: factory, createFlowEditor: factory,
            createSkillEditor: factory, createAIContextMenu: () => ({}), createFlowContextMenu: () => ({}), installFlowLibrary: install, llmUiEditors: {} } as any });
    try {
        expect(themeService.init).toHaveBeenCalledOnce(); expect(ocr).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
        expect(new Set(vi.mocked(runtime.vfs.openFileSystem).mock.calls.map(([path]) => path))).toEqual(new Set(['/etc', '/home/admin/minds']));
    } finally { await handle.destroy(); }
});

const uiFactory = () => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }));
const testUI = () => ({ createChatEditor: uiFactory, createAgentEditor: uiFactory, createFlowEditor: uiFactory,
    createSkillEditor: uiFactory, createAIContextMenu: () => ({}), createFlowContextMenu: () => ({}), llmUiEditors: {} }) as any;
function navigationDOM(other = false) {
    document.body.innerHTML = `<aside class="app-sidebar"><div class="app-sidebar__brand">MindOS</div>
        <button class="app-nav-btn" data-target="settings-workspace"><span>Settings</span></button></aside>
        <main class="main-content-area"><div id="settings-workspace" class="workspace-view"></div>
        ${other ? '<div id="other-workspace" class="workspace-view"></div>' : ''}</main>`;
}

it('starts at a lightweight page and loads a workspace only after choosing it', async () => {
    navigationDOM(); lifecycle.start.mockClear();
    const runtime = makeRuntime(), ready = vi.fn();
    const app = await initTestApp({ services: runtime, workspaces: [workspace], startPage: true, onShellReady: ready, ui: testUI() });
    try {
        expect(ready).toHaveBeenCalledOnce(); expect(location.hash).toBe('#/start');
        expect(lifecycle.start).not.toHaveBeenCalled(); expect(lifecycle.open).not.toHaveBeenCalled();
        document.querySelector<HTMLButtonElement>('.app-start__choice')!.click();
        await vi.waitFor(() => expect(lifecycle.start).toHaveBeenCalledOnce());
        expect(location.hash).toBe('#/settings');
        document.querySelector<HTMLElement>('.app-sidebar__brand')!.click();
        expect(location.hash).toBe('#/start');
        expect(document.querySelector('.app-start')?.classList.contains('active')).toBe(true);
    } finally { await app.destroy(); }
});

it('releases the global banner before slow workspace startup and ignores obsolete resource navigation', async () => {
    navigationDOM(true); lifecycle.start.mockClear(); lifecycle.open.mockClear();
    let finish!: () => void;
    lifecycle.start.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const other = { ...workspace, elementId: 'other-workspace', slug: 'other' };
    history.replaceState(null, '', '#/settings/old-file');
    const ready = vi.fn();
    const starting = initTestApp({ services: makeRuntime(), workspaces: [workspace, other], onShellReady: ready, ui: testUI() });
    await vi.waitFor(() => expect(lifecycle.start).toHaveBeenCalledOnce());
    expect(ready).toHaveBeenCalledOnce();
    const obsoleteSelection = lifecycle.selection;
    document.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.NAVIGATE, { detail: { target: 'other' } }));
    obsoleteSelection?.('obsolete-file'); finish();
    const app = await starting;
    try {
        expect(location.hash).toBe('#/other');
        expect(document.querySelector('#other-workspace')?.classList.contains('active')).toBe(true);
        expect(lifecycle.open).not.toHaveBeenCalled();
    } finally { await app.destroy(); }
});

it('keeps a failed workspace local and releases it before retrying', async () => {
    navigationDOM(); lifecycle.start.mockClear(); lifecycle.destroy.mockClear();
    lifecycle.start.mockRejectedValueOnce(new Error('Temporary workspace failure'));
    const app = await initTestApp({ services: makeRuntime(), workspaces: [workspace], startPage: true, ui: testUI() });
    try {
        await app.navigate('settings');
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Temporary workspace failure');
        expect(lifecycle.destroy).toHaveBeenCalledOnce();
        document.querySelector<HTMLButtonElement>('.workspace-status button')!.click();
        await vi.waitFor(() => expect(lifecycle.start).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(document.querySelector('.workspace-status')).toBeNull());
        expect(document.querySelector('#settings-workspace')?.classList.contains('active')).toBe(true);
    } finally { await app.destroy(); }
});

it('retries a failed skill filesystem request through the workspace retry button', async () => {
    navigationDOM(); lifecycle.start.mockClear();
    const runtime = makeRuntime(), backend = bindApplicationBackend(runtime);
    const files = await runtime.vfs.openFileSystem('/home/admin/skills');
    const skillsFiles = vi.spyOn(backend, 'skillsFiles').mockRejectedValueOnce(new Error('Temporary disconnect')).mockResolvedValue(files);
    const skills = { ...workspace, workspaceName: 'skills', slug: 'skills', type: 'skills' as const };
    const app = await initApp({ services: runtime, backend, workspaces: [skills], startPage: true, ui: testUI() });
    try {
        await app.navigate('skills');
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Temporary disconnect');
        expect(lifecycle.start).not.toHaveBeenCalled();
        document.querySelector<HTMLButtonElement>('.workspace-status button')!.click();
        await vi.waitFor(() => expect(lifecycle.start).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(document.querySelector('.workspace-status')).toBeNull());
        await app.navigate('start'); await app.navigate('skills');
        expect(skillsFiles).toHaveBeenCalledTimes(2);
    } finally { await app.destroy(); }
});

it('keeps host file formats independent from the standard editor', async () => {
    navigationDOM(); lifecycle.configure.mockClear();
    const runtime = makeRuntime(), fs = await runtime.vfs.openFileSystem('/home/admin');
    const fileTypes = [
        { id: 'json', extension: '.json', contentFormat: 'text' as const },
        { id: 'log', extension: '.log' },
        { id: 'custom', extension: '.CUSTOM', contentFormat: 'markdown' as const },
        { id: 'markdown', extension: '.md', contentFormat: 'text' as const },
    ].map(type => ({ label: type.id, defaultFileName: 'new' + type.extension, defaultContent: '', editorType: 'standard' as const, ...type }));
    const active = { ...workspace, type: 'standard' as const, supportedFileTypes: fileTypes.map(type => type.id), files: { fs, cwd: '/' } };
    const app = await initTestApp({ services: runtime, workspaces: [active], fileTypes, ui: testUI() });
    try {
        const types = lifecycle.configure.mock.calls[0][0].fileTypes;
        expect(fileContentFormat('/config.json', types)).toEqual({ contentFormat: 'text' });
        expect(fileContentFormat('/error.log', types)).toEqual({ contentFormat: 'text' });
        expect(fileContentFormat('/note.custom', types)).toEqual({ contentFormat: 'markdown' });
        expect(fileContentFormat('/plain.md', types)).toEqual({ contentFormat: 'text' });
        expect(fileContentFormat('/note.custom')).toEqual({ contentFormat: 'text' });
    } finally { await app.destroy(); }
});

it('honors an explicit resource link even when the start page is enabled', async () => {
    navigationDOM(); lifecycle.open.mockClear();
    history.replaceState(null, '', '#/settings/explicit-file');
    const app = await initTestApp({ services: makeRuntime(), workspaces: [workspace], startPage: true, ui: testUI() });
    try { expect(lifecycle.open).toHaveBeenCalledWith('explicit-file'); }
    finally { await app.destroy(); }
});

it('shares a pending workspace load and opens only the latest requested resource', async () => {
    navigationDOM(); lifecycle.start.mockClear(); lifecycle.open.mockClear();
    let finish!: () => void;
    lifecycle.start.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    history.replaceState(null, '', '#/settings/old-file');
    const starting = initTestApp({ services: makeRuntime(), workspaces: [workspace], ui: testUI() });
    await vi.waitFor(() => expect(lifecycle.start).toHaveBeenCalledOnce());
    document.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.NAVIGATE, { detail: { target: 'settings', resourceId: 'new-file' } }));
    finish();
    const app = await starting;
    try {
        await vi.waitFor(() => expect(lifecycle.open).toHaveBeenCalledOnce());
        expect(lifecycle.start).toHaveBeenCalledOnce(); expect(lifecycle.open).toHaveBeenCalledWith('new-file');
        expect(location.hash).toBe('#/settings/new-file');
    } finally { await app.destroy(); }
});
